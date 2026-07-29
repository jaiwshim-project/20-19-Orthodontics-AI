#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 모델 채택 게이트 설계 — 신뢰도 임계와 폴백 규칙을 실측으로 정한다.

## 왜 필요한가
HTML에 붙이려면 "언제 픽셀 결과를 쓰고 언제 규칙/KRR로 되돌릴지"를 정해야 한다.
지금까지 잰 것은 평균이다. 배포에서 중요한 것은 **최악 케이스**다:
  - 픽셀이 KRR보다 나쁜 케이스가 몇 건인가, 얼마나 나쁜가
  - 그 케이스를 히트맵 신뢰도(24점 최소 sigmoid)로 미리 걸러낼 수 있는가
걸러낼 수 있다면 임계 아래에서만 KRR로 되돌리는 하이브리드가 순수 픽셀보다 낫다.

임계는 **OOF 예측만** 써서 고른다(각 케이스는 자기가 학습에 안 들어간 fold 모델로
예측된 값이다). 다만 임계 자체를 384건 전체에서 고르면 그만큼은 선택 편의가 낀다 —
그래서 임계를 fold별 leave-one-fold-out으로 고른 뒤 남은 fold에서 평가해 함께 낸다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_case, to_pixels, truth_scale_px
from _pixel_ab import metrics_from_px, oof_stage_prediction, task_case_ids

HERE = Path(__file__).resolve().parent
THRESHOLDS = [0.0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.7]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    index = HERE / "dataset-index.patientgrouped.json"
    baseline = HERE / "baseline_predictions_all.json"

    met = json.loads((HERE / "pixel_model" / "metrics.json").read_text(encoding="utf-8"))
    per_case = {r["caseId"]: r for r in met["perCase"]}
    pred = json.loads((HERE / "pixel_model" / "predictions.json").read_text(encoding="utf-8"))
    conf, fold_of = {}, {}
    for fold, items in pred.items():
        for row in items:
            scores = np.asarray(row["scores"], dtype=float)
            conf[row["caseId"]] = float(scores.min())
            fold_of[row["caseId"]] = int(fold)

    tasks, _ = tr.build_samples(index, baseline)
    width = tasks["width"]
    case_ids = task_case_ids(index, baseline, "width")
    keys = np.asarray(case_ids, dtype=object)
    dims = dims_by_case(index)
    truth = to_pixels(width["target"].reshape(-1, 24, 2), keys, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), keys, dims)
    scale = truth_scale_px(truth)
    print("KRR OOF...", flush=True)
    krr = to_pixels(oof_stage_prediction(width).reshape(-1, 24, 2), keys, dims)
    rule_m = metrics_from_px(draft, truth, scale)
    krr_m = metrics_from_px(krr, truth, scale)

    shared = [i for i, cid in enumerate(case_ids) if cid in per_case and cid in conf]
    ids = [case_ids[i] for i in shared]
    pix_pos = np.asarray([per_case[c]["position"] for c in ids])
    pix_mol = np.asarray([per_case[c]["molar"] for c in ids])
    krr_pos = krr_m["position"][shared]
    krr_mol = krr_m["molar"][shared]
    rule_pos = rule_m["position"][shared]
    cf = np.asarray([conf[c] for c in ids])
    folds = np.asarray([fold_of[c] for c in ids])
    print(f"게이트 설계 케이스 {len(ids)}건", flush=True)

    worse = pix_pos > krr_pos
    worse_block = {
        "casesPixelWorseThanKrr": int(worse.sum()),
        "pctPixelWorse": round(float(worse.mean() * 100), 2),
        "meanExcessMmWhenWorse": round(float((pix_pos - krr_pos)[worse].mean()), 4)
        if worse.any() else 0.0,
        "maxExcessMm": round(float((pix_pos - krr_pos).max()), 4),
        "confidenceOfWorseCases": {
            "median": round(float(np.median(cf[worse])), 4) if worse.any() else None,
            "medianOfRest": round(float(np.median(cf[~worse])), 4),
        },
    }

    def hybrid(threshold: float, sel: np.ndarray | None = None) -> dict:
        s = np.ones(len(ids), dtype=bool) if sel is None else sel
        use_krr = cf[s] < threshold
        pos = np.where(use_krr, krr_pos[s], pix_pos[s])
        mol = np.where(use_krr, krr_mol[s], pix_mol[s])
        return {
            "threshold": threshold,
            "fallbackCases": int(use_krr.sum()),
            "fallbackPct": round(float(use_krr.mean() * 100), 2),
            "positionMm": round(float(pos.mean()), 4),
            "positionP95Mm": round(float(np.quantile(pos, 0.95)), 4),
            "positionMaxMm": round(float(pos.max()), 4),
            "molarMm": round(float(mol.mean()), 4),
        }

    sweep = [hybrid(t) for t in THRESHOLDS]
    best = min(sweep, key=lambda r: r["positionMm"])

    # 임계 선택 편의 제거: fold를 빼고 고른 임계를 그 fold에서 평가
    honest = []
    for fold in sorted(set(folds.tolist())):
        train_sel = folds != fold
        test_sel = folds == fold
        pick = min((hybrid(t, train_sel) for t in THRESHOLDS),
                   key=lambda r: r["positionMm"])["threshold"]
        row = hybrid(pick, test_sel)
        row["heldOutFold"] = fold
        honest.append(row)
    honest_pos = float(np.mean([r["positionMm"] for r in honest]))

    report = {
        "schemaVersion": "pixel-gate-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "purpose": ("픽셀 모델을 HTML에 붙일 때의 채택 규칙. 신뢰도(24점 최소 sigmoid) "
                    "임계 아래에서 KRR로 되돌리는 하이브리드가 순수 픽셀보다 나은지 실측."),
        "cases": len(ids),
        "pureMeans": {
            "rulePositionMm": round(float(rule_pos.mean()), 4),
            "krrPositionMm": round(float(krr_pos.mean()), 4),
            "pixelPositionMm": round(float(pix_pos.mean()), 4),
            "pixelPositionP95Mm": round(float(np.quantile(pix_pos, 0.95)), 4),
            "pixelPositionMaxMm": round(float(pix_pos.max()), 4),
        },
        "whenPixelLoses": worse_block,
        "confidenceCorrelation": {
            "pearsonMinScoreVsPositionMm": round(float(np.corrcoef(cf, pix_pos)[0, 1]), 4),
            "note": "음수 = 신뢰도 낮을수록 오차 크다(=게이트로 쓸 수 있다)",
        },
        "thresholdSweep": sweep,
        "bestThresholdInSample": best,
        "leaveOneFoldOutThresholdSelection": {
            "perFold": honest,
            "meanPositionMm": round(honest_pos, 4),
            "note": ("임계를 나머지 4 fold에서 고른 뒤 남은 fold에서 평가. 임계 선택 "
                     "편의를 뺀 값이다."),
        },
    }
    pure = report["pureMeans"]["pixelPositionMm"]
    gain = (pure - best["positionMm"]) / pure * 100.0
    report["verdict"] = {
        "hybridBeatsPurePixel": bool(best["positionMm"] < pure and best["threshold"] > 0),
        "recommendedThreshold": best["threshold"] if best["threshold"] > 0 else 0.0,
        "hybridGainOverPurePixelPct": round(float(gain), 2),
        "conclusion": (
            f"순수 픽셀 {pure}mm, 최적 하이브리드(임계 {best['threshold']}) "
            f"{best['positionMm']}mm ({gain:+.1f}%), 폴백 {best['fallbackPct']}%. "
            f"편의 제거 추정 {honest_pos:.4f}mm."
        ),
    }
    (HERE / "pixel_gate.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n{'임계':>6s} {'폴백':>6s} {'폴백%':>7s} {'위치mm':>9s} {'p95':>8s} {'최대':>8s} {'어금니':>8s}")
    for r in sweep:
        print(f"{r['threshold']:6.2f} {r['fallbackCases']:6d} {r['fallbackPct']:7.2f} "
              f"{r['positionMm']:9.4f} {r['positionP95Mm']:8.4f} {r['positionMaxMm']:8.4f} "
              f"{r['molarMm']:8.4f}")
    print("\nwhenPixelLoses:", json.dumps(worse_block, ensure_ascii=False))
    print("verdict:", json.dumps(report["verdict"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
