#!/usr/bin/env python3
"""어금니 개선율의 누출 없는(leak-free) 측정.

문제: 신규 99건은 신모델의 '학습 데이터'다. 따라서 신모델이 그 99건에서 잘 맞추는 것은
      일반화 근거가 아니라 in-sample 성적일 수 있다.
해법: 동일한 99건을 out-of-fold로만 평가한다.
  - 구모델 조건: 이전 학습셋(169샘플)만으로 학습 → 99건은 완전 미학습(out-of-sample)
  - 신모델 조건: 268샘플 전체를 grouped 5-fold로 돌려, 99건 각각이 test fold에 있을 때의
                예측만 사용(out-of-fold) → 자기 정답을 본 적 없는 상태의 예측
두 조건 모두 99건에 대해 '정답을 못 본' 예측이므로 공정 비교가 된다.
어금니 = 치아 1·2·11·12 → width 24포인트 중 인덱스 0,1,2,3,20,21,22,23.
"""
from pathlib import Path
import numpy as np
import train_residual as tr

HERE = Path(__file__).resolve().parent
DATASET = HERE / "dataset-index.json"
BASELINE = HERE / "baseline_predictions_all.json"
SEED = tr.DEFAULT_SEED
MAX_CORR = 0.05
FOLDS = 5
# width target = 12치아 × (p1,p2) × (x,y) = 48값. 포인트 인덱스 0..23(치아 i → 2i, 2i+1)
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]

# 클래스2 신규 99건의 이미지 SHA 집합
import json, re, hashlib
CLASS2 = json.loads((HERE / "krr_pred_class2_new.json").read_text(encoding="utf-8"))
class2_sha = {str(r["imageRef"]).replace("sha256:", "") for r in CLASS2["results"] if r.get("status") == "ok"}
print(f"클래스2 신규 SHA: {len(class2_sha)}건")

tasks, meta = tr.build_samples(DATASET, BASELINE)
w = tasks["width"]
x, base, target, groups = w["x"], w["baseline"], w["target"], w["groups"]
print(f"width 전체 샘플: {x.shape[0]} (그룹={len(set(groups.tolist()))})")

is_new = np.array([str(g) in class2_sha for g in groups])
print(f"  ├ 신규 클래스2: {int(is_new.sum())}")
print(f"  └ 기존(구 학습셋): {int((~is_new).sum())}")


def molar_metrics(tgt, pred):
    """어금니 8포인트만 골라 오차 산출(정규화 대각선 분율)."""
    t = tgt.reshape(len(tgt), 24, 2)[:, MOLAR_POINTS, :]
    p = pred.reshape(len(pred), 24, 2)[:, MOLAR_POINTS, :]
    d = (p - t).reshape(-1, 2)
    err = np.linalg.norm(d, axis=1) / np.sqrt(2.0)
    return {
        "mae": float(err.mean()),
        "p95": float(np.quantile(err, 0.95)),
        "coordMAE": float(np.abs(d).mean()),
        "n": int(err.size),
    }


# ── 조건 A: 구모델(기존 169샘플만 학습) → 신규 99건 예측 (완전 out-of-sample)
old_mask = ~is_new
gf, lam = tr.select_hyperparameters(
    x[old_mask], base[old_mask], target[old_mask], groups[old_mask], SEED + 50021, MAX_CORR, FOLDS
)[1:]
old_model = tr.fit_krr(x[old_mask], base[old_mask], target[old_mask], gf, lam)
pred_old, acc_old, _ = tr.predict_krr(old_model, x[is_new], base[is_new], MAX_CORR)
print(f"\n[A] 구모델(169학습) → 신규99 out-of-sample | gate통과율 {acc_old.mean():.3f}")

# ── 조건 B: 신모델(268 전체) out-of-fold 예측에서 신규 99건만 추출
masks = tr.grouped_folds(groups, FOLDS, SEED)
oof = np.zeros_like(target)
acc_oof = np.zeros(x.shape[0], dtype=bool)
for i, test_mask in enumerate(masks, start=1):
    trn = ~test_mask
    g2, l2 = tr.select_hyperparameters(
        x[trn], base[trn], target[trn], groups[trn], SEED + i * 1009, MAX_CORR, min(4, FOLDS)
    )[1:]
    m = tr.fit_krr(x[trn], base[trn], target[trn], g2, l2)
    p, a, _ = tr.predict_krr(m, x[test_mask], base[test_mask], MAX_CORR)
    oof[test_mask] = p
    acc_oof[test_mask] = a
pred_new = oof[is_new]
print(f"[B] 신모델(268) out-of-fold → 신규99 | gate통과율 {acc_oof[is_new].mean():.3f}")

# ── 비교
tgt_new = target[is_new]
rule = molar_metrics(tgt_new, base[is_new])
A = molar_metrics(tgt_new, pred_old)
B = molar_metrics(tgt_new, pred_new)


def imp(a, b):
    return f"{(a - b) / a * 100:+.1f}%"


print("\n=== 신규 99건 어금니(치아1·2·11·12) · 둘 다 정답 미학습 상태 ===")
print(f"{'조건':34} {'MAE':>9} {'P95':>9}")
print(f"{'규칙엔진(보정없음)':34} {rule['mae']:9.5f} {rule['p95']:9.5f}")
print(f"{'A 구모델169 (out-of-sample)':34} {A['mae']:9.5f} {A['p95']:9.5f}")
print(f"{'B 신모델268 (out-of-fold)':34} {B['mae']:9.5f} {B['p95']:9.5f}")
print(f"\n어금니 개선율 (규칙 대비)  구모델 {imp(rule['mae'], A['mae'])}   신모델 {imp(rule['mae'], B['mae'])}")
print(f"어금니 개선율 (구 → 신)    MAE {imp(A['mae'], B['mae'])}   P95 {imp(A['p95'], B['p95'])}")

# 전체 12치아도 같은 기준으로
def all_metrics(tgt, pred):
    d = (pred - tgt).reshape(-1, 2)
    err = np.linalg.norm(d, axis=1) / np.sqrt(2.0)
    return float(err.mean()), float(np.quantile(err, 0.95))

ra = all_metrics(tgt_new, base[is_new]); aa = all_metrics(tgt_new, pred_old); ba = all_metrics(tgt_new, pred_new)
print(f"\n[참고] 전체 12치아  규칙 {ra[0]:.5f} / 구 {aa[0]:.5f} / 신 {ba[0]:.5f}"
      f"  → 구→신 {imp(aa[0], ba[0])}")

# ── 어금니 '길이(mm)' 오차: 정규화 좌표 → 최외곽 스팬=54mm 규약으로 환산
SCALE_MM = 54.0

def length_mm(arr):
    """(n,48) → (n,12) 치아별 길이(mm). 케이스별 최외곽 끝점 스팬을 54mm로 정규화."""
    p = arr.reshape(len(arr), 24, 2)
    out = np.zeros((len(arr), 12))
    for k in range(len(arr)):
        pts = p[k]
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pts[i + 1:] - pts[i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        mmpp = SCALE_MM / span if span > 0 else 0.0
        for t in range(12):
            out[k, t] = float(np.linalg.norm(pts[2 * t] - pts[2 * t + 1])) * mmpp
    return out

# 스케일은 항상 '정답' 기준으로 고정(예측이 스케일을 바꿔 오차를 숨기지 못하게)
def length_mm_with_truth_scale(arr, tgt):
    pt = tgt.reshape(len(tgt), 24, 2)
    pp = arr.reshape(len(arr), 24, 2)
    out = np.zeros((len(arr), 12))
    for k in range(len(arr)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        mmpp = SCALE_MM / span if span > 0 else 0.0
        for t in range(12):
            out[k, t] = float(np.linalg.norm(pp[k][2 * t] - pp[k][2 * t + 1])) * mmpp
    return out

MT = [t - 1 for t in MOLAR_TEETH]
L_t = length_mm_with_truth_scale(tgt_new, tgt_new)
L_r = length_mm_with_truth_scale(base[is_new], tgt_new)
L_a = length_mm_with_truth_scale(pred_old, tgt_new)
L_b = length_mm_with_truth_scale(pred_new, tgt_new)


def lerr(L):
    e = np.abs(L[:, MT] - L_t[:, MT])
    return float(e.mean()), float(np.quantile(e, 0.95))


er, ea, eb = lerr(L_r), lerr(L_a), lerr(L_b)
print("\n=== 어금니 길이오차(mm) · 둘 다 정답 미학습 상태 ===")
print(f"규칙엔진          {er[0]:.3f} mm (P95 {er[1]:.3f})")
print(f"A 구모델169       {ea[0]:.3f} mm (P95 {ea[1]:.3f})")
print(f"B 신모델268 OOF   {eb[0]:.3f} mm (P95 {eb[1]:.3f})")
print(f"개선율  규칙→구 {imp(er[0], ea[0])}   규칙→신 {imp(er[0], eb[0])}   구→신 {imp(ea[0], eb[0])}")

# TZL 합계(12치아 총합) mm 오차
def tzl(L):
    return L.sum(axis=1)

tt = tzl(L_t)
for nm, L in (("규칙", L_r), ("구모델", L_a), ("신모델", L_b)):
    e = np.abs(tzl(L) - tt)
    print(f"TZL합계 오차 {nm:6} {e.mean():.3f} mm (P95 {np.quantile(e,0.95):.3f})")

import json as _j
_j.dump({
    "schemaVersion": "molar-leakfree-v1",
    "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                "containsImageCoordinates": False, "containsModelParameters": False},
    "note": "신규 클래스2 99건. A=구학습셋169만 학습한 모델의 out-of-sample 예측, B=268 전체 grouped 5-fold의 out-of-fold 예측. 둘 다 자기 정답 미학습.",
    "evalCases": int(is_new.sum()),
    "molarTeeth": list(MOLAR_TEETH),
    "normalizedCoordError": {"rule": rule, "old169_outOfSample": A, "new268_outOfFold": B},
    "molarLengthMm": {"rule": {"mae": er[0], "p95": er[1]},
                      "old169_outOfSample": {"mae": ea[0], "p95": ea[1]},
                      "new268_outOfFold": {"mae": eb[0], "p95": eb[1]}},
    "improvementPct": {
        "molarCoord_rule_to_old": (rule["mae"] - A["mae"]) / rule["mae"] * 100,
        "molarCoord_rule_to_new": (rule["mae"] - B["mae"]) / rule["mae"] * 100,
        "molarCoord_old_to_new": (A["mae"] - B["mae"]) / A["mae"] * 100,
        "molarCoordP95_old_to_new": (A["p95"] - B["p95"]) / A["p95"] * 100,
        "molarLength_old_to_new": (ea[0] - eb[0]) / ea[0] * 100,
    },
}, open("molar_leakfree_metrics.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n→ molar_leakfree_metrics.json")
