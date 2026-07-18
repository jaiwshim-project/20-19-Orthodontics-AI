#!/usr/bin/env python3
"""Generate PHI-free Python reference outputs for residual_inference.js.

The legacy policy calls train_residual.predict_krr directly.  The optional
pixel-diagonal policy changes only the per-landmark clipping metric; all other
preprocessing and KRR operations still import the trainer's implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from train_residual import (
    EPS,
    baseline_components,
    dimensions,
    feature_vector,
    nested,
    point_list,
    predict_krr,
    read_json,
    records_from_baseline,
    squared_distances,
    width_list,
)


POLICY_LEGACY = "legacy-axis-normalized"
POLICY_PIXEL = "pixel-diagonal"
POLICY_DEPLOYMENT = "deployment-policy"


def numpy_task_model(task: Mapping[str, Any]) -> dict[str, Any]:
    """Convert the JSON arrays expected by predict_krr back to float64 arrays."""
    return {
        "featureMean": np.asarray(task["featureMean"], dtype=np.float64),
        "featureScale": np.asarray(task["featureScale"], dtype=np.float64),
        "prototypes": np.asarray(task["prototypes"], dtype=np.float64),
        "alpha": np.asarray(task["alpha"], dtype=np.float64),
        "gamma": float(task["hyperparameters"]["gamma"]),
        "gateDistance": float(task["distanceGate"]["threshold"]),
    }


def clip_pixel_diagonal(corrections: np.ndarray, maximum_fraction: float, aspect: float) -> np.ndarray:
    """Cap normalized (dx,dy) by its actual pixel-space diagonal fraction."""
    shaped = corrections.reshape(corrections.shape[0], -1, 2).copy()
    magnitudes = np.sqrt((shaped[:, :, 0] * aspect) ** 2 + shaped[:, :, 1] ** 2)
    maximum = maximum_fraction * math.sqrt(aspect * aspect + 1.0)
    factors = np.minimum(1.0, maximum / np.maximum(magnitudes, EPS))
    shaped *= factors[:, :, None]
    return shaped.reshape(corrections.shape)


def predict_krr_pixel_diagonal(
    model: Mapping[str, Any],
    x: np.ndarray,
    baseline: np.ndarray,
    maximum_fraction: float,
    aspect: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Reference variant of predict_krr with only the cap metric corrected."""
    z = (x - model["featureMean"]) / model["featureScale"]
    distances = squared_distances(z, model["prototypes"])
    nearest = np.sqrt(np.min(distances, axis=1))
    accepted = nearest <= float(model["gateDistance"])
    correction = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
    correction = clip_pixel_diagonal(correction, maximum_fraction, aspect)
    correction[~accepted] = 0.0
    prediction = np.clip(baseline + correction, 0.0, 1.0)
    return prediction, accepted, nearest


def predict_krr_deployment_policy(
    model: Mapping[str, Any],
    x: np.ndarray,
    baseline: np.ndarray,
    maximum_fraction: float,
    aspect: float,
    blend: float,
    distance_gate_multiplier: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Reference Round-2 order: raw KRR → actual cap → blend → clamp."""
    z = (x - model["featureMean"]) / model["featureScale"]
    distances = squared_distances(z, model["prototypes"])
    nearest = np.sqrt(np.min(distances, axis=1))
    accepted = nearest <= float(model["gateDistance"]) * distance_gate_multiplier
    correction = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
    correction = clip_pixel_diagonal(correction, maximum_fraction, aspect)
    correction *= blend
    correction[~accepted] = 0.0
    prediction = np.clip(baseline + correction, 0.0, 1.0)
    return prediction, accepted, nearest


def as_points(values: np.ndarray) -> list[list[float]]:
    return np.asarray(values, dtype=np.float64).reshape(-1, 2).tolist()


def as_pixels(values: np.ndarray, dims: tuple[float, float]) -> list[list[float]]:
    result = np.asarray(values, dtype=np.float64).reshape(-1, 2).copy()
    result[:, 0] *= dims[0]
    result[:, 1] *= dims[1]
    return result.tolist()


def prediction_result(
    task_model: Mapping[str, Any],
    features: np.ndarray,
    baseline: np.ndarray,
    dims: tuple[float, float],
    maximum_fraction: float,
    policy: str,
) -> dict[str, Any]:
    if policy == POLICY_LEGACY:
        prediction, accepted, nearest = predict_krr(
            task_model, features[None, :], baseline[None, :], maximum_fraction
        )
    elif policy == POLICY_PIXEL:
        prediction, accepted, nearest = predict_krr_pixel_diagonal(
            task_model,
            features[None, :],
            baseline[None, :],
            maximum_fraction,
            dims[0] / dims[1],
        )
    else:
        raise ValueError(f"unknown fixture policy: {policy}")
    return {
        "accepted": bool(accepted[0]),
        "nearestDistance": float(nearest[0]),
        "normalizedPoints": as_points(prediction[0]),
        "pixelPoints": as_pixels(prediction[0], dims),
    }


def deployment_prediction_result(
    task_model: Mapping[str, Any],
    features: np.ndarray,
    baseline: np.ndarray,
    dims: tuple[float, float],
    maximum_fraction: float,
    task_policy: Mapping[str, Any],
) -> dict[str, Any]:
    blend = float(task_policy["blend"])
    multiplier = float(task_policy["distanceGateMultiplier"])
    prediction, accepted, nearest = predict_krr_deployment_policy(
        task_model,
        features[None, :],
        baseline[None, :],
        maximum_fraction,
        dims[0] / dims[1],
        blend,
        multiplier,
    )
    return {
        "accepted": bool(accepted[0]),
        "nearestDistance": float(nearest[0]),
        "blend": blend,
        "distanceGateMultiplier": multiplier,
        "effectiveDistanceGateThreshold": float(task_model["gateDistance"]) * multiplier,
        "normalizedPoints": as_points(prediction[0]),
        "pixelPoints": as_pixels(prediction[0], dims),
    }


def safe_input(record: Mapping[str, Any]) -> dict[str, Any]:
    """Retain only numeric dimensions and baseline landmarks, never IDs/paths."""
    prediction = nested(record, ("prediction", "baseline", "result", "autoDraft", "analysis", "outputs"))
    dims = dimensions(record) or dimensions(prediction)
    if dims is None:
        raise ValueError("missing dimensions")
    width_value = next(
        (prediction.get(key) for key in ("toothWidths", "toothWidthsPx", "tooth_widths", "widths") if key in prediction),
        None,
    )
    ez_value = next(
        (prediction.get(key) for key in ("ezPoints", "ezPointsPx", "ez_points") if key in prediction),
        None,
    )
    center_value = next(
        (prediction.get(key) for key in ("toothCenters", "toothCentersPx", "tooth_centers") if key in prediction),
        None,
    )
    widths = width_list(width_value, Counter(), "fixture")
    ez = point_list(ez_value)
    centers = point_list(center_value)
    return {
        "imageWidth": float(dims[0]),
        "imageHeight": float(dims[1]),
        "toothWidths": [
            {"p1": {"x": p1[0], "y": p1[1]}, "p2": {"x": p2[0], "y": p2[1]}}
            for p1, p2 in widths
        ],
        "ezPoints": [{"x": item[0], "y": item[1]} for item in ez],
        "toothCenters": [{"x": item[0], "y": item[1]} for item in centers],
    }


def synthetic_gate_outlier() -> dict[str, Any]:
    """Create a deterministic non-clinical geometry far outside model support."""
    width, height = 1000.0, 600.0
    tooth_widths = []
    ez_points = []
    centers = []
    for index in range(12):
        center_x = (-2.0 + index * 0.5) * width
        center_y = (-1.5 if index % 2 == 0 else 2.5) * height
        centers.append({"x": center_x, "y": center_y})
        tooth_widths.append({
            "p1": {"x": center_x - 0.30 * width, "y": center_y - 0.20 * height},
            "p2": {"x": center_x + 0.30 * width, "y": center_y + 0.20 * height},
        })
        ez_points.append({
            "x": center_x,
            "y": center_y + (1.25 if index % 3 == 0 else -1.25) * height,
        })
    return {
        "imageWidth": width,
        "imageHeight": height,
        "toothWidths": tooth_widths,
        "ezPoints": ez_points,
        "toothCenters": centers,
    }


def build_fixture(
    model_path: Path,
    baseline_path: Path,
    policy_path: Path,
    nested_metrics_path: Path,
    case_count: int,
) -> dict[str, Any]:
    if case_count < 10:
        raise ValueError("parity fixture requires at least 10 cases")
    model_document = read_json(model_path)
    policy_document = read_json(policy_path)
    if policy_document.get("schemaVersion") != "ez-tzl-residual-deployment-policy/v1":
        raise ValueError("deployment policy schema is unsupported")
    if policy_document.get("modelSchemaVersion") != model_document.get("schemaVersion"):
        raise ValueError("deployment policy model schema mismatch")
    if policy_document.get("modelTrainingDataDigestSha256") != model_document.get("trainingDataDigestSha256"):
        raise ValueError("deployment policy training-data digest mismatch")
    model_file_sha256 = hashlib.sha256(model_path.read_bytes()).hexdigest()
    if policy_document.get("modelFileSha256") != model_file_sha256:
        raise ValueError("deployment policy model file SHA-256 mismatch")
    if not policy_document.get("validation", {}).get("gates", {}).get("pass"):
        raise ValueError("deployment policy validation gate is not passing")
    if policy_document.get("status") != "candidate_rejected_nested_validation":
        raise ValueError("parity fixture expects the final rejected research policy")
    nested_validation = policy_document.get("nestedValidation", {})
    if (
        nested_validation.get("schemaVersion")
        != "ez-tzl-nested-deployment-policy-metrics/v1"
        or nested_validation.get("pass") is not False
        or nested_validation.get("decision") != "do_not_promote_research_only"
    ):
        raise ValueError("deployment policy nested rejection metadata is inconsistent")
    nested_metrics_sha256 = hashlib.sha256(nested_metrics_path.read_bytes()).hexdigest()
    if nested_validation.get("metricsFileSha256") != nested_metrics_sha256:
        raise ValueError("deployment policy nested metrics file SHA-256 mismatch")
    records = records_from_baseline(read_json(baseline_path))
    task_models = {name: numpy_task_model(model_document["tasks"][name]) for name in ("width", "ez")}
    candidates: list[
        tuple[Mapping[str, Any], tuple[np.ndarray, np.ndarray, np.ndarray], tuple[float, float], np.ndarray, list[float]]
    ] = []
    for record in records:
        try:
            components = baseline_components(record, Counter())
            dims = dimensions(record) or dimensions(nested(record, ("prediction", "baseline", "result", "autoDraft", "analysis", "outputs")))
        except (TypeError, ValueError):
            continue
        if components is not None and dims is not None:
            width_points, ez_points, centers = components
            features = feature_vector(width_points, ez_points, centers, dims[0] / dims[1])
            # A training row is mathematically distance zero from its own
            # prototype. NumPy/BLAS may expose cancellation as sqrt(~1e-14),
            # while scalar JS can produce exact zero. Independent rows avoid
            # testing that implementation artifact and exercise real inference.
            nearest = [
                float(np.sqrt(np.min(squared_distances(
                    ((features - task_models[task]["featureMean"]) / task_models[task]["featureScale"])[None, :],
                    task_models[task]["prototypes"],
                ))))
                for task in ("width", "ez")
            ]
            if min(nearest) > 1e-4:
                candidates.append((record, components, dims, features, nearest))
    if len(candidates) < case_count:
        raise ValueError(f"only {len(candidates)} usable baselines; requested {case_count}")

    # Include the nearest independent rows immediately below and above each
    # tightened task threshold, then fill remaining slots evenly. This makes
    # the fixture exercise both sides of the deployment gate boundary.
    effective_thresholds = {
        task: float(task_models[task]["gateDistance"])
        * float(policy_document["tasks"][task]["distanceGateMultiplier"])
        for task in ("width", "ez")
    }
    selected_indices: list[int] = []
    boundary_roles: dict[int, list[str]] = {}
    for task_index, task in enumerate(("width", "ez")):
        threshold = effective_thresholds[task]
        below = [
            (threshold - candidate[4][task_index], index)
            for index, candidate in enumerate(candidates)
            if candidate[4][task_index] <= threshold
        ]
        above = [
            (candidate[4][task_index] - threshold, index)
            for index, candidate in enumerate(candidates)
            if candidate[4][task_index] > threshold
        ]
        if not below or not above:
            raise ValueError(f"no independent cases bracket the {task} deployment gate")
        for side, values in (("inside", below), ("outside", above)):
            _, index = min(values)
            if index not in selected_indices:
                selected_indices.append(index)
            boundary_roles.setdefault(index, []).append(f"{task}-{side}")
    remaining = [index for index in range(len(candidates)) if index not in selected_indices]
    needed = case_count - len(selected_indices)
    if needed < 0:
        raise ValueError("case count is smaller than required boundary coverage")
    if needed:
        positions = np.linspace(0, len(remaining) - 1, needed, dtype=int).tolist()
        selected_indices.extend(remaining[position] for position in positions)
    maximum_fraction = float(model_document["correctionPolicy"]["maximumPerLandmarkCorrectionDiagonalFraction"])
    cases = []
    for fixture_index, selected_index in enumerate(selected_indices, start=1):
        record, components, dims, features, selection_nearest = candidates[selected_index]
        if min(selection_nearest) <= 1e-4:
            raise AssertionError("self-prototype row entered the independent parity fixture")
        recomputed_nearest = [
            float(np.sqrt(np.min(squared_distances(
                ((features - task_models[task]["featureMean"]) / task_models[task]["featureScale"])[None, :],
                task_models[task]["prototypes"],
            ))))
            for task in ("width", "ez")
        ]
        if not np.allclose(selection_nearest, recomputed_nearest, rtol=0.0, atol=1e-12):
            raise AssertionError("stored fixture feature vector changed after candidate selection")
        width_points, ez_points, centers = components
        task_baselines = {"width": width_points.reshape(-1), "ez": ez_points.reshape(-1)}
        policies = {}
        for policy in (POLICY_LEGACY, POLICY_PIXEL):
            policies[policy] = {
                task: prediction_result(
                    task_models[task], features, task_baselines[task], dims, maximum_fraction, policy
                )
                for task in ("width", "ez")
            }
        policies[POLICY_DEPLOYMENT] = {
            task: deployment_prediction_result(
                task_models[task],
                features,
                task_baselines[task],
                dims,
                float(policy_document["capPolicy"]["maximumFraction"]),
                policy_document["tasks"][task],
            )
            for task in ("width", "ez")
        }
        cases.append({
            "fixtureId": f"fixture-{fixture_index:02d}",
            "input": safe_input(record),
            "expectedFeatureVector": features.tolist(),
            "selectionNearestDistances": {"width": selection_nearest[0], "ez": selection_nearest[1]},
            "deploymentGateBoundaryRoles": boundary_roles.get(selected_index, []),
            "expected": policies,
        })

    # Explicitly exercise the unfamiliar-input gate and exact baseline fallback
    # for both tasks under both clipping policies.
    outlier_input = synthetic_gate_outlier()
    outlier_components = baseline_components(outlier_input, Counter())
    outlier_dims = dimensions(outlier_input)
    if outlier_components is None or outlier_dims is None:
        raise AssertionError("synthetic gate outlier is invalid")
    outlier_width, outlier_ez, outlier_centers = outlier_components
    outlier_features = feature_vector(
        outlier_width, outlier_ez, outlier_centers, outlier_dims[0] / outlier_dims[1]
    )
    outlier_baselines = {"width": outlier_width.reshape(-1), "ez": outlier_ez.reshape(-1)}
    outlier_policies = {}
    for policy in (POLICY_LEGACY, POLICY_PIXEL):
        outlier_policies[policy] = {
            task: prediction_result(
                task_models[task],
                outlier_features,
                outlier_baselines[task],
                outlier_dims,
                maximum_fraction,
                policy,
            )
            for task in ("width", "ez")
        }
        if any(value["accepted"] for value in outlier_policies[policy].values()):
            raise AssertionError("synthetic outlier did not trigger baseline fallback")
    outlier_policies[POLICY_DEPLOYMENT] = {
        task: deployment_prediction_result(
            task_models[task],
            outlier_features,
            outlier_baselines[task],
            outlier_dims,
            float(policy_document["capPolicy"]["maximumFraction"]),
            policy_document["tasks"][task],
        )
        for task in ("width", "ez")
    }
    if any(value["accepted"] for value in outlier_policies[POLICY_DEPLOYMENT].values()):
        raise AssertionError("synthetic outlier did not trigger deployment-policy fallback")
    cases.append({
        "fixtureId": "fixture-gate-outlier",
        "syntheticOutlier": True,
        "input": outlier_input,
        "expectedFeatureVector": outlier_features.tolist(),
        "expected": outlier_policies,
    })

    return {
        "schemaVersion": "ez-tzl-residual-parity-fixture/v1",
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImagePixels": False,
            "content": "numeric baseline landmarks and Python reference predictions only",
        },
        "modelVersion": model_document.get("schemaVersion"),
        "trainingDataDigestSha256": model_document.get("trainingDataDigestSha256"),
        "modelFileSha256": model_file_sha256,
        "deploymentPolicySchemaVersion": policy_document.get("schemaVersion"),
        "deploymentPolicyStatus": policy_document.get("status"),
        "nestedValidation": nested_validation,
        "independentClinicalGeometryCaseCount": case_count,
        "syntheticGateOutlierCount": 1,
        "caseCount": len(cases),
        "taskEvaluationsPerPolicy": len(cases) * 2,
        "policies": {
            POLICY_LEGACY: "exact train_residual.predict_krr behaviour: norm(dx,dy) <= fraction*sqrt(2)",
            POLICY_PIXEL: "actual pixel-diagonal behaviour: norm(dx*aspect,dy) <= fraction*sqrt(aspect^2+1)",
            POLICY_DEPLOYMENT: "Round-2 actual pixel cap, then task blend, with tightened task distance gate",
        },
        "cases": cases,
    }


def main() -> None:
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=root / "residual-model.json")
    parser.add_argument("--baseline", type=Path, default=root / "baseline_predictions_all.json")
    parser.add_argument("--policy", type=Path, default=root / "residual-deployment-policy.json")
    parser.add_argument("--nested-metrics", type=Path, default=root / "nested-policy-metrics.json")
    parser.add_argument("--output", type=Path, default=root / "residual-parity-fixture.json")
    parser.add_argument("--cases", type=int, default=12)
    args = parser.parse_args()
    fixture = build_fixture(
        args.model,
        args.baseline,
        args.policy,
        args.nested_metrics,
        args.cases,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "cases": fixture["caseCount"],
        "taskEvaluationsPerPolicy": fixture["taskEvaluationsPerPolicy"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
