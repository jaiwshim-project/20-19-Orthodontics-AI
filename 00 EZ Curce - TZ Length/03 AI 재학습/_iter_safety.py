#!/usr/bin/env python3
"""반복보정(cap 5% 유지)의 안전성 + EZ 과제 동시 확인.
반복보정은 라운드마다 5%를 넘지 않으므로 승격게이트의 correctionCapIs5PctDiagonal(=0.05)을
위반하지 않는다. 단 '누적' 이동은 5%를 넘을 수 있어 안전성을 별도로 재야 한다."""
from pathlib import Path
import json
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED, FOLDS, CAP = tr.DEFAULT_SEED, 5, 0.05
MT = (1, 2, 11, 12); MP = [p for t in MT for p in (2*(t-1), 2*(t-1)+1)]
SCALE_MM = 54.0
tasks, _ = tr.build_samples(HERE/"dataset-index.json", HERE/"baseline_predictions_all.json")


def oof_iter(task, rounds):
    d = tasks[task]
    x, base, target, groups = d["x"], d["baseline"], d["target"], d["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    o = np.zeros_like(target)
    for i, tm in enumerate(masks, 1):
        trn = ~tm
        ctr, cte = base[trn].copy(), base[tm].copy()
        for r in range(rounds):
            g, l = tr.select_hyperparameters(x[trn], ctr, target[trn], groups[trn], SEED+i*1009+r*31, CAP, 4)[1:]
            m = tr.fit_krr(x[trn], ctr, target[trn], g, l)
            cte = tr.predict_krr(m, x[tm], cte, CAP)[0]
            ctr = tr.predict_krr(m, x[trn], ctr, CAP)[0]
        o[tm] = cte
    return o, x, base, target


def pts_err(target, pred, pts=None):
    t = target.reshape(len(target), -1, 2); p = pred.reshape(len(pred), -1, 2)
    if pts is not None: t, p = t[:, pts, :], p[:, pts, :]
    return np.linalg.norm(p - t, axis=2) / np.sqrt(2.0)


out = {"schemaVersion": "iterative-correction-v1",
       "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                   "containsImageCoordinates": False, "containsModelParameters": False},
       "note": "라운드마다 cap 5% 독립 적용 → 게이트 correctionCapIs5PctDiagonal 위반 없음. 누적 이동량은 별도 보고.",
       "tasks": {}}

for task in ("width", "ez"):
    d = tasks[task]
    n = len(d["x"]); print(f"\n===== {task} ({n} 샘플) =====")
    recs = []
    for rounds in (1, 2, 3):
        pred, x, base, target = oof_iter(task, rounds)
        e_all = pts_err(target, pred); e_rule = pts_err(target, base)
        cum = np.linalg.norm((pred-base).reshape(len(pred), -1, 2), axis=2) / np.sqrt(2.0)
        rec = {"rounds": rounds, "mae": float(e_all.mean()), "p95": float(np.quantile(e_all, .95)),
               "ruleMae": float(e_rule.mean()),
               "improvePctVsRule": float(100*(e_rule.mean()-e_all.mean())/e_rule.mean()),
               "worseCasePct": float(100*(e_all.mean(axis=1) > e_rule.mean(axis=1)).mean()),
               "cumulativeMoveMean": float(cum.mean()), "cumulativeMoveP95": float(np.quantile(cum,.95)),
               "cumulativeMoveMax": float(cum.max()),
               "cumulativeOver5PctOfLandmarks": float(100*(cum > 0.05).mean())}
        if task == "width":
            em = pts_err(target, pred, MP); er = pts_err(target, base, MP)
            rec["molarMae"] = float(em.mean()); rec["molarP95"] = float(np.quantile(em, .95))
            rec["molarImprovePctVsRule"] = float(100*(er.mean()-em.mean())/er.mean())
        recs.append(rec)
        extra = f" 어금니 {rec['molarMae']:.5f}" if task == "width" else ""
        print(f"  {rounds}회: MAE {rec['mae']:.5f} (규칙대비 {rec['improvePctVsRule']:+.1f}%) P95 {rec['p95']:.5f}"
              f"{extra} | 악화케이스 {rec['worseCasePct']:.1f}% | 누적이동 평균 {rec['cumulativeMoveMean']:.4f}"
              f" P95 {rec['cumulativeMoveP95']:.4f} 최대 {rec['cumulativeMoveMax']:.4f} (>5% 랜드마크 {rec['cumulativeOver5PctOfLandmarks']:.1f}%)")
    b = recs[0]
    for r in recs[1:]:
        line = f"  → {r['rounds']}회 vs 1회: MAE {100*(b['mae']-r['mae'])/b['mae']:+.1f}% P95 {100*(b['p95']-r['p95'])/b['p95']:+.1f}%"
        if task == "width": line += f" 어금니 {100*(b['molarMae']-r['molarMae'])/b['molarMae']:+.1f}%"
        print(line)
    out["tasks"][task] = {"samples": n, "rounds": recs}

json.dump(out, open(HERE/"iterative_correction_metrics.json","w",encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n→ iterative_correction_metrics.json")
