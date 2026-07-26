#!/usr/bin/env python3
"""병목 확정 실험: (A) 보정상한 완화, (B) 상한 유지한 2단계 반복보정.

①~④ 진단에서 나온 결정적 사실:
  - in-sample 완전적합(λ=1e-6) 어금니 0.02923 == 방향완벽 cap5% 오라클 0.02923
    → 즉 현재 특징으로 잔차 방향은 이미 거의 완벽히 학습됨. 남은 오차는 '크기 제한'.
  - 학습곡선 지수 N^-0.058 (2배당 3.9%) → 데이터만 늘려도 개선 미미.
따라서 진짜 병목은 데이터가 아니라 5% cap. 실제 OOF로 확인한다.
"""
from pathlib import Path
import json
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED, FOLDS = tr.DEFAULT_SEED, 5
MT = (1, 2, 11, 12)
MP = [p for t in MT for p in (2 * (t - 1), 2 * (t - 1) + 1)]
SCALE_MM = 54.0

tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
w = tasks["width"]
x, base, target, groups = w["x"], w["baseline"], w["target"], w["groups"]
N = len(x)
masks = tr.grouped_folds(groups, FOLDS, SEED)


def mae(tgt, pred, pts=None):
    t = tgt.reshape(len(tgt), 24, 2); p = pred.reshape(len(pred), 24, 2)
    if pts is not None:
        t, p = t[:, pts, :], p[:, pts, :]
    return float((np.linalg.norm(p - t, axis=2) / np.sqrt(2.0)).mean())


def p95(tgt, pred, pts):
    t = tgt.reshape(len(tgt), 24, 2)[:, pts, :]; p = pred.reshape(len(pred), 24, 2)[:, pts, :]
    return float(np.quantile(np.linalg.norm(p - t, axis=2) / np.sqrt(2.0), 0.95))


def len_mm(arr, tgt):
    """정답 스팬을 54mm로 고정한 치아별 길이."""
    pt, pp = tgt.reshape(len(tgt), 24, 2), arr.reshape(len(arr), 24, 2)
    out = np.zeros((len(arr), 12))
    for k in range(len(arr)):
        span = max((float(np.linalg.norm(pt[k][i+1:] - pt[k][i], axis=1).max()) for i in range(23)), default=0.0)
        mmpp = SCALE_MM / span if span else 0.0
        for t in range(12):
            out[k, t] = float(np.linalg.norm(pp[k][2*t] - pp[k][2*t+1])) * mmpp
    return out


def molar_len_err(pred):
    L, Lt = len_mm(pred, target), len_mm(target, target)
    e = np.abs(L[:, [t-1 for t in MT]] - Lt[:, [t-1 for t in MT]])
    return float(e.mean()), float(np.quantile(e, 0.95))


def run_oof(cap, rounds=1):
    """cap과 반복횟수를 바꿔 out-of-fold 예측 생성. 각 라운드는 독립 cap을 받는다."""
    oof = np.zeros_like(target)
    for i, tm in enumerate(masks, 1):
        trn = ~tm
        cur_tr, cur_te = base[trn].copy(), base[tm].copy()
        for r in range(rounds):
            g, l = tr.select_hyperparameters(x[trn], cur_tr, target[trn], groups[trn], SEED + i*1009 + r*31, cap, 4)[1:]
            m = tr.fit_krr(x[trn], cur_tr, target[trn], g, l)
            pte, _, _ = tr.predict_krr(m, x[tm], cur_te, cap)
            ptr, _, _ = tr.predict_krr(m, x[trn], cur_tr, cap)
            cur_te, cur_tr = pte, ptr
        oof[tm] = cur_te
    return oof


rows = []
print(f"{'설정':28} {'어금니MAE':>10} {'어금니P95':>10} {'어금니길이mm':>12} {'전체MAE':>9}")
rb = ("규칙엔진(보정없음)", base)
for label, pred in [rb]:
    lm, lp = molar_len_err(pred)
    print(f"{label:28} {mae(target,pred,MP):10.5f} {p95(target,pred,MP):10.5f} {lm:12.3f} {mae(target,pred):9.5f}")
    rows.append({"config": label, "molarMae": mae(target,pred,MP), "molarP95": p95(target,pred,MP), "molarLenMm": lm, "allMae": mae(target,pred)})

for cap, rounds, label in [(0.05, 1, "현행 cap5% × 1회"), (0.05, 2, "cap5% × 2회 반복"),
                           (0.05, 3, "cap5% × 3회 반복"), (0.07, 1, "cap7% × 1회"),
                           (0.10, 1, "cap10% × 1회"), (0.15, 1, "cap15% × 1회")]:
    pred = run_oof(cap, rounds)
    lm, lp = molar_len_err(pred)
    print(f"{label:28} {mae(target,pred,MP):10.5f} {p95(target,pred,MP):10.5f} {lm:12.3f} {mae(target,pred):9.5f}")
    rows.append({"config": label, "cap": cap, "rounds": rounds, "molarMae": mae(target,pred,MP),
                 "molarP95": p95(target,pred,MP), "molarLenMm": lm, "molarLenP95": lp, "allMae": mae(target,pred)})

b = rows[1]
print("\n현행(cap5%×1회) 대비 개선율 — 전부 out-of-fold, 누출 없음")
for r in rows[2:]:
    print(f"  {r['config']:22} 어금니MAE {100*(b['molarMae']-r['molarMae'])/b['molarMae']:+6.1f}%"
          f"  P95 {100*(b['molarP95']-r['molarP95'])/b['molarP95']:+6.1f}%"
          f"  길이mm {100*(b['molarLenMm']-r['molarLenMm'])/b['molarLenMm']:+6.1f}%"
          f"  전체 {100*(b['allMae']-r['allMae'])/b['allMae']:+6.1f}%")

json.dump({"schemaVersion": "cap-experiment-v1",
           "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                       "containsImageCoordinates": False, "containsModelParameters": False},
           "note": "전부 grouped 5-fold out-of-fold. 반복보정은 각 라운드마다 5% cap을 독립 적용.",
           "widthSamples": N, "results": rows},
          open(HERE / "cap_experiment_metrics.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n→ cap_experiment_metrics.json")
