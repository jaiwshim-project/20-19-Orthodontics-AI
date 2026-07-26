#!/usr/bin/env python3
"""다단 보정 확정 검증: 실제 train_residual 경로(select_stage_hyperparameters + fit_stages
+ predict_stages, 누적 캡 포함)로 어금니 지표와 4시드 강건성을 측정."""
from pathlib import Path
import json
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
CAP, CUM, FOLDS = 0.05, 0.10, 5
MT = (1, 2, 11, 12); MP = [p for t in MT for p in (2*(t-1), 2*(t-1)+1)]
SCALE_MM = 54.0
tasks, _ = tr.build_samples(HERE/"dataset-index.json", HERE/"baseline_predictions_all.json")


def oof(task, seed, stages):
    d = tasks[task]
    x, base, target, groups = d["x"], d["baseline"], d["target"], d["groups"]
    o = np.zeros_like(target); acc = np.zeros(len(x), bool)
    for i, tm in enumerate(tr.grouped_folds(groups, FOLDS, seed), 1):
        trn = ~tm
        hp = tr.select_stage_hyperparameters(x[trn], base[trn], target[trn], groups[trn],
                                            seed + i*1009, CAP, 4, stages, CUM)
        ms = tr.fit_stages(x[trn], base[trn], target[trn], hp, CAP, CUM)
        p, a, _ = tr.predict_stages(ms, x[tm], base[tm], CAP, CUM)
        o[tm], acc[tm] = p, a
    return o, base, target


def err(target, pred, pts=None):
    t = target.reshape(len(target), -1, 2); p = pred.reshape(len(pred), -1, 2)
    if pts is not None: t, p = t[:, pts, :], p[:, pts, :]
    e = np.linalg.norm(p-t, axis=2)/np.sqrt(2.0)
    return float(e.mean()), float(np.quantile(e, .95))


def len_mm_err(target, pred, teeth):
    pt, pp = target.reshape(len(target),24,2), pred.reshape(len(pred),24,2)
    out = []
    for k in range(len(pred)):
        span = max((float(np.linalg.norm(pt[k][i+1:]-pt[k][i], axis=1).max()) for i in range(23)), default=0.0)
        s = SCALE_MM/span if span else 0.0
        for t in teeth:
            lt = float(np.linalg.norm(pt[k][2*(t-1)]-pt[k][2*(t-1)+1]))*s
            lp = float(np.linalg.norm(pp[k][2*(t-1)]-pp[k][2*(t-1)+1]))*s
            out.append(abs(lp-lt))
    a = np.array(out); return float(a.mean()), float(np.quantile(a,.95))


rep = {"schemaVersion": "staged-correction-verify-v1",
       "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                   "containsImageCoordinates": False, "containsModelParameters": False},
       "perStageCap": CAP, "cumulativeCap": CUM, "seeds": {}}

print("=== 확정 파이프라인 검증 (누적캡 10% 적용, 전부 out-of-fold) ===")
for seed in (20260711, 20260712, 20260713, 20260714):
    r = {}
    p1, base, target = oof("width", seed, 1)
    p2, _, _ = oof("width", seed, 2)
    m1, q1 = err(target, p1, MP); m2, q2 = err(target, p2, MP)
    a1, _ = err(target, p1); a2, _ = err(target, p2)
    l1 = len_mm_err(target, p1, MT); l2 = len_mm_err(target, p2, MT)
    e1, _, tz = oof("ez", seed, 1); ez1 = err(tz, e1)
    e2, _, _ = oof("ez", seed, 2); ez2 = err(tz, e2)
    r = {"molarMae1": m1, "molarMae2": m2, "molarMaeImprovePct": 100*(m1-m2)/m1,
         "molarP951": q1, "molarP952": q2, "molarP95ImprovePct": 100*(q1-q2)/q1,
         "molarLenMm1": l1[0], "molarLenMm2": l2[0], "molarLenImprovePct": 100*(l1[0]-l2[0])/l1[0],
         "widthAllMae1": a1, "widthAllMae2": a2, "widthAllImprovePct": 100*(a1-a2)/a1,
         "ezMae1": ez1[0], "ezMae2": ez2[0], "ezImprovePct": 100*(ez1[0]-ez2[0])/ez1[0]}
    rep["seeds"][str(seed)] = r
    print(f"seed {seed}: 어금니MAE {m1:.5f}→{m2:.5f} ({r['molarMaeImprovePct']:+.1f}%)"
          f" P95 {q1:.5f}→{q2:.5f} ({r['molarP95ImprovePct']:+.1f}%)"
          f" 길이 {l1[0]:.3f}→{l2[0]:.3f}mm ({r['molarLenImprovePct']:+.1f}%)"
          f" | width전체 {r['widthAllImprovePct']:+.1f}% | EZ {r['ezImprovePct']:+.1f}%")

ks = ["molarMaeImprovePct","molarP95ImprovePct","molarLenImprovePct","widthAllImprovePct","ezImprovePct"]
rep["means"] = {k: float(np.mean([v[k] for v in rep["seeds"].values()])) for k in ks}
rep["allSeedsImproved"] = {k: bool(all(v[k] > 0 for v in rep["seeds"].values())) for k in ks}
print("\n4시드 평균:", {k: f"{v:+.1f}%" for k, v in rep["means"].items()})
print("4시드 전부 개선:", rep["allSeedsImproved"])
json.dump(rep, open(HERE/"staged_verify_metrics.json","w",encoding="utf-8"), ensure_ascii=False, indent=2)
print("→ staged_verify_metrics.json")
