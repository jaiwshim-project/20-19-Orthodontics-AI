#!/usr/bin/env python3
"""연구용 HTML의 `WIDTH_BIAS`를 픽셀 공간에서 재교정 — 코호트 의존성까지 검정.

배경: 섹션26 ③은 "1.051은 과보정, 최적 ≈1.02"라고 보고했으나 그 측정은 **정규화
좌표**에서 이뤄졌다(섹션29 ①). 종횡비 왜곡이 방향에 따라 걸리므로 최적 배율도
다시 재야 한다.

`WIDTH_BIAS`는 각 폭선을 **중점 고정으로 b배 확대**한다. 따라서
  - 위치(중점)는 원리적으로 **불변** → 여기서도 확인만 한다
  - 길이와 TZL 합계에만 영향

측정:
  ① 2단계 **OOF** 예측 위에서 b를 0.98~1.12로 스윕 → 길이 절대오차·TZL 부호편향
  ② 홀드아웃 검증: 폴드별 train에서 최적 b를 구해 test에 적용(전역 상수를 정직하게 평가)
  ③ **코호트 의존성**: root(초기 119장) / nonRoot(추가 임베드) 각각의 최적 b.
     `_cohort_bias.py`가 찾은 스케일 격차 때문에 b도 갈리는지 확인한다.

mm는 정답 최외곽 스팬=54mm 기준. 출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _px_stage_check import oof_prediction
from _rule_ab_px import paired

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
FOLDS = 5
PER_STAGE = 0.05
STAGES = 2
CURRENT_BIAS = 1.051
GRID = np.round(np.arange(0.98, 1.1201, 0.002), 4)
MOLAR_IDX = [0, 1, 10, 11]


def apply_bias(points: np.ndarray, bias: float) -> np.ndarray:
    """폭선을 중점 고정으로 bias배 확대 (HTML의 WIDTH_BIAS와 동일한 연산).

    HTML은 확대 후 이미지 범위로 클램프하지만, 클램프가 걸리는 경우는 드물고
    여기서는 배율의 순효과만 보므로 클램프는 적용하지 않는다.
    """
    out = points.copy()
    mid = (points[:, 0::2, :] + points[:, 1::2, :]) / 2.0
    for t in range(12):
        a, b = 2 * t, 2 * t + 1
        out[:, a, :] = mid[:, t, :] + (points[:, a, :] - mid[:, t, :]) * bias
        out[:, b, :] = mid[:, t, :] + (points[:, b, :] - mid[:, t, :]) * bias
    return out


def length_stats(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray, idx=None):
    cols = range(12) if idx is None else idx
    signed, absolute = [], []
    for t in cols:
        a, b = 2 * t, 2 * t + 1
        tl = np.linalg.norm(truth[:, a, :] - truth[:, b, :], axis=1) * scale
        pl = np.linalg.norm(pred[:, a, :] - pred[:, b, :], axis=1) * scale
        signed.append((pl - tl) / np.maximum(tl, EPS) * 100)
        absolute.append(np.abs(pl - tl))
    return np.stack(signed, axis=1), np.stack(absolute, axis=1)


def position_mm(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray) -> float:
    pm = (pred[:, 0::2, :] + pred[:, 1::2, :]) / 2.0
    tm = (truth[:, 0::2, :] + truth[:, 1::2, :]) / 2.0
    return float((np.linalg.norm(pm - tm, axis=2) * scale[:, None]).mean())


def best_bias(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray) -> float:
    scores = [length_stats(apply_bias(pred, b), truth, scale)[1].mean() for b in GRID]
    return float(GRID[int(np.argmin(scores))])


def root_shas() -> set[str]:
    out = set()
    for n in range(1, 120):
        path = PROJECT / f"{n:03d}.jpg"
        if path.exists():
            out.add(hashlib.sha256(path.read_bytes()).hexdigest())
    return out


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    corrected, _ = oof_prediction(width, STAGES, PER_STAGE)

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    pred = to_pixels(corrected.reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)
    root = root_shas()
    is_root = np.array([str(g) in root for g in groups])

    sweep = []
    for b in GRID:
        biased = apply_bias(pred, float(b))
        signed, absolute = length_stats(biased, truth, scale)
        sweep.append({
            "bias": float(b),
            "lengthAbsMm": float(absolute.mean()),
            "lengthSignedPct": float(signed.mean()),
            "molarLengthAbsMm": float(length_stats(biased, truth, scale, MOLAR_IDX)[1].mean()),
            "positionMm": position_mm(biased, truth, scale),
        })
    best = min(sweep, key=lambda r: r["lengthAbsMm"])
    zero_bias = min(sweep, key=lambda r: abs(r["lengthSignedPct"]))
    current = min(sweep, key=lambda r: abs(r["bias"] - CURRENT_BIAS))
    neutral = min(sweep, key=lambda r: abs(r["bias"] - 1.0))

    # 홀드아웃: 폴드별 train에서 b를 뽑아 test에 적용
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    holdout_abs = np.zeros(len(truth))
    current_abs = np.zeros(len(truth))
    neutral_abs = np.zeros(len(truth))
    fold_bias = []
    for test in masks:
        train = ~test
        b = best_bias(pred[train], truth[train], scale[train])
        fold_bias.append(b)
        holdout_abs[test] = length_stats(apply_bias(pred[test], b), truth[test], scale[test])[1].mean(axis=1)
        current_abs[test] = length_stats(apply_bias(pred[test], CURRENT_BIAS), truth[test], scale[test])[1].mean(axis=1)
        neutral_abs[test] = length_stats(pred[test], truth[test], scale[test])[1].mean(axis=1)

    cohort = {}
    for mask, label in ((is_root, "root"), (~is_root, "nonRoot")):
        signed_now = length_stats(apply_bias(pred[mask], CURRENT_BIAS), truth[mask], scale[mask])[0].mean()
        cohort[label] = {
            "cases": int(mask.sum()),
            "bestBias": best_bias(pred[mask], truth[mask], scale[mask]),
            "lengthSignedPctAtCurrent": float(signed_now),
            "lengthSignedPctAtNeutral": float(length_stats(pred[mask], truth[mask], scale[mask])[0].mean()),
        }

    report = {
        "schemaVersion": "px-width-bias-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("연구용 HTML WIDTH_BIAS 재교정. 2단계 OOF 예측 위에서 픽셀 등방 공간으로 측정. "
                 "WIDTH_BIAS는 중점 고정 확대이므로 위치에는 영향이 없어야 한다(확인 포함). "
                 "mm는 정답 최외곽 스팬=54mm 기준."),
        "samples": int(len(truth)),
        "currentBias": CURRENT_BIAS,
        "sweepGrid": [float(GRID[0]), float(GRID[-1])],
        "keyPoints": {
            "bias1_000": neutral, "bestByLengthAbs": best,
            "zeroSignedBias": zero_bias, "current1_051": current,
        },
        "positionInvariance": {
            "positionAtNeutral": neutral["positionMm"],
            "positionAtCurrent": current["positionMm"],
            "positionAtBest": best["positionMm"],
            "verdict": ("position unaffected by WIDTH_BIAS (as expected)"
                        if abs(neutral["positionMm"] - current["positionMm"]) < 0.01
                        else "position changed — clamping side effect"),
        },
        "holdout": {
            "foldBiases": fold_bias,
            "biasSpread": float(max(fold_bias) - min(fold_bias)),
            "holdoutVsCurrent": paired(current_abs, holdout_abs),
            "neutralVsCurrent": paired(current_abs, neutral_abs),
        },
        "cohortDependence": cohort,
    }
    gap = abs(cohort["root"]["bestBias"] - cohort["nonRoot"]["bestBias"])
    report["cohortDependence"]["biasGap"] = float(gap)
    report["cohortDependence"]["verdict"] = (
        "best bias differs by cohort — a single global constant is a compromise"
        if gap >= 0.01 else "cohorts agree on the bias")
    hv = report["holdout"]["holdoutVsCurrent"]
    report["recommendation"] = {
        "keepCurrent": not hv["significant"],
        "suggestedBias": (round(float(np.mean(fold_bias)), 3) if hv["significant"] else CURRENT_BIAS),
        "expectedLengthGainPct": hv["improvementPct"],
        "rationale": ("폴드별 train에서 뽑은 최적 배율을 test에 적용해 현행 1.051과 짝지어 비교. "
                      "유의한 개선이 없으면 현행 유지."),
        "caveat": ("WIDTH_BIAS는 길이만 바꾸고 위치(오차의 지배 성분)는 못 고친다. "
                   "코호트별 최적값이 갈리면 전역 상수는 타협값일 뿐이다."),
    }

    (HERE / "px_width_bias.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}  (2단계 OOF, 픽셀 공간)")
    print("point            bias  lenAbsMm  lenSigned%  molarLenAbs  positionMm")
    for name, r in report["keyPoints"].items():
        print(f"{name:15s} {r['bias']:.3f} {r['lengthAbsMm']:9.4f} {r['lengthSignedPct']:11.2f} "
              f"{r['molarLengthAbsMm']:12.4f} {r['positionMm']:11.4f}")
    print("\npositionInvariance:", json.dumps(report["positionInvariance"], ensure_ascii=True))
    print("\nholdout foldBiases:", fold_bias, "spread", report["holdout"]["biasSpread"])
    for key in ("holdoutVsCurrent", "neutralVsCurrent"):
        v = report["holdout"][key]
        print(f"  {key:18s} {v['old']:.4f} -> {v['new']:.4f} ({v['improvementPct']:+.2f}%) "
              f"CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] sig={v['significant']}")
    print("\ncohortDependence:", json.dumps(report["cohortDependence"], ensure_ascii=True, indent=2))
    print("recommendation:", json.dumps(report["recommendation"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
