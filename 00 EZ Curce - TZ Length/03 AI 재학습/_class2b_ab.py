#!/usr/bin/env python3
"""신규 클래스2 폭 정답 116건이 실제로 도움이 되는가 — out-of-fold A/B 실측.

배경: 2026-07-27 `03 치아 좌우폭 찍기(유라쌤-클래스2)` 118건이 들어왔다. 감사
(`_audit_new_labels.mjs`) 결과 116건이 치아 12개 완전 라벨, 임베디드 SHA는 기존 라벨
폴더·번호 root와 **중복 0건**, 상대폭 프로파일도 기존 완전 라벨 322건과 동일(평균 |z| 0.253).
인덱스·규칙 baseline까지 반영해 폭 학습 표본이 268 → 384로 늘었다.

⚠️ 섹션 34의 교훈: "표본이 늘었다"는 개선이 아니다. 부분 주석 31건은 라벨 규약이 달라서
넣자마자 위치 −9.96%로 악화됐다. 그래서 늘어난 표본이 **홀드아웃 성능을 올리는지**를
따로 재야 한다. 그리고 절대 in-sample로 재지 않는다([[feedback-report-oof-not-insample]]).

측정 설계:
  평가 대상은 **기존 268건으로 고정**한다(양쪽 arm의 test 집합이 완전히 동일해야
  차이를 학습 데이터 탓으로만 돌릴 수 있다).
  A(기존) = 기존 268건만으로 학습, 그 268건에 대한 grouped 5-fold OOF 예측
  B(증강) = A의 각 폴드 train에 **신규 116건 전부**를 더해 학습, 같은 268건 test로 OOF
  → 신규 116건은 어느 폴드에서도 test에 들어가지 않는다. 즉 B의 성적은 신규 데이터에
    대한 in-sample 성적이 아니라 **기존 데이터에 대한 순수 홀드아웃 성적**이다.
  하이퍼파라미터는 배포 모델의 단계별 값을 양쪽에 그대로 고정(차이를 데이터로만 한정).

  덧붙여 C(신규 홀드아웃) = 기존 268건으로만 학습해 **신규 116건을 예측**한 성적도 낸다.
  신규 코호트가 기존 모델로 얼마나 맞는지(=분포가 정말 같은지)를 보는 확인용이며,
  이것도 신규 데이터가 학습에 들어가지 않은 완전 홀드아웃이다.

지표: 전부 픽셀 등방 공간, mm는 정답 최외곽 스팬 = 54mm.
  position(치아 중점 이동), lengthAbs, tzl(총합 오차), 어금니[0,1,10,11], 최말단[0,11]
  케이스 단위 짝지어진 부트스트랩 5,000회, 시드 4종(20260711~14).

출력에 PHI·좌표·파일명·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _more_labels import (CUMULATIVE, MOLAR_IDX, PER_STAGE, STAGE_HYPER,
                          TERMINAL_IDX, WIDTH_BIAS, apply_bias)
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEEDS = (20260711, 20260712, 20260713, 20260714)
BOOTSTRAP = 5000
BASELINE_BAK = "baseline_predictions_all.before-class2b.json.bak"


def legacy_group_set() -> set[str]:
    """증강 이전 학습 표본의 케이스 SHA 집합. 백업된 baseline으로 build_samples를 다시 돌려 얻는다.

    폴더 목록이나 파일명이 아니라 **이미지 SHA-256**으로 구분한다(파일 번호 매칭 금지).
    """
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / BASELINE_BAK)
    return set(tasks["width"]["groups"].tolist())


def metrics(pred_norm, target_norm, groups, dims, rows):
    """정규화 예측 → 픽셀 → mm. 케이스별 값 배열을 돌려준다(짝지어진 부트스트랩용)."""
    sub_groups = groups[rows]
    truth_px = to_pixels(target_norm[rows].reshape(-1, 24, 2), sub_groups, dims)
    pred_px = apply_bias(to_pixels(pred_norm[rows].reshape(-1, 24, 2), sub_groups, dims))
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


def paired(a: dict, b: dict, seed: int) -> dict:
    """A 대비 B의 변화율(%). 양수 = 개선(오차 감소). 케이스 단위 짝지어진 부트스트랩."""
    rng = np.random.default_rng(seed)
    out = {}
    for key in a:
        va, vb = a[key], b[key]
        n = len(va)
        delta = va - vb  # 양수면 B가 더 작다 = 개선
        base = va.mean()
        gains = []
        for _ in range(BOOTSTRAP):
            pick = rng.integers(0, n, n)
            gains.append(delta[pick].mean() / max(va[pick].mean(), 1e-12) * 100.0)
        low, high = float(np.quantile(gains, 0.025)), float(np.quantile(gains, 0.975))
        out[key] = {
            "aMm": round(float(base), 4),
            "bMm": round(float(vb.mean()), 4),
            "gainPercent": round(float(delta.mean() / max(base, 1e-12) * 100.0), 2),
            "ci95": [round(low, 2), round(high, 2)],
            "significant": bool(low > 0 or high < 0),
        }
    return out


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, info = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)

    legacy = legacy_group_set()
    is_legacy = np.array([sha in legacy for sha in groups.tolist()])
    legacy_rows = np.flatnonzero(is_legacy)
    fresh_rows = np.flatnonzero(~is_legacy)
    if len(fresh_rows) == 0:
        raise SystemExit("신규 표본이 0건 — 인덱스/baseline 반영이 안 됐다")

    x, base, target = width["x"], width["baseline"], width["target"]

    per_seed = []
    for seed in SEEDS:
        # 폴드는 **기존 268건에 대해서만** 나눈다. 신규는 항상 train에만 들어간다.
        legacy_groups = groups[legacy_rows]
        masks = tr.grouped_folds(legacy_groups, FOLDS, seed)
        pred_a = np.zeros_like(target)
        pred_b = np.zeros_like(target)
        for local_test in masks:
            test_rows = legacy_rows[local_test]
            train_rows_a = legacy_rows[~local_test]
            train_rows_b = np.concatenate([train_rows_a, fresh_rows])
            for rows_train, out in ((train_rows_a, pred_a), (train_rows_b, pred_b)):
                models = tr.fit_stages(x[rows_train], base[rows_train], target[rows_train],
                                       STAGE_HYPER, PER_STAGE, CUMULATIVE)
                out[test_rows] = tr.predict_stages(models, x[test_rows], base[test_rows],
                                                   PER_STAGE, CUMULATIVE)[0]
        ma = metrics(pred_a, target, groups, dims, legacy_rows)
        mb = metrics(pred_b, target, groups, dims, legacy_rows)
        per_seed.append({"seed": seed, "comparison": paired(ma, mb, seed)})

    # C: 기존 268건으로만 학습해 신규 116건을 예측(완전 홀드아웃). 규칙 초안 대비로 본다.
    models_legacy = tr.fit_stages(x[legacy_rows], base[legacy_rows], target[legacy_rows],
                                  STAGE_HYPER, PER_STAGE, CUMULATIVE)
    pred_fresh = np.zeros_like(target)
    pred_fresh[fresh_rows] = tr.predict_stages(models_legacy, x[fresh_rows], base[fresh_rows],
                                               PER_STAGE, CUMULATIVE)[0]
    fresh_model = metrics(pred_fresh, target, groups, dims, fresh_rows)
    fresh_rule = metrics(base, target, groups, dims, fresh_rows)
    legacy_rule = metrics(base, target, groups, dims, legacy_rows)

    keys = list(per_seed[0]["comparison"].keys())
    across = {}
    for key in keys:
        gains = [s["comparison"][key]["gainPercent"] for s in per_seed]
        sig = [s["comparison"][key]["significant"] for s in per_seed]
        improved = [g > 0 for g in gains]
        across[key] = {
            "meanGainPercent": round(float(np.mean(gains)), 2),
            "perSeedGainPercent": gains,
            "seedsImproved": f"{sum(improved)}/{len(gains)}",
            "seedsSignificant": f"{sum(sig)}/{len(gains)}",
        }

    report = {
        "schemaVersion": "class2b-width-ab-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsModelParameters": False},
        "note": ("신규 클래스2 폭 정답 116건의 가치를 out-of-fold로 실측. 평가 케이스는 기존 "
                 "268건으로 고정하고, 신규는 train에만 넣는다 → in-sample 이득이 섞이지 않는다. "
                 "mm는 정답 최외곽 스팬=54mm, 픽셀 등방 공간. 짝지어진 케이스 부트스트랩 5,000회."),
        "samples": {
            "widthSamplesTotal": int(len(groups)),
            "legacySamples": int(len(legacy_rows)),
            "freshSamples": int(len(fresh_rows)),
            "ezSamples": int(tasks["ez"]["x"].shape[0]),
            "datasetCases": info["inputSummary"]["datasetCases"],
        },
        "hyperparameters": {"stages": len(STAGE_HYPER), "perStageCap": PER_STAGE,
                            "cumulativeCap": CUMULATIVE, "widthBias": WIDTH_BIAS,
                            "folds": FOLDS, "seeds": list(SEEDS)},
        "acrossSeeds": across,
        "perSeed": per_seed,
        "freshCohortHoldout": {
            "note": ("신규 116건을 기존 268건 학습 모델로 예측한 성적(완전 홀드아웃). "
                     "신규 코호트가 기존 분포와 같은지 확인용."),
            "ruleDraftMm": {k: round(float(v.mean()), 4) for k, v in fresh_rule.items()},
            "modelMm": {k: round(float(v.mean()), 4) for k, v in fresh_model.items()},
            "gainOverRulePercent": {
                k: round(float((fresh_rule[k].mean() - fresh_model[k].mean())
                               / max(fresh_rule[k].mean(), 1e-12) * 100.0), 2)
                for k in fresh_rule},
            "legacyRuleDraftMm": {k: round(float(v.mean()), 4) for k, v in legacy_rule.items()},
        },
    }
    (HERE / "class2b_width_ab.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples: total {len(groups)} = legacy {len(legacy_rows)} + fresh {len(fresh_rows)}")
    print("\nA(legacy only) vs B(+fresh 116), OOF on the SAME legacy cases:")
    for key in keys:
        row = across[key]
        first = per_seed[0]["comparison"][key]
        print(f"   {key:10s} {first['aMm']:.4f} -> {first['bMm']:.4f} mm | "
              f"mean {row['meanGainPercent']:+.2f}% | improved {row['seedsImproved']} | "
              f"sig {row['seedsSignificant']}")
    print("\nfresh cohort holdout (trained on legacy only):")
    for key in keys:
        print(f"   {key:10s} rule {fresh_rule[key].mean():.4f} -> model "
              f"{fresh_model[key].mean():.4f} mm "
              f"({report['freshCohortHoldout']['gainOverRulePercent'][key]:+.2f}%) | "
              f"legacy rule {legacy_rule[key].mean():.4f}")


if __name__ == "__main__":
    main()
