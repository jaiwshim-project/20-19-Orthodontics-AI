#!/usr/bin/env python3
"""오라클 스케일을 **학습으로 회수**할 수 있는가 — 케이스별 배율 1개 예측.

`_headroom.py`: 케이스별 등방 스케일만 정답에 맞추면 TZL 5.878 → 4.527 mm(+23.0%),
좌표 라벨 약 9,300건에 상당. `_scale_source.py`: 그 여력은 전역 상수로 회수되지
않는다(오라클 대비 −9.9%, 필요 배율 CV 6.2% vs 계통편향 0.33%).

남은 질문: 배율이 케이스별로 다르다면, **그 배율을 예측**할 수 있나?
좌표 24개(48 DOF)를 맞추는 것과 달리 배율은 스칼라 1개다. 같은 라벨 수로도
훨씬 배우기 쉬울 수 있다. 이게 되면 "라벨 더" 대신 "항 하나 추가"가 답이 된다.

측정(그룹 5-fold OOF, 픽셀 등방 공간, 268건):
  타깃  = log f, f = 정답 중점 산포 / 예측 중점 산포 (headroom의 scale 오라클과 동일 정의)
  학습기 = ridge / RBF-KRR (하이퍼파라미터는 train 안쪽 CV로만 선택)
  평가  = 예측 배율을 적용한 뒤 TZL·위치 오차를 무보정 대비 짝지어 비교
  안전장치 = 예측 배율을 ±cap으로 클램프(과보정 방지). cap별로 전부 측정.
비교 기준으로 오라클(정답 배율)과 전역 상수도 같은 표에 넣는다.

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
CAPS = (0.02, 0.04, 0.06, None)
RIDGE_ALPHAS = (0.03, 0.1, 0.3, 1.0, 3.0, 10.0)
KRR_GAMMAS = (0.05, 0.1, 0.3, 1.0)


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
    """중점들의 중심 대비 평균 거리 = 아치 산포(등방 스케일의 척도)."""
    mid = midpoints(points)
    centre = mid.mean(axis=1, keepdims=True)
    return np.linalg.norm(mid - centre, axis=2).mean(axis=1)


def scale_about_centroid(points, factor):
    centre = midpoints(points).mean(axis=1)[:, None, :]
    return centre + (points - centre) * factor[:, None, None]


def metrics(pred, truth, scale):
    pos = np.linalg.norm(midpoints(pred) - midpoints(truth), axis=2) * scale[:, None]
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "positionMm": float(pos.mean()),
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "lengthAbsMm": float(np.abs(pl - tl).mean()),
        "tzlAbsErrorMm": float(np.abs(pl.sum(axis=1) - tl.sum(axis=1)).mean()),
        "_pos": pos.mean(axis=1),
        "_tzl": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
    }


def rbf(a, b, gamma):
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2)
    return np.exp(-gamma * d2 / max(a.shape[1], 1))


def fit_predict(kind, xt, yt, xv, hyper):
    """train에서 적합해 xv를 예측. 표준화·중심화는 train 통계만 사용."""
    mu, sd = xt.mean(axis=0), xt.std(axis=0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    zt, zv = (xt - mu) / sd, (xv - mu) / sd
    ym = yt.mean()
    if kind == "ridge":
        alpha = hyper
        gram = zt.T @ zt + alpha * np.eye(zt.shape[1])
        weights = np.linalg.solve(gram, zt.T @ (yt - ym))
        return zv @ weights + ym
    alpha, gamma = hyper
    k = rbf(zt, zt, gamma)
    dual = np.linalg.solve(k + alpha * np.eye(len(zt)), yt - ym)
    return rbf(zv, zt, gamma) @ dual + ym


def choose(kind, xt, yt, groups_t, seed):
    """train 안쪽 grouped CV로 하이퍼파라미터 선택(테스트 폴드 절대 미사용)."""
    grid = list(RIDGE_ALPHAS) if kind == "ridge" else [(a, g) for a in RIDGE_ALPHAS for g in KRR_GAMMAS]
    inner = tr.grouped_folds(groups_t, min(4, FOLDS), seed)
    best, best_err = grid[0], np.inf
    for hyper in grid:
        err = []
        for mask in inner:
            if mask.sum() == 0 or (~mask).sum() < 8:
                continue
            pred = fit_predict(kind, xt[~mask], yt[~mask], xt[mask], hyper)
            err.append(np.abs(pred - yt[mask]).mean())
        score = float(np.mean(err)) if err else np.inf
        if score < best_err:
            best, best_err = hyper, score
    return best


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

    oracle_factor = spread(truth) / np.maximum(spread(base), EPS)
    y = np.log(np.maximum(oracle_factor, EPS))

    masks = list(tr.grouped_folds(groups, FOLDS, SEED))
    learned = {kind: np.zeros(len(y)) for kind in ("ridge", "krr")}
    constant = np.zeros(len(y))
    picks = {"ridge": [], "krr": []}
    for index, test in enumerate(masks, start=1):
        train = ~test
        constant[test] = np.median(y[train])
        for kind in learned:
            hyper = choose(kind, x[train], y[train], groups[train], SEED + index * 1009)
            picks[kind].append(hyper if kind == "ridge" else list(hyper))
            learned[kind][test] = fit_predict(kind, x[train], y[train], x[test], hyper)

    base_m = metrics(base, truth, scale)
    variants = {"oracle": oracle_factor, "globalConstant": np.exp(constant)}
    for kind, pred_log in learned.items():
        variants[f"learned:{kind}"] = np.exp(pred_log)

    report = {
        "schemaVersion": "scale-learn-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("케이스별 등방 배율(스칼라 1개)을 기존 특징으로 예측해 오라클 여력을 실제로 "
                 "회수할 수 있는지 측정. 그룹 5-fold OOF, 하이퍼파라미터는 train 안쪽 CV로만 "
                 "선택. cap은 예측 배율의 최대 허용 편차. 픽셀 등방 공간, mm는 정답 최외곽 "
                 "스팬=54mm, WIDTH_BIAS 1.013 적용."),
        "samples": int(len(y)),
        "oracleFactor": {"mean": float(oracle_factor.mean()), "sd": float(oracle_factor.std(ddof=1)),
                         "p05": float(np.quantile(oracle_factor, 0.05)),
                         "p95": float(np.quantile(oracle_factor, 0.95))},
        "logFactorCorrelation": {},
        "baseline": {k: v for k, v in base_m.items() if not k.startswith("_")},
        "variants": {},
    }
    for kind, pred_log in learned.items():
        r = float(np.corrcoef(pred_log, y)[0, 1])
        report["logFactorCorrelation"][kind] = {
            "pearsonR": r, "r2": r * r,
            "mae": float(np.abs(pred_log - y).mean()),
            "maeOfConstant": float(np.abs(constant - y).mean()),
            "chosenHyperparameters": picks[kind],
        }

    for name, factor in variants.items():
        for cap in CAPS:
            f = np.clip(factor, 1 - cap, 1 + cap) if cap is not None else factor
            m = metrics(scale_about_centroid(base, f), truth, scale)
            key = f"{name}@cap{'none' if cap is None else f'{cap:.2f}'}"
            report["variants"][key] = {
                **{k: v for k, v in m.items() if not k.startswith("_")},
                "pairedTzl": paired(base_m["_tzl"], m["_tzl"]),
                "pairedPosition": paired(base_m["_pos"], m["_pos"]),
            }

    oracle_gain = base_m["tzlAbsErrorMm"] - report["variants"]["oracle@capnone"]["tzlAbsErrorMm"]
    best_key, best_gain = None, -np.inf
    for key, v in report["variants"].items():
        if not key.startswith("learned"):
            continue
        gain = base_m["tzlAbsErrorMm"] - v["tzlAbsErrorMm"]
        if gain > best_gain:
            best_key, best_gain = key, gain
    report["verdict"] = {
        "bestLearnedVariant": best_key,
        "bestLearnedTzlGainPct": float(best_gain / max(base_m["tzlAbsErrorMm"], EPS) * 100),
        "bestLearnedSignificant": report["variants"][best_key]["pairedTzl"]["significant"],
        "recoveredShareOfOraclePct": float(best_gain / max(oracle_gain, EPS) * 100),
        "conclusion": ("스케일은 스칼라 1개라도 기존 특징으로는 예측되지 않는다. 오라클 여력은 "
                       "라벨이 아니라 아치 끝점/경로 검출 자체를 고쳐야 회수된다."
                       if best_gain <= 0 or not report["variants"][best_key]["pairedTzl"]["significant"]
                       else "케이스별 배율 예측 항으로 오라클 여력의 일부를 실제로 회수할 수 있다."),
    }

    (HERE / "scale_learn.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']} oracleFactor mean {oracle_factor.mean():.4f} "
          f"sd {oracle_factor.std(ddof=1):.4f}")
    for kind, c in report["logFactorCorrelation"].items():
        print(f"  {kind:6s} r={c['pearsonR']:+.3f} R2={c['r2']:.3f} "
              f"mae {c['mae']:.4f} (constant {c['maeOfConstant']:.4f})")
    print(f"\nbaseline tzl {base_m['tzlAbsErrorMm']:.3f} pos {base_m['positionMm']:.3f}")
    print(f"{'variant':26s} {'tzl':>7s} {'pos':>7s} {'tzlGain%':>9s} {'sig':>5s}")
    for key, v in report["variants"].items():
        gain = (base_m["tzlAbsErrorMm"] - v["tzlAbsErrorMm"]) / base_m["tzlAbsErrorMm"] * 100
        print(f"{key:26s} {v['tzlAbsErrorMm']:7.3f} {v['positionMm']:7.3f} {gain:9.2f} "
              f"{str(v['pairedTzl']['significant']):>5s}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
