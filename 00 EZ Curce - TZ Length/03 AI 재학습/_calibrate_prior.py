#!/usr/bin/env python3
"""규칙엔진 `AUTO_TOOTH_WIDTHS_MM` prior 재교정 + 탐색범위 산정.

섹션28 발견: prior가 최말단 치아를 -16~-18% 과소평가하고, 탐색범위가
prior x 0.74~1.20로 하드 클램프되어 최말단 치아는 구조적으로 정답에 도달 불가
(도달불가율 치아1 63.8% / 치아12 47.0% vs 중앙 0.7~1.1%).

여기서는 (1) 새 prior를 정답에서 산출하고 (2) 그 prior 아래에서 필요한 탐색
범위를 역산한다. 새 prior의 근거는 268건 정답 폭(mm, 정답 최외곽 스팬=54mm 기준)이다.

**과적합 방지**: prior는 12개 숫자짜리 전역 상수이므로 케이스별로 맞출 수 없고,
따라서 "정답 평균"이 곧 최적이다. 그래도 특정 케이스 묶음에 끌려가지 않았는지
확인하기 위해 grouped 5-fold로 **폴드별 prior를 따로 산출해 흔들림을 본다**
(폴드 간 표준편차가 작으면 268건 평균은 안정적인 추정치다).

또한 사분위/백분위 기반 대안(중앙값, 60백분위)도 함께 내서, 평균이 이상치에
끌리지 않았는지 교차 확인한다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED = tr.DEFAULT_SEED
FOLDS = 5
SCALE_MM = 54.0
EPS = 1e-12
OLD_PRIOR = (12.19, 7.92, 8.13, 7.30, 6.49, 5.91, 5.91, 6.46, 7.21, 8.15, 8.04, 12.31)
OLD_RATIO = (0.74, 1.20)
# 목표: 도달불가율을 전 치아에서 2% 이하로 (중앙 치아의 현재 수준과 동급)
TARGET_UNREACHABLE_PCT = 2.0


def truth_widths_mm(target):
    pt = target.reshape(len(target), 24, 2)
    scale = np.zeros(len(target))
    for k in range(len(target)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale[k] = SCALE_MM / span if span > 0 else 0.0
    widths = np.zeros((len(target), 12))
    for t in range(12):
        widths[:, t] = np.linalg.norm(pt[:, 2 * t, :] - pt[:, 2 * t + 1, :], axis=1) * scale
    return widths


def unreachable_pct(widths, prior, ratio_min, ratio_max):
    out = []
    for t in range(12):
        low, high = prior[t] * ratio_min, prior[t] * ratio_max
        out.append(float(((widths[:, t] > high) | (widths[:, t] < low)).mean() * 100))
    return out


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    target, groups = width["target"], width["groups"]
    widths = truth_widths_mm(target)
    masks = tr.grouped_folds(groups, FOLDS, SEED)

    new_prior = widths.mean(axis=0)
    median_prior = np.median(widths, axis=0)

    # 폴드별 prior → 안정성
    fold_priors = np.array([widths[~m].mean(axis=0) for m in masks])
    fold_std = fold_priors.std(axis=0)

    # 새 prior 아래에서 필요한 ratio 범위 (백분위 기반)
    ratios = widths / np.maximum(new_prior[None, :], EPS)
    needed_low = np.quantile(ratios, TARGET_UNREACHABLE_PCT / 200.0, axis=0)
    needed_high = np.quantile(ratios, 1.0 - TARGET_UNREACHABLE_PCT / 200.0, axis=0)

    report = {
        "schemaVersion": "calibrate-prior-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False},
        "note": ("width 268건 정답 폭에서 prior 재교정. mm는 정답 최외곽 스팬=54mm 기준. "
                 "prior는 12개 전역 상수라 케이스별 적합이 불가능하므로 정답 평균이 곧 최적. "
                 "폴드별 prior 표준편차로 안정성을 확인한다."),
        "samples": int(len(target)),
        "perTooth": [{
            "tooth": t + 1,
            "oldPriorMm": OLD_PRIOR[t],
            "newPriorMm": round(float(new_prior[t]), 2),
            "medianPriorMm": round(float(median_prior[t]), 2),
            "changePct": round(float((new_prior[t] - OLD_PRIOR[t]) / OLD_PRIOR[t] * 100), 1),
            "foldStdMm": round(float(fold_std[t]), 3),
            "foldStdAsPctOfPrior": round(float(fold_std[t] / new_prior[t] * 100), 2),
            "meanVsMedianDiffPct": round(float((new_prior[t] - median_prior[t]) / median_prior[t] * 100), 2),
            "neededRatioLow": round(float(needed_low[t]), 3),
            "neededRatioHigh": round(float(needed_high[t]), 3),
        } for t in range(12)],
        "newPriorArray": [round(float(v), 2) for v in new_prior],
        "priorStability": {
            "maxFoldStdMm": float(fold_std.max()),
            "maxFoldStdAsPctOfPrior": float((fold_std / new_prior * 100).max()),
            "verdict": ("stable" if (fold_std / new_prior * 100).max() < 2.0 else "unstable"),
        },
        "meanVsMedian": {
            "maxAbsDiffPct": float(np.abs((new_prior - median_prior) / median_prior * 100).max()),
            "verdict": ("mean not outlier-driven"
                        if np.abs((new_prior - median_prior) / median_prior * 100).max() < 3.0
                        else "mean pulled by outliers"),
        },
        "ratioRange": {
            "old": list(OLD_RATIO),
            "neededLowMin": round(float(needed_low.min()), 3),
            "neededHighMax": round(float(needed_high.max()), 3),
        },
        "unreachablePct": {
            "oldPriorOldRatio": [round(v, 1) for v in unreachable_pct(widths, OLD_PRIOR, *OLD_RATIO)],
            "newPriorOldRatio": [round(v, 1) for v in unreachable_pct(widths, new_prior, *OLD_RATIO)],
        },
    }

    # 후보 탐색범위들 평가
    candidates = [(0.74, 1.20), (0.72, 1.28), (0.70, 1.32), (0.68, 1.40), (0.65, 1.45)]
    evaluated = []
    for low, high in candidates:
        old_rates = unreachable_pct(widths, OLD_PRIOR, low, high)
        new_rates = unreachable_pct(widths, new_prior, low, high)
        evaluated.append({
            "ratioRange": [low, high],
            "withOldPrior_maxUnreachablePct": round(max(old_rates), 1),
            "withOldPrior_meanUnreachablePct": round(float(np.mean(old_rates)), 2),
            "withNewPrior_maxUnreachablePct": round(max(new_rates), 1),
            "withNewPrior_meanUnreachablePct": round(float(np.mean(new_rates)), 2),
            "withNewPrior_perTooth": [round(v, 1) for v in new_rates],
            "searchWindowWidthPct": round((high - low) * 100, 1),
        })
    report["ratioCandidates"] = evaluated

    # 권고: 새 prior + 최대 도달불가율 <= 목표를 만족하는 **가장 좁은** 범위
    ok = [c for c in evaluated if c["withNewPrior_maxUnreachablePct"] <= TARGET_UNREACHABLE_PCT]
    report["recommendation"] = {
        "prior": report["newPriorArray"],
        "ratioRange": (min(ok, key=lambda c: c["searchWindowWidthPct"])["ratioRange"]
                       if ok else [round(float(needed_low.min()), 2), round(float(needed_high.max()), 2)]),
        "rationale": ("새 prior + 목표 도달불가율 2% 이하를 만족하는 가장 좁은 탐색범위. "
                      "범위를 넓히면 오검출 위험이 커지므로 필요한 만큼만 넓힌다."),
    }

    (HERE / "calibrate_prior.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("tooth  old    new   change%  foldStd%  mean-vs-median%  neededRatio")
    for r in report["perTooth"]:
        print(f"{r['tooth']:5d} {r['oldPriorMm']:6.2f} {r['newPriorMm']:6.2f} {r['changePct']:8.1f} "
              f"{r['foldStdAsPctOfPrior']:9.2f} {r['meanVsMedianDiffPct']:16.2f}  "
              f"{r['neededRatioLow']:.2f}..{r['neededRatioHigh']:.2f}")
    print()
    print("newPrior =", report["newPriorArray"])
    print("stability:", report["priorStability"])
    print("meanVsMedian:", report["meanVsMedian"])
    print()
    for c in evaluated:
        print(f"ratio {c['ratioRange']}: oldPrior max {c['withOldPrior_maxUnreachablePct']:5.1f}% "
              f"mean {c['withOldPrior_meanUnreachablePct']:5.2f}%  |  "
              f"newPrior max {c['withNewPrior_maxUnreachablePct']:5.1f}% "
              f"mean {c['withNewPrior_meanUnreachablePct']:5.2f}%")
    print()
    print("recommendation:", json.dumps(report["recommendation"], ensure_ascii=True))


if __name__ == "__main__":
    main()
