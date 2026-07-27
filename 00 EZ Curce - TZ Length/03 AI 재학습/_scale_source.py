#!/usr/bin/env python3
"""스케일 오차(TZL 여력 23%)의 정체 — 정의 불일치인가 추정 실패인가.

`_headroom.py`: 케이스별 등방 스케일만 정답에 맞추면 TZL 오차 5.878 → 4.527 mm
(+23.0%). 라벨 약 9,300건 상당. 이게 **코드로 회수 가능한지**를 가른다.

두 가설:
  (A) 정의 불일치 — 정답의 54 mm 기준점과 엔진의 54 mm 기준점이 서로 다른 해부학적
      지점이다. 그렇다면 필요 배율에 **일정한 편향**이 있고, 상수 하나로 회수된다.
  (B) 케이스별 추정 실패 — 배율 오차가 케이스마다 무작위. 상수로는 못 고치고
      아치 끝점 검출 자체를 개선해야 한다.

판별: 케이스별 필요 배율 f = (정답 스팬) / (예측 스팬)의 분포를 본다.
  - 평균이 1에서 유의하게 벗어나면 (A) 성분 존재 → 상수 보정으로 회수 가능
  - 변동계수가 크면 (B) 성분 → 검출 개선 필요
그리고 (A)만 고쳤을 때(전역 상수 = 홀드아웃 중앙값) 실제 회수량을 짝지어 측정한다.
코호트별로도 나눠 본다([[project_label_cohort_scale_gap]]).

픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm. 출력에 PHI·좌표·모델 파라미터 없음.
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
STAGES = 2
PER_STAGE = 0.05
WIDTH_BIAS = 1.013


def midpoints(p):
    return (p[:, 0::2, :] + p[:, 1::2, :]) / 2.0


def apply_bias(points, bias):
    out = points.copy()
    mid = midpoints(points)
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def span(points):
    """최외곽 폭 끝점 사이 거리 = 앱이 54mm로 보정하는 기준 현."""
    ends = np.concatenate([points[:, 0:2, :], points[:, 22:24, :]], axis=1)
    best = np.zeros(len(points))
    for i in range(4):
        for j in range(i + 1, 4):
            best = np.maximum(best, np.linalg.norm(ends[:, i, :] - ends[:, j, :], axis=1))
    return best


def scale_about_centroid(points, factor):
    out = points.copy()
    centre = midpoints(points).mean(axis=1)[:, None, :]
    return centre + (out - centre) * factor[:, None, None]


def tzl(points, scale):
    total = np.zeros(len(points))
    for t in range(12):
        total += np.linalg.norm(points[:, 2 * t, :] - points[:, 2 * t + 1, :], axis=1) * scale
    return total


def root_shas():
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
    pred = apply_bias(to_pixels(corrected.reshape(-1, 24, 2), groups, dims), WIDTH_BIAS)
    scale = truth_scale_px(truth)
    root = root_shas()
    is_root = np.array([str(g) in root for g in groups])

    factor = span(truth) / np.maximum(span(pred), EPS)
    tzl_truth = tzl(truth, scale)

    def stats(mask):
        f = factor[mask]
        return {
            "cases": int(mask.sum()),
            "meanFactor": float(f.mean()),
            "medianFactor": float(np.median(f)),
            "sdFactor": float(f.std(ddof=1)),
            "coefficientOfVariationPct": float(f.std(ddof=1) / max(abs(f.mean()), EPS) * 100),
            "p05": float(np.quantile(f, 0.05)),
            "p95": float(np.quantile(f, 0.95)),
            "shareWithin2Pct": float((np.abs(f - 1) <= 0.02).mean() * 100),
            "shareOver5Pct": float((np.abs(f - 1) > 0.05).mean() * 100),
        }

    # 전역 상수 보정을 홀드아웃으로 평가: 폴드별 train 중앙값을 test에 적용
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    global_factor = np.ones(len(truth))
    fold_constants = []
    for test in masks:
        c = float(np.median(factor[~test]))
        fold_constants.append(round(c, 4))
        global_factor[test] = c

    base_err = np.abs(tzl(pred, scale) - tzl_truth)
    const_err = np.abs(tzl(scale_about_centroid(pred, global_factor), scale) - tzl_truth)
    oracle_err = np.abs(tzl(scale_about_centroid(pred, factor), scale) - tzl_truth)

    const_vs_base = paired(base_err, const_err)
    oracle_vs_base = paired(base_err, oracle_err)
    recovered = (const_vs_base["old"] - const_vs_base["new"]) / \
        max(oracle_vs_base["old"] - oracle_vs_base["new"], EPS) * 100

    report = {
        "schemaVersion": "scale-source-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("TZL 오차 중 '스케일' 성분이 정의 불일치(상수로 회수 가능)인지 케이스별 "
                 "추정 실패(검출 개선 필요)인지 판별. 전역 상수는 폴드별 train 중앙값을 "
                 "test에 적용해 홀드아웃 평가. 픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm."),
        "samples": int(len(truth)),
        "requiredFactor": {"all": stats(np.ones(len(truth), bool)),
                           "root": stats(is_root), "nonRoot": stats(~is_root)},
        "holdoutGlobalConstant": {
            "foldConstants": fold_constants,
            "constantSpread": float(max(fold_constants) - min(fold_constants)),
            "tzlAbsError": const_vs_base,
        },
        "oracleCaseWise": {"tzlAbsError": oracle_vs_base},
        "recoveredByConstantPct": float(recovered),
    }
    cv = report["requiredFactor"]["all"]["coefficientOfVariationPct"]
    bias_pct = abs(report["requiredFactor"]["all"]["meanFactor"] - 1) * 100
    report["verdict"] = {
        "systematicBiasPct": bias_pct,
        "caseVariationPct": cv,
        "dominantComponent": "definition mismatch (constant)" if bias_pct > cv else "case-wise estimation",
        "conclusion": (
            "스케일 여력의 대부분은 케이스별 아치 끝점 검출 오차다. 전역 상수로는 "
            f"오라클 대비 {recovered:.0f}%만 회수된다. 상수 보정이 아니라 끝점 검출/"
            "정합 개선 또는 스케일 예측 항이 필요하다."
            if cv >= bias_pct else
            "스케일 여력의 상당 부분이 기준점 정의 불일치이므로 전역 상수 하나로 회수 가능하다."),
    }

    (HERE / "scale_source.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}")
    for key, s in report["requiredFactor"].items():
        print(f"{key:8s} n={s['cases']:4d} mean {s['meanFactor']:.4f} median {s['medianFactor']:.4f} "
              f"sd {s['sdFactor']:.4f} CV {s['coefficientOfVariationPct']:.2f}% "
              f"within2% {s['shareWithin2Pct']:.1f}% over5% {s['shareOver5Pct']:.1f}%")
    print("\nfold constants", fold_constants, "spread", report["holdoutGlobalConstant"]["constantSpread"])
    for tag, v in (("constant(holdout)", const_vs_base), ("oracle(case-wise)", oracle_vs_base)):
        print(f"  {tag:20s} {v['old']:.4f} -> {v['new']:.4f} ({v['improvementPct']:+.2f}%) "
              f"CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] sig={v['significant']}")
    print(f"  recovered by constant: {recovered:.1f}% of oracle")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
