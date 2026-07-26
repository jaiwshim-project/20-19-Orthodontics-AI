#!/usr/bin/env python3
"""왼쪽 어금니가 오른쪽보다 정확한 이유 규명 — 좌우 비대칭 OOF 측정.

사용자 관찰: "어금니 치아폭 분석에서 왼쪽 어금니가 오른쪽보다 비교적 정확하다."

가설 후보:
  H1 치아 인덱스↔영상 좌우의 대응이 케이스마다 뒤집힌다(방향 규약 불일치).
     그러면 모델은 서로 거울인 두 분포를 한 출력에 섞어 학습하게 되고,
     한쪽이 다수면 그쪽만 정확해진다.
  H2 규칙엔진 초안 자체가 이미 한쪽에서 더 나쁘다(잔차보정이 아니라 초안의 문제).
  H3 정답(라벨) 쪽이 한쪽에서 더 흩어져 있다(합의 불일치·주석 난이도).
  H4 잔차보정이 비대칭을 만든다/키운다(초안은 대칭인데 보정 후 비대칭).
  H5 영상 내 위치 효과: 화면 왼쪽 절반/오른쪽 절반에 있는 점의 오차 차이.

측정: 268건 grouped 5-fold OOF(2단계, 단계캡5%/누적10%).
치아 인덱스별·영상측별로 좌표 MAE, 길이 mm 오차, 부호 있는 편향을 모두 낸다.
짝지은 케이스 부트스트랩으로 좌우 차이가 유의한지도 본다.

출력에 PHI·좌표·모델 파라미터 없음(집계값만).
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
SCALE_MM = 54.0
BOOTSTRAP = 5000
# 치아 1·2 = 한쪽 끝, 11·12 = 반대쪽 끝
END_A_TEETH = (1, 2)
END_B_TEETH = (11, 12)


def points(arr):
    return arr.reshape(len(arr), 24, 2)


def tooth_points(index):
    """치아 t(1-based)의 width 두 끝점 인덱스."""
    return (2 * (index - 1), 2 * (index - 1) + 1)


def coord_err(target, prediction, point_ids):
    t = points(target)[:, point_ids, :]
    p = points(prediction)[:, point_ids, :]
    return np.linalg.norm((p - t), axis=2).reshape(len(target), -1) / np.sqrt(2.0)


def truth_scale(target):
    """정답의 최외곽 스팬 = 54 mm. 예측이 스케일로 오차를 숨기지 못하게 고정."""
    pt = points(target)
    scale = np.zeros(len(target))
    for k in range(len(target)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale[k] = SCALE_MM / span if span > 0 else 0.0
    return scale


def tooth_lengths_mm(arr, scale):
    p = points(arr)
    out = np.zeros((len(arr), 12))
    for t in range(12):
        out[:, t] = np.linalg.norm(p[:, 2 * t, :] - p[:, 2 * t + 1, :], axis=1) * scale
    return out


def oof(x, base, target, groups, masks):
    prediction = np.zeros_like(target)
    for index, test_mask in enumerate(masks, start=1):
        train = ~test_mask
        chosen = tr.select_stage_hyperparameters(
            x[train], base[train], target[train], groups[train],
            SEED + index * 1009, PER_STAGE, min(4, FOLDS), STAGES, CUMULATIVE)
        fitted = tr.fit_stages(x[train], base[train], target[train], chosen, PER_STAGE, CUMULATIVE)
        fold_prediction, _, _ = tr.predict_stages(
            fitted, x[test_mask], base[test_mask], PER_STAGE, CUMULATIVE)
        prediction[test_mask] = fold_prediction
        print(f"fold {index} done")
    return prediction


def paired_bootstrap(per_case_a, per_case_b, seed):
    """케이스 단위 짝지은 부트스트랩: (a - b) 평균의 CI. a=오른쪽, b=왼쪽 식으로 넣는다."""
    rng = np.random.default_rng(seed)
    diff = per_case_a - per_case_b
    n = len(diff)
    means = np.empty(BOOTSTRAP)
    for i in range(BOOTSTRAP):
        means[i] = diff[rng.integers(0, n, n)].mean()
    return {
        "meanDiff": float(diff.mean()),
        "ci95Low": float(np.quantile(means, 0.025)),
        "ci95High": float(np.quantile(means, 0.975)),
        "probAGreaterThanB": float((means > 0).mean()),
    }


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    scale = truth_scale(target)
    prediction = oof(x, base, target, groups, masks)

    report = {
        "schemaVersion": "molar-lr-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("width 268건 grouped 5-fold OOF, 2단계(단계캡5%/누적10%). "
                 "mm 스케일은 항상 정답 최외곽 스팬=54mm 고정. 집계값만 기록."),
        "samples": int(x.shape[0]),
    }

    # ── H1: 치아 인덱스 ↔ 영상 좌우 대응이 케이스마다 일관적인가
    pt = points(target)
    x_end_a = pt[:, [p for t in END_A_TEETH for p in tooth_points(t)], 0].mean(axis=1)
    x_end_b = pt[:, [p for t in END_B_TEETH for p in tooth_points(t)], 0].mean(axis=1)
    a_is_left = x_end_a < x_end_b
    report["orientationConsistency"] = {
        "teeth1n2_onImageLeft_cases": int(a_is_left.sum()),
        "teeth11n12_onImageLeft_cases": int((~a_is_left).sum()),
        "majoritySharePct": float(max(a_is_left.mean(), 1 - a_is_left.mean()) * 100),
        "verdict": ("consistent" if a_is_left.all() or (~a_is_left).all() else "mixed orientation"),
    }

    # ── 치아 인덱스별 오차 (전 12치아)
    per_tooth = []
    truth_len = tooth_lengths_mm(target, scale)
    pred_len = tooth_lengths_mm(prediction, scale)
    base_len = tooth_lengths_mm(base, scale)
    for t in range(1, 13):
        ids = list(tooth_points(t))
        per_tooth.append({
            "tooth": t,
            "ruleCoordMae": float(coord_err(target, base, ids).mean()),
            "stage2CoordMae": float(coord_err(target, prediction, ids).mean()),
            "stage2LengthMaeMm": float(np.abs(pred_len[:, t - 1] - truth_len[:, t - 1]).mean()),
            "ruleLengthMaeMm": float(np.abs(base_len[:, t - 1] - truth_len[:, t - 1]).mean()),
            "stage2LengthSignedBiasPct": float(
                ((pred_len[:, t - 1] - truth_len[:, t - 1]) / truth_len[:, t - 1]).mean() * 100),
            "truthLengthMeanMm": float(truth_len[:, t - 1].mean()),
            "truthLengthStdMm": float(truth_len[:, t - 1].std()),
            "meanImageX": float(pt[:, ids, 0].mean()),
        })
    report["perTooth"] = per_tooth

    # ── 영상 기준 좌/우로 묶기 (인덱스가 아니라 실제 화면 위치로)
    # 각 케이스에서 x가 작은 쪽 끝 2치아 = 영상 왼쪽 어금니, 큰 쪽 = 영상 오른쪽
    left_teeth = np.where(a_is_left[:, None], np.array(END_A_TEETH), np.array(END_B_TEETH))
    right_teeth = np.where(a_is_left[:, None], np.array(END_B_TEETH), np.array(END_A_TEETH))

    def side_metrics(side_teeth, label):
        coord_case, len_case, signed_case, rule_coord_case, rule_len_case = [], [], [], [], []
        truth_std_all = []
        for k in range(len(target)):
            ids = [p for t in side_teeth[k] for p in tooth_points(int(t))]
            tooth_ids = [int(t) - 1 for t in side_teeth[k]]
            coord_case.append(float(coord_err(target[k:k + 1], prediction[k:k + 1], ids).mean()))
            rule_coord_case.append(float(coord_err(target[k:k + 1], base[k:k + 1], ids).mean()))
            len_case.append(float(np.abs(pred_len[k, tooth_ids] - truth_len[k, tooth_ids]).mean()))
            rule_len_case.append(float(np.abs(base_len[k, tooth_ids] - truth_len[k, tooth_ids]).mean()))
            signed_case.append(float(((pred_len[k, tooth_ids] - truth_len[k, tooth_ids])
                                      / truth_len[k, tooth_ids]).mean() * 100))
            truth_std_all.append(truth_len[k, tooth_ids].mean())
        return {
            "label": label,
            "stage2CoordMae": float(np.mean(coord_case)),
            "ruleCoordMae": float(np.mean(rule_coord_case)),
            "stage2LengthMaeMm": float(np.mean(len_case)),
            "ruleLengthMaeMm": float(np.mean(rule_len_case)),
            "stage2LengthSignedBiasPct": float(np.mean(signed_case)),
            "truthLengthMeanMm": float(np.mean(truth_std_all)),
            "_perCaseCoord": np.asarray(coord_case),
            "_perCaseLen": np.asarray(len_case),
            "_perCaseRuleCoord": np.asarray(rule_coord_case),
        }

    left = side_metrics(left_teeth, "image-left molars")
    right = side_metrics(right_teeth, "image-right molars")

    report["byImageSide"] = {
        "left": {k: v for k, v in left.items() if not k.startswith("_")},
        "right": {k: v for k, v in right.items() if not k.startswith("_")},
        "rightMinusLeft_coordMae": float(right["stage2CoordMae"] - left["stage2CoordMae"]),
        "rightWorseByPct_coord": float(
            (right["stage2CoordMae"] - left["stage2CoordMae"]) / left["stage2CoordMae"] * 100),
        "rightWorseByPct_lengthMm": float(
            (right["stage2LengthMaeMm"] - left["stage2LengthMaeMm"]) / left["stage2LengthMaeMm"] * 100),
        "ruleEngine_rightWorseByPct_coord": float(
            (right["ruleCoordMae"] - left["ruleCoordMae"]) / left["ruleCoordMae"] * 100),
    }
    report["byImageSide"]["pairedBootstrapCoord_rightMinusLeft"] = paired_bootstrap(
        right["_perCaseCoord"], left["_perCaseCoord"], SEED + 77)
    report["byImageSide"]["pairedBootstrapLengthMm_rightMinusLeft"] = paired_bootstrap(
        right["_perCaseLen"], left["_perCaseLen"], SEED + 78)
    report["byImageSide"]["pairedBootstrapRuleCoord_rightMinusLeft"] = paired_bootstrap(
        right["_perCaseRuleCoord"], left["_perCaseRuleCoord"], SEED + 79)

    # ── 인덱스 기준 좌/우 (치아1·2 vs 11·12) — 인덱스 규약 자체의 비대칭
    ids_a = [p for t in END_A_TEETH for p in tooth_points(t)]
    ids_b = [p for t in END_B_TEETH for p in tooth_points(t)]
    report["byToothIndexEnd"] = {
        "teeth1n2": {
            "ruleCoordMae": float(coord_err(target, base, ids_a).mean()),
            "stage2CoordMae": float(coord_err(target, prediction, ids_a).mean()),
            "stage2LengthMaeMm": float(np.abs(pred_len[:, [0, 1]] - truth_len[:, [0, 1]]).mean()),
            "truthLengthMeanMm": float(truth_len[:, [0, 1]].mean()),
        },
        "teeth11n12": {
            "ruleCoordMae": float(coord_err(target, base, ids_b).mean()),
            "stage2CoordMae": float(coord_err(target, prediction, ids_b).mean()),
            "stage2LengthMaeMm": float(np.abs(pred_len[:, [10, 11]] - truth_len[:, [10, 11]]).mean()),
            "truthLengthMeanMm": float(truth_len[:, [10, 11]].mean()),
        },
    }

    # ── H3: 정답 라벨의 좌우 일치도 (여러 전문가 주석 간 불일치가 한쪽에 몰렸는가)
    # truth_consensus가 이미 합의를 냈으므로, 여기서는 정답 길이의 좌우 분산으로 대리 측정
    report["truthDispersion"] = {
        "teeth1n2_lengthStdMm": float(truth_len[:, [0, 1]].std()),
        "teeth11n12_lengthStdMm": float(truth_len[:, [10, 11]].std()),
        "middleTeeth_lengthStdMm": float(truth_len[:, 4:8].std()),
    }

    # ── H4: 보정이 비대칭을 만드는가 (초안 비대칭 대비 보정후 비대칭)
    rule_asym = report["byImageSide"]["ruleEngine_rightWorseByPct_coord"]
    stage_asym = report["byImageSide"]["rightWorseByPct_coord"]
    report["asymmetryOrigin"] = {
        "ruleDraftAsymmetryPct": rule_asym,
        "afterCorrectionAsymmetryPct": stage_asym,
        "verdict": ("inherited from rule draft" if abs(rule_asym) >= abs(stage_asym)
                    else "amplified by residual correction"),
    }

    (HERE / "molar_lr_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
