#!/usr/bin/env python3
"""라벨을 더 모으면 2단계 체제에서 실제로 얼마나 좋아지는가 — 학습곡선 재측정.

섹션24의 학습곡선(N^-0.058)은 1단계 모델 기준이었다. 2단계에서는 보정량 여유가
커졌으므로 데이터의 가치가 달라질 수 있다. width(268)와 ez(113) 양쪽을 잰다.

방법: train 파티션을 그룹 단위로 비율 subsample(50/65/80/100%)해서 학습하고,
같은 test 폴드로 평가한다. 여러 subsample 시드를 평균해 표본 운을 제거한다.
로그-로그 기울기로 "라벨 100건 추가 시 기대 개선율"을 추정한다.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED = tr.DEFAULT_SEED
FOLDS = 5
PER_STAGE = 0.05
CUMULATIVE = 0.10
STAGES = 2
FRACTIONS = (0.5, 0.65, 0.8, 1.0)
SUBSAMPLE_SEEDS = (11, 23, 37)
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]


def coord_mae(target, prediction, points=None):
    n = target.shape[1] // 2
    t = target.reshape(len(target), n, 2)
    p = prediction.reshape(len(prediction), n, 2)
    if points is not None:
        t, p = t[:, points, :], p[:, points, :]
    err = np.linalg.norm((p - t).reshape(-1, 2), axis=1) / np.sqrt(2.0)
    return float(err.mean())


def curve_for_task(task_name: str, task: dict, molar: bool) -> dict:
    x, base, target, groups = task["x"], task["baseline"], task["target"], task["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    points = MOLAR_POINTS if molar else None
    result = {}
    for fraction in FRACTIONS:
        scores, molar_scores, sizes = [], [], []
        for sub_seed in (SUBSAMPLE_SEEDS if fraction < 1.0 else (0,)):
            prediction = np.zeros_like(target)
            for index, test_mask in enumerate(masks, start=1):
                train_mask = ~test_mask
                train_groups = np.unique(groups[train_mask])
                if fraction < 1.0:
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
            scores.append(coord_mae(target, prediction))
            if molar:
                molar_scores.append(coord_mae(target, prediction, points))
        result[f"{int(fraction*100)}pct"] = {
            "meanTrainSamples": float(np.mean(sizes)),
            "allCoordMae": float(np.mean(scores)),
            "molarCoordMae": float(np.mean(molar_scores)) if molar_scores else None,
            "subsampleRuns": len(scores),
        }
        print(f"{task_name} {fraction:.2f} -> all {np.mean(scores):.5f}"
              + (f" molar {np.mean(molar_scores):.5f}" if molar_scores else ""))
    # 로그-로그 기울기 (N이 커질 때 오차 ~ N^slope)
    # 아래 루프가 result에 float 키를 추가하므로, 비율 키를 먼저 고정해 둔다.
    fraction_keys = [f"{int(f*100)}pct" for f in FRACTIONS]
    n = np.array([result[k]["meanTrainSamples"] for k in fraction_keys])
    for key, field in (("allSlope", "allCoordMae"), ("molarSlope", "molarCoordMae")):
        values = [result[k][field] for k in fraction_keys]
        if any(v is None for v in values):
            continue
        slope = float(np.polyfit(np.log(n), np.log(np.array(values)), 1)[0])
        result[key] = slope
        current = float(n[-1])
        for add in (100, 200, 500):
            gain = 1.0 - ((current + add) / current) ** slope
            result[f"{key}_expectedGainPctFor{add}Labels"] = float(gain * 100)
    return result


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    report = {
        "schemaVersion": "next-labels-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("2단계(단계캡5%/누적10%) 체제에서의 학습곡선. train 파티션을 그룹 단위로 "
                 "subsample, 동일 test 폴드로 평가. 오차 ~ N^slope."),
        "stages": STAGES,
        "width": curve_for_task("width", tasks["width"], molar=True),
        "ez": curve_for_task("ez", tasks["ez"], molar=False),
    }
    (HERE / "next_labels_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
