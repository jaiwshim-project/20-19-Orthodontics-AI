#!/usr/bin/env python3
"""반복보정 2회의 이득이 폴드 분할 시드에 흔들리는지 확인(4시드 독립)."""
from pathlib import Path
import json
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
CAP, FOLDS = 0.05, 5
MT = (1,2,11,12); MP=[p for t in MT for p in (2*(t-1),2*(t-1)+1)]
tasks,_ = tr.build_samples(HERE/"dataset-index.json", HERE/"baseline_predictions_all.json")
d = tasks["width"]; x,base,target,groups = d["x"],d["baseline"],d["target"],d["groups"]

def run(seed, rounds):
    masks = tr.grouped_folds(groups, FOLDS, seed); o=np.zeros_like(target)
    for i,tm in enumerate(masks,1):
        trn=~tm; ctr,cte=base[trn].copy(),base[tm].copy()
        for r in range(rounds):
            g,l = tr.select_hyperparameters(x[trn],ctr,target[trn],groups[trn],seed+i*1009+r*31,CAP,4)[1:]
            m = tr.fit_krr(x[trn],ctr,target[trn],g,l)
            cte = tr.predict_krr(m,x[tm],cte,CAP)[0]; ctr = tr.predict_krr(m,x[trn],ctr,CAP)[0]
        o[tm]=cte
    return o

def em(p, pts=None):
    t=target.reshape(len(target),24,2); q=p.reshape(len(p),24,2)
    if pts is not None: t,q=t[:,pts,:],q[:,pts,:]
    e=np.linalg.norm(q-t,axis=2)/np.sqrt(2.0); return e.mean(), np.quantile(e,.95)

rows=[]
print(f"{'seed':10} {'1회 어금니':>10} {'2회 어금니':>10} {'개선':>7} {'1회 P95':>9} {'2회 P95':>9} {'개선':>7}")
for seed in (20260711,20260712,20260713,20260714):
    a=run(seed,1); b=run(seed,2)
    a_m,a_p = em(a,MP); b_m,b_p = em(b,MP)
    a_t,_=em(a); b_t,_=em(b)
    rows.append({"seed":seed,"molar1":a_m,"molar2":b_m,"molarImprovePct":100*(a_m-b_m)/a_m,
                 "p951":a_p,"p952":b_p,"p95ImprovePct":100*(a_p-b_p)/a_p,
                 "all1":a_t,"all2":b_t,"allImprovePct":100*(a_t-b_t)/a_t})
    print(f"{seed:<10} {a_m:10.5f} {b_m:10.5f} {100*(a_m-b_m)/a_m:+6.1f}% {a_p:9.5f} {b_p:9.5f} {100*(a_p-b_p)/a_p:+6.1f}%")
mi=[r["molarImprovePct"] for r in rows]; pi=[r["p95ImprovePct"] for r in rows]; ai=[r["allImprovePct"] for r in rows]
print(f"{'평균':10} {'':10} {'':10} {np.mean(mi):+6.1f}% {'':9} {'':9} {np.mean(pi):+6.1f}%")
print(f"4시드 전부 개선? 어금니 {all(v>0 for v in mi)} / P95 {all(v>0 for v in pi)} / 전체 {all(v>0 for v in ai)}"
      f" | 전체 평균 {np.mean(ai):+.1f}%")
json.dump({"schemaVersion":"iterative-seed-robustness-v1",
  "privacy":{"containsPhi":False,"containsCaseIdentifiers":False,"containsFilePaths":False,
             "containsImageCoordinates":False,"containsModelParameters":False},
  "seeds":rows,"meanMolarImprovePct":float(np.mean(mi)),"meanP95ImprovePct":float(np.mean(pi)),
  "meanAllImprovePct":float(np.mean(ai)),"allSeedsImproved":bool(all(v>0 for v in mi))},
  open(HERE/"iterative_seed_metrics.json","w",encoding="utf-8"),ensure_ascii=False,indent=2)
print("→ iterative_seed_metrics.json")
