#!/usr/bin/env python3
"""Train deterministic NumPy-only RBF-KRR residual landmark correctors.

The trainer compares the rule-engine baseline coordinates with canonical expert
labels.  It trains independent models for 12 tooth-width line endpoints and 12
arc-length-resampled EZ points, evaluates them with nested grouped 5-fold CV,
and emits browser-friendly JSON containing numeric model parameters only.

No image pixels, file paths, case identifiers, or other PHI are written to the
model or metrics outputs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import numpy as np


SCHEMA_MODEL = "ez-tzl-residual-krr/v1"
SCHEMA_METRICS = "ez-tzl-residual-metrics/v1"
DEFAULT_SEED = 20260711
DEFAULT_FOLDS = 5
GATE_QUANTILE = 0.95
PCK_THRESHOLDS = (0.02, 0.05, 0.10)
GAMMA_FACTORS = (0.25, 0.5, 1.0, 2.0, 4.0)
LAMBDA_VALUES = (1e-4, 1e-3, 1e-2, 1e-1, 1.0)
EPS = 1e-12


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def finite_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def canonical_id(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return str(int(text)) if text.isdigit() else text.casefold()


def sha256_text(value: str | None) -> str | None:
    if not value:
        return None
    text = value.removeprefix("sha256:").strip().casefold()
    return text if len(text) == 64 and all(ch in "0123456789abcdef" for ch in text) else None


def get_case_id(record: Mapping[str, Any]) -> str | None:
    for key in ("caseId", "case_id", "id", "caseNumber", "case_number"):
        value = canonical_id(record.get(key))
        if value is not None:
            return value
    return None


def point(value: Any) -> tuple[float, float] | None:
    if isinstance(value, Mapping):
        x = finite_float(value.get("x"))
        y = finite_float(value.get("y"))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) >= 2:
        x = finite_float(value[0])
        y = finite_float(value[1])
    else:
        return None
    return (x, y) if x is not None and y is not None else None


def point_list(value: Any) -> list[tuple[float, float]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    parsed = [point(item) for item in value]
    return [item for item in parsed if item is not None]


def width_pair(value: Any) -> tuple[tuple[float, float], tuple[float, float]] | None:
    if isinstance(value, Mapping):
        left = point(value.get("p1") or value.get("left") or value.get("start"))
        right = point(value.get("p2") or value.get("right") or value.get("end"))
        if left is None or right is None:
            x1, y1 = finite_float(value.get("x1")), finite_float(value.get("y1"))
            x2, y2 = finite_float(value.get("x2")), finite_float(value.get("y2"))
            if None not in (x1, y1, x2, y2):
                left, right = (x1, y1), (x2, y2)
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        if len(value) == 2:
            left, right = point(value[0]), point(value[1])
        elif len(value) >= 4:
            left, right = point(value[:2]), point(value[2:4])
        else:
            return None
    else:
        return None
    return (left, right) if left is not None and right is not None else None


def width_list(value: Any, quality: Counter[str], prefix: str) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    items = list(value)
    if items and all(isinstance(item, Mapping) and finite_float(item.get("toothNo")) is not None for item in items):
        items.sort(key=lambda item: float(item["toothNo"]))
    result = []
    for item in items:
        parsed = width_pair(item)
        if parsed is None:
            continue
        p1, p2 = parsed
        if (p2[0], p2[1]) < (p1[0], p1[1]):
            p1, p2 = p2, p1
            quality[f"{prefix}WidthPairsCanonicalized"] += 1
        result.append((p1, p2))
    return result


def orient_curve(points: list[tuple[float, float]], quality: Counter[str], prefix: str) -> list[tuple[float, float]]:
    if len(points) >= 2 and points[-1][0] < points[0][0]:
        quality[f"{prefix}EzCurvesReversed"] += 1
        return list(reversed(points))
    return points


def resample_curve(points: Sequence[Sequence[float]], count: int = 12) -> np.ndarray:
    array = np.asarray(points, dtype=np.float64)
    if array.ndim != 2 or array.shape[1] != 2 or array.shape[0] < 2 or not np.isfinite(array).all():
        raise ValueError("EZ curve needs at least two finite 2D points")
    keep = np.ones(array.shape[0], dtype=bool)
    keep[1:] = np.linalg.norm(np.diff(array, axis=0), axis=1) > EPS
    array = array[keep]
    if array.shape[0] < 2:
        raise ValueError("EZ curve has zero arc length")
    cumulative = np.concatenate(([0.0], np.cumsum(np.linalg.norm(np.diff(array, axis=0), axis=1))))
    if cumulative[-1] <= EPS:
        raise ValueError("EZ curve has zero arc length")
    samples = np.linspace(0.0, cumulative[-1], count)
    return np.column_stack((np.interp(samples, cumulative, array[:, 0]), np.interp(samples, cumulative, array[:, 1])))


def dimensions(container: Mapping[str, Any] | None) -> tuple[float, float] | None:
    if not isinstance(container, Mapping):
        return None
    candidates: list[Mapping[str, Any]] = [container]
    for key in ("image", "sourceImage", "embeddedImage"):
        nested = container.get(key)
        if isinstance(nested, Mapping):
            candidates.append(nested)
    for item in candidates:
        width = next((finite_float(item.get(key)) for key in ("widthPx", "imageWidth", "width") if finite_float(item.get(key)) is not None), None)
        height = next((finite_float(item.get(key)) for key in ("heightPx", "imageHeight", "height") if finite_float(item.get(key)) is not None), None)
        if width is not None and height is not None and width > 0 and height > 0:
            return width, height
    return None


def normalize_points(points: Sequence[Sequence[float]], dims: tuple[float, float]) -> np.ndarray:
    width, height = dims
    array = np.asarray(points, dtype=np.float64)
    result = array.copy()
    result[:, 0] /= width
    result[:, 1] /= height
    return result


def normalize_widths(
    widths: Sequence[tuple[Sequence[float], Sequence[float]]], dims: tuple[float, float]
) -> np.ndarray:
    return normalize_points([point_value for pair_value in widths for point_value in pair_value], dims)


def nested(container: Mapping[str, Any], keys: Iterable[str]) -> Mapping[str, Any]:
    for key in keys:
        value = container.get(key)
        if isinstance(value, Mapping):
            return value
    return container


def baseline_components(record: Mapping[str, Any], quality: Counter[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    prediction = nested(record, ("prediction", "baseline", "result", "autoDraft", "analysis", "outputs"))
    dims = dimensions(record) or dimensions(prediction)
    if dims is None:
        return None
    width_values = next((prediction.get(key) for key in ("toothWidths", "toothWidthsPx", "tooth_widths", "widths") if key in prediction), None)
    ez_values = next((prediction.get(key) for key in ("ezPoints", "ezPointsPx", "ez_points") if key in prediction), None)
    center_values = next((prediction.get(key) for key in ("toothCenters", "toothCentersPx", "tooth_centers") if key in prediction), None)
    widths = width_list(width_values, quality, "baseline")
    ez = orient_curve(point_list(ez_values), quality, "baseline")
    if len(widths) != 12 or len(ez) < 2:
        return None
    width_points = normalize_widths(widths, dims)
    ez_points = normalize_points(resample_curve(ez, 12), dims)
    centers = point_list(center_values)
    if len(centers) == 12:
        center_points = normalize_points(centers, dims)
    else:
        center_points = (width_points[0::2] + width_points[1::2]) * 0.5
    return width_points, ez_points, center_points


FEATURE_BLOCKS = (
    ("widthEndpointsXY", 48),
    ("ezPointsXY", 24),
    ("toothCentersXY", 24),
    ("widthLengthDiag", 12),
    ("widthDirectionXY", 24),
    ("ezSegmentLengthDiag", 11),
    ("ezSegmentDirectionXY", 22),
    ("globalGeometry", 4),
)


def feature_vector(width_points: np.ndarray, ez_points: np.ndarray, centers: np.ndarray, aspect: float) -> np.ndarray:
    width_vectors = width_points[1::2] - width_points[0::2]
    width_lengths = np.linalg.norm(width_vectors, axis=1)
    width_dirs = width_vectors / np.maximum(width_lengths[:, None], EPS)
    ez_vectors = np.diff(ez_points, axis=0)
    ez_lengths = np.linalg.norm(ez_vectors, axis=1)
    ez_dirs = ez_vectors / np.maximum(ez_lengths[:, None], EPS)
    chord = ez_points[-1] - ez_points[0]
    chord_length = float(np.linalg.norm(chord))
    if chord_length > EPS:
        cross = np.abs(chord[0] * (ez_points[:, 1] - ez_points[0, 1]) - chord[1] * (ez_points[:, 0] - ez_points[0, 0]))
        arch_depth = float(np.max(cross) / chord_length)
    else:
        arch_depth = 0.0
    global_geometry = np.asarray((math.log(max(aspect, EPS)), chord_length / math.sqrt(2.0), arch_depth / math.sqrt(2.0), float(width_lengths.mean()) / math.sqrt(2.0)))
    result = np.concatenate((
        width_points.reshape(-1), ez_points.reshape(-1), centers.reshape(-1),
        width_lengths / math.sqrt(2.0), width_dirs.reshape(-1),
        ez_lengths / math.sqrt(2.0), ez_dirs.reshape(-1), global_geometry,
    )).astype(np.float64)
    expected = sum(length for _, length in FEATURE_BLOCKS)
    if result.shape != (expected,) or not np.isfinite(result).all():
        raise ValueError("invalid baseline feature vector")
    return result


def case_annotations(case: Mapping[str, Any], kind: str) -> list[Mapping[str, Any]]:
    expert = case.get("expert") if isinstance(case.get("expert"), Mapping) else {}
    key = "widthAnnotations" if kind == "width" else "ezAnnotations"
    value = expert.get(key, case.get(key, []))
    return [item for item in value if isinstance(item, Mapping)] if isinstance(value, Sequence) else []


def annotation_raw(annotation: Mapping[str, Any], index_dir: Path) -> Mapping[str, Any]:
    raw = annotation.get("raw")
    if isinstance(raw, Mapping):
        return raw
    path_value = annotation.get("filePath") or annotation.get("path")
    if not isinstance(path_value, str):
        return annotation
    path = Path(path_value)
    if not path.is_absolute():
        path = index_dir / path
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.casefold() == ".json":
        loaded = json.loads(text)
    else:
        marker = text.find("```json")
        start = text.find("{", marker)
        end = text.find("\n```", start)
        if marker < 0 or start < 0 or end < 0:
            raise ValueError("annotation JSON fence is missing")
        loaded = json.loads(text[start:end])
    return loaded if isinstance(loaded, Mapping) else {}


def truth_consensus(
    case: Mapping[str, Any], kind: str, dims: tuple[float, float], index_dir: Path, quality: Counter[str]
) -> np.ndarray | None:
    candidates: list[np.ndarray] = []
    for annotation in case_annotations(case, kind):
        try:
            raw = annotation_raw(annotation, index_dir)
        except (OSError, ValueError, json.JSONDecodeError):
            quality[f"{kind}AnnotationsUnreadable"] += 1
            continue
        if kind == "width":
            value = next((raw.get(key) for key in ("toothWidthsPx", "toothWidths", "tooth_widths", "widths") if key in raw), None)
            widths = width_list(value, quality, "expert")
            if len(widths) == 12:
                candidates.append(normalize_widths(widths, dims))
        else:
            value = next((raw.get(key) for key in ("ezPointsPx", "ezPoints", "ez_points") if key in raw), None)
            points = orient_curve(point_list(value), quality, "expert")
            if len(points) >= 2:
                try:
                    candidates.append(normalize_points(resample_curve(points, 12), dims))
                except ValueError:
                    quality["ezAnnotationsInvalidArc"] += 1
    if not candidates:
        return None
    if len(candidates) > 1:
        quality[f"{kind}MultiAnnotationCases"] += 1
    return np.mean(np.stack(candidates), axis=0)


def records_from_baseline(document: Any) -> list[Mapping[str, Any]]:
    if isinstance(document, Sequence) and not isinstance(document, (str, bytes)):
        return [item for item in document if isinstance(item, Mapping)]
    if not isinstance(document, Mapping):
        return []
    for key in ("results", "cases", "predictions", "items", "records"):
        value = document.get(key)
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            return [item for item in value if isinstance(item, Mapping)]
    records = []
    for key, value in document.items():
        if isinstance(value, Mapping):
            item = dict(value)
            item.setdefault("caseId", key)
            records.append(item)
    return records


def baseline_sha(record: Mapping[str, Any]) -> str | None:
    for key in ("imageRef", "sourceImageSha256", "imageSha256", "sha256"):
        value = sha256_text(record.get(key))
        if value:
            return value
    image = record.get("image")
    return sha256_text(image.get("sha256")) if isinstance(image, Mapping) else None


def dataset_cases(document: Any) -> list[Mapping[str, Any]]:
    if isinstance(document, Mapping) and isinstance(document.get("cases"), Sequence):
        return [item for item in document["cases"] if isinstance(item, Mapping)]
    if isinstance(document, Sequence) and not isinstance(document, (str, bytes)):
        return [item for item in document if isinstance(item, Mapping)]
    raise ValueError("dataset index must contain a cases array")


def build_samples(dataset_path: Path, baseline_path: Path) -> tuple[dict[str, dict[str, np.ndarray]], dict[str, Any]]:
    dataset = dataset_cases(read_json(dataset_path))
    baseline = records_from_baseline(read_json(baseline_path))
    by_sha = {baseline_sha(item): item for item in baseline if baseline_sha(item)}
    by_id = {get_case_id(item): item for item in baseline if get_case_id(item)}
    quality: Counter[str] = Counter()
    task_rows: dict[str, list[tuple[np.ndarray, np.ndarray, np.ndarray, str]]] = {"width": [], "ez": []}
    matched = 0

    for case in dataset:
        image = case.get("image") if isinstance(case.get("image"), Mapping) else case
        image_sha = sha256_text(image.get("sha256")) if isinstance(image, Mapping) else None
        baseline_record = by_sha.get(image_sha) if image_sha else None
        if baseline_record is None:
            baseline_record = by_id.get(get_case_id(case))
        if baseline_record is None:
            quality["casesWithoutBaseline"] += 1
            continue
        if str(baseline_record.get("status", "ok")).casefold() != "ok":
            quality["baselineErrorCases"] += 1
            continue
        truth_dims = dimensions(case)
        base_dims = dimensions(baseline_record)
        if truth_dims is None or base_dims is None:
            quality["invalidDimensionCases"] += 1
            continue
        components = baseline_components(baseline_record, quality)
        if components is None:
            quality["baselineIncompleteCases"] += 1
            continue
        matched += 1
        width_points, ez_points, centers = components
        features = feature_vector(width_points, ez_points, centers, base_dims[0] / base_dims[1])
        split = case.get("splitGrouping") if isinstance(case.get("splitGrouping"), Mapping) else {}
        group = str(split.get("minimumGroupId") or image_sha or get_case_id(case) or f"anonymous-{matched}")

        width_truth = truth_consensus(case, "width", truth_dims, dataset_path.parent, quality)
        if width_truth is not None and width_truth.shape == (24, 2):
            task_rows["width"].append((features, width_points.reshape(-1), width_truth.reshape(-1), group))
        else:
            quality["casesWithoutComplete12WidthTruth"] += 1

        ez_truth = truth_consensus(case, "ez", truth_dims, dataset_path.parent, quality)
        if ez_truth is not None and ez_truth.shape == (12, 2):
            task_rows["ez"].append((features, ez_points.reshape(-1), ez_truth.reshape(-1), group))
        else:
            quality["casesWithoutUsableEzTruth"] += 1

    tasks: dict[str, dict[str, np.ndarray]] = {}
    for name, rows in task_rows.items():
        if not rows:
            continue
        tasks[name] = {
            "x": np.stack([row[0] for row in rows]),
            "baseline": np.stack([row[1] for row in rows]),
            "target": np.stack([row[2] for row in rows]),
            "groups": np.asarray([row[3] for row in rows], dtype=object),
        }
    input_summary = {
        "datasetCases": len(dataset),
        "baselineRecords": len(baseline),
        "matchedUsableBaselines": matched,
        "taskSamples": {name: int(values["x"].shape[0]) for name, values in tasks.items()},
        "taskGroups": {name: int(len(set(values["groups"].tolist()))) for name, values in tasks.items()},
    }
    quality_report = {
        "counts": dict(sorted(quality.items())),
        "flags": [key for key, value in sorted(quality.items()) if value > 0 and ("Canonicalized" in key or "Reversed" in key or "MultiAnnotation" in key)],
    }
    return tasks, {"inputSummary": input_summary, "labelQuality": quality_report}


def grouped_folds(groups: np.ndarray, folds: int, seed: int) -> list[np.ndarray]:
    unique = np.asarray(sorted(set(str(value) for value in groups)), dtype=object)
    if unique.size < folds:
        raise ValueError(f"need at least {folds} unique groups, got {unique.size}")
    rng = np.random.default_rng(seed)
    shuffled = unique[rng.permutation(unique.size)]
    buckets = [set() for _ in range(folds)]
    for index, group in enumerate(shuffled):
        buckets[index % folds].add(str(group))
    return [np.asarray([str(value) in bucket for value in groups], dtype=bool) for bucket in buckets]


def standardize_fit(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-9] = 1.0
    return mean, scale


def squared_distances(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    result = np.sum(a * a, axis=1)[:, None] + np.sum(b * b, axis=1)[None, :] - 2.0 * a @ b.T
    return np.maximum(result, 0.0)


def gamma_base(z: np.ndarray) -> float:
    if z.shape[0] < 2:
        return 1.0
    values = squared_distances(z, z)[np.triu_indices(z.shape[0], 1)]
    values = values[values > 1e-12]
    return 1.0 / float(np.median(values)) if values.size else 1.0


def distance_gate(z: np.ndarray, quantile: float = GATE_QUANTILE) -> float:
    if z.shape[0] < 2:
        return float("inf")
    distances = squared_distances(z, z)
    np.fill_diagonal(distances, np.inf)
    nearest = np.sqrt(np.min(distances, axis=1))
    finite = nearest[np.isfinite(nearest)]
    return max(float(np.quantile(finite, quantile)), 1e-9) if finite.size else float("inf")


def solve_alpha(kernel: np.ndarray, residual: np.ndarray, regularization: float) -> np.ndarray:
    matrix = kernel + np.eye(kernel.shape[0], dtype=np.float64) * regularization
    try:
        return np.linalg.solve(matrix, residual)
    except np.linalg.LinAlgError:
        return np.linalg.lstsq(matrix, residual, rcond=None)[0]


def fit_krr(
    x: np.ndarray, baseline: np.ndarray, target: np.ndarray, gamma_factor: float, regularization: float
) -> dict[str, Any]:
    mean, scale = standardize_fit(x)
    prototypes = (x - mean) / scale
    gamma = gamma_base(prototypes) * gamma_factor
    kernel = np.exp(-gamma * squared_distances(prototypes, prototypes))
    alpha = solve_alpha(kernel, target - baseline, regularization)
    gate = distance_gate(prototypes)
    return {
        "featureMean": mean,
        "featureScale": scale,
        "prototypes": prototypes,
        "alpha": alpha,
        "gamma": float(gamma),
        "gammaFactor": float(gamma_factor),
        "lambda": float(regularization),
        "gateDistance": float(gate),
        "gateKernelSimilarity": float(math.exp(-gamma * gate * gate)) if math.isfinite(gate) else 0.0,
    }


def clip_corrections(corrections: np.ndarray, max_diag_fraction: float) -> np.ndarray:
    shaped = corrections.reshape(corrections.shape[0], -1, 2).copy()
    lengths = np.linalg.norm(shaped, axis=2)
    maximum = max_diag_fraction * math.sqrt(2.0)
    factors = np.minimum(1.0, maximum / np.maximum(lengths, EPS))
    shaped *= factors[:, :, None]
    return shaped.reshape(corrections.shape)


def predict_krr(model: Mapping[str, Any], x: np.ndarray, baseline: np.ndarray, max_correction: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    z = (x - model["featureMean"]) / model["featureScale"]
    distances = squared_distances(z, model["prototypes"])
    nearest = np.sqrt(np.min(distances, axis=1))
    accepted = nearest <= float(model["gateDistance"])
    correction = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
    correction = clip_corrections(correction, max_correction)
    correction[~accepted] = 0.0
    prediction = np.clip(baseline + correction, 0.0, 1.0)
    return prediction, accepted, nearest


def error_metrics(target: np.ndarray, prediction: np.ndarray) -> dict[str, Any]:
    delta = prediction.reshape(-1, 2) - target.reshape(-1, 2)
    coordinate_abs = np.abs(delta)
    point_error = np.linalg.norm(delta, axis=1) / math.sqrt(2.0)
    coordinate_mae = float(coordinate_abs.mean())
    return {
        "mae": float(point_error.mean()),
        "rmse": float(np.sqrt(np.mean(point_error * point_error))),
        "coordinateMAE": coordinate_mae,
        "coordinateRMSE": float(np.sqrt(np.mean(delta * delta))),
        "p95": float(np.quantile(point_error, 0.95)),
        "pck": {f"{int(threshold * 100)}pct": float(np.mean(point_error <= threshold)) for threshold in PCK_THRESHOLDS},
        "landmarkCount": int(point_error.size),
    }


def relative_improvement(baseline_value: float, corrected_value: float) -> float:
    return float((baseline_value - corrected_value) / baseline_value) if baseline_value > EPS else 0.0


def select_hyperparameters(
    x: np.ndarray,
    baseline: np.ndarray,
    target: np.ndarray,
    groups: np.ndarray,
    seed: int,
    max_correction: float,
    folds: int,
) -> tuple[float, float, float]:
    inner_folds = min(max(2, folds), len(set(groups.tolist())))
    masks = grouped_folds(groups, inner_folds, seed)
    best: tuple[float, float, float] | None = None
    for gamma_factor in GAMMA_FACTORS:
        for regularization in LAMBDA_VALUES:
            errors = []
            for test_mask in masks:
                train_mask = ~test_mask
                model = fit_krr(x[train_mask], baseline[train_mask], target[train_mask], gamma_factor, regularization)
                prediction, _, _ = predict_krr(model, x[test_mask], baseline[test_mask], max_correction)
                errors.append(error_metrics(target[test_mask], prediction)["coordinateMAE"])
            score = float(np.mean(errors))
            candidate = (score, gamma_factor, regularization)
            if best is None or candidate < best:
                best = candidate
    if best is None:
        raise RuntimeError("hyperparameter search produced no result")
    return best


def evaluate_task(
    data: Mapping[str, np.ndarray], task: str, folds: int, seed: int, max_correction: float
) -> tuple[dict[str, Any], dict[str, Any]]:
    x, baseline, target, groups = data["x"], data["baseline"], data["target"], data["groups"]
    masks = grouped_folds(groups, folds, seed)
    corrected_oof = np.zeros_like(target)
    accepted_oof = np.zeros(x.shape[0], dtype=bool)
    nearest_oof = np.zeros(x.shape[0], dtype=np.float64)
    fold_reports = []

    for fold_index, test_mask in enumerate(masks, start=1):
        train_mask = ~test_mask
        _, gamma_factor, regularization = select_hyperparameters(
            x[train_mask], baseline[train_mask], target[train_mask], groups[train_mask],
            seed + fold_index * 1009, max_correction, min(4, folds),
        )
        model = fit_krr(x[train_mask], baseline[train_mask], target[train_mask], gamma_factor, regularization)
        prediction, accepted, nearest = predict_krr(model, x[test_mask], baseline[test_mask], max_correction)
        corrected_oof[test_mask] = prediction
        accepted_oof[test_mask] = accepted
        nearest_oof[test_mask] = nearest
        base_metrics = error_metrics(target[test_mask], baseline[test_mask])
        corrected_metrics = error_metrics(target[test_mask], prediction)
        fold_reports.append({
            "fold": fold_index,
            "trainSamples": int(train_mask.sum()),
            "testSamples": int(test_mask.sum()),
            "trainGroups": int(len(set(groups[train_mask].tolist()))),
            "testGroups": int(len(set(groups[test_mask].tolist()))),
            "hyperparameters": {
                "gammaFactor": gamma_factor,
                "gamma": model["gamma"],
                "lambda": regularization,
            },
            "distanceGate": {
                "threshold": model["gateDistance"],
                "kernelSimilarityFloor": model["gateKernelSimilarity"],
                "accepted": int(accepted.sum()),
                "fallback": int((~accepted).sum()),
                "acceptedRate": float(accepted.mean()),
            },
            "baseline": base_metrics,
            "corrected": corrected_metrics,
            "coordinateMaeRelativeImprovement": relative_improvement(base_metrics["coordinateMAE"], corrected_metrics["coordinateMAE"]),
            "p95Regression": corrected_metrics["p95"] - base_metrics["p95"],
        })

    base_overall = error_metrics(target, baseline)
    corrected_overall = error_metrics(target, corrected_oof)
    improved_folds = sum(report["corrected"]["coordinateMAE"] < report["baseline"]["coordinateMAE"] for report in fold_reports)
    improvement = relative_improvement(base_overall["coordinateMAE"], corrected_overall["coordinateMAE"])
    p95_regression = corrected_overall["p95"] - base_overall["p95"]
    checks = {
        "coordinateMaeRelativeImprovementAtLeast10Pct": improvement >= 0.10,
        "atLeast4Of5FoldsImproved": folds == 5 and improved_folds >= 4,
        "p95DidNotRegress": p95_regression <= EPS,
        "correctionCapIs5PctDiagonal": abs(max_correction - 0.05) <= EPS,
        "unfamiliarFallbackEnabled": True,
    }
    task_gate = {
        "pass": all(checks.values()),
        "checks": checks,
        "observed": {
            "coordinateMaeRelativeImprovement": improvement,
            "improvedFolds": improved_folds,
            "foldCount": folds,
            "p95Regression": p95_regression,
            "unfamiliarAcceptedRate": float(accepted_oof.mean()),
            "unfamiliarFallbackCount": int((~accepted_oof).sum()),
            "nearestTrainingDistanceP95": float(np.quantile(nearest_oof, 0.95)),
        },
        "required": {
            "coordinateMaeRelativeImprovement": 0.10,
            "improvedFolds": 4,
            "foldCount": 5,
            "p95RegressionMaximum": 0.0,
            "correctionCapDiagonalFraction": 0.05,
            "unfamiliarFallback": True,
        },
    }

    _, final_gamma_factor, final_regularization = select_hyperparameters(
        x, baseline, target, groups, seed + 50021, max_correction, folds,
    )
    final_model = fit_krr(x, baseline, target, final_gamma_factor, final_regularization)
    model_json = {
        "output": "12_tooth_width_endpoints_xy" if task == "width" else "12_ez_points_xy",
        "outputShape": [24, 2] if task == "width" else [12, 2],
        "trainingSamples": int(x.shape[0]),
        "trainingGroups": int(len(set(groups.tolist()))),
        "hyperparameters": {
            "kernel": "rbf",
            "gammaFactor": final_gamma_factor,
            "gamma": final_model["gamma"],
            "lambda": final_regularization,
        },
        "distanceGate": {
            "metric": "euclidean_in_standardized_feature_space",
            "trainingNearestNeighborQuantile": GATE_QUANTILE,
            "threshold": final_model["gateDistance"],
            "kernelSimilarityFloor": final_model["gateKernelSimilarity"],
            "outsideAction": "return_rule_engine_baseline",
        },
        "featureMean": final_model["featureMean"].tolist(),
        "featureScale": final_model["featureScale"].tolist(),
        "prototypes": final_model["prototypes"].tolist(),
        "alpha": final_model["alpha"].tolist(),
    }
    metrics_json = {
        "samples": int(x.shape[0]),
        "groups": int(len(set(groups.tolist()))),
        "folds": fold_reports,
        "overallOutOfFold": {
            "baseline": base_overall,
            "corrected": corrected_overall,
            "coordinateMaeRelativeImprovement": improvement,
            "p95Regression": p95_regression,
        },
        "selectedFinalHyperparameters": model_json["hyperparameters"],
        "promotionGate": task_gate,
    }
    return model_json, metrics_json


def sanitize_finite(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): sanitize_finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_finite(item) for item in value]
    if isinstance(value, np.ndarray):
        return sanitize_finite(value.tolist())
    if isinstance(value, (np.floating, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("output contains a non-finite float")
        return number
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    raise TypeError(f"unsupported JSON value: {type(value).__name__}")


def data_digest(tasks: Mapping[str, Mapping[str, np.ndarray]]) -> str:
    digest = hashlib.sha256()
    for task in sorted(tasks):
        digest.update(task.encode("ascii"))
        for key in ("x", "baseline", "target"):
            digest.update(np.ascontiguousarray(tasks[task][key], dtype="<f8").tobytes())
    return digest.hexdigest()


def run_training(
    dataset_path: Path,
    baseline_path: Path,
    output_dir: Path,
    folds: int = DEFAULT_FOLDS,
    seed: int = DEFAULT_SEED,
    max_correction: float = 0.05,
) -> tuple[Path, Path, dict[str, Any]]:
    if folds != 5:
        raise ValueError("promotion protocol requires exactly 5 folds")
    if not (0.0 < max_correction <= 0.25):
        raise ValueError("max correction must be in (0, 0.25]")
    tasks, audit = build_samples(dataset_path, baseline_path)
    if not tasks:
        raise ValueError("no trainable width or EZ samples were matched")
    model_tasks: dict[str, Any] = {}
    metric_tasks: dict[str, Any] = {}
    for offset, task in enumerate(("width", "ez")):
        if task not in tasks:
            continue
        if len(set(tasks[task]["groups"].tolist())) < folds:
            raise ValueError(f"{task} has fewer than {folds} unique groups")
        model_tasks[task], metric_tasks[task] = evaluate_task(
            tasks[task], task, folds, seed + offset * 100003, max_correction,
        )

    all_pass = bool(metric_tasks) and all(item["promotionGate"]["pass"] for item in metric_tasks.values())
    promotion_gate = {
        "pass": all_pass,
        "taskPass": {task: item["promotionGate"]["pass"] for task, item in metric_tasks.items()},
        "policy": "deploy_only_if_every_trained_task_passes",
    }
    feature_size = sum(length for _, length in FEATURE_BLOCKS)
    model_document = {
        "schemaVersion": SCHEMA_MODEL,
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImagePixels": False,
            "content": "normalized numeric model parameters only",
        },
        "seed": seed,
        "trainingDataDigestSha256": data_digest(tasks),
        "coordinateNormalization": "x/imageWidth,y/imageHeight",
        "featureSpec": {
            "version": "rule-landmark-geometry/v1",
            "size": feature_size,
            "blocks": [{"name": name, "length": length} for name, length in FEATURE_BLOCKS],
            "requires": ["12 tooth width lines", "12 EZ points", "12 tooth centers or derived width midpoints", "image aspect ratio"],
        },
        "correctionPolicy": {
            "prediction": "rule_engine_baseline_plus_krr_residual",
            "maximumPerLandmarkCorrectionDiagonalFraction": max_correction,
            "clipCoordinatesToUnitSquare": True,
            "unfamiliarInputAction": "return_rule_engine_baseline",
        },
        "tasks": model_tasks,
        "promotionGate": promotion_gate,
    }
    metrics_document = {
        "schemaVersion": SCHEMA_METRICS,
        "privacy": model_document["privacy"],
        "seed": seed,
        "foldCount": folds,
        "trainingDataDigestSha256": model_document["trainingDataDigestSha256"],
        "metricDefinitions": {
            "coordinateMAE": "mean absolute x/y error after axis normalization",
            "mae": "mean 2D landmark error as fraction of normalized image diagonal",
            "rmse": "root mean squared 2D landmark error as fraction of normalized image diagonal",
            "p95": "95th percentile 2D landmark error as fraction of normalized image diagonal",
            "pck": "fraction of landmarks within 2%, 5%, and 10% of normalized image diagonal",
            "overallOutOfFold": "each prediction is from a model that excluded its split group",
        },
        **audit,
        "tasks": metric_tasks,
        "promotionGate": promotion_gate,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    model_path = output_dir / "residual-model.json"
    metrics_path = output_dir / "residual-metrics.json"
    model_path.write_text(json.dumps(sanitize_finite(model_document), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    metrics_path.write_text(json.dumps(sanitize_finite(metrics_document), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return model_path, metrics_path, metrics_document


def synthetic_documents(count: int = 30, seed: int = 7711) -> tuple[dict[str, Any], dict[str, Any]]:
    rng = np.random.default_rng(seed)
    cases = []
    results = []
    for index in range(count):
        case_id = f"{index + 1:03d}"
        image_hash = hashlib.sha256(f"synthetic-{case_id}".encode()).hexdigest()
        width, height = 1200, 800
        phase = (index - count / 2) / count
        xs = np.linspace(0.18, 0.82, 12)
        arch = 0.36 + 0.25 * (1.0 - ((xs - 0.5) / 0.34) ** 2) + phase * 0.025
        ez_truth = np.column_stack((xs, arch))
        centers = ez_truth + np.column_stack((np.zeros(12), np.full(12, 0.09)))
        widths_truth = []
        widths_base = []
        for tooth_index, center in enumerate(centers):
            half = 0.018 + 0.004 * abs(tooth_index - 5.5) / 5.5
            true_p1 = center + (-half, -0.004 * (tooth_index - 5.5))
            true_p2 = center + (half, 0.004 * (tooth_index - 5.5))
            bias = np.asarray((0.010 + 0.002 * phase, -0.008 + 0.002 * center[0]))
            widths_truth.append((true_p1, true_p2))
            widths_base.append((true_p1 + bias + rng.normal(0, 0.001, 2), true_p2 + bias + rng.normal(0, 0.001, 2)))
        ez_bias = np.column_stack((np.full(12, -0.009 + 0.002 * phase), 0.011 + 0.004 * (xs - 0.5)))
        ez_base = ez_truth + ez_bias + rng.normal(0, 0.001, ez_truth.shape)

        def px(value: Sequence[float]) -> dict[str, float]:
            return {"x": float(value[0] * width), "y": float(value[1] * height)}

        cases.append({
            "caseId": case_id,
            "image": {"sha256": image_hash, "widthPx": width, "heightPx": height},
            "splitGrouping": {"minimumGroupId": image_hash},
            "expert": {
                "widthAnnotations": [{"raw": {"toothWidthsPx": [{"toothNo": i + 1, "p1": px(pair[0]), "p2": px(pair[1])} for i, pair in enumerate(widths_truth)]}}],
                "ezAnnotations": [{"raw": {"ezPointsPx": [px(item) for item in ez_truth]}}],
            },
        })
        results.append({
            "caseId": case_id,
            "imageRef": "sha256:" + image_hash,
            "status": "ok",
            "imageWidth": width,
            "imageHeight": height,
            "prediction": {
                "toothWidths": [{"p1": px(pair[0]), "p2": px(pair[1])} for pair in widths_base],
                "ezPoints": [px(item) for item in ez_base],
                "toothCenters": [px((pair[0] + pair[1]) * 0.5) for pair in widths_base],
            },
        })
    return {"schemaVersion": "synthetic-index/v1", "cases": cases}, {"schemaVersion": "synthetic-baseline/v1", "results": results}


def self_test(seed: int = DEFAULT_SEED) -> None:
    dataset, baseline = synthetic_documents()
    with tempfile.TemporaryDirectory(prefix="ez-residual-selftest-") as directory:
        root = Path(directory)
        dataset_path = root / "dataset-index.json"
        baseline_path = root / "baseline-predictions.json"
        dataset_path.write_text(json.dumps(dataset), encoding="utf-8")
        baseline_path.write_text(json.dumps(baseline), encoding="utf-8")
        model_path, metrics_path, metrics = run_training(dataset_path, baseline_path, root / "out", seed=seed)
        if not model_path.is_file() or not metrics_path.is_file():
            raise AssertionError("self-test outputs were not created")
        for task in ("width", "ez"):
            result = metrics["tasks"][task]["overallOutOfFold"]
            if result["corrected"]["coordinateMAE"] >= result["baseline"]["coordinateMAE"]:
                raise AssertionError(f"synthetic {task} correction did not improve coordinate MAE")
            if not math.isfinite(result["corrected"]["rmse"]):
                raise AssertionError(f"synthetic {task} RMSE is not finite")
    print("synthetic self-test: PASS")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-index", type=Path, help="canonical dataset-index.json")
    parser.add_argument("--baseline-predictions", type=Path, help="rule-engine baseline predictions JSON")
    parser.add_argument("--output-dir", type=Path, help="directory for residual-model.json and residual-metrics.json")
    parser.add_argument("--folds", type=int, default=DEFAULT_FOLDS, help="grouped CV folds; promotion protocol requires 5")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="deterministic split seed")
    parser.add_argument("--max-correction", type=float, default=0.05, help="maximum correction per landmark, fraction of image diagonal")
    parser.add_argument("--self-test", action="store_true", help="run deterministic synthetic end-to-end test")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.self_test:
        self_test(args.seed)
        return
    if args.dataset_index is None or args.baseline_predictions is None or args.output_dir is None:
        raise SystemExit("--dataset-index, --baseline-predictions, and --output-dir are required")
    model_path, metrics_path, metrics = run_training(
        args.dataset_index.resolve(), args.baseline_predictions.resolve(), args.output_dir.resolve(),
        folds=args.folds, seed=args.seed, max_correction=args.max_correction,
    )
    summary = {
        "model": str(model_path),
        "metrics": str(metrics_path),
        "taskSamples": metrics["inputSummary"]["taskSamples"],
        "promotionGatePass": metrics["promotionGate"]["pass"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
