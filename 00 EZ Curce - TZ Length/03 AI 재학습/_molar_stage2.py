#!/usr/bin/env python3
"""어금니 정확도: 1단계 → 2단계(반복 잔차보정) 개선폭의 누출 없는 측정.

두 조건 모두 out-of-fold다. 공통 grouped 5-fold를 쓰고, 각 폴드에서
하이퍼파라미터 선택까지 train 파티션 안에서만 수행한다(테스트 그룹 미노출).
  - 조건 1: 1단계 KRR (캡 5%)
  - 조건 2: 2단계 KRR (단계별 캡 5%, 누적 캡 10%)
같은 폴드·같은 시드를 공유하므로 차이는 스테이지 수에서만 온다.

어금니 = 치아 1·2·11·12 → width 24포인트 중 0,1,2,3,20,21,22,23.
길이(mm) 환산 스케일은 항상 '정답' 기준으로 고정한다(예측이 스케일을 바꿔
오차를 숨기지 못하게).

출력은 PHI·좌표·모델 파라미터를 담지 않는다.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
DATASET = HERE / "dataset-index.json"
BASELINE = HERE / "baseline_predictions_all.json"
SEED = tr.DEFAULT_SEED
PER_STAGE_CAP = 0.05
CUMULATIVE_CAP = 0.10
FOLDS = 5
STAGES = 2
SCALE_MM = 54.0
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]
MOLAR_TEETH_INDEX = [t - 1 for t in MOLAR_TEETH]


def point_error(target: np.ndarray, prediction: np.ndarray, points: list[int] | None) -> dict[str, float]:
    t = target.reshape(len(target), 24, 2)
    p = prediction.reshape(len(prediction), 24, 2)
    if points is not None:
        t, p = t[:, points, :], p[:, points, :]
    delta = (p - t).reshape(-1, 2)
    err = np.linalg.norm(delta, axis=1) / np.sqrt(2.0)
    return {"mae": float(err.mean()), "p95": float(np.quantile(err, 0.95)), "n": int(err.size)}


def length_mm_truth_scale(arr: np.ndarray, truth: np.ndarray) -> np.ndarray:
    """(n,48) → (n,12) 치아별 길이(mm). 케이스별 스케일은 정답의 최외곽 스팬=54mm."""
    pt = truth.reshape(len(truth), 24, 2)
    pp = arr.reshape(len(arr), 24, 2)
    out = np.zeros((len(arr), 12))
    for k in range(len(arr)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        mm_per_unit = SCALE_MM / span if span > 0 else 0.0
        for t in range(12):
            out[k, t] = float(np.linalg.norm(pp[k][2 * t] - pp[k][2 * t + 1])) * mm_per_unit
    return out


def oof_prediction(x, base, target, groups, masks, stages: int) -> tuple[np.ndarray, np.ndarray]:
    prediction = np.zeros_like(target)
    accepted = np.zeros(x.shape[0], dtype=bool)
    for index, test_mask in enumerate(masks, start=1):
        train_mask = ~test_mask
        seed = SEED + index * 1009
        if stages == 1:
            _, gamma_factor, regularization = tr.select_hyperparameters(
                x[train_mask], base[train_mask], target[train_mask], groups[train_mask],
                seed, PER_STAGE_CAP, min(4, FOLDS),
            )
            model = tr.fit_krr(x[train_mask], base[train_mask], target[train_mask], gamma_factor, regularization)
            fold_prediction, fold_accepted, _ = tr.predict_krr(model, x[test_mask], base[test_mask], PER_STAGE_CAP)
        else:
            chosen = tr.select_stage_hyperparameters(
                x[train_mask], base[train_mask], target[train_mask], groups[train_mask],
                seed, PER_STAGE_CAP, min(4, FOLDS), stages, CUMULATIVE_CAP,
            )
            fitted = tr.fit_stages(
                x[train_mask], base[train_mask], target[train_mask], chosen, PER_STAGE_CAP, CUMULATIVE_CAP,
            )
            fold_prediction, fold_accepted, _ = tr.predict_stages(
                fitted, x[test_mask], base[test_mask], PER_STAGE_CAP, CUMULATIVE_CAP,
            )
        prediction[test_mask] = fold_prediction
        accepted[test_mask] = fold_accepted
    return prediction, accepted


def improvement(before: float, after: float) -> float:
    return (before - after) / before * 100.0


def main() -> None:
    tasks, _ = tr.build_samples(DATASET, BASELINE)
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    print(f"width samples={x.shape[0]} groups={len(set(groups.tolist()))} folds={FOLDS}")

    single, accepted_single = oof_prediction(x, base, target, groups, masks, 1)
    print(f"[1-stage] out-of-fold done, gate pass rate {accepted_single.mean():.3f}")
    staged, accepted_staged = oof_prediction(x, base, target, groups, masks, STAGES)
    print(f"[{STAGES}-stage] out-of-fold done, gate pass rate {accepted_staged.mean():.3f}")

    rows = {}
    for label, prediction in (("rule", base), ("stage1", single), ("stage2", staged)):
        rows[label] = {
            "molarCoord": point_error(target, prediction, MOLAR_POINTS),
            "allCoord": point_error(target, prediction, None),
        }

    truth_length = length_mm_truth_scale(target, target)
    lengths = {label: length_mm_truth_scale(prediction, target)
               for label, prediction in (("rule", base), ("stage1", single), ("stage2", staged))}
    for label, length in lengths.items():
        molar_error = np.abs(length[:, MOLAR_TEETH_INDEX] - truth_length[:, MOLAR_TEETH_INDEX])
        all_error = np.abs(length - truth_length)
        tzl_error = np.abs(length.sum(axis=1) - truth_length.sum(axis=1))
        rows[label]["molarLengthMm"] = {"mae": float(molar_error.mean()),
                                        "p95": float(np.quantile(molar_error, 0.95))}
        rows[label]["allLengthMm"] = {"mae": float(all_error.mean()),
                                      "p95": float(np.quantile(all_error, 0.95))}
        rows[label]["tzlSumMm"] = {"mae": float(tzl_error.mean()),
                                   "p95": float(np.quantile(tzl_error, 0.95))}

    # 케이스 단위 짝지은 부트스트랩(어금니 길이 mm): 1단계 → 2단계 개선의 불확실성.
    rng = np.random.default_rng(SEED)
    case_stage1 = np.abs(lengths["stage1"][:, MOLAR_TEETH_INDEX] - truth_length[:, MOLAR_TEETH_INDEX]).mean(axis=1)
    case_stage2 = np.abs(lengths["stage2"][:, MOLAR_TEETH_INDEX] - truth_length[:, MOLAR_TEETH_INDEX]).mean(axis=1)
    difference = case_stage1 - case_stage2
    replicates = 5000
    draws = np.array([difference[rng.integers(0, len(difference), len(difference))].mean()
                      for _ in range(replicates)])
    bootstrap = {
        "unit": "case",
        "replicates": replicates,
        "meanImprovementMm": float(difference.mean()),
        "ci95LowerMm": float(np.quantile(draws, 0.025)),
        "ci95UpperMm": float(np.quantile(draws, 0.975)),
        "probabilityImproved": float((draws > 0).mean()),
        "casesImproved": int((difference > 0).sum()),
        "casesWorsened": int((difference < 0).sum()),
        "cases": int(len(difference)),
    }

    report = {
        "schemaVersion": "molar-stage2-oof-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("동일한 grouped 5-fold out-of-fold 비교. 1단계 vs 2단계 모두 자기 정답 미학습 예측. "
                 "길이 mm 스케일은 정답 최외곽 스팬=54mm로 고정."),
        "widthSamples": int(x.shape[0]),
        "stageCount": STAGES,
        "perStageCap": PER_STAGE_CAP,
        "cumulativeCap": CUMULATIVE_CAP,
        "molarTeeth": list(MOLAR_TEETH),
        "results": rows,
        "improvementPct": {
            "molarCoord_rule_to_stage1": improvement(rows["rule"]["molarCoord"]["mae"], rows["stage1"]["molarCoord"]["mae"]),
            "molarCoord_rule_to_stage2": improvement(rows["rule"]["molarCoord"]["mae"], rows["stage2"]["molarCoord"]["mae"]),
            "molarCoord_stage1_to_stage2": improvement(rows["stage1"]["molarCoord"]["mae"], rows["stage2"]["molarCoord"]["mae"]),
            "molarCoordP95_stage1_to_stage2": improvement(rows["stage1"]["molarCoord"]["p95"], rows["stage2"]["molarCoord"]["p95"]),
            "molarLength_rule_to_stage1": improvement(rows["rule"]["molarLengthMm"]["mae"], rows["stage1"]["molarLengthMm"]["mae"]),
            "molarLength_rule_to_stage2": improvement(rows["rule"]["molarLengthMm"]["mae"], rows["stage2"]["molarLengthMm"]["mae"]),
            "molarLength_stage1_to_stage2": improvement(rows["stage1"]["molarLengthMm"]["mae"], rows["stage2"]["molarLengthMm"]["mae"]),
            "allCoord_stage1_to_stage2": improvement(rows["stage1"]["allCoord"]["mae"], rows["stage2"]["allCoord"]["mae"]),
        },
        "molarLengthPairedBootstrap": bootstrap,
        "gatePassRate": {"stage1": float(accepted_single.mean()), "stage2": float(accepted_staged.mean())},
    }
    (HERE / "molar_stage2_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"results": rows, "improvementPct": report["improvementPct"],
                      "bootstrap": bootstrap}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
