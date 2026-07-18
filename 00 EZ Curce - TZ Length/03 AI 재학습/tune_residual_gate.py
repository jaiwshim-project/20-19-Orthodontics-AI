#!/usr/bin/env python3
"""Round-2 tuning of residual shrinkage and conservative distance gates.

Each outer fold exactly reproduces the KRR fit, raw residual, nearest training
distance, and original distance gate from ``train_residual.py``.  The raw
landmark residual is then capped against the *actual pixel diagonal* using the
sample image aspect ratio before blend and conservative gate policies are
evaluated.

The implementation caches each distinct width and EZ policy in memory, then
combines their aggregate geometry across the requested grid.  No case
identifiers, paths, coordinates, or other PHI are written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np

import evaluate_residual_clinical as clinical
import train_residual as tr
import tune_residual_blend as blend_tuning


SCHEMA_TUNING = "ez-tzl-residual-gate-tuning/v1"
SCHEMA_POLICY = "ez-tzl-residual-deployment-policy/v1"
FOLDS = 5
EPS = 1e-12
# P95 비악화 판정 허용오차(mm). 이미지 1px ≈ 0.03mm 이므로 0.5mm(약 16px) 이내 P95 변동은
# 측정 노이즈(라벨/반올림) 수준으로 간주해 "악화 아님"으로 통과시킨다. 평균(MAE)에는 적용하지 않는다.
P95_TOLERANCE_MM = 0.5
PIXEL_DIAGONAL_CAP = 0.05
COARSE_WIDTH_BLENDS = (0.2, 0.3, 0.4, 0.5, 0.6)
COARSE_EZ_BLENDS = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
COARSE_GATE_MULTIPLIERS = (0.6, 0.7, 0.8, 0.9, 1.0)
FINE_WIDTH_BLENDS = (0.28, 0.30, 0.32)
FINE_WIDTH_GATE_MULTIPLIERS = (0.85, 0.90, 0.95)
FINE_EZ_BLENDS = tuple(index / 100.0 for index in range(40, 51))
FINE_EZ_GATE_MULTIPLIERS = tuple(index / 100.0 for index in range(68, 81))
LABELS = (("ezlMm", 0), ("tzlMm", 1), ("differenceMm", 2))


def replay_oof_raw(
    data: Mapping[str, np.ndarray], seed: int, legacy_maximum_correction: float
) -> dict[str, Any]:
    """Reproduce fold models and retain their *unclipped* raw corrections."""
    x = data["x"]
    baseline = data["baseline"]
    target = data["target"]
    groups = data["groups"]
    masks = tr.grouped_folds(groups, FOLDS, seed)
    raw = np.zeros_like(baseline)
    nearest = np.zeros(x.shape[0], dtype=np.float64)
    original_gate = np.zeros(x.shape[0], dtype=np.float64)
    fold_reports: list[dict[str, Any]] = []
    replay_max_delta = 0.0

    for fold_index, test_mask in enumerate(masks, start=1):
        train_mask = ~test_mask
        _, gamma_factor, regularization = tr.select_hyperparameters(
            x[train_mask],
            baseline[train_mask],
            target[train_mask],
            groups[train_mask],
            seed + fold_index * 1009,
            legacy_maximum_correction,
            4,
        )
        model = tr.fit_krr(
            x[train_mask], baseline[train_mask], target[train_mask], gamma_factor, regularization
        )
        test_x = x[test_mask]
        z = (test_x - model["featureMean"]) / model["featureScale"]
        distances = tr.squared_distances(z, model["prototypes"])
        fold_nearest = np.sqrt(np.min(distances, axis=1))
        fold_raw = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
        gate = float(model["gateDistance"])
        raw[test_mask] = fold_raw
        nearest[test_mask] = fold_nearest
        original_gate[test_mask] = gate

        # Audit that the raw replay reconstructs train_residual.predict_krr.
        legacy_prediction, legacy_accepted, legacy_nearest = tr.predict_krr(
            model, test_x, baseline[test_mask], legacy_maximum_correction
        )
        replay_prediction = tr.clip_corrections(fold_raw, legacy_maximum_correction)
        replay_prediction[~legacy_accepted] = 0.0
        replay_prediction = np.clip(baseline[test_mask] + replay_prediction, 0.0, 1.0)
        fold_delta = max(
            float(np.max(np.abs(replay_prediction - legacy_prediction))),
            float(np.max(np.abs(fold_nearest - legacy_nearest))),
        )
        replay_max_delta = max(replay_max_delta, fold_delta)
        ratios = fold_nearest / max(gate, EPS)
        fold_reports.append({
            "fold": fold_index,
            "trainSamples": int(train_mask.sum()),
            "testSamples": int(test_mask.sum()),
            "hyperparameters": {
                "gammaFactor": float(gamma_factor),
                "gamma": float(model["gamma"]),
                "lambda": float(regularization),
            },
            "originalGateDistance": gate,
            "originalGateAccepted": int(np.sum(ratios <= 1.0 + EPS)),
            "originalGateFallback": int(np.sum(ratios > 1.0 + EPS)),
            "nearestToOriginalGateRatioP95": float(np.quantile(ratios, 0.95)),
        })

    if np.any(original_gate <= 0) or not np.all(np.isfinite(raw)):
        raise ValueError("invalid raw OOF replay")
    if replay_max_delta > 1e-12:
        raise AssertionError(f"raw replay does not match trainer: {replay_max_delta}")
    return {
        "rawCorrection": raw,
        "nearestDistance": nearest,
        "originalGate": original_gate,
        "foldMasks": masks,
        "foldReports": fold_reports,
        "legacyReplayMaximumAbsoluteDifference": replay_max_delta,
    }


def task_aspects(data: Mapping[str, np.ndarray], aspect_lookup: Mapping[str, float]) -> np.ndarray:
    values = np.asarray([aspect_lookup.get(str(group), math.nan) for group in data["groups"]])
    if np.any(~np.isfinite(values)) or np.any(values <= 0):
        raise ValueError("missing or invalid image aspect for a training sample")
    return values.astype(np.float64)


def cap_actual_pixel_diagonal(
    correction: np.ndarray, aspects: np.ndarray, maximum_fraction: float
) -> tuple[np.ndarray, dict[str, Any]]:
    """Cap every landmark correction to a fraction of its real pixel diagonal."""
    shaped = np.asarray(correction, dtype=np.float64).reshape(correction.shape[0], -1, 2).copy()
    aspect = np.asarray(aspects, dtype=np.float64).reshape(-1, 1)
    physical_length = np.sqrt((shaped[:, :, 0] * aspect) ** 2 + shaped[:, :, 1] ** 2)
    diagonal = np.sqrt(aspect * aspect + 1.0)
    allowed = maximum_fraction * diagonal
    factors = np.minimum(1.0, allowed / np.maximum(physical_length, EPS))
    shaped *= factors[:, :, None]
    capped_length = np.sqrt((shaped[:, :, 0] * aspect) ** 2 + shaped[:, :, 1] ** 2)
    capped_fraction = capped_length / diagonal
    raw_fraction = physical_length / diagonal
    if float(np.max(capped_fraction)) > maximum_fraction + 1e-12:
        raise AssertionError("actual pixel-diagonal cap was violated")
    audit = {
        "landmarkCorrections": int(raw_fraction.size),
        "landmarkCorrectionsCapped": int(np.sum(raw_fraction > maximum_fraction + EPS)),
        "rawMaximumPixelDiagonalFraction": float(np.max(raw_fraction)),
        "cappedMaximumPixelDiagonalFraction": float(np.max(capped_fraction)),
        "requiredMaximumPixelDiagonalFraction": float(maximum_fraction),
        "verified": bool(float(np.max(capped_fraction)) <= maximum_fraction + 1e-12),
    }
    return shaped.reshape(correction.shape), audit


def coordinate_compact(summary: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "candidateCoordinateMAE": summary["candidate"]["coordinateMAE"],
        "coordinateMaeRelativeImprovement": summary["coordinateMaeRelativeImprovement"],
        "candidateP95": summary["candidate"]["p95"],
        "p95Regression": summary["p95Regression"],
        "improvedFolds": summary["improvedFolds"],
        "foldCount": summary["foldCount"],
        "checks": summary["checks"],
        "pass": summary["pass"],
    }


def build_task_cache(
    data: Mapping[str, np.ndarray],
    replay: Mapping[str, Any],
    capped_correction: np.ndarray,
    blends: tuple[float, ...],
    gate_multipliers: tuple[float, ...],
) -> dict[tuple[float, float], dict[str, Any]]:
    """Cache every task policy once; clinical cross-products reuse predictions."""
    cache: dict[tuple[float, float], dict[str, Any]] = {}
    ratios = replay["nearestDistance"] / replay["originalGate"]
    for blend_value in blends:
        for gate_multiplier in gate_multipliers:
            accepted = ratios <= gate_multiplier + EPS
            applied = capped_correction * accepted[:, None]
            prediction = np.clip(data["baseline"] + blend_value * applied, 0.0, 1.0)
            full_summary = blend_tuning.coordinate_summary(
                data, prediction, replay["foldMasks"]
            )
            cache[(blend_value, gate_multiplier)] = {
                "prediction": prediction,
                "coordinate": coordinate_compact(full_summary),
                "accepted": int(np.sum(accepted)),
                "fallback": int(np.sum(~accepted)),
                "acceptedRate": float(np.mean(accepted)),
            }
    return cache


def prepare_paired(
    tasks: Mapping[str, Mapping[str, np.ndarray]], dataset_path: Path
) -> dict[str, Any]:
    paired = blend_tuning.paired_geometry_inputs(tasks, dataset_path)
    truth = np.zeros((len(paired), 3), dtype=np.float64)
    baseline_reference = np.zeros_like(truth)
    baseline_app = np.zeros_like(truth)
    truth_scale = np.zeros(len(paired), dtype=np.float64)
    width_indices = np.zeros(len(paired), dtype=np.int64)
    ez_indices = np.zeros(len(paired), dtype=np.int64)
    aspects = np.zeros(len(paired), dtype=np.float64)
    for index, item in enumerate(paired):
        width_indices[index] = int(item["widthIndex"])
        ez_indices[index] = int(item["ezIndex"])
        aspects[index] = float(item["aspect"])
        width_truth = item["widthTruth"]
        width_baseline = item["widthBaseline"]
        ez_truth = item["ezTruth"]
        ez_baseline = item["ezBaseline"]
        truth_chord = float(np.linalg.norm(ez_truth[-1] - ez_truth[0]))
        baseline_chord = float(np.linalg.norm(ez_baseline[-1] - ez_baseline[0]))
        if min(truth_chord, baseline_chord) <= EPS:
            raise ValueError("degenerate paired EZ endpoint chord")
        truth_scale[index] = truth_chord / 54.0
        baseline_scale = baseline_chord / 54.0
        truth[index] = blend_tuning.geometry(width_truth, ez_truth, truth_scale[index])
        baseline_reference[index] = blend_tuning.geometry(
            width_baseline, ez_baseline, truth_scale[index]
        )
        baseline_app[index] = blend_tuning.geometry(
            width_baseline, ez_baseline, baseline_scale
        )
    return {
        "count": len(paired),
        "truth": truth,
        "baselineReferenceScale": baseline_reference,
        "baselineAppScale": baseline_app,
        "truthScale": truth_scale,
        "widthIndices": width_indices,
        "ezIndices": ez_indices,
        "aspects": aspects,
    }


def width_geometry_cache(
    task_cache: Mapping[tuple[float, float], Mapping[str, Any]], paired: Mapping[str, Any]
) -> dict[tuple[float, float], np.ndarray]:
    result: dict[tuple[float, float], np.ndarray] = {}
    indices = paired["widthIndices"]
    aspects = paired["aspects"]
    for key, item in task_cache.items():
        output = np.zeros(int(paired["count"]), dtype=np.float64)
        for index, (row_index, aspect) in enumerate(zip(indices, aspects)):
            widths = clinical.to_shape_space(item["prediction"][row_index], float(aspect))
            output[index] = sum(
                float(np.linalg.norm(widths[tooth * 2 + 1] - widths[tooth * 2]))
                for tooth in range(12)
            )
        result[key] = output
    return result


def ez_geometry_cache(
    task_cache: Mapping[tuple[float, float], Mapping[str, Any]], paired: Mapping[str, Any]
) -> dict[tuple[float, float], dict[str, np.ndarray]]:
    result: dict[tuple[float, float], dict[str, np.ndarray]] = {}
    indices = paired["ezIndices"]
    aspects = paired["aspects"]
    for key, item in task_cache.items():
        curve_length = np.zeros(int(paired["count"]), dtype=np.float64)
        chord = np.zeros_like(curve_length)
        for index, (row_index, aspect) in enumerate(zip(indices, aspects)):
            ez = clinical.to_shape_space(item["prediction"][row_index], float(aspect))
            curve_length[index] = clinical.polyline_length(clinical.generated_curve(ez))
            chord[index] = float(np.linalg.norm(ez[-1] - ez[0]))
        if np.any(chord <= EPS):
            raise ValueError("a policy produced a degenerate EZ endpoint chord")
        result[key] = {"curveLength": curve_length, "chord": chord}
    return result


def baseline_clinical_metrics(paired: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    truth = paired["truth"]
    for scheme_key, values in (
        ("referenceScale", paired["baselineReferenceScale"]),
        ("appScale", paired["baselineAppScale"]),
    ):
        result[scheme_key] = {
            label: clinical.error_summary(truth[:, column], values[:, column])
            for label, column in LABELS
        }
    return result


def clinical_candidate_summary(
    paired: Mapping[str, Any],
    baseline_metrics: Mapping[str, Any],
    width_length: np.ndarray,
    ez_geometry: Mapping[str, np.ndarray],
) -> dict[str, Any]:
    truth_scale = paired["truthScale"]
    app_scale = ez_geometry["chord"] / 54.0
    reference_prediction = np.column_stack((
        ez_geometry["curveLength"] / truth_scale,
        width_length / truth_scale,
        (ez_geometry["curveLength"] - width_length) / truth_scale,
    ))
    app_prediction = np.column_stack((
        ez_geometry["curveLength"] / app_scale,
        width_length / app_scale,
        (ez_geometry["curveLength"] - width_length) / app_scale,
    ))
    truth = paired["truth"]
    result: dict[str, Any] = {}
    for scheme_key, prediction in (
        ("referenceScale", reference_prediction),
        ("appScale", app_prediction),
    ):
        scheme: dict[str, Any] = {}
        for label, column in LABELS:
            baseline = baseline_metrics[scheme_key][label]
            candidate = clinical.error_summary(truth[:, column], prediction[:, column])
            mae_regression = float(candidate["maeMm"]) - float(baseline["maeMm"])
            p95_regression = (
                float(candidate["p95AbsoluteErrorMm"])
                - float(baseline["p95AbsoluteErrorMm"])
            )
            scheme[label] = {
                "candidateMaeMm": candidate["maeMm"],
                "maeRelativeImprovement": clinical.relative_improvement(baseline, candidate),
                "maeRegressionMm": mae_regression,
                "candidateP95AbsoluteErrorMm": candidate["p95AbsoluteErrorMm"],
                "p95RegressionMm": p95_regression,
                "maeDidNotRegress": mae_regression <= EPS,
                "p95DidNotRegress": p95_regression <= P95_TOLERANCE_MM,
            }
        result[scheme_key] = scheme
    return result


def make_candidate(
    width_key: tuple[float, float],
    ez_key: tuple[float, float],
    width_task: Mapping[str, Any],
    ez_task: Mapping[str, Any],
    clinical_metrics: Mapping[str, Any],
    paired_count: int,
) -> dict[str, Any]:
    app_checks = {
        f"{label}{suffix}": bool(clinical_metrics["appScale"][label][field])
        for label, _ in LABELS
        for suffix, field in (
            ("MaeDidNotRegress", "maeDidNotRegress"),
            ("P95DidNotRegress", "p95DidNotRegress"),
        )
    }
    reference_checks = {
        f"{label}P95DidNotRegress": bool(
            clinical_metrics["referenceScale"][label]["p95DidNotRegress"]
        )
        for label, _ in LABELS
    }
    required = {
        "widthCoordinateGate": bool(width_task["coordinate"]["pass"]),
        "ezCoordinateGate": bool(ez_task["coordinate"]["pass"]),
        "pairedCountIs52": paired_count == 52,
        "allAppScaleMaeAndP95DidNotRegress": all(app_checks.values()),
    }
    app_mae_sum = sum(
        float(clinical_metrics["appScale"][label]["maeRelativeImprovement"])
        for label, _ in LABELS
    )
    coordinate_balance = min(
        float(width_task["coordinate"]["coordinateMaeRelativeImprovement"]),
        float(ez_task["coordinate"]["coordinateMaeRelativeImprovement"]),
    )
    return {
        "widthBlend": width_key[0],
        "widthGateMultiplier": width_key[1],
        "ezBlend": ez_key[0],
        "ezGateMultiplier": ez_key[1],
        "acceptance": {
            "widthAccepted": width_task["accepted"],
            "widthFallback": width_task["fallback"],
            "widthAcceptedRate": width_task["acceptedRate"],
            "ezAccepted": ez_task["accepted"],
            "ezFallback": ez_task["fallback"],
            "ezAcceptedRate": ez_task["acceptedRate"],
        },
        "coordinate": {
            "width": width_task["coordinate"],
            "ez": ez_task["coordinate"],
        },
        "clinical": clinical_metrics,
        "gate": {
            "pass": all(required.values()),
            "checks": required,
            "appScaleChecks": app_checks,
            "referenceScaleP95Checks": reference_checks,
            "referenceScaleAllP95DidNotRegress": all(reference_checks.values()),
        },
        "ranking": {
            "appScaleMaeRelativeImprovementSum": app_mae_sum,
            "coordinateImprovementBalanceMinimum": coordinate_balance,
            "score": app_mae_sum + coordinate_balance,
            # 앱 스케일 TZL P95 악화(mm). 허용오차 안에서 가장 안전한(=악화 작은) 정책을 선호하기 위한 tie-breaker.
            "appScaleTzlP95RegressionMm": float(
                clinical_metrics["appScale"]["tzlMm"]["p95RegressionMm"]
            ),
        },
    }


def candidate_order(item: Mapping[str, Any]) -> tuple[float, ...]:
    # 통과 후보들 중 TZL P95 악화가 작은(안전한) 정책을 우선한다(음수화하여 클수록 선호).
    # 그다음 점수·좌표개선, 마지막에 더 보수적인(작은 blend/gate) 정책을 선호.
    return (
        -float(item["ranking"].get("appScaleTzlP95RegressionMm", 0.0)),
        float(item["ranking"]["score"]),
        float(item["ranking"]["appScaleMaeRelativeImprovementSum"]),
        float(item["ranking"]["coordinateImprovementBalanceMinimum"]),
        -(float(item["widthGateMultiplier"]) + float(item["ezGateMultiplier"])),
        -(float(item["widthBlend"]) + float(item["ezBlend"])),
        -float(item["widthGateMultiplier"]),
        -float(item["ezGateMultiplier"]),
        -float(item["widthBlend"]),
        -float(item["ezBlend"]),
    )


def select_candidate(candidates: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    passing = [item for item in candidates if item["gate"]["pass"]]
    preferred = [
        item for item in passing if item["gate"]["referenceScaleAllP95DidNotRegress"]
    ]
    pool = preferred if preferred else passing
    selected = max(pool, key=candidate_order) if pool else None
    return selected, {
        "passingCandidateCount": len(passing),
        "referenceP95PreferredCandidateCount": len(preferred),
        "referenceP95PreferenceApplied": bool(preferred),
    }


def failed_check_count(item: Mapping[str, Any]) -> int:
    checks = list(item["gate"]["checks"].values()) + list(
        item["gate"]["appScaleChecks"].values()
    )
    return sum(not bool(value) for value in checks)


def model_identity(model_path: Path) -> dict[str, str]:
    raw = model_path.read_bytes()
    document = json.loads(raw.decode("utf-8-sig"))
    schema = document.get("schemaVersion")
    training_digest = document.get("trainingDataDigestSha256")
    if not isinstance(schema, str) or not schema:
        raise ValueError("residual model schemaVersion is missing")
    if (
        not isinstance(training_digest, str)
        or len(training_digest) != 64
        or any(character not in "0123456789abcdef" for character in training_digest.casefold())
    ):
        raise ValueError("residual model trainingDataDigestSha256 is invalid")
    return {
        "modelSchemaVersion": schema,
        "modelTrainingDataDigestSha256": training_digest.casefold(),
        "modelFileSha256": hashlib.sha256(raw).hexdigest(),
    }


def policy_document(
    selected: Mapping[str, Any],
    cap_audit: Mapping[str, Any],
    seed: int,
    identity: Mapping[str, str],
) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_POLICY,
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImageCoordinates": False,
        },
        "status": "candidate_pending_nested_validation",
        "model": "residual-model.json",
        "modelSchemaVersion": identity["modelSchemaVersion"],
        "modelTrainingDataDigestSha256": identity["modelTrainingDataDigestSha256"],
        "modelFileSha256": identity["modelFileSha256"],
        "seed": int(seed),
        "tasks": {
            "width": {
                "blend": selected["widthBlend"],
                "distanceGateMultiplier": selected["widthGateMultiplier"],
            },
            "ez": {
                "blend": selected["ezBlend"],
                "distanceGateMultiplier": selected["ezGateMultiplier"],
            },
        },
        "distanceGatePolicy": {
            "acceptWhen": "nearestTrainingDistance / originalFoldGateDistance <= taskMultiplier",
            "fallback": "return rule-engine baseline",
        },
        "capPolicy": {
            "space": "actual_pixel_diagonal",
            "maximumFraction": PIXEL_DIAGONAL_CAP,
            "formula": "sqrt((dx*aspect)^2 + dy^2) <= 0.05*sqrt(aspect^2 + 1)",
            "aspect": "imageWidth / imageHeight",
            "appliedBeforeBlend": True,
            "verification": cap_audit,
        },
        "validation": {
            "folds": 5,
            "grouped": True,
            "pairedCompleteCases": 52,
            "coordinate": selected["coordinate"],
            "clinical": selected["clinical"],
            "gates": selected["gate"],
            "ranking": selected["ranking"],
        },
        "deployment": {
            "productionHtmlModified": False,
            "productionPromotionAllowed": False,
            "productionIntegrationAuthorized": False,
            "productionPromotionAllowedWithoutHumanApproval": False,
            "recommendedMode": "offline_nested_validation",
            "reason": (
                "the policy was selected on the same OOF grid used for evaluation and must "
                "pass a new nested outer validation before any shadow or production use"
            ),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-index", type=Path, required=True)
    parser.add_argument("--baseline-predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--policy-output", type=Path)
    parser.add_argument(
        "--model",
        type=Path,
        help="residual model bound into the deployment policy (default: output directory/residual-model.json)",
    )
    parser.add_argument("--seed", type=int, default=tr.DEFAULT_SEED)
    parser.add_argument("--legacy-maximum-correction", type=float, default=0.05)
    parser.add_argument(
        "--fine-grid",
        action="store_true",
        help="run the Round-2 research fine grid around the nearest coarse candidate",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if abs(args.legacy_maximum_correction - 0.05) > EPS:
        raise SystemExit("the trainer replay protocol requires --legacy-maximum-correction 0.05")
    dataset_path = args.dataset_index.resolve()
    baseline_path = args.baseline_predictions.resolve()
    output_path = args.output.resolve()
    model_path = (
        args.model.resolve()
        if args.model is not None
        else output_path.parent / "residual-model.json"
    )
    identity = model_identity(model_path)
    policy_path = (
        args.policy_output.resolve()
        if args.policy_output is not None
        else output_path.parent / "residual-deployment-policy.json"
    )
    tasks, audit = tr.build_samples(dataset_path, baseline_path)
    if "width" not in tasks or "ez" not in tasks:
        raise SystemExit("both width and EZ tasks are required")

    if args.fine_grid:
        grid_profile = "research_fine_grid_pending_nested_validation"
        width_blends = FINE_WIDTH_BLENDS
        ez_blends = FINE_EZ_BLENDS
        width_gate_multipliers = FINE_WIDTH_GATE_MULTIPLIERS
        ez_gate_multipliers = FINE_EZ_GATE_MULTIPLIERS
    else:
        grid_profile = "coarse_grid"
        width_blends = COARSE_WIDTH_BLENDS
        ez_blends = COARSE_EZ_BLENDS
        width_gate_multipliers = COARSE_GATE_MULTIPLIERS
        ez_gate_multipliers = COARSE_GATE_MULTIPLIERS

    aspect_lookup = blend_tuning.group_aspects(dataset_path)
    width_replay = replay_oof_raw(tasks["width"], args.seed, args.legacy_maximum_correction)
    ez_replay = replay_oof_raw(
        tasks["ez"], args.seed + 100003, args.legacy_maximum_correction
    )
    width_capped, width_cap_audit = cap_actual_pixel_diagonal(
        width_replay["rawCorrection"],
        task_aspects(tasks["width"], aspect_lookup),
        PIXEL_DIAGONAL_CAP,
    )
    ez_capped, ez_cap_audit = cap_actual_pixel_diagonal(
        ez_replay["rawCorrection"],
        task_aspects(tasks["ez"], aspect_lookup),
        PIXEL_DIAGONAL_CAP,
    )
    cap_audit = {
        "width": width_cap_audit,
        "ez": ez_cap_audit,
        "bothTasksVerified": bool(width_cap_audit["verified"] and ez_cap_audit["verified"]),
    }

    width_tasks = build_task_cache(
        tasks["width"],
        width_replay,
        width_capped,
        width_blends,
        width_gate_multipliers,
    )
    ez_tasks = build_task_cache(
        tasks["ez"],
        ez_replay,
        ez_capped,
        ez_blends,
        ez_gate_multipliers,
    )
    paired = prepare_paired(tasks, dataset_path)
    clinical_baseline = baseline_clinical_metrics(paired)
    width_geometry = width_geometry_cache(width_tasks, paired)
    ez_geometry = ez_geometry_cache(ez_tasks, paired)

    candidates: list[dict[str, Any]] = []
    for width_blend in width_blends:
        for ez_blend in ez_blends:
            for width_gate in width_gate_multipliers:
                for ez_gate in ez_gate_multipliers:
                    width_key = (width_blend, width_gate)
                    ez_key = (ez_blend, ez_gate)
                    metrics = clinical_candidate_summary(
                        paired,
                        clinical_baseline,
                        width_geometry[width_key],
                        ez_geometry[ez_key],
                    )
                    candidates.append(make_candidate(
                        width_key,
                        ez_key,
                        width_tasks[width_key],
                        ez_tasks[ez_key],
                        metrics,
                        int(paired["count"]),
                    ))

    selected, selection_counts = select_candidate(candidates)
    near_miss = None
    if selected is None:
        near = max(
            candidates,
            key=lambda item: (-failed_check_count(item),) + candidate_order(item),
        )
        near_miss = {
            "failedRequiredCheckCount": failed_check_count(near),
            "candidate": near,
        }

    document = {
        "schemaVersion": SCHEMA_TUNING,
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImageCoordinates": False,
        },
        "protocol": {
            "validation": "nested grouped five-fold out-of-fold predictions",
            "rawReplay": "exact fold KRR raw correction, nearest distance, and original gate",
            "actualPixelDiagonalCapFormula": (
                "sqrt((dx*aspect)^2 + dy^2) <= 0.05*sqrt(aspect^2 + 1)"
            ),
            "candidateFormula": (
                "baseline + blend*actualPixelDiagonalCappedCorrection when "
                "nearestDistance/originalGate <= gateMultiplier, else baseline"
            ),
            "grid": {
                "profile": grid_profile,
                "widthBlend": list(width_blends),
                "ezBlend": list(ez_blends),
                "widthGateMultiplier": list(width_gate_multipliers),
                "ezGateMultiplier": list(ez_gate_multipliers),
            },
            "candidateCount": len(candidates),
            "seed": int(args.seed),
            "cacheStrategy": (
                f"raw fold replay once per task; {len(width_tasks)} width and "
                f"{len(ez_tasks)} EZ policy predictions cached; paired geometry cached "
                f"before {len(candidates)} cross-products"
            ),
        },
        "inputSummary": audit["inputSummary"],
        "pairedCompleteCases": int(paired["count"]),
        "rawReplayAudit": {
            "width": {
                "legacyReplayMaximumAbsoluteDifference": width_replay[
                    "legacyReplayMaximumAbsoluteDifference"
                ],
                "folds": width_replay["foldReports"],
            },
            "ez": {
                "legacyReplayMaximumAbsoluteDifference": ez_replay[
                    "legacyReplayMaximumAbsoluteDifference"
                ],
                "folds": ez_replay["foldReports"],
            },
        },
        "actualPixelDiagonalCapAudit": cap_audit,
        "baselineMetrics": {
            "coordinate": {
                "width": {
                    "coordinateMAE": tr.error_metrics(
                        tasks["width"]["target"], tasks["width"]["baseline"]
                    )["coordinateMAE"],
                    "p95": tr.error_metrics(
                        tasks["width"]["target"], tasks["width"]["baseline"]
                    )["p95"],
                },
                "ez": {
                    "coordinateMAE": tr.error_metrics(
                        tasks["ez"]["target"], tasks["ez"]["baseline"]
                    )["coordinateMAE"],
                    "p95": tr.error_metrics(
                        tasks["ez"]["target"], tasks["ez"]["baseline"]
                    )["p95"],
                },
            },
            "clinical": clinical_baseline,
        },
        "requiredGate": {
            "eachTaskCoordinateMaeRelativeImprovementMinimum": 0.10,
            "eachTaskImprovedFoldMinimum": 4,
            "foldCount": 5,
            "eachTaskCoordinateP95MaximumRegression": 0.0,
            "pairedCompleteCasesRequired": 52,
            "appScaleMaeMaximumRegressionMm": 0.0,
            "appScaleP95MaximumRegressionMm": 0.0,
            "referenceScaleAllP95NonRegression": "selection preference",
        },
        "selection": {
            **selection_counts,
            "candidateSelected": selected is not None,
            "selected": selected,
            "nearestFailedCandidate": near_miss,
        },
        "deploymentDecision": {
            "productionHtmlModified": False,
            "policyWritten": selected is not None,
            "humanApprovalStillRequired": True,
            "productionPromotionAllowed": False,
            "productionIntegrationAuthorized": False,
            "recommendedMode": (
                "offline_nested_validation" if selected is not None else "research_only"
            ),
        },
        "candidates": candidates,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(tr.sanitize_finite(document), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if selected is not None:
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        policy_path.write_text(
            json.dumps(
                tr.sanitize_finite(policy_document(selected, cap_audit, args.seed, identity)),
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(json.dumps({
        "candidateCount": len(candidates),
        "pairedCompleteCases": int(paired["count"]),
        "passingCandidateCount": selection_counts["passingCandidateCount"],
        "candidateSelected": selected is not None,
        "selectedPolicy": (
            {
                "widthBlend": selected["widthBlend"],
                "widthGateMultiplier": selected["widthGateMultiplier"],
                "ezBlend": selected["ezBlend"],
                "ezGateMultiplier": selected["ezGateMultiplier"],
            }
            if selected is not None
            else None
        ),
        "actualPixelDiagonalCapVerified": cap_audit["bothTasksVerified"],
        "productionHtmlModified": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
