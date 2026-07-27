#!/usr/bin/env python3
"""치아폭 선분의 "위치" 오차를 길이 오차와 분리해 측정 — 좌우 비교.

사용자 관찰(2026-07-27): "좌우 어금니 길이 차이는 거의 없지만, 치아폭을 표기한
선분의 위치가 왼쪽은 어금니에 비교적 일치하는데 오른쪽은 많이 벗어나 있다."

앞선 측정은 좌표 MAE만 봤다. 좌표 MAE는 (선분 위치 이동) + (길이 오차) +
(각도 오차)를 모두 뭉쳐놓은 값이라, 길이는 맞고 위치만 틀리는 상황을 구분하지
못한다. 여기서는 각 치아의 폭 선분을 세 성분으로 분해한다.

  ① 위치(중점 이동): 예측 선분의 중점 − 정답 선분의 중점
     - 정답 선분 방향의 성분(along)  = 치아 길이축 방향으로 밀림
     - 그 수직 성분(perp)            = 치아에서 옆으로 벗어남
  ② 길이: |예측 길이 − 정답 길이|
  ③ 각도: 예측 선분과 정답 선분이 이루는 각(도)

핵심은 "부호 일관성"이다. 오차의 방향이 케이스마다 랜덤이면 눈에는 안 보이지만,
같은 방향으로 계통적으로 밀리면 **육안으로 즉시 보인다**. 그래서 평균 벡터의
크기 / 평균 크기 = coherence(0~1)를 함께 낸다. coherence가 높을수록 "항상 같은
쪽으로 밀린다"는 뜻이다.

또한 중점 이동이 치아 폭의 절반을 넘으면 선분이 **옆 치아 쪽에 걸친다**고 보고
그 케이스 비율을 센다(육안으로 "많이 벗어났다"에 해당).

width 268건 grouped 5-fold OOF, 2단계. 출력에 PHI·좌표·모델 파라미터 없음.
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
BOOTSTRAP = 5000
LEFT_TEETH = (1, 2)     # 268/268 케이스에서 영상 왼쪽으로 확인됨 (_molar_lr.py)
RIGHT_TEETH = (11, 12)
EPS = 1e-12


def points(arr):
    return arr.reshape(len(arr), 24, 2)


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


def decompose(target, prediction, tooth, scale):
    """치아 하나의 선분 오차를 위치(along/perp)·길이·각도로 분해. 전부 mm/도."""
    a, b = 2 * (tooth - 1), 2 * (tooth - 1) + 1
    pt, pp = points(target), points(prediction)
    t0, t1 = pt[:, a, :], pt[:, b, :]
    p0, p1 = pp[:, a, :], pp[:, b, :]

    truth_vec = t1 - t0
    truth_len = np.linalg.norm(truth_vec, axis=1)
    unit = truth_vec / np.maximum(truth_len[:, None], EPS)
    normal = np.stack((-unit[:, 1], unit[:, 0]), axis=1)

    shift = (p0 + p1) / 2.0 - (t0 + t1) / 2.0
    along = (shift * unit).sum(axis=1) * scale        # 치아 길이축 방향 밀림 (mm)
    perp = (shift * normal).sum(axis=1) * scale       # 치아에서 옆으로 벗어남 (mm)

    pred_vec = p1 - p0
    pred_len = np.linalg.norm(pred_vec, axis=1)
    length_err = (pred_len - truth_len) * scale       # 부호 있는 길이 오차 (mm)

    cos = np.clip((unit * (pred_vec / np.maximum(pred_len[:, None], EPS))).sum(axis=1), -1.0, 1.0)
    angle = np.degrees(np.arccos(np.abs(cos)))        # 0~90도, 방향 무관

    return {
        "along": along, "perp": perp, "lengthErr": length_err, "angle": angle,
        "shiftMm": np.linalg.norm(shift, axis=1) * scale,
        "truthLenMm": truth_len * scale,
    }


def coherence(vector_x, vector_y):
    """평균 벡터 크기 / 평균 크기. 1에 가까우면 항상 같은 방향으로 밀린다."""
    magnitude = np.hypot(vector_x, vector_y)
    mean_magnitude = float(magnitude.mean())
    if mean_magnitude < EPS:
        return 0.0
    return float(np.hypot(vector_x.mean(), vector_y.mean()) / mean_magnitude)


def summarize_side(parts, label):
    along = np.concatenate([p["along"] for p in parts])
    perp = np.concatenate([p["perp"] for p in parts])
    length_err = np.concatenate([p["lengthErr"] for p in parts])
    angle = np.concatenate([p["angle"] for p in parts])
    shift = np.concatenate([p["shiftMm"] for p in parts])
    truth_len = np.concatenate([p["truthLenMm"] for p in parts])
    return {
        "label": label,
        "positionShiftMaeMm": float(shift.mean()),
        "positionShiftP95Mm": float(np.quantile(shift, 0.95)),
        "alongSignedMeanMm": float(along.mean()),
        "alongAbsMeanMm": float(np.abs(along).mean()),
        "perpSignedMeanMm": float(perp.mean()),
        "perpAbsMeanMm": float(np.abs(perp).mean()),
        "lengthSignedMeanMm": float(length_err.mean()),
        "lengthAbsMeanMm": float(np.abs(length_err).mean()),
        "angleMeanDeg": float(angle.mean()),
        "angleP95Deg": float(np.quantile(angle, 0.95)),
        "shiftCoherence": coherence(along, perp),
        "shiftAsPctOfToothWidth": float((shift / np.maximum(truth_len, EPS)).mean() * 100),
        "casesShiftedOverHalfToothWidthPct": float((shift > 0.5 * truth_len).mean() * 100),
        "casesShiftedOverQuarterToothWidthPct": float((shift > 0.25 * truth_len).mean() * 100),
        "positionVsLengthErrorRatio": float(shift.mean() / max(np.abs(length_err).mean(), EPS)),
    }


def paired_bootstrap(a, b, seed):
    rng = np.random.default_rng(seed)
    diff = a - b
    n = len(diff)
    means = np.array([diff[rng.integers(0, n, n)].mean() for _ in range(BOOTSTRAP)])
    return {"meanDiff": float(diff.mean()), "ci95Low": float(np.quantile(means, 0.025)),
            "ci95High": float(np.quantile(means, 0.975)),
            "probAGreaterThanB": float((means > 0).mean())}


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


def apply_bias(prediction, factor):
    """HTML의 WIDTH_BIAS: 중점 고정 확대 → 위치는 안 바뀌고 길이만 바뀐다(확인용)."""
    p = points(prediction).copy()
    for t in range(12):
        a, b = p[:, 2 * t, :], p[:, 2 * t + 1, :]
        mid = (a + b) / 2.0
        p[:, 2 * t, :] = mid + (a - mid) * factor
        p[:, 2 * t + 1, :] = mid + (b - mid) * factor
    return np.clip(p.reshape(len(prediction), -1), 0.0, 1.0)


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    scale = truth_scale(target)
    prediction = oof(x, base, target, groups, masks)
    biased = apply_bias(prediction, HTML_WIDTH_BIAS)

    report = {
        "schemaVersion": "molar-offset-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("width 268건 grouped 5-fold OOF, 2단계. 선분 오차를 위치(중점이동)·길이·각도로 "
                 "분해. mm 스케일은 정답 최외곽 스팬=54mm 고정. 영상 왼쪽=치아1·2, 오른쪽=치아11·12. "
                 "along=치아 길이축 방향 밀림, perp=치아에서 옆으로 벗어남."),
        "samples": int(x.shape[0]),
    }

    for name, source in (("stage2", prediction), ("ruleDraft", base), ("stage2WithHtmlBias1051", biased)):
        left_parts = [decompose(target, source, t, scale) for t in LEFT_TEETH]
        right_parts = [decompose(target, source, t, scale) for t in RIGHT_TEETH]
        left = summarize_side(left_parts, "image-left molars (teeth 1,2)")
        right = summarize_side(right_parts, "image-right molars (teeth 11,12)")
        report[name] = {
            "left": left, "right": right,
            "rightMinusLeft_positionShiftMm": right["positionShiftMaeMm"] - left["positionShiftMaeMm"],
            "rightWorsePct_positionShift": float(
                (right["positionShiftMaeMm"] - left["positionShiftMaeMm"]) / left["positionShiftMaeMm"] * 100),
            "rightWorsePct_lengthAbs": float(
                (right["lengthAbsMeanMm"] - left["lengthAbsMeanMm"]) / left["lengthAbsMeanMm"] * 100),
        }
        print(f"{name}: left shift {left['positionShiftMaeMm']:.3f}mm  right shift {right['positionShiftMaeMm']:.3f}mm")

    # 케이스 단위 짝지은 비교 (2단계, 좌우 위치이동)
    left_shift = np.mean([decompose(target, prediction, t, scale)["shiftMm"] for t in LEFT_TEETH], axis=0)
    right_shift = np.mean([decompose(target, prediction, t, scale)["shiftMm"] for t in RIGHT_TEETH], axis=0)
    report["pairedBootstrap_positionShift_rightMinusLeft"] = paired_bootstrap(
        right_shift, left_shift, SEED + 91)
    report["perCasePositionShift"] = {
        "rightWorseCases": int((right_shift > left_shift).sum()),
        "leftWorseCases": int((right_shift < left_shift).sum()),
        "rightWorseSharePct": float((right_shift > left_shift).mean() * 100),
        "meanAbsAsymmetryMm": float(np.abs(right_shift - left_shift).mean()),
        "asymmetryP95Mm": float(np.quantile(np.abs(right_shift - left_shift), 0.95)),
        "casesRightShiftOver2xLeft": int((right_shift > 2.0 * np.maximum(left_shift, EPS)).sum()),
        "casesLeftShiftOver2xRight": int((left_shift > 2.0 * np.maximum(right_shift, EPS)).sum()),
    }

    # 전 12치아 위치이동 프로파일 (중앙 vs 최말단)
    per_tooth = []
    for t in range(1, 13):
        d = decompose(target, prediction, t, scale)
        r = decompose(target, base, t, scale)
        per_tooth.append({
            "tooth": t,
            "stage2_positionShiftMaeMm": float(d["shiftMm"].mean()),
            "rule_positionShiftMaeMm": float(r["shiftMm"].mean()),
            "stage2_lengthAbsMeanMm": float(np.abs(d["lengthErr"]).mean()),
            "stage2_alongSignedMm": float(d["along"].mean()),
            "stage2_perpSignedMm": float(d["perp"].mean()),
            "stage2_shiftCoherence": coherence(d["along"], d["perp"]),
            "stage2_shiftAsPctOfToothWidth": float((d["shiftMm"] / np.maximum(d["truthLenMm"], EPS)).mean() * 100),
            "stage2_angleMeanDeg": float(d["angle"].mean()),
        })
    report["perTooth"] = per_tooth

    left_s, right_s = report["stage2"]["left"], report["stage2"]["right"]
    report["verdict"] = {
        "positionErrorDominatesLength": bool(left_s["positionVsLengthErrorRatio"] > 1.0
                                             or right_s["positionVsLengthErrorRatio"] > 1.0),
        "systematicSideDifferenceInPosition": (
            "no" if 40.0 <= report["perCasePositionShift"]["rightWorseSharePct"] <= 60.0 else "yes"),
        "rightShiftCoherence": right_s["shiftCoherence"],
        "leftShiftCoherence": left_s["shiftCoherence"],
        "htmlBiasMovesPosition": bool(
            abs(report["stage2WithHtmlBias1051"]["right"]["positionShiftMaeMm"]
                - right_s["positionShiftMaeMm"]) > 1e-9),
    }

    (HERE / "molar_offset_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
