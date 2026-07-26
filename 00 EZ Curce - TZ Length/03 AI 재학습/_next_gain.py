#!/usr/bin/env python3
"""2단계 도입 이후 "정확도를 더 높이려면 무엇이 필요한가" — 후보 5종을 OOF로 측정.

섹션24의 진단은 1단계 모델 기준이었다. 2단계가 들어간 지금은 병목이 이동했을 수
있으므로 재측정한다. 모두 동일한 grouped 5-fold out-of-fold, 하이퍼파라미터
선택은 각 train 파티션 내부에서만.

측정 후보:
  ① 스테이지 수: 2 → 3, 4 (누적 캡을 단계수x5%로 함께 올려야 의미가 있다)
  ② 누적 캡: 2단계 유지, 누적 10% → 15%, 20% (단계별은 5% 고정)
  ③ WIDTH_BIAS 재교정: HTML의 1.051은 1단계 모델에서 잰 값. 2단계에서
     최적 배율이 얼마인지, 그리고 그게 실제로 이득인지.
  ④ 거리 게이트: 미숙지 폴백된 6%가 어금니 오차에 얼마나 기여하는가
     (게이트를 열면 얼마나 좋아지거나 나빠지는가).
  ⑤ 상한 오라클(2단계): 지금 특징으로 도달 가능한 최대치. 여기에 붙어 있으면
     라벨/특징 추가로 얻을 게 없다는 뜻.

출력에 PHI·좌표·모델 파라미터 없음.
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
SCALE_MM = 54.0
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]
MOLAR_INDEX = [t - 1 for t in MOLAR_TEETH]


def molar_error(target: np.ndarray, prediction: np.ndarray) -> dict[str, float]:
    t = target.reshape(len(target), 24, 2)[:, MOLAR_POINTS, :]
    p = prediction.reshape(len(prediction), 24, 2)[:, MOLAR_POINTS, :]
    err = np.linalg.norm((p - t).reshape(-1, 2), axis=1) / np.sqrt(2.0)
    return {"mae": float(err.mean()), "p95": float(np.quantile(err, 0.95))}


def all_error(target: np.ndarray, prediction: np.ndarray) -> float:
    err = np.linalg.norm((prediction - target).reshape(-1, 2), axis=1) / np.sqrt(2.0)
    return float(err.mean())


def length_mm(arr: np.ndarray, truth: np.ndarray) -> np.ndarray:
    """(n,48) → (n,12) 치아별 길이 mm. 스케일은 항상 정답의 최외곽 스팬=54mm."""
    pt = truth.reshape(len(truth), 24, 2)
    pp = arr.reshape(len(arr), 24, 2)
    out = np.zeros((len(arr), 12))
    for k in range(len(arr)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale = SCALE_MM / span if span > 0 else 0.0
        for t in range(12):
            out[k, t] = float(np.linalg.norm(pp[k][2 * t] - pp[k][2 * t + 1])) * scale
    return out


def summarize(target, prediction, truth_length, label):
    length = length_mm(prediction, target)
    molar_len = np.abs(length[:, MOLAR_INDEX] - truth_length[:, MOLAR_INDEX])
    tzl = np.abs(length.sum(axis=1) - truth_length.sum(axis=1))
    row = molar_error(target, prediction)
    row["allMae"] = all_error(target, prediction)
    row["molarLengthMaeMm"] = float(molar_len.mean())
    row["tzlSumMaeMm"] = float(tzl.mean())
    row["label"] = label
    return row


def oof_staged(x, base, target, groups, masks, stages: int, cumulative: float,
               force_gate_open: bool = False):
    prediction = np.zeros_like(target)
    accepted = np.zeros(x.shape[0], dtype=bool)
    for index, test_mask in enumerate(masks, start=1):
        train = ~test_mask
        chosen = tr.select_stage_hyperparameters(
            x[train], base[train], target[train], groups[train],
            SEED + index * 1009, PER_STAGE, min(4, FOLDS), stages, cumulative)
        fitted = tr.fit_stages(x[train], base[train], target[train], chosen, PER_STAGE, cumulative)
        fold_prediction, fold_accepted, _ = tr.predict_stages(
            fitted, x[test_mask], base[test_mask], PER_STAGE, cumulative)
        if force_gate_open:
            # 게이트를 무시하고 전원 보정 적용했을 때의 예측(폴백 기여도 측정용).
            forced = base[test_mask]
            for model in fitted:
                forced = tr.predict_krr(model, x[test_mask], forced, PER_STAGE)[0]
                forced = tr.clip_cumulative(forced, base[test_mask], cumulative)
            fold_prediction = forced
        prediction[test_mask] = fold_prediction
        accepted[test_mask] = fold_accepted
    return prediction, accepted


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    truth_length = length_mm(target, target)
    rows = [summarize(target, base, truth_length, "rule")]
    report = {}

    # 현행(2단계, 누적10%)
    current, accepted = oof_staged(x, base, target, groups, masks, 2, 0.10)
    rows.append(summarize(target, current, truth_length, "stage2-cum10 (현행)"))
    print("current done")

    # ① 스테이지 수 늘리기 (누적 캡 = 단계수 x 5%)
    for stages in (3, 4):
        prediction, _ = oof_staged(x, base, target, groups, masks, stages, 0.05 * stages)
        rows.append(summarize(target, prediction, truth_length, f"stage{stages}-cum{int(500*stages/100*10)//10*5}"))
        print(f"stages={stages} done")

    # ② 2단계 유지, 누적 캡만 완화
    for cumulative in (0.15, 0.20):
        prediction, _ = oof_staged(x, base, target, groups, masks, 2, cumulative)
        rows.append(summarize(target, prediction, truth_length, f"stage2-cum{int(cumulative*100)}"))
        print(f"cum={cumulative} done")

    report["variants"] = rows

    # ③ WIDTH_BIAS 재교정: 현행 2단계 예측에 배율을 곱했을 때 어금니/전체 길이 오차
    def apply_bias(prediction, factor):
        p = prediction.reshape(len(prediction), 24, 2).copy()
        for t in range(12):
            a, b = p[:, 2 * t, :], p[:, 2 * t + 1, :]
            mid = (a + b) / 2.0
            p[:, 2 * t, :] = mid + (a - mid) * factor
            p[:, 2 * t + 1, :] = mid + (b - mid) * factor
        return np.clip(p.reshape(len(prediction), -1), 0.0, 1.0)

    bias_rows = []
    for factor in (1.0, 1.02, 1.051, 1.08, 1.10):
        biased = apply_bias(current, factor)
        length = length_mm(biased, target)
        molar_len = np.abs(length[:, MOLAR_INDEX] - truth_length[:, MOLAR_INDEX])
        signed = (length[:, MOLAR_INDEX] - truth_length[:, MOLAR_INDEX]) / truth_length[:, MOLAR_INDEX]
        bias_rows.append({
            "factor": factor,
            "molarCoordMae": molar_error(target, biased)["mae"],
            "molarLengthMaeMm": float(molar_len.mean()),
            "molarLengthSignedBiasPct": float(signed.mean() * 100),
            "tzlSumMaeMm": float(np.abs(length.sum(axis=1) - truth_length.sum(axis=1)).mean()),
        })
    report["widthBias"] = bias_rows
    print("bias done")

    # ④ 거리 게이트 기여도
    forced, _ = oof_staged(x, base, target, groups, masks, 2, 0.10, force_gate_open=True)
    report["distanceGate"] = {
        "acceptedRate": float(accepted.mean()),
        "fallbackCount": int((~accepted).sum()),
        "withGate": summarize(target, current, truth_length, "gate on"),
        "gateForcedOpen": summarize(target, forced, truth_length, "gate forced open"),
        "fallbackCasesOnly": {
            "ruleMae": molar_error(target[~accepted], base[~accepted])["mae"] if (~accepted).any() else None,
            "forcedMae": molar_error(target[~accepted], forced[~accepted])["mae"] if (~accepted).any() else None,
        },
    }
    print("gate done")

    # ⑤ 상한 오라클(2단계): 잔차를 in-sample로 거의 완전 적합했을 때
    chosen = [(1.0, 1e-6), (1.0, 1e-6)]
    fitted = tr.fit_stages(x, base, target, chosen, PER_STAGE, 0.10)
    oracle, _, _ = tr.predict_stages(fitted, x, base, PER_STAGE, 0.10)
    report["inSampleOracle2Stage"] = summarize(target, oracle, truth_length, "in-sample fit (oracle)")
    # 방향 완벽 오라클: 정답 방향으로 누적 캡까지 최대 이동
    direction = target - base
    norm = np.linalg.norm(direction.reshape(len(direction), 24, 2), axis=2, keepdims=True)
    unit = np.divide(direction.reshape(len(direction), 24, 2), np.where(norm == 0, 1, norm))
    limit = np.minimum(norm, 0.10 * np.sqrt(2.0))
    perfect = np.clip((base.reshape(len(base), 24, 2) + unit * limit).reshape(len(base), -1), 0.0, 1.0)
    report["perfectDirectionCum10"] = summarize(target, perfect, truth_length, "perfect direction, cum 10%")
    print("oracle done")

    report.update({
        "schemaVersion": "next-gain-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": "전부 grouped 5-fold out-of-fold(오라클 2종만 in-sample 상한). 단계별 캡 5% 고정.",
        "widthSamples": int(x.shape[0]),
    })
    (HERE / "next_gain_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
