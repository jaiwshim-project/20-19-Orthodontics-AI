#!/usr/bin/env python3
"""아치 경로 정합 여력(+44.8%)은 실제로 회수 가능한가 — 정합 DOF 학습 가능성 검증.

`_headroom.py`: 케이스별 최적 상사변환이면 어금니 위치 2.917 → 1.369 mm, 전체
2.259 → 1.247 mm(+44.8%, 라벨 22.8만 건 상당). 이게 "다음 최우선 과제"가 되려면
그 변환을 **정답 없이 추정**할 수 있어야 한다.

경고 사례: `_scale_learn.py`에서 등방 배율(스칼라 1개)은 기존 특징으로 R² 0.001,
즉 오라클 여력의 5%만 회수됐다. 스케일이 그랬다면 이동·회전도 그럴 수 있다.
오라클 상한을 근거로 코드 작업을 1순위로 권고하기 전에 이걸 확인해야 한다.

측정(그룹 5-fold OOF, 268건, 픽셀 등방 공간, WIDTH_BIAS 1.013 적용 예측 위):
  타깃 = 케이스별 최적 상사변환의 4개 DOF (dx, dy, log s, θ) — 정답 중점에 맞춘 값
  학습기 = ridge / RBF-KRR (하이퍼파라미터는 train 안쪽 CV로만 선택)
  평가 = ① 각 DOF의 OOF R² ② 예측 변환을 적용한 뒤 위치·어금니 위치 오차
         ③ 오라클 대비 회수율 ④ DOF를 하나씩 켜며 어디까지 회수되는지
  안전장치 = 예측 변환량을 분위 클램프로 제한(과보정 방지), cap별 전부 측정

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _px_stage_check import oof_prediction
from _rule_ab_px import paired

HERE = Path(__file__).resolve().parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
FOLDS = 5
STAGES = 2
PER_STAGE = 0.05
WIDTH_BIAS = 1.013
MOLAR_IDX = [0, 1, 10, 11]
ALPHAS = (0.03, 0.1, 0.3, 1.0, 3.0, 10.0)
GAMMAS = (0.05, 0.1, 0.3, 1.0)
DOF_NAMES = ("dxRel", "dyRel", "logScale", "rotationRad")
SUBSETS = {
    "translationOnly": ("dxRel", "dyRel"),
    "scaleOnly": ("logScale",),
    "rotationOnly": ("rotationRad",),
    "similarityAll": DOF_NAMES,
}


def midpoints(p):
    return (p[:, 0::2, :] + p[:, 1::2, :]) / 2.0


def apply_bias(points, bias):
    out = points.copy()
    mid = midpoints(points)
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def spread(points):
    mid = midpoints(points)
    return np.linalg.norm(mid - mid.mean(axis=1, keepdims=True), axis=2).mean(axis=1)


def oracle_dofs(pred, truth):
    """케이스별 최적 상사변환을 복소 최소자승으로 구해 4 DOF로 분해.

    dx, dy는 예측 산포로 정규화해 이미지 해상도 의존을 없앤다(학습 타깃 스케일 통일).
    """
    pm, tm = midpoints(pred), midpoints(truth)
    n = len(pred)
    out = np.zeros((n, 4))
    sp = spread(pred)
    for k in range(n):
        zs = pm[k, :, 0] + 1j * pm[k, :, 1]
        zd = tm[k, :, 0] + 1j * tm[k, :, 1]
        cs, cd = zs.mean(), zd.mean()
        a = np.vdot(zs - cs, zd - cd) / max(np.vdot(zs - cs, zs - cs).real, EPS)
        shift = cd - cs
        out[k] = [shift.real / max(sp[k], EPS), shift.imag / max(sp[k], EPS),
                  np.log(max(abs(a), EPS)), np.angle(a)]
    return out


def apply_dofs(pred, dofs, active):
    """선택한 DOF만 적용한 상사변환. 비활성 DOF는 항등값으로 둔다."""
    out = pred.copy()
    sp = spread(pred)
    idx = {name: i for i, name in enumerate(DOF_NAMES)}
    for k in range(len(pred)):
        z = pred[k, :, 0] + 1j * pred[k, :, 1]
        centre = (midpoints(pred)[k, :, 0] + 1j * midpoints(pred)[k, :, 1]).mean()
        scale = np.exp(dofs[k, idx["logScale"]]) if "logScale" in active else 1.0
        theta = dofs[k, idx["rotationRad"]] if "rotationRad" in active else 0.0
        z = centre + (z - centre) * (scale * np.exp(1j * theta))
        if "dxRel" in active:
            z = z + dofs[k, idx["dxRel"]] * sp[k]
        if "dyRel" in active:
            z = z + 1j * dofs[k, idx["dyRel"]] * sp[k]
        out[k, :, 0], out[k, :, 1] = z.real, z.imag
    return out


def metrics(pred, truth, scale):
    pos = np.linalg.norm(midpoints(pred) - midpoints(truth), axis=2) * scale[:, None]
    return {
        "positionMm": float(pos.mean()),
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "_pos": pos.mean(axis=1),
        "_molar": pos[:, MOLAR_IDX].mean(axis=1),
    }


def rbf(a, b, gamma):
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2)
    return np.exp(-gamma * d2 / max(a.shape[1], 1))


def fit_predict(kind, xt, yt, xv, hyper):
    mu, sd = xt.mean(axis=0), xt.std(axis=0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    zt, zv = (xt - mu) / sd, (xv - mu) / sd
    ym = yt.mean()
    if kind == "ridge":
        w = np.linalg.solve(zt.T @ zt + hyper * np.eye(zt.shape[1]), zt.T @ (yt - ym))
        return zv @ w + ym
    alpha, gamma = hyper
    k = rbf(zt, zt, gamma)
    dual = np.linalg.solve(k + alpha * np.eye(len(zt)), yt - ym)
    return rbf(zv, zt, gamma) @ dual + ym


def choose(kind, xt, yt, groups_t, seed):
    grid = list(ALPHAS) if kind == "ridge" else [(a, g) for a in ALPHAS for g in GAMMAS]
    inner = tr.grouped_folds(groups_t, min(4, FOLDS), seed)
    best, best_err = grid[0], np.inf
    for hyper in grid:
        errs = []
        for mask in inner:
            if mask.sum() == 0 or (~mask).sum() < 8:
                continue
            errs.append(np.abs(fit_predict(kind, xt[~mask], yt[~mask], xt[mask], hyper) - yt[mask]).mean())
        score = float(np.mean(errs)) if errs else np.inf
        if score < best_err:
            best, best_err = hyper, score
    return best


def oof_dof_prediction(kind, x, y_all, groups):
    """4 DOF를 각각 그룹 5-fold OOF로 예측."""
    out = np.zeros_like(y_all)
    for j in range(y_all.shape[1]):
        for index, test in enumerate(tr.grouped_folds(groups, FOLDS, SEED), start=1):
            train = ~test
            hyper = choose(kind, x[train], y_all[train, j], groups[train], SEED + index * 1009 + j * 17)
            out[test, j] = fit_predict(kind, x[train], y_all[train, j], x[test], hyper)
    return out


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    corrected, _ = oof_prediction(width, STAGES, PER_STAGE)

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    base = apply_bias(to_pixels(corrected.reshape(-1, 24, 2), groups, dims), WIDTH_BIAS)
    scale = truth_scale_px(truth)
    x = width["x"]

    dofs = oracle_dofs(base, truth)
    base_m = metrics(base, truth, scale)
    oracle_m = metrics(apply_dofs(base, dofs, DOF_NAMES), truth, scale)
    oracle_gain = base_m["positionMm"] - oracle_m["positionMm"]

    report = {
        "schemaVersion": "registration-learn-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("아치 경로 정합의 4 DOF(이동 2·스케일·회전)를 기존 특징으로 예측해 오라클 "
                 "여력을 실제 회수할 수 있는지 검증. 그룹 5-fold OOF, 하이퍼파라미터는 train "
                 "안쪽 CV로만 선택. 픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm, "
                 "WIDTH_BIAS 1.013 적용. 오라클은 배포 불가한 상한."),
        "samples": int(len(truth)),
        "baseline": {k: v for k, v in base_m.items() if not k.startswith("_")},
        "oracleSimilarity": {k: v for k, v in oracle_m.items() if not k.startswith("_")},
        "oracleDofDistribution": {
            name: {"mean": float(dofs[:, j].mean()), "sd": float(dofs[:, j].std(ddof=1)),
                   "p05": float(np.quantile(dofs[:, j], 0.05)),
                   "p95": float(np.quantile(dofs[:, j], 0.95))}
            for j, name in enumerate(DOF_NAMES)
        },
        "learners": {},
    }

    for kind in ("ridge", "krr"):
        predicted = oof_dof_prediction(kind, x, dofs, groups)
        entry = {"dofR2": {}, "variants": {}}
        for j, name in enumerate(DOF_NAMES):
            y, p = dofs[:, j], predicted[:, j]
            ss_res = float(((y - p) ** 2).sum())
            ss_tot = float(((y - y.mean()) ** 2).sum())
            r = float(np.corrcoef(p, y)[0, 1]) if p.std() > 1e-12 else 0.0
            entry["dofR2"][name] = {"r2FromResiduals": 1.0 - ss_res / max(ss_tot, EPS),
                                    "pearsonR": r, "pearsonR2": r * r}
        # 분위 클램프로 과보정 억제
        lo = np.quantile(dofs, 0.05, axis=0)
        hi = np.quantile(dofs, 0.95, axis=0)
        clamped = np.clip(predicted, lo, hi)
        for tag, source in (("raw", predicted), ("clamped5to95", clamped)):
            for subset, active in SUBSETS.items():
                m = metrics(apply_dofs(base, source, active), truth, scale)
                gain = base_m["positionMm"] - m["positionMm"]
                entry["variants"][f"{subset}@{tag}"] = {
                    "positionMm": m["positionMm"], "molarPositionMm": m["molarPositionMm"],
                    "positionGainPct": float(gain / max(base_m["positionMm"], EPS) * 100),
                    "recoveredShareOfOraclePct": float(gain / max(oracle_gain, EPS) * 100),
                    "pairedPosition": paired(base_m["_pos"], m["_pos"]),
                    "pairedMolar": paired(base_m["_molar"], m["_molar"]),
                }
        report["learners"][kind] = entry

    best_key, best_kind, best_gain = None, None, -np.inf
    for kind, entry in report["learners"].items():
        for key, v in entry["variants"].items():
            if v["positionGainPct"] > best_gain:
                best_key, best_kind, best_gain = key, kind, v["positionGainPct"]
    best = report["learners"][best_kind]["variants"][best_key]
    report["verdict"] = {
        "bestLearner": best_kind, "bestVariant": best_key,
        "bestPositionGainPct": best["positionGainPct"],
        "bestMolarGainPct": best["pairedMolar"]["improvementPct"],
        "significant": best["pairedPosition"]["significant"],
        "recoveredShareOfOraclePct": best["recoveredShareOfOraclePct"],
        "conclusion": (
            "정합 DOF도 기존 특징으로는 예측되지 않는다. 오라클 +44.8%는 현재 입력으로 "
            "회수 불가이며, 새 입력(EZ 예측 기하·아치 끝점 검출 개선)이 선행돼야 한다."
            if best_gain <= 0 or not best["pairedPosition"]["significant"] else
            "정합 DOF의 일부는 기존 특징으로도 예측된다. 오라클 여력의 일부는 라벨 없이 "
            "코드만으로 회수 가능하다."),
    }

    (HERE / "registration_learn.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}  base pos {base_m['positionMm']:.3f} "
          f"molar {base_m['molarPositionMm']:.3f}  oracle pos {oracle_m['positionMm']:.3f} "
          f"molar {oracle_m['molarPositionMm']:.3f}")
    print("\noracle DOF spread:")
    for name, s in report["oracleDofDistribution"].items():
        print(f"  {name:12s} mean {s['mean']:+.4f} sd {s['sd']:.4f} "
              f"p05 {s['p05']:+.4f} p95 {s['p95']:+.4f}")
    for kind, entry in report["learners"].items():
        print(f"\n--- {kind} DOF predictability (OOF) ---")
        for name, s in entry["dofR2"].items():
            print(f"  {name:12s} R2 {s['r2FromResiduals']:+.4f} (pearsonR2 {s['pearsonR2']:.4f})")
        print(f"  {'variant':28s} {'pos':>7s} {'molar':>7s} {'gain%':>7s} {'ofOracle%':>10s} {'sig':>5s}")
        for key, v in entry["variants"].items():
            print(f"  {key:28s} {v['positionMm']:7.3f} {v['molarPositionMm']:7.3f} "
                  f"{v['positionGainPct']:7.2f} {v['recoveredShareOfOraclePct']:10.1f} "
                  f"{str(v['pairedPosition']['significant']):>5s}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
