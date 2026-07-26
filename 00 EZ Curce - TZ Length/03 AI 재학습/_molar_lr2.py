#!/usr/bin/env python3
"""좌우 어금니 정확도 차이의 원인 규명 2차 — 케이스별 분포와 구동 요인.

1차(`_molar_lr.py`) 결과: 좌우 방향 규약은 268건 전부 일관(치아1·2가 항상 영상
왼쪽), 평균 좌우 격차는 1.34%(부트스트랩 CI가 0을 포함) — 즉 **평균으로는 계통적
좌우 편향이 없다**. 그러면 사용자가 본 "왼쪽이 더 정확하다"는 케이스별 현상이므로,
케이스별 분포와 무엇이 그것을 결정하는지를 본다.

측정:
  A. 케이스별 (오른쪽 − 왼쪽) 어금니 오차 분포: 오른쪽이 나쁜 비율, 사분위, 극단값
  B. 무엇이 좌우 격차를 만드는가 — 케이스 단위 상관:
     ① 아치 회전/기울기(양쪽 최말단 어금니를 잇는 선의 기울기)
     ② 좌우 최말단 어금니의 정답 길이 차이(=실제 비대칭 or 원근)
     ③ 좌우 규칙엔진 초안 오차 차이(초안이 이미 한쪽에서 나쁜가)
     ④ 좌우 어금니의 영상 내 세로 위치 차이(원근/카메라 축 이탈 대리지표)
  C. 치아 3의 부호편향 +10.8% 이상치 확인(다른 치아는 전부 음수)
  D. 연구용 HTML이 실제 적용하는 WIDTH_BIAS 1.051을 곱한 뒤의 좌우 격차
     (사용자가 화면에서 보는 값과 같은 조건)

출력에 PHI·좌표·모델 파라미터 없음(집계값·상관계수만).
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
HTML_WIDTH_BIAS = 1.051
LEFT_TEETH = (1, 2)      # 1차 측정에서 268/268 케이스 모두 영상 왼쪽으로 확인됨
RIGHT_TEETH = (11, 12)


def points(arr):
    return arr.reshape(len(arr), 24, 2)


def tooth_ids(teeth):
    return [p for t in teeth for p in (2 * (t - 1), 2 * (t - 1) + 1)]


def per_case_coord(target, prediction, ids):
    t = points(target)[:, ids, :]
    p = points(prediction)[:, ids, :]
    return (np.linalg.norm(p - t, axis=2) / np.sqrt(2.0)).mean(axis=1)


def truth_scale(target):
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


def lengths_mm(arr, scale):
    p = points(arr)
    out = np.zeros((len(arr), 12))
    for t in range(12):
        out[:, t] = np.linalg.norm(p[:, 2 * t, :] - p[:, 2 * t + 1, :], axis=1) * scale
    return out


def apply_bias(prediction, factor):
    p = points(prediction).copy()
    for t in range(12):
        a, b = p[:, 2 * t, :], p[:, 2 * t + 1, :]
        mid = (a + b) / 2.0
        p[:, 2 * t, :] = mid + (a - mid) * factor
        p[:, 2 * t + 1, :] = mid + (b - mid) * factor
    return np.clip(p.reshape(len(prediction), -1), 0.0, 1.0)


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


def corr(a, b):
    if np.std(a) < 1e-12 or np.std(b) < 1e-12:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def quantiles(values):
    return {f"p{int(q*100)}": float(np.quantile(values, q)) for q in (0.05, 0.25, 0.5, 0.75, 0.95)}


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    scale = truth_scale(target)
    prediction = oof(x, base, target, groups, masks)
    biased = apply_bias(prediction, HTML_WIDTH_BIAS)

    left_ids, right_ids = tooth_ids(LEFT_TEETH), tooth_ids(RIGHT_TEETH)
    left_err = per_case_coord(target, prediction, left_ids)
    right_err = per_case_coord(target, prediction, right_ids)
    left_rule = per_case_coord(target, base, left_ids)
    right_rule = per_case_coord(target, base, right_ids)
    diff = right_err - left_err

    truth_len = lengths_mm(target, scale)
    pred_len = lengths_mm(prediction, scale)
    bias_len = lengths_mm(biased, scale)
    left_len_err = np.abs(pred_len[:, [0, 1]] - truth_len[:, [0, 1]]).mean(axis=1)
    right_len_err = np.abs(pred_len[:, [10, 11]] - truth_len[:, [10, 11]]).mean(axis=1)

    pt = points(target)
    left_centroid = pt[:, left_ids, :].mean(axis=1)
    right_centroid = pt[:, right_ids, :].mean(axis=1)
    vertical_gap = right_centroid[:, 1] - left_centroid[:, 1]
    arch_tilt_deg = np.degrees(np.arctan2(
        right_centroid[:, 1] - left_centroid[:, 1],
        np.maximum(np.abs(right_centroid[:, 0] - left_centroid[:, 0]), 1e-9)))
    truth_len_gap = truth_len[:, [10, 11]].mean(axis=1) - truth_len[:, [0, 1]].mean(axis=1)
    rule_diff = right_rule - left_rule

    report = {
        "schemaVersion": "molar-lr2-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("width 268건 grouped 5-fold OOF, 2단계. 1차 측정에서 방향 규약은 268/268 일관. "
                 "영상 왼쪽 어금니=치아1·2, 오른쪽=치아11·12. 집계값·상관계수만 기록."),
        "samples": int(x.shape[0]),

        "A_perCaseAsymmetry": {
            "rightWorseCaseCount": int((diff > 0).sum()),
            "leftWorseCaseCount": int((diff < 0).sum()),
            "rightWorseSharePct": float((diff > 0).mean() * 100),
            "meanAbsAsymmetryCoord": float(np.abs(diff).mean()),
            "meanSignedAsymmetryCoord": float(diff.mean()),
            "asymmetryQuantiles_rightMinusLeft": quantiles(diff),
            "casesWhereOneSideIs2xWorse": int((np.maximum(right_err, left_err)
                                               > 2.0 * np.minimum(right_err, left_err)).sum()),
            "meanAbsAsymmetryAsPctOfMeanErr": float(
                np.abs(diff).mean() / ((right_err.mean() + left_err.mean()) / 2) * 100),
            "interpretation": ("케이스별 좌우 격차는 크지만 방향이 랜덤에 가까우면 "
                              "계통적 좌우 편향이 아니라 케이스별 변동이다."),
        },

        "B_whatDrivesAsymmetry_correlationWithRightMinusLeft": {
            "ruleDraftAsymmetry": corr(rule_diff, diff),
            "archTiltDeg": corr(arch_tilt_deg, diff),
            "verticalGapNormalized": corr(vertical_gap, diff),
            "truthLengthGapMm": corr(truth_len_gap, diff),
            "absArchTiltDeg_vsAbsAsymmetry": corr(np.abs(arch_tilt_deg), np.abs(diff)),
            "archTiltDegStats": {"mean": float(arch_tilt_deg.mean()),
                                 "std": float(arch_tilt_deg.std()),
                                 "absMean": float(np.abs(arch_tilt_deg).mean()),
                                 "absP95": float(np.quantile(np.abs(arch_tilt_deg), 0.95))},
            "truthLengthGapStats": {"meanMm": float(truth_len_gap.mean()),
                                    "absMeanMm": float(np.abs(truth_len_gap).mean()),
                                    "absP95Mm": float(np.quantile(np.abs(truth_len_gap), 0.95))},
        },

        "C_toothLevelSignedBiasPct": {
            f"tooth{t}": float(((pred_len[:, t - 1] - truth_len[:, t - 1]) / truth_len[:, t - 1]).mean() * 100)
            for t in range(1, 13)
        },

        "D_withHtmlWidthBias1051": {
            "left_lengthMaeMm": float(np.abs(bias_len[:, [0, 1]] - truth_len[:, [0, 1]]).mean()),
            "right_lengthMaeMm": float(np.abs(bias_len[:, [10, 11]] - truth_len[:, [10, 11]]).mean()),
            "left_signedBiasPct": float(((bias_len[:, [0, 1]] - truth_len[:, [0, 1]])
                                         / truth_len[:, [0, 1]]).mean() * 100),
            "right_signedBiasPct": float(((bias_len[:, [10, 11]] - truth_len[:, [10, 11]])
                                          / truth_len[:, [10, 11]]).mean() * 100),
            "noBias_left_lengthMaeMm": float(left_len_err.mean()),
            "noBias_right_lengthMaeMm": float(right_len_err.mean()),
        },

        "E_perTeethPairDetail": {
            "tooth1_coordMae": float(per_case_coord(target, prediction, [0, 1]).mean()),
            "tooth12_coordMae": float(per_case_coord(target, prediction, [22, 23]).mean()),
            "tooth2_coordMae": float(per_case_coord(target, prediction, [2, 3]).mean()),
            "tooth11_coordMae": float(per_case_coord(target, prediction, [20, 21]).mean()),
            "tooth1_vs_tooth12_worseByPct": float(
                (per_case_coord(target, prediction, [22, 23]).mean()
                 - per_case_coord(target, prediction, [0, 1]).mean())
                / per_case_coord(target, prediction, [0, 1]).mean() * 100),
        },
    }

    a = report["A_perCaseAsymmetry"]
    b = report["B_whatDrivesAsymmetry_correlationWithRightMinusLeft"]
    report["verdict"] = {
        "systematicSideBias": "no" if 40.0 <= a["rightWorseSharePct"] <= 60.0 else "yes",
        "dominantDriver": max(
            (("ruleDraftAsymmetry", abs(b["ruleDraftAsymmetry"] or 0)),
             ("archTiltDeg", abs(b["archTiltDeg"] or 0)),
             ("truthLengthGapMm", abs(b["truthLengthGapMm"] or 0))),
            key=lambda item: item[1])[0],
    }

    (HERE / "molar_lr2_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
