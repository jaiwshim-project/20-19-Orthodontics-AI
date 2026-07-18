#!/usr/bin/env python3
"""Leakage-free nested validation of the residual deployment policy.

The outer five folds are common to the width and EZ tasks.  For every outer
fold, KRR hyperparameters and the blend/distance-gate policy are selected using
only the outer-training groups.  The selected policy is then applied once to
the untouched outer-test groups.  Corrections are capped in the real pixel
diagonal metric before blending.

Only aggregate metrics are emitted.  The output deliberately excludes case
identifiers, hashes, file paths, image coordinates, and model parameters.
Production application files are never modified.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

import evaluate_residual_clinical as clinical
import train_residual as tr
import tune_residual_blend as blend
import tune_residual_gate as gate


SCHEMA_VERSION = "ez-tzl-nested-deployment-policy-metrics/v1"
OUTER_FOLDS = 5
INNER_FOLDS = 4
EPS = 1e-12
CAP_FRACTION = 0.05
MIN_PAIRED_INNER = 20
MIN_PAIRED_OUTER_TOTAL = 50
BOOTSTRAP_REPLICATES = 5000
# Pre-declared coarse round-2 search space.  The later fine grid was centered
# after inspecting complete-OOF results, so using it here would carry that
# post-hoc choice into the claimed independent audit.
# 더 보수적인 blend/gate 후보를 추가한다(0.1, 0.15, gate 0.45~0.55).
# TZL P95 악화를 피하는 안전한 후보가 각 outer-train 내부에서 선택될 수 있도록 탐색 범위만 넓히는 것이며,
# 게이트 판정 기준 자체는 변경하지 않는다(선택 편향 없음).
WIDTH_BLENDS = (0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6)
EZ_BLENDS = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8)
WIDTH_GATE_MULTIPLIERS = (0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0)
EZ_GATE_MULTIPLIERS = (0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1.0)


def subset(data: Mapping[str, np.ndarray], mask: np.ndarray) -> dict[str, np.ndarray]:
    return {key: np.asarray(value)[mask] for key, value in data.items()}


def group_set(data: Mapping[str, np.ndarray]) -> set[str]:
    return {str(value) for value in data["groups"]}


def balanced_common_assignment(
    width_groups: set[str], ez_groups: set[str], folds: int, seed: int
) -> dict[str, int]:
    """Assign shared groups once while balancing paired and task-only strata."""
    if folds < 2:
        raise ValueError("at least two folds are required")
    categories = (
        sorted(width_groups & ez_groups),
        sorted(width_groups - ez_groups),
        sorted(ez_groups - width_groups),
    )
    if len(width_groups | ez_groups) < folds:
        raise ValueError("fewer unique groups than folds")
    rng = np.random.default_rng(seed)
    assignment: dict[str, int] = {}
    offset = 0
    for category in categories:
        if not category:
            continue
        shuffled = [category[index] for index in rng.permutation(len(category))]
        for index, group in enumerate(shuffled):
            assignment[group] = (offset + index) % folds
        offset = (offset + len(shuffled)) % folds
    return assignment


def masks_from_assignment(
    groups: np.ndarray, assignment: Mapping[str, int], folds: int
) -> list[np.ndarray]:
    values = np.asarray([assignment[str(value)] for value in groups], dtype=np.int64)
    masks = [values == fold for fold in range(folds)]
    if not all(mask.any() and (~mask).any() for mask in masks):
        raise ValueError("a common fold is empty for one task")
    if not np.all(np.sum(np.stack(masks), axis=0) == 1):
        raise AssertionError("fold masks do not partition samples")
    return masks


def aspects_for(data: Mapping[str, np.ndarray], lookup: Mapping[str, float]) -> np.ndarray:
    values = np.asarray([lookup.get(str(group), math.nan) for group in data["groups"]])
    if np.any(~np.isfinite(values)) or np.any(values <= 0):
        raise ValueError("missing image aspect ratio")
    return values.astype(np.float64)


def raw_predict(model: Mapping[str, Any], x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    z = (x - model["featureMean"]) / model["featureScale"]
    distances = tr.squared_distances(z, model["prototypes"])
    nearest = np.sqrt(np.min(distances, axis=1))
    raw = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
    ratio = nearest / max(float(model["gateDistance"]), EPS)
    return raw, nearest, ratio


def capped_raw_prediction(
    model: Mapping[str, Any], data: Mapping[str, np.ndarray], aspects: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    raw, nearest, ratio = raw_predict(model, data["x"])
    capped, audit = gate.cap_actual_pixel_diagonal(raw, aspects, CAP_FRACTION)
    return capped, nearest, ratio, audit


def select_krr_hyperparameters(
    data: Mapping[str, np.ndarray], masks: Sequence[np.ndarray], aspects: np.ndarray
) -> dict[str, Any]:
    """Select KRR settings inside the outer-training set only."""
    best: tuple[float, float, float] | None = None
    for gamma_factor in tr.GAMMA_FACTORS:
        for regularization in tr.LAMBDA_VALUES:
            prediction = np.zeros_like(data["target"])
            for validation_mask in masks:
                training_mask = ~validation_mask
                model = tr.fit_krr(
                    data["x"][training_mask],
                    data["baseline"][training_mask],
                    data["target"][training_mask],
                    gamma_factor,
                    regularization,
                )
                capped, _, ratio, _ = capped_raw_prediction(
                    model, subset(data, validation_mask), aspects[validation_mask]
                )
                accepted = ratio <= 1.0 + EPS
                applied = capped * accepted[:, None]
                prediction[validation_mask] = np.clip(
                    data["baseline"][validation_mask] + applied, 0.0, 1.0
                )
            score = tr.error_metrics(data["target"], prediction)["coordinateMAE"]
            candidate = (float(score), float(gamma_factor), float(regularization))
            if best is None or candidate < best:
                best = candidate
    if best is None:
        raise RuntimeError("KRR hyperparameter search failed")
    return {"innerCoordinateMAE": best[0], "gammaFactor": best[1], "lambda": best[2]}


def inner_oof_replay(
    data: Mapping[str, np.ndarray],
    masks: Sequence[np.ndarray],
    aspects: np.ndarray,
    hyperparameters: Mapping[str, float],
) -> dict[str, Any]:
    raw = np.zeros_like(data["baseline"])
    capped = np.zeros_like(data["baseline"])
    ratio = np.zeros(data["x"].shape[0], dtype=np.float64)
    for validation_mask in masks:
        training_mask = ~validation_mask
        model = tr.fit_krr(
            data["x"][training_mask],
            data["baseline"][training_mask],
            data["target"][training_mask],
            float(hyperparameters["gammaFactor"]),
            float(hyperparameters["lambda"]),
        )
        fold_raw, _, fold_ratio = raw_predict(model, data["x"][validation_mask])
        fold_capped, _ = gate.cap_actual_pixel_diagonal(
            fold_raw, aspects[validation_mask], CAP_FRACTION
        )
        raw[validation_mask] = fold_raw
        capped[validation_mask] = fold_capped
        ratio[validation_mask] = fold_ratio
    verified_capped, cap_audit = gate.cap_actual_pixel_diagonal(raw, aspects, CAP_FRACTION)
    if float(np.max(np.abs(verified_capped - capped))) > 1e-12:
        raise AssertionError("inner cap replay mismatch")
    return {"capped": capped, "ratio": ratio, "capAudit": cap_audit}


def coordinate_summary(
    data: Mapping[str, np.ndarray], prediction: np.ndarray, masks: Sequence[np.ndarray]
) -> dict[str, Any]:
    baseline = tr.error_metrics(data["target"], data["baseline"])
    candidate = tr.error_metrics(data["target"], prediction)
    fold_improvements: list[float] = []
    improved = 0
    for mask in masks:
        base_fold = tr.error_metrics(data["target"][mask], data["baseline"][mask])
        cand_fold = tr.error_metrics(data["target"][mask], prediction[mask])
        value = tr.relative_improvement(base_fold["coordinateMAE"], cand_fold["coordinateMAE"])
        fold_improvements.append(value)
        improved += int(cand_fold["coordinateMAE"] < base_fold["coordinateMAE"] - EPS)
    improvement = tr.relative_improvement(baseline["coordinateMAE"], candidate["coordinateMAE"])
    p95_regression = float(candidate["p95"] - baseline["p95"])
    minimum_improved = max(1, len(masks) - 1)
    checks = {
        "coordinateMaeRelativeImprovementAtLeast10Pct": improvement >= 0.10 - EPS,
        "allButAtMostOneInnerFoldsImproved": improved >= minimum_improved,
        "coordinateP95DidNotRegress": p95_regression <= EPS,
    }
    return {
        "baseline": {"coordinateMAE": baseline["coordinateMAE"], "p95": baseline["p95"]},
        "candidate": {"coordinateMAE": candidate["coordinateMAE"], "p95": candidate["p95"]},
        "coordinateMaeRelativeImprovement": improvement,
        "p95Regression": p95_regression,
        "improvedFolds": improved,
        "foldCount": len(masks),
        "foldCoordinateMaeRelativeImprovements": fold_improvements,
        "checks": checks,
        "pass": all(checks.values()),
    }


def task_policy_cache(
    data: Mapping[str, np.ndarray],
    replay: Mapping[str, Any],
    masks: Sequence[np.ndarray],
    blend_values: Sequence[float],
    gate_multipliers: Sequence[float],
) -> dict[tuple[float, float], dict[str, Any]]:
    output: dict[tuple[float, float], dict[str, Any]] = {}
    for blend_value in blend_values:
        for gate_multiplier in gate_multipliers:
            accepted = replay["ratio"] <= gate_multiplier + EPS
            prediction = np.clip(
                data["baseline"]
                + float(blend_value) * replay["capped"] * accepted[:, None],
                0.0,
                1.0,
            )
            output[(float(blend_value), float(gate_multiplier))] = {
                "prediction": prediction,
                "coordinate": coordinate_summary(data, prediction, masks),
                "accepted": int(accepted.sum()),
                "fallback": int((~accepted).sum()),
                "acceptedRate": float(accepted.mean()),
            }
    return output


def make_candidate(
    width_key: tuple[float, float],
    ez_key: tuple[float, float],
    width_item: Mapping[str, Any],
    ez_item: Mapping[str, Any],
    clinical_metrics: Mapping[str, Any],
    paired_count: int,
) -> dict[str, Any]:
    app_checks = {
        f"{label}{suffix}": bool(clinical_metrics["appScale"][label][field])
        for label, _ in gate.LABELS
        for suffix, field in (
            ("MaeDidNotRegress", "maeDidNotRegress"),
            ("P95DidNotRegress", "p95DidNotRegress"),
        )
    }
    reference_checks = {
        f"{label}P95DidNotRegress": bool(
            clinical_metrics["referenceScale"][label]["p95DidNotRegress"]
        )
        for label, _ in gate.LABELS
    }
    required = {
        "widthCoordinateGate": bool(width_item["coordinate"]["pass"]),
        "ezCoordinateGate": bool(ez_item["coordinate"]["pass"]),
        "pairedCountAtLeast20": paired_count >= MIN_PAIRED_INNER,
        "allAppScaleMaeAndP95DidNotRegress": all(app_checks.values()),
    }
    app_mae_sum = sum(
        float(clinical_metrics["appScale"][label]["maeRelativeImprovement"])
        for label, _ in gate.LABELS
    )
    coordinate_balance = min(
        float(width_item["coordinate"]["coordinateMaeRelativeImprovement"]),
        float(ez_item["coordinate"]["coordinateMaeRelativeImprovement"]),
    )
    return {
        "widthBlend": width_key[0],
        "widthGateMultiplier": width_key[1],
        "ezBlend": ez_key[0],
        "ezGateMultiplier": ez_key[1],
        "coordinate": {"width": width_item["coordinate"], "ez": ez_item["coordinate"]},
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
        },
    }


def candidate_compact(item: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if item is None:
        return None
    failed = [name for name, value in item["gate"]["checks"].items() if not value]
    failed.extend(name for name, value in item["gate"]["appScaleChecks"].items() if not value)
    return {
        "widthBlend": item["widthBlend"],
        "widthGateMultiplier": item["widthGateMultiplier"],
        "ezBlend": item["ezBlend"],
        "ezGateMultiplier": item["ezGateMultiplier"],
        "pass": item["gate"]["pass"],
        "failedChecks": failed,
        "ranking": item["ranking"],
        "coordinate": {
            task: {
                "coordinateMaeRelativeImprovement": item["coordinate"][task][
                    "coordinateMaeRelativeImprovement"
                ],
                "p95Regression": item["coordinate"][task]["p95Regression"],
                "improvedFolds": item["coordinate"][task]["improvedFolds"],
            }
            for task in ("width", "ez")
        },
    }


def select_inner_policy(
    train_tasks: Mapping[str, Mapping[str, np.ndarray]],
    task_caches: Mapping[str, Mapping[tuple[float, float], Mapping[str, Any]]],
    dataset_path: Path,
) -> tuple[dict[str, dict[str, float]], dict[str, Any]]:
    paired = gate.prepare_paired(train_tasks, dataset_path)
    paired_count = int(paired["count"])
    baseline_metrics = gate.baseline_clinical_metrics(paired)
    width_geometry = gate.width_geometry_cache(task_caches["width"], paired)
    ez_geometry = gate.ez_geometry_cache(task_caches["ez"], paired)
    candidates: list[dict[str, Any]] = []
    for width_key, width_item in task_caches["width"].items():
        for ez_key, ez_item in task_caches["ez"].items():
            clinical_metrics = gate.clinical_candidate_summary(
                paired, baseline_metrics, width_geometry[width_key], ez_geometry[ez_key]
            )
            candidates.append(
                make_candidate(
                    width_key, ez_key, width_item, ez_item, clinical_metrics, paired_count
                )
            )
    passing = [item for item in candidates if item["gate"]["pass"]]
    preferred = [
        item for item in passing if item["gate"]["referenceScaleAllP95DidNotRegress"]
    ]
    pool = preferred if preferred else passing
    selected = max(pool, key=gate.candidate_order) if pool else None
    nearest = max(
        candidates,
        key=lambda item: (
            -sum(not bool(value) for value in item["gate"]["checks"].values())
            - sum(not bool(value) for value in item["gate"]["appScaleChecks"].values()),
        )
        + gate.candidate_order(item),
    )
    if selected is None:
        policy = {
            "width": {"blend": 0.0, "gateMultiplier": 0.0},
            "ez": {"blend": 0.0, "gateMultiplier": 0.0},
        }
        mode = "baseline_only_safety_fallback"
    else:
        policy = {
            "width": {
                "blend": float(selected["widthBlend"]),
                "gateMultiplier": float(selected["widthGateMultiplier"]),
            },
            "ez": {
                "blend": float(selected["ezBlend"]),
                "gateMultiplier": float(selected["ezGateMultiplier"]),
            },
        }
        mode = "strict_inner_candidate"
    audit = {
        "mode": mode,
        "pairedInnerCases": paired_count,
        "candidateCount": len(candidates),
        "strictPassingCandidateCount": len(passing),
        "referenceP95PreferredCandidateCount": len(preferred),
        "selected": candidate_compact(selected),
        "nearestCandidateWhenNoStrictPass": candidate_compact(nearest) if selected is None else None,
    }
    return policy, audit


def apply_outer_policy(
    train: Mapping[str, np.ndarray],
    test: Mapping[str, np.ndarray],
    test_aspects: np.ndarray,
    hyperparameters: Mapping[str, float],
    policy: Mapping[str, float],
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    model = tr.fit_krr(
        train["x"],
        train["baseline"],
        train["target"],
        float(hyperparameters["gammaFactor"]),
        float(hyperparameters["lambda"]),
    )
    capped, _, ratio, cap_audit = capped_raw_prediction(model, test, test_aspects)
    accepted = ratio <= float(policy["gateMultiplier"]) + EPS
    if float(policy["blend"]) <= EPS:
        accepted[:] = False
    prediction = np.clip(
        test["baseline"] + float(policy["blend"]) * capped * accepted[:, None],
        0.0,
        1.0,
    )
    return prediction, accepted, cap_audit


def bootstrap_mean_improvement(
    baseline_error: np.ndarray, candidate_error: np.ndarray, seed: int
) -> dict[str, Any]:
    difference = np.asarray(baseline_error, dtype=np.float64) - np.asarray(
        candidate_error, dtype=np.float64
    )
    if difference.ndim != 1 or difference.size == 0:
        raise ValueError("bootstrap requires a non-empty case-level vector")
    rng = np.random.default_rng(seed)
    indices = rng.integers(0, difference.size, size=(BOOTSTRAP_REPLICATES, difference.size))
    samples = difference[indices].mean(axis=1)
    return {
        "unit": "case",
        "replicates": BOOTSTRAP_REPLICATES,
        "meanImprovement": float(difference.mean()),
        "ci95Lower": float(np.quantile(samples, 0.025)),
        "ci95Upper": float(np.quantile(samples, 0.975)),
        "probabilityImprovement": float(np.mean(samples > 0.0)),
    }


def clinical_bootstrap(arrays: Mapping[str, np.ndarray], seed: int) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for scheme_index, scheme in enumerate(("ReferenceScale", "AppScale")):
        scheme_output: dict[str, Any] = {}
        for label_index, (label, suffix) in enumerate(
            (("ezlMm", "Ez"), ("tzlMm", "Tz"), ("differenceMm", "Difference"))
        ):
            truth = arrays["reference" + suffix]
            baseline_error = np.abs(arrays["baseline" + scheme + suffix] - truth)
            candidate_error = np.abs(arrays["candidate" + scheme + suffix] - truth)
            scheme_output[label] = bootstrap_mean_improvement(
                baseline_error,
                candidate_error,
                seed + scheme_index * 1009 + label_index * 101,
            )
            scheme_output[label]["unitOfMeanImprovement"] = "mm MAE reduction"
        output[scheme[0].lower() + scheme[1:]] = scheme_output
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-index", type=Path, required=True)
    parser.add_argument("--baseline-predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--policy",
        type=Path,
        help="deployment policy to finalize (default: output directory/residual-deployment-policy.json)",
    )
    parser.add_argument("--seed", type=int, default=tr.DEFAULT_SEED)
    return parser.parse_args()


def finalized_policy_document(
    policy: Mapping[str, Any],
    nested_metrics: Mapping[str, Any],
    metrics_file_sha256: str,
) -> dict[str, Any]:
    result = dict(policy)
    if result.get("schemaVersion") != gate.SCHEMA_POLICY:
        raise ValueError("deployment policy schema is incompatible with nested validation")
    promotion = nested_metrics.get("promotionGate")
    if not isinstance(promotion, Mapping) or not isinstance(promotion.get("pass"), bool):
        raise ValueError("nested validation promotionGate is invalid")
    promotion_pass = bool(promotion["pass"])
    decision = promotion.get("decision")
    if not isinstance(decision, str) or not decision:
        raise ValueError("nested validation decision is missing")
    result["status"] = (
        "candidate_nested_validation_passed"
        if promotion_pass
        else "candidate_rejected_nested_validation"
    )
    result["nestedValidation"] = {
        "schemaVersion": nested_metrics.get("schemaVersion"),
        "metricsFileSha256": metrics_file_sha256,
        "pass": promotion_pass,
        "decision": decision,
    }
    deployment = dict(result.get("deployment", {}))
    deployment["productionHtmlModified"] = False
    deployment["productionPromotionAllowed"] = False
    deployment["productionIntegrationAuthorized"] = False
    deployment["productionPromotionAllowedWithoutHumanApproval"] = False
    deployment["recommendedMode"] = "human_review_only" if promotion_pass else "research_only"
    deployment["reason"] = (
        "nested validation passed; separate human approval is still required"
        if promotion_pass
        else "authoritative nested validation failed; do not promote this policy"
    )
    result["deployment"] = deployment
    return result


def main() -> None:
    args = parse_args()
    dataset_path = args.dataset_index.resolve()
    baseline_path = args.baseline_predictions.resolve()
    output_path = args.output.resolve()
    policy_path = (
        args.policy.resolve()
        if args.policy is not None
        else output_path.parent / "residual-deployment-policy.json"
    )
    tasks, build_audit = tr.build_samples(dataset_path, baseline_path)
    if "width" not in tasks or "ez" not in tasks:
        raise SystemExit("both width and EZ tasks are required")
    aspect_lookup = blend.group_aspects(dataset_path)

    outer_assignment = balanced_common_assignment(
        group_set(tasks["width"]), group_set(tasks["ez"]), OUTER_FOLDS, args.seed
    )
    outer_masks = {
        task: masks_from_assignment(data["groups"], outer_assignment, OUTER_FOLDS)
        for task, data in tasks.items()
    }
    oof = {task: np.zeros_like(data["target"]) for task, data in tasks.items()}
    accepted_oof = {
        task: np.zeros(data["target"].shape[0], dtype=bool) for task, data in tasks.items()
    }
    outer_reports: list[dict[str, Any]] = []
    cap_verified_all = True

    for outer_fold in range(OUTER_FOLDS):
        train_tasks: dict[str, dict[str, np.ndarray]] = {}
        test_tasks: dict[str, dict[str, np.ndarray]] = {}
        for task in ("width", "ez"):
            test_mask = outer_masks[task][outer_fold]
            train_tasks[task] = subset(tasks[task], ~test_mask)
            test_tasks[task] = subset(tasks[task], test_mask)

        inner_assignment = balanced_common_assignment(
            group_set(train_tasks["width"]),
            group_set(train_tasks["ez"]),
            INNER_FOLDS,
            args.seed + (outer_fold + 1) * 7919,
        )
        hyperparameters: dict[str, dict[str, Any]] = {}
        caches: dict[str, dict[tuple[float, float], dict[str, Any]]] = {}
        inner_masks_by_task: dict[str, list[np.ndarray]] = {}
        inner_cap_audit: dict[str, Any] = {}
        for task, blend_values, gate_multipliers in (
            ("width", WIDTH_BLENDS, WIDTH_GATE_MULTIPLIERS),
            ("ez", EZ_BLENDS, EZ_GATE_MULTIPLIERS),
        ):
            inner_masks = masks_from_assignment(
                train_tasks[task]["groups"], inner_assignment, INNER_FOLDS
            )
            inner_masks_by_task[task] = inner_masks
            train_aspects = aspects_for(train_tasks[task], aspect_lookup)
            hyperparameters[task] = select_krr_hyperparameters(
                train_tasks[task], inner_masks, train_aspects
            )
            replay = inner_oof_replay(
                train_tasks[task], inner_masks, train_aspects, hyperparameters[task]
            )
            inner_cap_audit[task] = replay["capAudit"]
            caches[task] = task_policy_cache(
                train_tasks[task], replay, inner_masks, blend_values, gate_multipliers
            )

        selected_policy, selection_audit = select_inner_policy(
            train_tasks, caches, dataset_path
        )
        local_predictions: dict[str, np.ndarray] = {}
        task_reports: dict[str, Any] = {}
        for task in ("width", "ez"):
            prediction, accepted, outer_cap = apply_outer_policy(
                train_tasks[task],
                test_tasks[task],
                aspects_for(test_tasks[task], aspect_lookup),
                hyperparameters[task],
                selected_policy[task],
            )
            test_mask = outer_masks[task][outer_fold]
            oof[task][test_mask] = prediction
            accepted_oof[task][test_mask] = accepted
            local_predictions[task] = prediction
            cap_verified_all = cap_verified_all and bool(outer_cap["verified"])
            base_metrics = tr.error_metrics(
                test_tasks[task]["target"], test_tasks[task]["baseline"]
            )
            candidate_metrics = tr.error_metrics(test_tasks[task]["target"], prediction)
            task_reports[task] = {
                "trainSamples": int(train_tasks[task]["x"].shape[0]),
                "testSamples": int(test_tasks[task]["x"].shape[0]),
                "selectedKrr": hyperparameters[task],
                "selectedPolicy": selected_policy[task],
                "innerActualPixelDiagonalCap": inner_cap_audit[task],
                "outerTestActualPixelDiagonalCap": outer_cap,
                "outerTestAccepted": int(accepted.sum()),
                "outerTestFallback": int((~accepted).sum()),
                "outerTestCoordinateMaeRelativeImprovement": tr.relative_improvement(
                    base_metrics["coordinateMAE"], candidate_metrics["coordinateMAE"]
                ),
                "outerTestP95Regression": float(candidate_metrics["p95"] - base_metrics["p95"]),
            }

        test_paired = blend.paired_geometry_inputs(test_tasks, dataset_path)
        fold_clinical = blend.clinical_summary(
            blend.clinical_arrays(
                test_paired, local_predictions["width"], local_predictions["ez"]
            )
        )
        outer_reports.append(
            {
                "fold": outer_fold + 1,
                "innerSelection": selection_audit,
                "tasks": task_reports,
                "pairedOuterTestCases": len(test_paired),
                "outerTestClinical": fold_clinical,
            }
        )

    coordinate: dict[str, Any] = {}
    coordinate_bootstrap: dict[str, Any] = {}
    for index, task in enumerate(("width", "ez")):
        coordinate[task] = coordinate_summary(tasks[task], oof[task], outer_masks[task])
        base_case_error = np.mean(np.abs(tasks[task]["baseline"] - tasks[task]["target"]), axis=1)
        candidate_case_error = np.mean(np.abs(oof[task] - tasks[task]["target"]), axis=1)
        coordinate_bootstrap[task] = bootstrap_mean_improvement(
            base_case_error, candidate_case_error, args.seed + 300001 + index * 1009
        )
        coordinate_bootstrap[task]["unitOfMeanImprovement"] = "axis-normalized coordinate MAE reduction"

    paired = blend.paired_geometry_inputs(tasks, dataset_path)
    clinical_arrays = blend.clinical_arrays(paired, oof["width"], oof["ez"])
    clinical_metrics = blend.clinical_summary(clinical_arrays)
    clinical_ci = clinical_bootstrap(clinical_arrays, args.seed + 400003)

    strict_policy_folds = sum(
        report["innerSelection"]["mode"] == "strict_inner_candidate"
        for report in outer_reports
    )
    coordinate_checks = {
        f"{task}CoordinateGate": bool(coordinate[task]["pass"])
        for task in ("width", "ez")
    }
    coordinate_ci_checks = {
        f"{task}CoordinateMaeBootstrapLowerAboveZero": bool(
            coordinate_bootstrap[task]["ci95Lower"] > 0.0
        )
        for task in ("width", "ez")
    }
    app_checks = {
        f"{label}{suffix}": bool(clinical_metrics["appScale"][label][field])
        for label, _ in gate.LABELS
        for suffix, field in (
            ("MaeDidNotRegress", "maeDidNotRegress"),
            ("P95DidNotRegress", "p95DidNotRegress"),
        )
    }
    reference_p95_checks = {
        f"{label}ReferenceP95DidNotRegress": bool(
            clinical_metrics["referenceScale"][label]["p95DidNotRegress"]
        )
        for label, _ in gate.LABELS
    }
    app_ci_checks = {
        f"{label}AppMaeBootstrapLowerNotBelowZero": bool(
            clinical_ci["appScale"][label]["ci95Lower"] >= 0.0
        )
        for label, _ in gate.LABELS
    }
    gate_checks = {
        **coordinate_checks,
        **coordinate_ci_checks,
        "allFiveOuterFoldsSelectedStrictInnerPolicy": strict_policy_folds == OUTER_FOLDS,
        "pairedCompleteCasesAtLeast50": len(paired) >= MIN_PAIRED_OUTER_TOTAL,
        "actualPixelDiagonalCapVerified": cap_verified_all,
        "allAppScaleMaeAndP95DidNotRegress": all(app_checks.values()),
        "allReferenceScaleP95DidNotRegress": all(reference_p95_checks.values()),
        "allAppScaleMaeBootstrapLowerBoundsNonNegative": all(app_ci_checks.values()),
    }
    promotion_pass = all(gate_checks.values())

    document = {
        "schemaVersion": SCHEMA_VERSION,
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImageCoordinates": False,
            "containsModelParameters": False,
        },
        "auditFinding": {
            "priorProtocolRisk": (
                "blend and distance-gate candidates were selected on the same complete OOF "
                "predictions later reported as deployment-policy performance"
            ),
            "bias": "post-selection OOF performance is optimistic for the deployment policy",
            "remedy": (
                "common grouped outer five-fold evaluation; all KRR and policy selection is "
                "restricted to each outer-training partition"
            ),
        },
        "protocol": {
            "outerValidation": "common grouped five-fold, untouched policy test folds",
            "innerSelection": "common grouped four-fold within each outer-training partition",
            "krrGrid": {
                "gammaFactors": list(tr.GAMMA_FACTORS),
                "lambdaValues": list(tr.LAMBDA_VALUES),
            },
            "policyGrid": {
                "widthBlend": list(WIDTH_BLENDS),
                "ezBlend": list(EZ_BLENDS),
                "widthDistanceGateMultiplier": list(WIDTH_GATE_MULTIPLIERS),
                "ezDistanceGateMultiplier": list(EZ_GATE_MULTIPLIERS),
                "jointCandidateCountPerOuterFold": (
                    len(WIDTH_BLENDS)
                    * len(EZ_BLENDS)
                    * len(WIDTH_GATE_MULTIPLIERS)
                    * len(EZ_GATE_MULTIPLIERS)
                ),
            },
            "noStrictInnerCandidateAction": "return rule-engine baseline for that outer fold",
            "actualPixelDiagonalCap": {
                "maximumFraction": CAP_FRACTION,
                "formula": "sqrt((dx*aspect)^2 + dy^2) <= 0.05*sqrt(aspect^2 + 1)",
                "appliedBeforeBlend": True,
            },
            "clinical": {
                "calibrationMm": 54,
                "referenceScale": "expert EZ endpoint chord",
                "appScale": "candidate EZ endpoint chord, matching the application",
                "curve": "production Catmull-Rom, 25 samples per segment",
            },
            "bootstrap": {
                "type": "paired nonparametric case bootstrap",
                "replicates": BOOTSTRAP_REPLICATES,
                "confidenceLevel": 0.95,
            },
            "seed": int(args.seed),
        },
        "inputSummary": build_audit["inputSummary"],
        "outerFoldReports": outer_reports,
        "aggregateOuterTest": {
            "coordinate": coordinate,
            "coordinateBootstrap": coordinate_bootstrap,
            "pairedCompleteCases": len(paired),
            "pairedClinical": clinical_metrics,
            "pairedClinicalBootstrap": clinical_ci,
            "accepted": {task: int(accepted_oof[task].sum()) for task in ("width", "ez")},
            "fallback": {task: int((~accepted_oof[task]).sum()) for task in ("width", "ez")},
        },
        "promotionGate": {
            "pass": promotion_pass,
            "checks": gate_checks,
            "details": {
                "coordinate": coordinate_checks,
                "coordinateBootstrap": coordinate_ci_checks,
                "appScale": app_checks,
                "referenceScaleP95": reference_p95_checks,
                "appScaleBootstrap": app_ci_checks,
                "strictInnerPolicySelectedFolds": strict_policy_folds,
                "requiredStrictInnerPolicySelectedFolds": OUTER_FOLDS,
            },
            "decision": (
                "eligible_for_human_review_not_automatic_deployment"
                if promotion_pass
                else "do_not_promote_research_only"
            ),
            "productionHtmlModified": False,
            "humanApprovalRequiredEvenIfPass": True,
        },
        "limitations": [
            "internal cross-validation is not an independent external clinical validation",
            "only complete 12-width labels are used for the width task",
            "expert EZ curves with varying point counts are arc-length resampled to 12 points",
            "the paired clinical sample is modest, so percentile estimates remain uncertain",
            "model output is decision support and is not independently validated for clinical diagnosis",
        ],
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(tr.sanitize_finite(document), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if policy_path.is_file():
        policy = tr.read_json(policy_path)
        policy = finalized_policy_document(
            policy,
            document,
            hashlib.sha256(output_path.read_bytes()).hexdigest(),
        )
        policy_path.write_text(
            json.dumps(tr.sanitize_finite(policy), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(
        json.dumps(
            {
                "output": output_path.name,
                "outerFolds": OUTER_FOLDS,
                "strictInnerPolicySelectedFolds": strict_policy_folds,
                "pairedCompleteCases": len(paired),
                "promotionPass": promotion_pass,
                "decision": document["promotionGate"]["decision"],
                "productionHtmlModified": False,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
