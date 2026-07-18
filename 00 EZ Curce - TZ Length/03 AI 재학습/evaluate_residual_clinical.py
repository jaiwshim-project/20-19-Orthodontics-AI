#!/usr/bin/env python3
"""Evaluate out-of-fold residual predictions in clinical length units.

This script replays the exact nested grouped folds from train_residual.py and
combines the width and EZ tasks only after both predictions have excluded the
test image group.  It emits aggregate metrics only; case identifiers and image
coordinates are deliberately excluded.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping

import numpy as np

import train_residual as tr


def catmull_rom(p0: np.ndarray, p1: np.ndarray, p2: np.ndarray, p3: np.ndarray, t: float) -> np.ndarray:
    t2, t3 = t * t, t * t * t
    return 0.5 * (
        2.0 * p1
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    )


def generated_curve(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    if points.shape[0] < 2:
        return points.copy()
    if points.shape[0] == 2:
        return points.copy()
    output: list[np.ndarray] = []
    for index in range(points.shape[0] - 1):
        p0 = points[max(0, index - 1)]
        p1 = points[index]
        p2 = points[index + 1]
        p3 = points[min(points.shape[0] - 1, index + 2)]
        for step in range(25):
            output.append(catmull_rom(p0, p1, p2, p3, step / 25.0))
    output.append(points[-1])
    return np.asarray(output, dtype=np.float64)


def polyline_length(points: np.ndarray) -> float:
    points = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    if points.shape[0] < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())


def to_shape_space(flat: np.ndarray, aspect: float) -> np.ndarray:
    """Convert axis-normalized coordinates to pixels up to an arbitrary h=1 scale."""
    points = np.asarray(flat, dtype=np.float64).reshape(-1, 2).copy()
    points[:, 0] *= aspect
    return points


def replay_oof(data: Mapping[str, np.ndarray], seed: int, maximum_correction: float) -> tuple[np.ndarray, np.ndarray]:
    x = data["x"]
    baseline = data["baseline"]
    target = data["target"]
    groups = data["groups"]
    corrected = np.zeros_like(target)
    accepted = np.zeros(x.shape[0], dtype=bool)
    for fold_index, test_mask in enumerate(tr.grouped_folds(groups, 5, seed), start=1):
        train_mask = ~test_mask
        _, gamma_factor, regularization = tr.select_hyperparameters(
            x[train_mask], baseline[train_mask], target[train_mask], groups[train_mask],
            seed + fold_index * 1009, maximum_correction, 4,
        )
        model = tr.fit_krr(
            x[train_mask], baseline[train_mask], target[train_mask], gamma_factor, regularization
        )
        prediction, fold_accepted, _ = tr.predict_krr(
            model, x[test_mask], baseline[test_mask], maximum_correction
        )
        corrected[test_mask] = prediction
        accepted[test_mask] = fold_accepted
    return corrected, accepted


def percentile(values: np.ndarray, quantile: float) -> float:
    return float(np.quantile(values, quantile)) if values.size else 0.0


def error_summary(reference: np.ndarray, prediction: np.ndarray) -> dict[str, float | int]:
    signed = np.asarray(prediction, dtype=np.float64) - np.asarray(reference, dtype=np.float64)
    absolute = np.abs(signed)
    return {
        "count": int(signed.size),
        "maeMm": float(absolute.mean()),
        "rmseMm": float(np.sqrt(np.mean(signed * signed))),
        "medianAbsoluteErrorMm": percentile(absolute, 0.5),
        "p90AbsoluteErrorMm": percentile(absolute, 0.9),
        "p95AbsoluteErrorMm": percentile(absolute, 0.95),
        "maximumAbsoluteErrorMm": float(absolute.max()),
        "signedBiasMm": float(signed.mean()),
    }


def relative_improvement(baseline: Mapping[str, Any], corrected: Mapping[str, Any]) -> float:
    value = float(baseline["maeMm"])
    return float((value - float(corrected["maeMm"])) / value) if value > 1e-12 else 0.0


def group_aspects(dataset_path: Path) -> dict[str, float]:
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset-index", type=Path, required=True)
    parser.add_argument("--baseline-predictions", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=tr.DEFAULT_SEED)
    parser.add_argument("--maximum-correction", type=float, default=0.05)
    args = parser.parse_args()

    tasks, audit = tr.build_samples(args.dataset_index.resolve(), args.baseline_predictions.resolve())
    if "width" not in tasks or "ez" not in tasks:
        raise SystemExit("both width and EZ tasks are required")

    width_corrected, width_accepted = replay_oof(tasks["width"], args.seed, args.maximum_correction)
    ez_seed = args.seed + 100003
    ez_corrected, ez_accepted = replay_oof(tasks["ez"], ez_seed, args.maximum_correction)
    aspects = group_aspects(args.dataset_index.resolve())

    width_index = {str(group): index for index, group in enumerate(tasks["width"]["groups"])}
    ez_index = {str(group): index for index, group in enumerate(tasks["ez"]["groups"])}
    paired_groups = sorted(set(width_index).intersection(ez_index))

    values: dict[str, list[float]] = {
        "referenceEz": [], "referenceTz": [], "referenceDifference": [],
        "baselineReferenceScaleEz": [], "baselineReferenceScaleTz": [], "baselineReferenceScaleDifference": [],
        "correctedReferenceScaleEz": [], "correctedReferenceScaleTz": [], "correctedReferenceScaleDifference": [],
        "baselineAppScaleEz": [], "baselineAppScaleTz": [], "baselineAppScaleDifference": [],
        "correctedAppScaleEz": [], "correctedAppScaleTz": [], "correctedAppScaleDifference": [],
    }
    accepted_both = 0

    for group in paired_groups:
        aspect = aspects.get(group)
        if aspect is None or not math.isfinite(aspect) or aspect <= 0:
            continue
        wi, ei = width_index[group], ez_index[group]
        width_truth = to_shape_space(tasks["width"]["target"][wi], aspect)
        width_base = to_shape_space(tasks["width"]["baseline"][wi], aspect)
        width_corr = to_shape_space(width_corrected[wi], aspect)
        ez_truth = to_shape_space(tasks["ez"]["target"][ei], aspect)
        ez_base = to_shape_space(tasks["ez"]["baseline"][ei], aspect)
        ez_corr = to_shape_space(ez_corrected[ei], aspect)

        truth_chord = float(np.linalg.norm(ez_truth[-1] - ez_truth[0]))
        base_chord = float(np.linalg.norm(ez_base[-1] - ez_base[0]))
        corr_chord = float(np.linalg.norm(ez_corr[-1] - ez_corr[0]))
        if min(truth_chord, base_chord, corr_chord) <= 1e-12:
            continue
        truth_scale = truth_chord / 54.0
        base_scale = base_chord / 54.0
        corr_scale = corr_chord / 54.0
        truth_ez = polyline_length(generated_curve(ez_truth)) / truth_scale
        truth_tz = sum(
            float(np.linalg.norm(width_truth[index * 2 + 1] - width_truth[index * 2]))
            for index in range(12)
        ) / truth_scale
        truth_difference = truth_ez - truth_tz

        def geometry(widths: np.ndarray, ez: np.ndarray, scale: float) -> tuple[float, float, float]:
            ezl = polyline_length(generated_curve(ez)) / scale
            tzl = sum(
                float(np.linalg.norm(widths[index * 2 + 1] - widths[index * 2]))
                for index in range(12)
            ) / scale
            return ezl, tzl, ezl - tzl

        base_ref = geometry(width_base, ez_base, truth_scale)
        corr_ref = geometry(width_corr, ez_corr, truth_scale)
        base_app = geometry(width_base, ez_base, base_scale)
        corr_app = geometry(width_corr, ez_corr, corr_scale)
        values["referenceEz"].append(truth_ez)
        values["referenceTz"].append(truth_tz)
        values["referenceDifference"].append(truth_difference)
        for prefix, geometry_values in (
            ("baselineReferenceScale", base_ref), ("correctedReferenceScale", corr_ref),
            ("baselineAppScale", base_app), ("correctedAppScale", corr_app),
        ):
            values[prefix + "Ez"].append(geometry_values[0])
            values[prefix + "Tz"].append(geometry_values[1])
            values[prefix + "Difference"].append(geometry_values[2])
        accepted_both += int(bool(width_accepted[wi] and ez_accepted[ei]))

    arrays = {key: np.asarray(value, dtype=np.float64) for key, value in values.items()}
    reference = {
        "ezlMm": arrays["referenceEz"],
        "tzlMm": arrays["referenceTz"],
        "differenceMm": arrays["referenceDifference"],
    }

    def scheme(name: str) -> dict[str, Any]:
        output: dict[str, Any] = {}
        for label, suffix in (("ezlMm", "Ez"), ("tzlMm", "Tz"), ("differenceMm", "Difference")):
            baseline = error_summary(reference[label], arrays["baseline" + name + suffix])
            corrected = error_summary(reference[label], arrays["corrected" + name + suffix])
            output[label] = {
                "baseline": baseline,
                "corrected": corrected,
                "maeRelativeImprovement": relative_improvement(baseline, corrected),
            }
        return output

    document = {
        "schemaVersion": "ez-tzl-residual-clinical-metrics/v1",
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImageCoordinates": False,
        },
        "protocol": {
            "validation": "nested grouped five-fold out-of-fold predictions",
            "group": "exact image SHA-256",
            "expertEz": "arc-length-resampled 12-point consensus",
            "curve": "production Catmull-Rom with 25 samples per segment",
            "calibrationMm": 54,
            "referenceScale": "expert EZ endpoint chord is used for expert and prediction",
            "appScale": "each predicted EZ endpoint chord is treated as 54 mm, matching the app",
        },
        "inputSummary": audit["inputSummary"],
        "pairedCompleteCases": int(arrays["referenceEz"].size),
        "pairedBothCorrectionsAccepted": accepted_both,
        "pairedAnyFallback": int(arrays["referenceEz"].size) - accepted_both,
        "referenceScale": scheme("ReferenceScale"),
        "appScale": scheme("AppScale"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(tr.sanitize_finite(document), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "pairedCompleteCases": document["pairedCompleteCases"],
        "referenceScale": document["referenceScale"],
        "appScale": document["appScale"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
