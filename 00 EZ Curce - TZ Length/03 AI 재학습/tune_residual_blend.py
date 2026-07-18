#!/usr/bin/env python3
"""Tune conservative shrinkage for the residual landmark correctors.

The script replays the exact nested, grouped five-fold protocol used by
``train_residual.py``.  It then shrinks only the already out-of-fold residual
corrections on an 11 x 11 grid.  No model is refit while scoring a blend, so
every reported candidate remains an out-of-fold estimate.

Only aggregate metrics are written.  Case identifiers, file paths, image
coordinates, and other PHI are deliberately excluded from the output.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np

import evaluate_residual_clinical as clinical
import train_residual as tr


SCHEMA_VERSION = "ez-tzl-residual-blend-tuning/v1"
GRID = tuple(index / 10.0 for index in range(11))
FOLDS = 5
EPS = 1e-12


def replay_oof_raw(
    data: Mapping[str, np.ndarray], seed: int, maximum_correction: float
) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    """Reproduce the trainer's raw out-of-fold prediction for one task."""
    x = data["x"]
    baseline = data["baseline"]
    target = data["target"]
    groups = data["groups"]
    corrected = np.zeros_like(target)
    accepted = np.zeros(x.shape[0], dtype=bool)
    masks = tr.grouped_folds(groups, FOLDS, seed)

    for fold_index, test_mask in enumerate(masks, start=1):
        train_mask = ~test_mask
        _, gamma_factor, regularization = tr.select_hyperparameters(
            x[train_mask],
            baseline[train_mask],
            target[train_mask],
            groups[train_mask],
            seed + fold_index * 1009,
            maximum_correction,
            4,
        )
        model = tr.fit_krr(
            x[train_mask],
            baseline[train_mask],
            target[train_mask],
            gamma_factor,
            regularization,
        )
        prediction, fold_accepted, _ = tr.predict_krr(
            model, x[test_mask], baseline[test_mask], maximum_correction
        )
        corrected[test_mask] = prediction
        accepted[test_mask] = fold_accepted

    return corrected, accepted, masks


def blended_prediction(baseline: np.ndarray, raw: np.ndarray, blend: float) -> np.ndarray:
    """Shrink an out-of-fold residual without changing its fallback behavior."""
    return np.clip(baseline + float(blend) * (raw - baseline), 0.0, 1.0)


def coordinate_summary(
    data: Mapping[str, np.ndarray], prediction: np.ndarray, masks: list[np.ndarray]
) -> dict[str, Any]:
    baseline_metrics = tr.error_metrics(data["target"], data["baseline"])
    candidate_metrics = tr.error_metrics(data["target"], prediction)
    fold_improved = 0
    fold_summaries: list[dict[str, Any]] = []
    for fold_index, mask in enumerate(masks, start=1):
        fold_baseline = tr.error_metrics(data["target"][mask], data["baseline"][mask])
        fold_candidate = tr.error_metrics(data["target"][mask], prediction[mask])
        improved = fold_candidate["coordinateMAE"] < fold_baseline["coordinateMAE"] - EPS
        fold_improved += int(improved)
        fold_summaries.append({
            "fold": fold_index,
            "coordinateMaeRelativeImprovement": tr.relative_improvement(
                fold_baseline["coordinateMAE"], fold_candidate["coordinateMAE"]
            ),
            "improved": bool(improved),
        })

    improvement = tr.relative_improvement(
        baseline_metrics["coordinateMAE"], candidate_metrics["coordinateMAE"]
    )
    p95_regression = candidate_metrics["p95"] - baseline_metrics["p95"]
    checks = {
        "coordinateMaeRelativeImprovementAtLeast10Pct": improvement >= 0.10 - EPS,
        "atLeast4Of5FoldsImproved": fold_improved >= 4,
        "coordinateP95DidNotRegress": p95_regression <= EPS,
    }
    return {
        "baseline": {
            "coordinateMAE": baseline_metrics["coordinateMAE"],
            "p95": baseline_metrics["p95"],
        },
        "candidate": {
            "coordinateMAE": candidate_metrics["coordinateMAE"],
            "p95": candidate_metrics["p95"],
        },
        "coordinateMaeRelativeImprovement": improvement,
        "p95Regression": p95_regression,
        "improvedFolds": fold_improved,
        "foldCount": len(masks),
        "folds": fold_summaries,
        "checks": checks,
        "pass": all(checks.values()),
    }


def group_aspects(dataset_path: Path) -> dict[str, float]:
    """Internal-only lookup; group identifiers never leave this process."""
    document = tr.read_json(dataset_path)
    result: dict[str, float] = {}
    for case in tr.dataset_cases(document):
        dims = tr.dimensions(case)
        if dims is None:
            continue
        image = case.get("image") if isinstance(case.get("image"), Mapping) else case
        image_sha = tr.sha256_text(image.get("sha256")) if isinstance(image, Mapping) else None
        split = case.get("splitGrouping") if isinstance(case.get("splitGrouping"), Mapping) else {}
        group = str(split.get("minimumGroupId") or image_sha or tr.get_case_id(case) or "")
        if group:
            result[group] = dims[0] / dims[1]
    return result


def paired_geometry_inputs(
    tasks: Mapping[str, Mapping[str, np.ndarray]], dataset_path: Path
) -> list[dict[str, Any]]:
    """Build paired truth/baseline geometry in memory without exporting IDs."""
    aspects = group_aspects(dataset_path)
    width_index = {str(group): index for index, group in enumerate(tasks["width"]["groups"])}
    ez_index = {str(group): index for index, group in enumerate(tasks["ez"]["groups"])}
    paired: list[dict[str, Any]] = []
    for group in sorted(set(width_index).intersection(ez_index)):
        aspect = aspects.get(group)
        if aspect is None or not math.isfinite(aspect) or aspect <= 0:
            continue
        wi, ei = width_index[group], ez_index[group]
        width_truth = clinical.to_shape_space(tasks["width"]["target"][wi], aspect)
        width_base = clinical.to_shape_space(tasks["width"]["baseline"][wi], aspect)
        ez_truth = clinical.to_shape_space(tasks["ez"]["target"][ei], aspect)
        ez_base = clinical.to_shape_space(tasks["ez"]["baseline"][ei], aspect)
        truth_chord = float(np.linalg.norm(ez_truth[-1] - ez_truth[0]))
        base_chord = float(np.linalg.norm(ez_base[-1] - ez_base[0]))
        if min(truth_chord, base_chord) <= EPS:
            continue
        paired.append({
            "widthIndex": wi,
            "ezIndex": ei,
            "aspect": aspect,
            "widthTruth": width_truth,
            "widthBaseline": width_base,
            "ezTruth": ez_truth,
            "ezBaseline": ez_base,
        })
    return paired


def geometry(widths: np.ndarray, ez: np.ndarray, scale: float) -> tuple[float, float, float]:
    ezl = clinical.polyline_length(clinical.generated_curve(ez)) / scale
    tzl = sum(
        float(np.linalg.norm(widths[index * 2 + 1] - widths[index * 2]))
        for index in range(12)
    ) / scale
    return ezl, tzl, ezl - tzl


def clinical_arrays(
    paired: list[dict[str, Any]],
    width_prediction: np.ndarray,
    ez_prediction: np.ndarray,
) -> dict[str, np.ndarray]:
    values: dict[str, list[float]] = {
        "referenceEz": [],
        "referenceTz": [],
        "referenceDifference": [],
        "baselineReferenceScaleEz": [],
        "baselineReferenceScaleTz": [],
        "baselineReferenceScaleDifference": [],
        "candidateReferenceScaleEz": [],
        "candidateReferenceScaleTz": [],
        "candidateReferenceScaleDifference": [],
        "baselineAppScaleEz": [],
        "baselineAppScaleTz": [],
        "baselineAppScaleDifference": [],
        "candidateAppScaleEz": [],
        "candidateAppScaleTz": [],
        "candidateAppScaleDifference": [],
    }
    for item in paired:
        aspect = float(item["aspect"])
        width_candidate = clinical.to_shape_space(
            width_prediction[int(item["widthIndex"])], aspect
        )
        ez_candidate = clinical.to_shape_space(ez_prediction[int(item["ezIndex"])], aspect)
        width_truth = item["widthTruth"]
        width_baseline = item["widthBaseline"]
        ez_truth = item["ezTruth"]
        ez_baseline = item["ezBaseline"]

        truth_chord = float(np.linalg.norm(ez_truth[-1] - ez_truth[0]))
        baseline_chord = float(np.linalg.norm(ez_baseline[-1] - ez_baseline[0]))
        candidate_chord = float(np.linalg.norm(ez_candidate[-1] - ez_candidate[0]))
        if min(truth_chord, baseline_chord, candidate_chord) <= EPS:
            raise ValueError("a blend produced a degenerate EZ endpoint chord")
        truth_scale = truth_chord / 54.0
        baseline_scale = baseline_chord / 54.0
        candidate_scale = candidate_chord / 54.0
        truth_values = geometry(width_truth, ez_truth, truth_scale)
        baseline_reference = geometry(width_baseline, ez_baseline, truth_scale)
        candidate_reference = geometry(width_candidate, ez_candidate, truth_scale)
        baseline_app = geometry(width_baseline, ez_baseline, baseline_scale)
        candidate_app = geometry(width_candidate, ez_candidate, candidate_scale)

        for suffix, index in (("Ez", 0), ("Tz", 1), ("Difference", 2)):
            values["reference" + suffix].append(truth_values[index])
            values["baselineReferenceScale" + suffix].append(baseline_reference[index])
            values["candidateReferenceScale" + suffix].append(candidate_reference[index])
            values["baselineAppScale" + suffix].append(baseline_app[index])
            values["candidateAppScale" + suffix].append(candidate_app[index])
    return {key: np.asarray(value, dtype=np.float64) for key, value in values.items()}


def clinical_summary(arrays: Mapping[str, np.ndarray]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for scheme in ("ReferenceScale", "AppScale"):
        scheme_summary: dict[str, Any] = {}
        for label, suffix in (("ezlMm", "Ez"), ("tzlMm", "Tz"), ("differenceMm", "Difference")):
            reference = arrays["reference" + suffix]
            baseline = clinical.error_summary(reference, arrays["baseline" + scheme + suffix])
            candidate = clinical.error_summary(reference, arrays["candidate" + scheme + suffix])
            mae_improvement = clinical.relative_improvement(baseline, candidate)
            mae_regression = float(candidate["maeMm"]) - float(baseline["maeMm"])
            p95_regression = (
                float(candidate["p95AbsoluteErrorMm"])
                - float(baseline["p95AbsoluteErrorMm"])
            )
            scheme_summary[label] = {
                "baselineMaeMm": baseline["maeMm"],
                "candidateMaeMm": candidate["maeMm"],
                "maeRelativeImprovement": mae_improvement,
                "maeRegressionMm": mae_regression,
                "baselineP95AbsoluteErrorMm": baseline["p95AbsoluteErrorMm"],
                "candidateP95AbsoluteErrorMm": candidate["p95AbsoluteErrorMm"],
                "p95RegressionMm": p95_regression,
                "maeDidNotRegress": mae_regression <= EPS,
                "p95DidNotRegress": p95_regression <= EPS,
            }
        output[scheme[0].lower() + scheme[1:]] = scheme_summary
    return output


def candidate_record(
    width_blend: float,
    ez_blend: float,
    tasks: Mapping[str, Mapping[str, np.ndarray]],
    width_raw: np.ndarray,
    ez_raw: np.ndarray,
    width_masks: list[np.ndarray],
    ez_masks: list[np.ndarray],
    paired: list[dict[str, Any]],
) -> dict[str, Any]:
    width_prediction = blended_prediction(tasks["width"]["baseline"], width_raw, width_blend)
    ez_prediction = blended_prediction(tasks["ez"]["baseline"], ez_raw, ez_blend)
    width_summary = coordinate_summary(tasks["width"], width_prediction, width_masks)
    ez_summary = coordinate_summary(tasks["ez"], ez_prediction, ez_masks)
    clinical_metrics = clinical_summary(
        clinical_arrays(paired, width_prediction, ez_prediction)
    )

    app_checks = {
        f"{label}{metric}": bool(clinical_metrics["appScale"][label][key])
        for label in ("ezlMm", "tzlMm", "differenceMm")
        for metric, key in (("MaeDidNotRegress", "maeDidNotRegress"), ("P95DidNotRegress", "p95DidNotRegress"))
    }
    reference_p95_checks = {
        f"{label}P95DidNotRegress": bool(
            clinical_metrics["referenceScale"][label]["p95DidNotRegress"]
        )
        for label in ("ezlMm", "tzlMm", "differenceMm")
    }
    app_mae_sum = sum(
        float(clinical_metrics["appScale"][label]["maeRelativeImprovement"])
        for label in ("ezlMm", "tzlMm", "differenceMm")
    )
    coordinate_balance = min(
        float(width_summary["coordinateMaeRelativeImprovement"]),
        float(ez_summary["coordinateMaeRelativeImprovement"]),
    )
    score = app_mae_sum + coordinate_balance
    required_checks = {
        "widthCoordinateGate": bool(width_summary["pass"]),
        "ezCoordinateGate": bool(ez_summary["pass"]),
        "pairedCountIs52": len(paired) == 52,
        "allAppScaleMaeAndP95DidNotRegress": all(app_checks.values()),
    }
    return {
        "widthBlend": width_blend,
        "ezBlend": ez_blend,
        "coordinate": {"width": width_summary, "ez": ez_summary},
        "clinical": clinical_metrics,
        "gate": {
            "pass": all(required_checks.values()),
            "checks": required_checks,
            "appScaleChecks": app_checks,
            "referenceScaleP95Checks": reference_p95_checks,
            "referenceScaleAllP95DidNotRegress": all(reference_p95_checks.values()),
        },
        "ranking": {
            "appScaleMaeRelativeImprovementSum": app_mae_sum,
            "coordinateImprovementBalanceMinimum": coordinate_balance,
            "score": score,
        },
    }


def select_candidate(candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    passing = [item for item in candidates if item["gate"]["pass"]]
    preferred = [
        item for item in passing if item["gate"]["referenceScaleAllP95DidNotRegress"]
    ]
    pool = preferred if preferred else passing
    if not pool:
        return None, {
            "passingCandidateCount": 0,
            "referenceP95PreferredCandidateCount": 0,
            "referenceP95PreferenceApplied": False,
        }

    # Deterministic order: safety preference, composite benefit, then smaller
    # corrections when aggregate benefits tie.
    selected = max(
        pool,
        key=lambda item: (
            float(item["ranking"]["score"]),
            float(item["ranking"]["appScaleMaeRelativeImprovementSum"]),
            float(item["ranking"]["coordinateImprovementBalanceMinimum"]),
            -(float(item["widthBlend"]) + float(item["ezBlend"])),
            -float(item["widthBlend"]),
            -float(item["ezBlend"]),
        ),
    )
    return selected, {
        "passingCandidateCount": len(passing),
        "referenceP95PreferredCandidateCount": len(preferred),
        "referenceP95PreferenceApplied": bool(preferred),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-index", type=Path, required=True)
    parser.add_argument("--baseline-predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=tr.DEFAULT_SEED)
    parser.add_argument("--maximum-correction", type=float, default=0.05)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dataset_path = args.dataset_index.resolve()
    baseline_path = args.baseline_predictions.resolve()
    tasks, audit = tr.build_samples(dataset_path, baseline_path)
    if "width" not in tasks or "ez" not in tasks:
        raise SystemExit("both width and EZ tasks are required")

    width_raw, width_accepted, width_masks = replay_oof_raw(
        tasks["width"], args.seed, args.maximum_correction
    )
    ez_raw, ez_accepted, ez_masks = replay_oof_raw(
        tasks["ez"], args.seed + 100003, args.maximum_correction
    )
    paired = paired_geometry_inputs(tasks, dataset_path)

    candidates = [
        candidate_record(
            width_blend,
            ez_blend,
            tasks,
            width_raw,
            ez_raw,
            width_masks,
            ez_masks,
            paired,
        )
        for width_blend in GRID
        for ez_blend in GRID
    ]
    selected, selection_summary = select_candidate(candidates)

    selected_summary = None
    if selected is not None:
        selected_summary = {
            "widthBlend": selected["widthBlend"],
            "ezBlend": selected["ezBlend"],
            "coordinate": selected["coordinate"],
            "clinical": selected["clinical"],
            "gate": selected["gate"],
            "ranking": selected["ranking"],
        }

    document = {
        "schemaVersion": SCHEMA_VERSION,
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImageCoordinates": False,
        },
        "protocol": {
            "validation": "nested grouped five-fold out-of-fold predictions",
            "postProcess": "baseline + blend * (raw_oof_correction), clipped to [0,1]",
            "grid": {"widthBlend": list(GRID), "ezBlend": list(GRID)},
            "candidateCount": len(candidates),
            "seed": int(args.seed),
            "maximumCorrectionArgument": float(args.maximum_correction),
            "ranking": (
                "prefer required-gate candidates with all reference-scale P95 non-regression; "
                "then maximize app-scale MAE relative-improvement sum plus the smaller of width/EZ "
                "coordinate-MAE relative improvements; ties prefer smaller blends"
            ),
        },
        "inputSummary": audit["inputSummary"],
        "pairedCompleteCases": len(paired),
        "outOfFoldFallbackSummary": {
            "widthAccepted": int(width_accepted.sum()),
            "widthFallback": int((~width_accepted).sum()),
            "ezAccepted": int(ez_accepted.sum()),
            "ezFallback": int((~ez_accepted).sum()),
        },
        "requiredGate": {
            "eachTaskCoordinateMaeRelativeImprovementMinimum": 0.10,
            "eachTaskImprovedFoldMinimum": 4,
            "foldCount": 5,
            "eachTaskCoordinateP95MaximumRegression": 0.0,
            "pairedCompleteCasesRequired": 52,
            "appScaleMetrics": ["ezlMm", "tzlMm", "differenceMm"],
            "appScaleMaeMaximumRegressionMm": 0.0,
            "appScaleP95MaximumRegressionMm": 0.0,
            "referenceScaleP95": "selection preference when a required-gate candidate satisfies all three",
        },
        "selection": {
            **selection_summary,
            "candidateSelected": selected is not None,
            "selected": selected_summary,
        },
        "safetyFlags": {
            "actualPixelDiagonalCorrectionCap": {
                "status": "known_issue_not_fixed",
                "flag": True,
                "detail": (
                    "The current trainer clips landmark residuals in axis-normalized XY space using "
                    "maximumCorrection * sqrt(2). For non-square images this is not the same as a cap "
                    "measured against the actual pixel diagonal."
                ),
                "productionCodeModified": False,
                "productionPromotionBlockedUntilResolvedAndRevalidated": True,
            },
            "medicalHumanApprovalRequired": True,
        },
        "deploymentDecision": {
            "productionPromotionAllowed": False,
            "mode": "research_candidate_only",
            "reason": "blend tuning does not resolve the actual pixel-diagonal correction-cap issue",
        },
        "candidates": candidates,
    }
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(tr.sanitize_finite(document), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "candidateCount": len(candidates),
        "pairedCompleteCases": len(paired),
        "passingCandidateCount": selection_summary["passingCandidateCount"],
        "candidateSelected": selected is not None,
        "selectedBlend": (
            {"widthBlend": selected["widthBlend"], "ezBlend": selected["ezBlend"]}
            if selected is not None else None
        ),
        "productionPromotionAllowed": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
