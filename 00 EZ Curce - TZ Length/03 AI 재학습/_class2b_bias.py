#!/usr/bin/env python3
"""신규 116건의 길이 악화가 WIDTH_BIAS 불일치 때문인가 — 폴드 내 재교정으로 분리.

`_class2b_ab.py` 결과: 신규 116건을 넣으면 위치는 4/4 시드 개선(+1.42%)인데
**길이는 4/4 시드 유의하게 악화(−3.82%)**했다. 원인 가설은 코호트 스케일 차다.
필요 폭 배율(정답 TZL / 초안 TZL)이 기존 268건은 평균 1.071, 신규 116건은 1.169로
서로 다르다([[project-label-cohort-scale-gap]]와 같은 현상). 배포 WIDTH_BIAS 1.013은
기존 코호트에서 교정된 **전역 상수**라, 더 긴 폭을 요구하는 신규 데이터를 섞으면
모델이 길게 예측하고 기존 케이스에서 과대추정이 된다.

이 가설이 맞다면 "신규 데이터가 나쁘다"가 아니라 "**상수를 다시 교정해야 한다**"가 결론이다.
그래서 A/B를 한 번 더, 이번엔 배율을 **각 폴드의 train에서만** 산출해서 돌린다
(test 케이스의 정답으로 배율을 맞추면 누출이다).

  A' = 기존 268건 학습 + 기존 train에서 교정한 배율
  B' = 기존 268 + 신규 116 학습 + 그 합집합 train에서 교정한 배율
  평가는 양쪽 동일하게 기존 268건의 out-of-fold.

배율 산출식은 `_width_bias` 계열과 같게 픽셀 공간에서 sum(정답 폭)/sum(예측 폭)의
케이스 중위수로 한다(평균은 이상치에 끌린다).

출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _class2b_ab import BOOTSTRAP, FOLDS, SEEDS, legacy_group_set, paired
from _more_labels import (CUMULATIVE, MOLAR_IDX, PER_STAGE, STAGE_HYPER,
                          TERMINAL_IDX, WIDTH_BIAS)
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent


def fit_bias(pred_px: np.ndarray, truth_px: np.ndarray) -> float:
    """폭 배율 = 케이스별 (정답 폭 합 / 예측 폭 합)의 중위수."""
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2).sum(axis=1)
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2).sum(axis=1)
    return float(np.median(tl / np.maximum(pl, 1e-12)))


def scale_about_midpoint(points_px: np.ndarray, bias: float) -> np.ndarray:
    """치아 선분을 중점 기준으로 bias배 늘린다(`_more_labels.apply_bias`와 동일 정의)."""
    out = points_px.copy()
    for tooth in range(12):
        a, b = 2 * tooth, 2 * tooth + 1
        mid = (out[:, a, :] + out[:, b, :]) / 2.0
        out[:, a, :] = mid + (out[:, a, :] - mid) * bias
        out[:, b, :] = mid + (out[:, b, :] - mid) * bias
    return out


def case_metrics(pred_px, truth_px):
    scale = truth_scale_px(truth_px)
    mid_p = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    pos = np.linalg.norm(mid_p - mid_t, axis=2) * scale[:, None]
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "position": pos.mean(axis=1),
        "molar": pos[:, MOLAR_IDX].mean(axis=1),
        "terminal": pos[:, TERMINAL_IDX].mean(axis=1),
        "lengthAbs": np.abs(pl - tl).mean(axis=1),
        "tzl": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
    }


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)
    x, base, target = width["x"], width["baseline"], width["target"]

    legacy = legacy_group_set()
    is_legacy = np.array([sha in legacy for sha in groups.tolist()])
    legacy_rows = np.flatnonzero(is_legacy)
    fresh_rows = np.flatnonzero(~is_legacy)

    truth_px_all = to_pixels(target.reshape(-1, 24, 2), groups, dims)

    per_seed, bias_log = [], []
    for seed in SEEDS:
        masks = tr.grouped_folds(groups[legacy_rows], FOLDS, seed)
        collected = {"A": {}, "B": {}}
        for fold_index, local_test in enumerate(masks):
            test_rows = legacy_rows[local_test]
            train_a = legacy_rows[~local_test]
            train_b = np.concatenate([train_a, fresh_rows])
            for arm, rows_train in (("A", train_a), ("B", train_b)):
                models = tr.fit_stages(x[rows_train], base[rows_train], target[rows_train],
                                       STAGE_HYPER, PER_STAGE, CUMULATIVE)
                # 배율은 train 케이스의 in-fold 예측에서 산출한다(test 정답 미사용).
                fit_pred = tr.predict_stages(models, x[rows_train], base[rows_train],
                                             PER_STAGE, CUMULATIVE)[0]
                fit_px = to_pixels(fit_pred.reshape(-1, 24, 2), groups[rows_train], dims)
                bias = fit_bias(fit_px, truth_px_all[rows_train])
                bias_log.append({"seed": seed, "fold": fold_index, "arm": arm,
                                 "bias": round(bias, 4)})
                test_pred = tr.predict_stages(models, x[test_rows], base[test_rows],
                                              PER_STAGE, CUMULATIVE)[0]
                test_px = scale_about_midpoint(
                    to_pixels(test_pred.reshape(-1, 24, 2), groups[test_rows], dims), bias)
                metrics = case_metrics(test_px, truth_px_all[test_rows])
                for key, values in metrics.items():
                    collected[arm].setdefault(key, []).append(values)
        ma = {k: np.concatenate(v) for k, v in collected["A"].items()}
        mb = {k: np.concatenate(v) for k, v in collected["B"].items()}
        per_seed.append({"seed": seed, "comparison": paired(ma, mb, seed)})

    keys = list(per_seed[0]["comparison"].keys())
    across = {}
    for key in keys:
        gains = [s["comparison"][key]["gainPercent"] for s in per_seed]
        sig = [s["comparison"][key]["significant"] for s in per_seed]
        across[key] = {
            "meanGainPercent": round(float(np.mean(gains)), 2),
            "perSeedGainPercent": gains,
            "seedsImproved": f"{sum(g > 0 for g in gains)}/{len(gains)}",
            "seedsSignificant": f"{sum(sig)}/{len(gains)}",
        }

    bias_a = [row["bias"] for row in bias_log if row["arm"] == "A"]
    bias_b = [row["bias"] for row in bias_log if row["arm"] == "B"]
    report = {
        "schemaVersion": "class2b-width-bias-refit-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False},
        "note": ("신규 116건의 길이 악화가 WIDTH_BIAS 코호트 불일치 때문인지 확인. 배율을 "
                 "각 폴드 train에서만 재교정해 A/B를 다시 돌린다(test 정답 누출 없음). "
                 "mm는 정답 최외곽 스팬=54mm, 픽셀 등방 공간, 부트스트랩 "
                 f"{BOOTSTRAP}회, 시드 {list(SEEDS)}."),
        "shippedGlobalWidthBias": WIDTH_BIAS,
        "refitBias": {
            "armA_legacyOnly": {"mean": round(float(np.mean(bias_a)), 4),
                                "min": round(float(np.min(bias_a)), 4),
                                "max": round(float(np.max(bias_a)), 4)},
            "armB_withFresh": {"mean": round(float(np.mean(bias_b)), 4),
                               "min": round(float(np.min(bias_b)), 4),
                               "max": round(float(np.max(bias_b)), 4)},
        },
        "acrossSeeds": across,
        "perSeed": per_seed,
    }
    (HERE / "class2b_width_bias.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"refit bias  A(legacy only) {np.mean(bias_a):.4f}  "
          f"B(+fresh) {np.mean(bias_b):.4f}  (shipped global {WIDTH_BIAS})")
    print("\nA' vs B' with per-fold refit bias, OOF on the SAME legacy cases:")
    for key in keys:
        row = across[key]
        first = per_seed[0]["comparison"][key]
        print(f"   {key:10s} {first['aMm']:.4f} -> {first['bMm']:.4f} mm | "
              f"mean {row['meanGainPercent']:+.2f}% | improved {row['seedsImproved']} | "
              f"sig {row['seedsSignificant']}")


if __name__ == "__main__":
    main()
