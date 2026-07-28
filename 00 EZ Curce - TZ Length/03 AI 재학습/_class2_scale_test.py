#!/usr/bin/env python3
"""폭 스케일 차는 '누가 찍었나'가 아니라 '클래스2인가'다 — 그리고 배율 2개로 회복되나.

`cohort_scale_map.json`이 프레이밍을 뒤집었다. 필요 폭 배율 중위수:

  A(유라쌤 1차, 비클래스2)  1.019   n=4
  B(김원장님 2차, 비클래스2) 1.091   n=52
  C(김원장님 교정후)         1.047   n=59
  D(김원장님-클래스2)        1.162   n=99
  E(유라쌤-클래스2)          1.170   n=116

**담당자가 다른 D와 E가 일치하고(CI 겹침), 담당자가 같은 B·C·D가 갈린다.**
즉 기준 차이는 주석자 속성이 아니라 **케이스 속성(클래스2)**이다. 원장 지도로 만든
정답이라는 사실과 정합한다 — 라벨이 틀린 게 아니라 규칙엔진 초안이 클래스2에서
폭을 더 크게 과소추정하는 것이다.

그러면 앞서 "코호트 지시자가 필요하다(미구현)"로 남겼던 것이 실은 **클래스2 여부
하나로 되는지**를 재야 한다. 두 가지를 실측한다.

  실험 1: 배율을 클래스2/비클래스2 **2개**로 나눠 적용(각 폴드 train에서만 산출).
          앞서 전역 상수 재교정은 −4.33%로 실패했다. 2개면 회복되는가?
  실험 2: 신규 116건 투입 효과를 **클래스2 케이스에서만** 재평가.
          앞서 −3.82%는 평가 집합이 기존 268건(대부분 비클래스2)이었다.
          정본 기준이 클래스2 쪽이라면 클래스2 평가에서는 이득이어야 한다.

평가 집합은 두 실험 모두 **기존 268건으로 고정**하고 신규는 train에만 넣는다
(신규 데이터의 in-sample 이득 배제 — [[feedback-report-oof-not-insample]]).

출력에 PHI·좌표·파일명·담당자명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _class2b_ab import BOOTSTRAP, FOLDS, SEEDS, legacy_group_set, paired
from _class2b_bias import case_metrics, fit_bias, scale_about_midpoint
from _cohort_scale_map import case_cohorts, label_sha_to_cohort
from _more_labels import CUMULATIVE, PER_STAGE, STAGE_HYPER
from _px_decompose import dims_by_group, to_pixels

HERE = Path(__file__).resolve().parent
CLASS2_CODES = {"D_class2_a", "E_class2_b"}


def class2_mask(dataset_path: Path, groups: np.ndarray) -> np.ndarray:
    """케이스가 클래스2 폭 라벨 폴더에서 왔는지. 여러 폴더가 겹치면 하나라도 클래스2면 True."""
    cohorts = case_cohorts(dataset_path, label_sha_to_cohort())
    return np.asarray([bool(cohorts.get(sha, set()) & CLASS2_CODES) for sha in groups.tolist()])


def apply_group_bias(points_px, is_class2, bias_class2, bias_other):
    """클래스2 케이스와 나머지에 서로 다른 폭 배율을 적용."""
    out = points_px.copy()
    if is_class2.any():
        out[is_class2] = scale_about_midpoint(points_px[is_class2], bias_class2)
    if (~is_class2).any():
        out[~is_class2] = scale_about_midpoint(points_px[~is_class2], bias_other)
    return out


def summarize(per_seed, keys):
    out = {}
    for key in keys:
        gains = [s["comparison"][key]["gainPercent"] for s in per_seed]
        sig = [s["comparison"][key]["significant"] for s in per_seed]
        out[key] = {
            "meanGainPercent": round(float(np.mean(gains)), 2),
            "perSeedGainPercent": gains,
            "seedsImproved": f"{sum(g > 0 for g in gains)}/{len(gains)}",
            "seedsSignificant": f"{sum(sig)}/{len(gains)}",
        }
    return out


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
    is_class2 = class2_mask(dataset_path, groups)

    truth_px_all = to_pixels(target.reshape(-1, 24, 2), groups, dims)

    # ── 실험 1: 배율 2개(클래스2 / 나머지)로 나눠 A/B ─────────────────────────
    per_seed_two, bias_log = [], []
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
                fit_pred = tr.predict_stages(models, x[rows_train], base[rows_train],
                                            PER_STAGE, CUMULATIVE)[0]
                fit_px = to_pixels(fit_pred.reshape(-1, 24, 2), groups[rows_train], dims)
                train_c2 = is_class2[rows_train]
                # 배율은 train 케이스의 in-fold 예측에서만 산출한다(test 정답 미사용).
                bias_c2 = (fit_bias(fit_px[train_c2], truth_px_all[rows_train][train_c2])
                           if train_c2.sum() >= 5 else 1.0)
                bias_other = (fit_bias(fit_px[~train_c2], truth_px_all[rows_train][~train_c2])
                              if (~train_c2).sum() >= 5 else 1.0)
                bias_log.append({"seed": seed, "fold": fold_index, "arm": arm,
                                 "class2": round(bias_c2, 4), "other": round(bias_other, 4)})
                test_pred = tr.predict_stages(models, x[test_rows], base[test_rows],
                                             PER_STAGE, CUMULATIVE)[0]
                test_px = apply_group_bias(
                    to_pixels(test_pred.reshape(-1, 24, 2), groups[test_rows], dims),
                    is_class2[test_rows], bias_c2, bias_other)
                for key, values in case_metrics(test_px, truth_px_all[test_rows]).items():
                    collected[arm].setdefault(key, []).append(values)
        ma = {k: np.concatenate(v) for k, v in collected["A"].items()}
        mb = {k: np.concatenate(v) for k, v in collected["B"].items()}
        per_seed_two.append({"seed": seed, "comparison": paired(ma, mb, seed)})

    keys = list(per_seed_two[0]["comparison"].keys())
    two_bias = summarize(per_seed_two, keys)

    # ── 실험 2: 전역 배율 그대로 두고, 평가를 클래스2 / 비클래스2로 쪼개서 A/B ──
    per_seed_split = {"class2": [], "other": []}
    for seed in SEEDS:
        masks = tr.grouped_folds(groups[legacy_rows], FOLDS, seed)
        collected = {"A": {}, "B": {}}
        flags = []
        for local_test in masks:
            test_rows = legacy_rows[local_test]
            train_a = legacy_rows[~local_test]
            train_b = np.concatenate([train_a, fresh_rows])
            flags.append(is_class2[test_rows])
            for arm, rows_train in (("A", train_a), ("B", train_b)):
                models = tr.fit_stages(x[rows_train], base[rows_train], target[rows_train],
                                       STAGE_HYPER, PER_STAGE, CUMULATIVE)
                fit_pred = tr.predict_stages(models, x[rows_train], base[rows_train],
                                            PER_STAGE, CUMULATIVE)[0]
                fit_px = to_pixels(fit_pred.reshape(-1, 24, 2), groups[rows_train], dims)
                bias = fit_bias(fit_px, truth_px_all[rows_train])
                test_pred = tr.predict_stages(models, x[test_rows], base[test_rows],
                                             PER_STAGE, CUMULATIVE)[0]
                test_px = scale_about_midpoint(
                    to_pixels(test_pred.reshape(-1, 24, 2), groups[test_rows], dims), bias)
                for key, values in case_metrics(test_px, truth_px_all[test_rows]).items():
                    collected[arm].setdefault(key, []).append(values)
        flag = np.concatenate(flags)
        ma = {k: np.concatenate(v) for k, v in collected["A"].items()}
        mb = {k: np.concatenate(v) for k, v in collected["B"].items()}
        for label, sel in (("class2", flag), ("other", ~flag)):
            if sel.sum() < 10:
                continue
            per_seed_split[label].append({
                "seed": seed,
                "comparison": paired({k: v[sel] for k, v in ma.items()},
                                     {k: v[sel] for k, v in mb.items()}, seed),
            })

    split = {label: summarize(rows, keys) for label, rows in per_seed_split.items() if rows}
    split_counts = {label: len(rows) for label, rows in per_seed_split.items()}

    b_c2 = [row["class2"] for row in bias_log if row["arm"] == "B"]
    b_other = [row["other"] for row in bias_log if row["arm"] == "B"]
    report = {
        "schemaVersion": "class2-scale-test-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("폭 스케일 차가 주석자 속성이 아니라 클래스2 케이스 속성임을 확인한 뒤, "
                 "(1) 배율을 클래스2/나머지 2개로 나누면 길이 악화가 회복되는지, "
                 "(2) 평가를 클래스2 케이스로 한정하면 신규 116건이 이득인지 실측. "
                 "평가 집합은 기존 268건 고정, 신규는 train에만. mm는 정답 최외곽 스팬=54mm, "
                 f"픽셀 등방 공간, 부트스트랩 {BOOTSTRAP}회, 시드 {list(SEEDS)}."),
        "class2Counts": {
            "legacyClass2": int(is_class2[legacy_rows].sum()),
            "legacyOther": int((~is_class2[legacy_rows]).sum()),
            "freshClass2": int(is_class2[fresh_rows].sum()),
        },
        "twoGroupBias": {
            "refitClass2": {"mean": round(float(np.mean(b_c2)), 4),
                            "min": round(float(np.min(b_c2)), 4),
                            "max": round(float(np.max(b_c2)), 4)},
            "refitOther": {"mean": round(float(np.mean(b_other)), 4),
                           "min": round(float(np.min(b_other)), 4),
                           "max": round(float(np.max(b_other)), 4)},
            "acrossSeeds": two_bias,
        },
        "evaluationSplit": {"seedsUsed": split_counts, "acrossSeeds": split},
    }
    (HERE / "class2_scale_test.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"legacy class2 {report['class2Counts']['legacyClass2']} / "
          f"other {report['class2Counts']['legacyOther']} | "
          f"fresh class2 {report['class2Counts']['freshClass2']}")
    print(f"\nrefit bias with TWO groups (arm B): class2 {np.mean(b_c2):.4f}  "
          f"other {np.mean(b_other):.4f}")
    print("experiment 1 - A vs B with two-group bias, OOF on same legacy cases:")
    for key in keys:
        row = two_bias[key]
        print(f"   {key:10s} mean {row['meanGainPercent']:+.2f}% | "
              f"improved {row['seedsImproved']} | sig {row['seedsSignificant']}")
    print("\nexperiment 2 - global bias, evaluation split by class:")
    for label in ("class2", "other"):
        if label not in split:
            continue
        print(f"  [{label}]")
        for key in keys:
            row = split[label][key]
            print(f"   {key:10s} mean {row['meanGainPercent']:+.2f}% | "
                  f"improved {row['seedsImproved']} | sig {row['seedsSignificant']}")


if __name__ == "__main__":
    main()
