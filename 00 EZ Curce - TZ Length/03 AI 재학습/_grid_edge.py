#!/usr/bin/env python3
"""탐색 격자의 경계가 성능을 묶고 있나 — 라벨 0건으로 남은 여력 확인.

배포 모델의 단계별 하이퍼파라미터가 격자 **끝**에 붙어 있다:
  width: [(0.25, 0.1), (0.25, 1.0), (4.0, 1.0)]   ← gammaFactor 4.0 = 상한, lambda 1.0 = 상한
  ez:    [(0.25, 0.1), (1.0, 1.0), (4.0, 1.0)]
GAMMA_FACTORS 상한 4.0, LAMBDA_VALUES 상한 1.0. 선택값이 경계면 "격자 밖이 더 좋은데
못 가본 것"일 수 있다. 이건 정답을 새로 받지 않고도 검증 가능한 여력이다.
동시에 gammaFactor 하한(0.25)도 두 단계에서 선택됐으므로 아래쪽도 넓힌다.

측정: 확장 격자로 grouped 5-fold OOF를 다시 만들어 현행 격자와 A/B.
하이퍼파라미터 선택은 **각 폴드의 train 안에서만** 수행하므로(select_stage_hyperparameters가
내부 CV를 돈다) 확장 자체가 테스트 정보를 새지 않는다.

⚠️ 격자를 넓히면 선택 분산도 커진다. 개선이 나와도 시드를 바꿔 재현되는지 확인해야
채택 가치가 있다([[project-rule-engine-candidates-rejected]]의 교훈: 단일 시드 개선은
기각 사유가 되기 쉽다).

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _more_labels import MOLAR_IDX, TERMINAL_IDX, WIDTH_BIAS, apply_bias
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_px import paired

HERE = Path(__file__).resolve().parent
FOLDS = 5
PER_STAGE = 0.05
STAGES = 3
CUMULATIVE = 0.15
SEEDS = (tr.DEFAULT_SEED, 20260712, 20260713, 20260714)

WIDE_GAMMA = (0.0625, 0.125, 0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0)
WIDE_LAMBDA = (1e-5, 1e-4, 1e-3, 1e-2, 1e-1, 1.0, 10.0, 100.0)


def oof(data, seed: int):
    x, baseline, target, groups = data["x"], data["baseline"], data["target"], data["groups"]
    masks = tr.grouped_folds(groups, FOLDS, seed)
    out = np.zeros_like(target)
    chosen = []
    for i, test in enumerate(masks, start=1):
        train = ~test
        hyper = tr.select_stage_hyperparameters(
            x[train], baseline[train], target[train], groups[train],
            seed + i * 1009, PER_STAGE, min(4, FOLDS), STAGES, CUMULATIVE)
        chosen.append([[float(g), float(l)] for g, l in hyper])
        models = tr.fit_stages(x[train], baseline[train], target[train], hyper, PER_STAGE, CUMULATIVE)
        out[test] = tr.predict_stages(models, x[test], baseline[test], PER_STAGE, CUMULATIVE)[0]
    return out, chosen


def score(values, groups, dims, truth_px, scale):
    pred = apply_bias(to_pixels(values.reshape(-1, 24, 2), groups, dims))
    mid_p = (pred[:, 0::2, :] + pred[:, 1::2, :]) / 2.0
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    pos = np.linalg.norm(mid_p - mid_t, axis=2) * scale[:, None]
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "_pos": pos.mean(axis=1), "_molarPos": pos[:, MOLAR_IDX].mean(axis=1),
        "_terminalPos": pos[:, TERMINAL_IDX].mean(axis=1),
        "_len": np.abs(pl - tl).mean(axis=1),
        "_tzl": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
    }


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)
    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth_px)

    keys = ("position", "molarPosition", "terminalPosition", "lengthAbs", "tzlAbsError")
    series = {"position": "_pos", "molarPosition": "_molarPos", "terminalPosition": "_terminalPos",
              "lengthAbs": "_len", "tzlAbsError": "_tzl"}

    narrow_grid = (tr.GAMMA_FACTORS, tr.LAMBDA_VALUES)
    per_seed = []
    edge_counts = {"narrow": 0, "wide": 0}
    edge_total = {"narrow": 0, "wide": 0}
    wide_outside = 0

    for seed in SEEDS:
        results = {}
        picks = {}
        for label, (gammas, lambdas) in (("narrow", narrow_grid), ("wide", (WIDE_GAMMA, WIDE_LAMBDA))):
            tr.GAMMA_FACTORS, tr.LAMBDA_VALUES = gammas, lambdas
            values, chosen = oof(width, seed)
            results[label] = score(values, groups, dims, truth_px, scale)
            picks[label] = chosen
            for fold in chosen:
                for gamma_factor, regularization in fold:
                    edge_total[label] += 1
                    if gamma_factor in (gammas[0], gammas[-1]) or regularization in (lambdas[0], lambdas[-1]):
                        edge_counts[label] += 1
                    if label == "wide" and (gamma_factor not in narrow_grid[0]
                                            or regularization not in narrow_grid[1]):
                        wide_outside += 1
        tr.GAMMA_FACTORS, tr.LAMBDA_VALUES = narrow_grid
        comparison = {k: paired(results["narrow"][series[k]], results["wide"][series[k]]) for k in keys}
        per_seed.append({
            "seed": seed,
            "comparison": comparison,
            "wideChoicesOutsideNarrowGrid": sum(
                1 for fold in picks["wide"] for g, l in fold
                if g not in narrow_grid[0] or l not in narrow_grid[1]),
        })
        print(f"seed {seed}:")
        for key in keys:
            gain = comparison[key]
            print(f"   {key:18s} {gain['old']:.4f} -> {gain['new']:.4f} "
                  f"({gain['improvementPct']:+6.2f}%) sig={gain['significant']}")
        print(f"   wide picks outside narrow grid: {per_seed[-1]['wideChoicesOutsideNarrowGrid']}/{STAGES * FOLDS}")

    def summarize(key):
        gains = [s["comparison"][key]["improvementPct"] for s in per_seed]
        significant = [s["comparison"][key]["significant"] for s in per_seed]
        return {
            "improvementPctBySeed": [round(g, 2) for g in gains],
            "meanImprovementPct": round(float(np.mean(gains)), 2),
            "seedsImproved": int(sum(1 for g, s in zip(gains, significant) if s and g > 0)),
            "seedsWorsened": int(sum(1 for g, s in zip(gains, significant) if s and g < 0)),
        }

    summary = {key: summarize(key) for key in keys}
    consistent = [k for k in keys if summary[k]["seedsImproved"] == len(SEEDS)]
    harmful = [k for k in keys if summary[k]["seedsWorsened"] > 0]

    report = {
        "schemaVersion": "grid-edge-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("배포 하이퍼파라미터가 탐색 격자 경계(gammaFactor 4.0, lambda 1.0)에 붙어 있어, "
                 "격자를 위아래로 넓히면 남은 여력이 있는지 확인. 선택은 폴드 train 내부 CV에서만 "
                 "수행. 시드 4종 전부 재현되는지까지 본다. 픽셀 등방, mm=최외곽 스팬 54mm, "
                 "짝지어 부트스트랩 5,000회, WIDTH_BIAS 1.013."),
        "grids": {
            "narrow": {"gammaFactors": list(narrow_grid[0]), "lambdas": list(narrow_grid[1])},
            "wide": {"gammaFactors": list(WIDE_GAMMA), "lambdas": list(WIDE_LAMBDA)},
        },
        "edgeSelectionRate": {
            label: round(edge_counts[label] / max(1, edge_total[label]), 3) for label in edge_counts},
        "wideChoicesOutsideNarrowGridTotal": wide_outside,
        "perSeed": per_seed,
        "summary": summary,
        "verdict": {
            "consistentGains": consistent,
            "anySeedWorsened": harmful,
            "worthAdopting": bool(consistent and not harmful),
            "conclusion": ("격자 확장이 시드 4종에서 재현되는 개선을 준다 — 라벨 0건으로 얻는 여력."
                           if consistent and not harmful else
                           "격자 확장은 재현되는 개선을 주지 않는다 — 현행 격자가 병목이 아니다."),
        },
    }
    (HERE / "grid_edge.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("\nsummary:", json.dumps(summary, indent=1))
    print("verdict:", json.dumps({k: v for k, v in report["verdict"].items() if k != "conclusion"}, indent=1))


if __name__ == "__main__":
    main()
