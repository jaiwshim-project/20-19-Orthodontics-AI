#!/usr/bin/env python3
"""정답 라벨이 몇 건 더 필요한가 — 픽셀 공간 학습곡선에서 역산.

기존 `_next_labels.py`는 정규화 좌표 MAE로 곡선을 그렸다. 비율 기반이라 기울기
자체는 대체로 살아 있지만, "몇 mm까지 내려가나 / 몇 건 필요한가"를 말하려면
**픽셀 등방 공간의 임상 단위**로 재야 한다([[project_segment_position_bottleneck]]).

측정:
  ① width 학습곡선 — train 파티션을 그룹 단위로 subsample(40~100%), 같은 test
     폴드로 2단계 OOF 평가. 지표는 **위치(중점 이동) mm**, 길이 mm, TZL 합계 오차 mm.
  ② ez 학습곡선 — EZL 길이 오차 mm(같은 프로토콜).
  ③ 로그-로그 기울기로 목표치 도달에 필요한 총 샘플 수 N을 역산.
     목표는 임상 관점으로 고정: TZL/EZL 오차 3 mm(1차) / 2 mm(2차),
     위치 오차 2.0 mm(치아폭 1/4 수준) / 1.5 mm.
  ④ 코호트별 곡선 — 초기 라벨(root) 코호트만으로 평가할 때의 기울기.
     라벨 관습이 다른 코호트를 섞는 것이 이득인지 확인한다.

mm는 정답 최외곽 스팬=54mm 기준. 출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
FOLDS = 5
PER_STAGE = 0.05
CUMULATIVE = 0.10
STAGES = 2
FRACTIONS = (0.4, 0.55, 0.7, 0.85, 1.0)
SUBSAMPLE_SEEDS = (11, 23)
WIDTH_BIAS = 1.013  # 연구용 HTML에 적용된 현행 배율
MOLAR_IDX = [0, 1, 10, 11]

POSITION_TARGETS = (2.0, 1.5)
TZL_TARGETS = (3.0, 2.0)


def root_shas() -> set[str]:
    out = set()
    for n in range(1, 120):
        path = PROJECT / f"{n:03d}.jpg"
        if path.exists():
            out.add(hashlib.sha256(path.read_bytes()).hexdigest())
    return out


def apply_bias(points: np.ndarray, bias: float) -> np.ndarray:
    out = points.copy()
    mid = (points[:, 0::2, :] + points[:, 1::2, :]) / 2.0
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def oof_with_fraction(task: dict, fraction: float, sub_seed: int):
    """train 파티션을 그룹 단위로 fraction만 남겨 2단계 OOF 예측을 만든다."""
    x, base, target, groups = task["x"], task["baseline"], task["target"], task["groups"]
    prediction = np.zeros_like(target)
    sizes = []
    for index, test_mask in enumerate(tr.grouped_folds(groups, FOLDS, SEED), start=1):
        train_mask = ~test_mask
        if fraction < 1.0:
            train_groups = np.unique(groups[train_mask])
            rng = np.random.default_rng(SEED + sub_seed * 977 + index)
            keep = rng.choice(train_groups, size=max(8, int(round(len(train_groups) * fraction))),
                              replace=False)
            train_mask = train_mask & np.isin(groups, keep)
        sizes.append(int(train_mask.sum()))
        chosen = tr.select_stage_hyperparameters(
            x[train_mask], base[train_mask], target[train_mask], groups[train_mask],
            SEED + index * 1009, PER_STAGE, min(4, FOLDS), STAGES, CUMULATIVE)
        fitted = tr.fit_stages(x[train_mask], base[train_mask], target[train_mask],
                               chosen, PER_STAGE, CUMULATIVE)
        fold_prediction, _, _ = tr.predict_stages(
            fitted, x[test_mask], base[test_mask], PER_STAGE, CUMULATIVE)
        prediction[test_mask] = fold_prediction
    return prediction, float(np.mean(sizes))


def width_scores(prediction, task, dims, mask=None) -> dict:
    groups = task["groups"]
    truth = to_pixels(task["target"].reshape(-1, 24, 2), groups, dims)
    pred = apply_bias(to_pixels(prediction.reshape(-1, 24, 2), groups, dims), WIDTH_BIAS)
    scale = truth_scale_px(truth)
    if mask is not None:
        truth, pred, scale = truth[mask], pred[mask], scale[mask]
    tm = (truth[:, 0::2, :] + truth[:, 1::2, :]) / 2.0
    pm = (pred[:, 0::2, :] + pred[:, 1::2, :]) / 2.0
    position = np.linalg.norm(pm - tm, axis=2) * scale[:, None]
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "positionMm": float(position.mean()),
        "molarPositionMm": float(position[:, MOLAR_IDX].mean()),
        "lengthAbsMm": float(np.abs(pl - tl).mean()),
        "tzlAbsErrorMm": float(np.abs(pl.sum(axis=1) - tl.sum(axis=1)).mean()),
    }


def ez_scores(prediction, task, dims) -> dict:
    """EZ는 12점 폴리라인 길이(EZL)와 점 위치 오차를 픽셀 공간에서 본다."""
    groups = task["groups"]
    n = task["target"].shape[1] // 2
    truth = to_pixels(task["target"].reshape(-1, n, 2), groups, dims)
    pred = to_pixels(prediction.reshape(-1, n, 2), groups, dims)
    # EZ 과제에는 폭 정답이 없으므로 스케일은 EZ 양끝 현을 54mm로 본다(앱과 동일).
    chord = np.linalg.norm(truth[:, -1, :] - truth[:, 0, :], axis=1)
    scale = 54.0 / np.maximum(chord, EPS)
    tlen = np.linalg.norm(np.diff(truth, axis=1), axis=2).sum(axis=1) * scale
    plen = np.linalg.norm(np.diff(pred, axis=1), axis=2).sum(axis=1) * scale
    point = np.linalg.norm(pred - truth, axis=2) * scale[:, None]
    return {
        "pointMm": float(point.mean()),
        "ezlAbsErrorMm": float(np.abs(plen - tlen).mean()),
    }


def fit_slope(sizes, values):
    return float(np.polyfit(np.log(np.array(sizes)), np.log(np.array(values)), 1)[0])


def labels_needed(current_n: float, current_value: float, slope: float, target: float):
    """오차 ~ N^slope 가정 하에 target 도달에 필요한 총 N과 추가 라벨 수."""
    if slope >= -1e-6 or target <= 0:
        return None
    required = current_n * (target / current_value) ** (1.0 / slope)
    return {
        "targetMm": target,
        "requiredTotalSamples": int(round(required)),
        "additionalLabels": int(round(required - current_n)),
        "feasible": bool(required - current_n <= 2000),
    }


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    dims = dims_by_group(HERE / "dataset-index.json")
    root = root_shas()

    report = {
        "schemaVersion": "label-need-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("픽셀 등방 공간 학습곡선에서 필요 라벨 수를 역산. train 파티션을 그룹 단위로 "
                 "subsample하고 동일 test 폴드로 2단계 OOF 평가. width에는 현행 WIDTH_BIAS "
                 "1.013을 적용해 사용자가 보는 값 기준으로 잰다. mm는 정답 최외곽 스팬=54mm "
                 "(EZ는 앱과 동일하게 EZ 양끝 현=54mm). 외삽은 오차~N^slope 가정이며 "
                 "라벨 관습이 균일하다는 전제가 필요하다."),
        "config": {"stages": STAGES, "perStageCap": PER_STAGE, "cumulativeCap": CUMULATIVE,
                   "folds": FOLDS, "fractions": list(FRACTIONS), "subsampleSeeds": list(SUBSAMPLE_SEEDS),
                   "widthBias": WIDTH_BIAS},
        "curves": {},
    }

    # ── width ────────────────────────────────────────────────────────────────
    width = tasks["width"]
    is_root = np.array([str(g) in root for g in width["groups"]])
    width_curve, width_root_curve = [], []
    for fraction in FRACTIONS:
        seeds = SUBSAMPLE_SEEDS if fraction < 1.0 else (0,)
        runs, root_runs, sizes = [], [], []
        for sub_seed in seeds:
            prediction, mean_size = oof_with_fraction(width, fraction, sub_seed)
            runs.append(width_scores(prediction, width, dims))
            root_runs.append(width_scores(prediction, width, dims, mask=is_root))
            sizes.append(mean_size)
        agg = {k: float(np.mean([r[k] for r in runs])) for k in runs[0]}
        agg["meanTrainSamples"] = float(np.mean(sizes))
        agg["fraction"] = fraction
        width_curve.append(agg)
        root_agg = {k: float(np.mean([r[k] for r in root_runs])) for k in root_runs[0]}
        root_agg["meanTrainSamples"] = float(np.mean(sizes))
        width_root_curve.append(root_agg)
        print(f"width {fraction:.2f} N={agg['meanTrainSamples']:.0f} pos {agg['positionMm']:.3f} "
              f"len {agg['lengthAbsMm']:.3f} tzl {agg['tzlAbsErrorMm']:.3f} "
              f"| root pos {root_agg['positionMm']:.3f}")

    # ── ez ───────────────────────────────────────────────────────────────────
    ez = tasks["ez"]
    ez_curve = []
    for fraction in FRACTIONS:
        seeds = SUBSAMPLE_SEEDS if fraction < 1.0 else (0,)
        runs, sizes = [], []
        for sub_seed in seeds:
            prediction, mean_size = oof_with_fraction(ez, fraction, sub_seed)
            runs.append(ez_scores(prediction, ez, dims))
            sizes.append(mean_size)
        agg = {k: float(np.mean([r[k] for r in runs])) for k in runs[0]}
        agg["meanTrainSamples"] = float(np.mean(sizes))
        agg["fraction"] = fraction
        ez_curve.append(agg)
        print(f"ez    {fraction:.2f} N={agg['meanTrainSamples']:.0f} "
              f"point {agg['pointMm']:.3f} ezl {agg['ezlAbsErrorMm']:.3f}")

    report["curves"] = {"width": width_curve, "widthRootCohort": width_root_curve, "ez": ez_curve}

    # ── 기울기와 필요 라벨 수 ────────────────────────────────────────────────
    def analyse(curve, fields, targets_by_field):
        sizes = [row["meanTrainSamples"] for row in curve]
        current_n = sizes[-1]
        out = {}
        for field in fields:
            values = [row[field] for row in curve]
            slope = fit_slope(sizes, values)
            entry = {"slope": slope, "currentMm": values[-1], "currentTrainSamples": current_n,
                     "gainPctFor": {}}
            for add in (50, 100, 200, 500):
                entry["gainPctFor"][str(add)] = float(
                    (1.0 - ((current_n + add) / current_n) ** slope) * 100)
            entry["targets"] = [t for t in
                                (labels_needed(current_n, values[-1], slope, target)
                                 for target in targets_by_field.get(field, ()))
                                if t is not None]
            out[field] = entry
        return out

    report["analysis"] = {
        "width": analyse(width_curve, ("positionMm", "molarPositionMm", "lengthAbsMm", "tzlAbsErrorMm"),
                         {"positionMm": POSITION_TARGETS, "molarPositionMm": POSITION_TARGETS,
                          "tzlAbsErrorMm": TZL_TARGETS}),
        "widthRootCohort": analyse(width_root_curve, ("positionMm", "tzlAbsErrorMm"),
                                   {"positionMm": POSITION_TARGETS, "tzlAbsErrorMm": TZL_TARGETS}),
        "ez": analyse(ez_curve, ("pointMm", "ezlAbsErrorMm"), {"ezlAbsErrorMm": TZL_TARGETS}),
    }

    w = report["analysis"]["width"]
    e = report["analysis"]["ez"]
    report["comparison"] = {
        "widthSlopePosition": w["positionMm"]["slope"],
        "ezSlopeEzl": e["ezlAbsErrorMm"]["slope"],
        "widthGainPer100": w["positionMm"]["gainPctFor"]["100"],
        "ezGainPer100": e["ezlAbsErrorMm"]["gainPctFor"]["100"],
        "perLabelValueRatio_ezOverWidth": float(
            e["ezlAbsErrorMm"]["gainPctFor"]["100"] / max(w["positionMm"]["gainPctFor"]["100"], EPS)),
        "verdict": ("EZ 라벨이 라벨 1건당 가치가 더 크다"
                    if e["ezlAbsErrorMm"]["gainPctFor"]["100"] > w["positionMm"]["gainPctFor"]["100"]
                    else "width 라벨이 라벨 1건당 가치가 더 크다"),
    }

    (HERE / "label_need.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("\n--- analysis ---")
    print(json.dumps(report["analysis"], ensure_ascii=True, indent=2))
    print("\n--- comparison ---")
    print(json.dumps(report["comparison"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
