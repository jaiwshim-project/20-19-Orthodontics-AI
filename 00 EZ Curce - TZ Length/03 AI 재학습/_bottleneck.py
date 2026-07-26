#!/usr/bin/env python3
"""개선 효과를 높이려면 무엇이 필요한가 — 병목 4종을 데이터로 규명.

측정 대상(추측 금지, 전부 수치로):
  ① 5% 보정 상한(cap)이 어금니 보정을 잘라내는가?
  ② 거리 게이트(unfamiliar fallback)가 어금니 케이스를 버리는가?
  ③ 학습곡선: 표본 N을 늘리면 어금니 오차가 실제로 내려가는가 / 100건당 몇 %인가?
  ④ 상한 오라클: 지금 특징(169차원)으로 도달 가능한 최대치는 어디인가?
     = 잔차를 in-sample로 완전히 맞췄을 때(λ→0)의 오차. 여기서 멀면 데이터 부족,
       이미 붙어 있으면 특징/모델 구조 부족.
"""
import json
from pathlib import Path
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent

SEED = tr.DEFAULT_SEED
MAX_CORR = 0.05
FOLDS = 5
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]

tasks, meta = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
w = tasks["width"]
x, base, target, groups = w["x"], w["baseline"], w["target"], w["groups"]
N = x.shape[0]
print(f"width 샘플 {N} / 특징 {x.shape[1]}차원 / 목표 {target.shape[1]}값")


def molar_mae(tgt, pred):
    t = tgt.reshape(len(tgt), 24, 2)[:, MOLAR_POINTS, :]
    p = pred.reshape(len(pred), 24, 2)[:, MOLAR_POINTS, :]
    return float((np.linalg.norm(p - t, axis=2) / np.sqrt(2.0)).mean())


def all_mae(tgt, pred):
    d = (pred - tgt).reshape(-1, 2)
    return float((np.linalg.norm(d, axis=1) / np.sqrt(2.0)).mean())


# ── ① 필요한 보정량 vs 5% 상한 ─────────────────────────────
need = (target - base).reshape(N, 24, 2)
need_mag = np.linalg.norm(need, axis=2) / np.sqrt(2.0)   # 대각선 분율
mol_need = need_mag[:, MOLAR_POINTS].ravel()
inc_need = need_mag[:, [10, 11, 12, 13]].ravel()          # 치아6,7 = 포인트10~13
print("\n[① 5% 보정상한] '정답까지 필요한 이동량'의 분포 (대각선 분율)")
for nm, v in (("어금니", mol_need), ("앞니", inc_need), ("전체", need_mag.ravel())):
    print(f"  {nm:4} 평균 {v.mean():.4f}  P50 {np.quantile(v,.5):.4f}  P90 {np.quantile(v,.9):.4f}"
          f"  P95 {np.quantile(v,.95):.4f}  >5%초과 {100*(v>MAX_CORR).mean():5.1f}%  >10%초과 {100*(v>0.10).mean():5.1f}%")
print(f"  → 어금니는 필요 이동량의 {100*(mol_need>MAX_CORR).mean():.1f}%가 상한(5%)을 넘는다.")

# 상한을 풀면 얼마나 좋아지는가(오라클: 방향은 정답, 크기만 상한 적용)
for cap in (0.05, 0.07, 0.10, 1.0):
    unit = need / np.maximum(np.linalg.norm(need, axis=2, keepdims=True), 1e-12)
    mag = np.minimum(np.linalg.norm(need, axis=2, keepdims=True), cap * np.sqrt(2.0))
    oracle = (base.reshape(N, 24, 2) + unit * mag).reshape(N, -1)
    print(f"  방향완벽 오라클 cap={cap:<4} 어금니MAE {molar_mae(target, oracle):.5f}")

# ── ② 거리 게이트 ──────────────────────────────────────────
masks = tr.grouped_folds(groups, FOLDS, SEED)
acc_all, oof = np.zeros(N, bool), np.zeros_like(target)
for i, tm in enumerate(masks, 1):
    trn = ~tm
    g, l = tr.select_hyperparameters(x[trn], base[trn], target[trn], groups[trn], SEED + i * 1009, MAX_CORR, 4)[1:]
    m = tr.fit_krr(x[trn], base[trn], target[trn], g, l)
    p, a, _ = tr.predict_krr(m, x[tm], base[tm], MAX_CORR)
    oof[tm], acc_all[tm] = p, a
print(f"\n[② 게이트] out-of-fold 보정 적용 {100*acc_all.mean():.1f}% / 미적용(규칙 그대로) {100*(~acc_all).mean():.1f}%")
print(f"  적용 케이스 어금니MAE {molar_mae(target[acc_all], oof[acc_all]):.5f}"
      f" (규칙 {molar_mae(target[acc_all], base[acc_all]):.5f})")
if (~acc_all).any():
    print(f"  미적용 케이스 어금니MAE {molar_mae(target[~acc_all], base[~acc_all]):.5f} — 개선 0")

# 실제 KRR이 낸 보정량이 상한에 얼마나 붙어 있나
applied = (oof - base).reshape(N, 24, 2)
amag = np.linalg.norm(applied, axis=2) / np.sqrt(2.0)
mol_ap = amag[acc_all][:, MOLAR_POINTS].ravel()
print(f"  적용된 어금니 보정량 평균 {mol_ap.mean():.4f} / 상한포화(≥4.9%) {100*(mol_ap>=0.049).mean():.1f}%"
      f" / 필요량 평균 {mol_need.mean():.4f}")

# ── ③ 학습곡선 ────────────────────────────────────────────
print("\n[③ 학습곡선] 학습 그룹 수를 줄여가며 동일 홀드아웃에서 어금니 OOF 오차 측정")
uniq = sorted(set(str(g) for g in groups))
rng = np.random.default_rng(SEED)
perm = rng.permutation(len(uniq))
hold = set(uniq[i] for i in perm[: len(uniq) // 5])          # 20% 고정 홀드아웃
pool = [uniq[i] for i in perm[len(uniq) // 5:]]
hm = np.array([str(g) in hold for g in groups])
curve = []
for frac in (0.25, 0.5, 0.75, 1.0):
    k = max(FOLDS + 1, int(len(pool) * frac))
    sub = set(pool[:k])
    trm = np.array([str(g) in sub for g in groups])
    g_, l_ = tr.select_hyperparameters(x[trm], base[trm], target[trm], groups[trm], SEED + 7, MAX_CORR, 4)[1:]
    m = tr.fit_krr(x[trm], base[trm], target[trm], g_, l_)
    p, a, _ = tr.predict_krr(m, x[hm], base[hm], MAX_CORR)
    e_m, e_a = molar_mae(target[hm], p), all_mae(target[hm], p)
    curve.append({"trainSamples": int(trm.sum()), "molarMae": e_m, "allMae": e_a, "gateRate": float(a.mean())})
    print(f"  학습 {int(trm.sum()):3}샘플 → 어금니 {e_m:.5f} / 전체 {e_a:.5f} / 게이트 {a.mean():.3f}")
r_base = molar_mae(target[hm], base[hm])
print(f"  (같은 홀드아웃 규칙엔진 어금니 {r_base:.5f})")
# 멱함수 적합 err = c*N^-p → 목표 오차 도달 N 추정
ns = np.array([c["trainSamples"] for c in curve], float)
es = np.array([c["molarMae"] for c in curve], float)
p_, logc = np.polyfit(np.log(ns), np.log(es), 1)
print(f"  멱함수 적합: 어금니오차 ≈ {np.exp(logc):.4f}·N^({p_:.3f})  → N 2배당 {100*(1-2**p_):.1f}% 감소")
for tgt_imp in (0.10, 0.20, 0.30):
    cur = es[-1]
    need_n = (cur * (1 - tgt_imp) / np.exp(logc)) ** (1 / p_)
    print(f"  현재 대비 {int(tgt_imp*100)}% 더 줄이려면 학습샘플 ≈ {need_n:.0f}건 (현 {int(ns[-1])}건, +{need_n-ns[-1]:.0f})")

# ── ④ 특징 표현력 상한 (in-sample 완전적합) ─────────────────
print("\n[④ 특징 표현력] 169차원 특징으로 잔차를 in-sample 완전적합했을 때(λ 최소)")
for lam in (1e-6, 1e-4, 1e-2):
    m = tr.fit_krr(x, base, target, 1.0, lam)
    p, a, _ = tr.predict_krr(m, x, base, MAX_CORR)
    print(f"  λ={lam:<7} in-sample 어금니 {molar_mae(target, p):.5f} / 전체 {all_mae(target, p):.5f}")
print(f"  OOF 어금니 {molar_mae(target, oof):.5f} / 규칙 {molar_mae(target, base):.5f}")

json.dump({
    "schemaVersion": "bottleneck-diagnosis-v1",
    "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                "containsImageCoordinates": False, "containsModelParameters": False},
    "widthSamples": N,
    "capBinding": {"molarNeedMean": float(mol_need.mean()),
                   "molarNeedP95": float(np.quantile(mol_need, .95)),
                   "molarPctNeedOverCap": float(100 * (mol_need > MAX_CORR).mean()),
                   "molarAppliedMean": float(mol_ap.mean()),
                   "molarPctSaturated": float(100 * (mol_ap >= 0.049).mean())},
    "gate": {"oofAppliedPct": float(100 * acc_all.mean())},
    "learningCurve": curve,
    "powerLaw": {"exponent": float(p_), "coefficient": float(np.exp(logc)),
                 "pctDropPerDoubling": float(100 * (1 - 2 ** p_))},
}, open(HERE / "bottleneck_metrics.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n→ bottleneck_metrics.json")
