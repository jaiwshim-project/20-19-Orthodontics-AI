#!/usr/bin/env python3
"""cap 완화의 안전성 검증. cap의 존재 이유 = '모델이 틀렸을 때 규칙엔진 초안을 멀리 끌고 가지 못하게'.
따라서 평균 개선만 보면 안 되고 (a)악화 케이스 비율/최대 악화폭 (b)임상 mm 오차 꼬리 (c)미숙지
케이스(게이트 탈락)에서의 거동을 함께 봐야 한다."""
from pathlib import Path
import json
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED, FOLDS = tr.DEFAULT_SEED, 5
MT = (1, 2, 11, 12)
MP = [p for t in MT for p in (2*(t-1), 2*(t-1)+1)]
SCALE_MM = 54.0
tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
w = tasks["width"]
x, base, target, groups = w["x"], w["baseline"], w["target"], w["groups"]
masks = tr.grouped_folds(groups, FOLDS, SEED)


def oof(cap):
    o = np.zeros_like(target); acc = np.zeros(len(x), bool)
    for i, tm in enumerate(masks, 1):
        trn = ~tm
        g, l = tr.select_hyperparameters(x[trn], base[trn], target[trn], groups[trn], SEED+i*1009, cap, 4)[1:]
        m = tr.fit_krr(x[trn], base[trn], target[trn], g, l)
        p, a, _ = tr.predict_krr(m, x[tm], base[tm], cap)
        o[tm], acc[tm] = p, a
    return o, acc


def case_err(pred, pts):
    t = target.reshape(len(target), 24, 2)[:, pts, :]; p = pred.reshape(len(pred), 24, 2)[:, pts, :]
    return (np.linalg.norm(p - t, axis=2) / np.sqrt(2.0)).mean(axis=1)


def tzl_mm(pred):
    pt, pp = target.reshape(len(target),24,2), pred.reshape(len(pred),24,2)
    out = np.zeros(len(pred))
    for k in range(len(pred)):
        span = max((float(np.linalg.norm(pt[k][i+1:]-pt[k][i], axis=1).max()) for i in range(23)), default=0.0)
        mmpp = SCALE_MM/span if span else 0.0
        out[k] = sum(float(np.linalg.norm(pp[k][2*t]-pp[k][2*t+1]))*mmpp for t in range(12))
    return out


tzl_t = tzl_mm(target)
rule_c = case_err(base, MP)
rows = []
print(f"{'설정':14} {'악화케이스%':>10} {'최대악화':>9} {'악화평균':>9} {'TZL오차mm':>10} {'TZLp95':>8} {'TZL최악':>8}")
for cap in (0.05, 0.07, 0.10, 0.15):
    pred, acc = oof(cap)
    c = case_err(pred, MP)
    worse = c > rule_c
    dt = np.abs(tzl_mm(pred) - tzl_t)
    r = {"cap": cap, "worseCasePct": float(100*worse.mean()),
         "maxWorsenAbs": float((c-rule_c).max()), "meanWorsenAmongWorse": float((c-rule_c)[worse].mean()) if worse.any() else 0.0,
         "tzlMaeMm": float(dt.mean()), "tzlP95Mm": float(np.quantile(dt,0.95)), "tzlMaxMm": float(dt.max()),
         "gateRate": float(acc.mean())}
    rows.append(r)
    print(f"cap{int(cap*100):>3}%{'':7} {r['worseCasePct']:10.1f} {r['maxWorsenAbs']:9.4f} {r['meanWorsenAmongWorse']:9.4f}"
          f" {r['tzlMaeMm']:10.3f} {r['tzlP95Mm']:8.3f} {r['tzlMaxMm']:8.3f}")
dt_r = np.abs(tzl_mm(base) - tzl_t)
print(f"{'규칙엔진':14} {'-':>10} {'-':>9} {'-':>9} {dt_r.mean():10.3f} {np.quantile(dt_r,0.95):8.3f} {dt_r.max():8.3f}")
json.dump({"schemaVersion": "cap-safety-v1",
           "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                       "containsImageCoordinates": False, "containsModelParameters": False},
           "ruleTzl": {"maeMm": float(dt_r.mean()), "p95Mm": float(np.quantile(dt_r,0.95)), "maxMm": float(dt_r.max())},
           "results": rows}, open(HERE/"cap_safety_metrics.json","w",encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n→ cap_safety_metrics.json")
