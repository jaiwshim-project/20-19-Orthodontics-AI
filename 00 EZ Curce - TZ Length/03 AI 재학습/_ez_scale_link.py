#!/usr/bin/env python3
"""EZ 정답이 치아폭 스케일 오차를 설명하는가 — 라벨 종류 선택의 결정 실험.

앞선 측정의 궁지:
  · `_headroom.py`   — 케이스별 등방 배율만 맞추면 TZL 5.878 → 4.527 mm(+23.0%)
  · `_scale_source.py` — 그 여력은 전역 상수로 회수 불가(오라클 대비 −9.9%)
  · `_scale_learn.py`  — **기존 특징으로는 배율이 예측되지 않는다**(R² 0.001~0.006)
즉 필요한 정보가 현재 입력에 아예 없다. 그럼 어떤 정보를 더 넣어야 하나?

가설: 그 정보는 **아치 경로**다. EZ 곡선이 바로 아치 경로의 정답이므로, EZ 정답에서
뽑은 기하 특징(현 길이·호 길이·굴곡·폭)이 필요 배율 log f를 설명해야 한다.
설명되면 → EZ 라벨은 EZL 정확도만 올리는 게 아니라 **치아폭 스케일 여력의 열쇠**다.
설명되지 않으면 → 남은 여력은 라벨이 아니라 이미지 검출 자체의 문제로 확정된다.

측정(치아폭·EZ 정답을 모두 가진 케이스, 이미지 SHA-256으로만 결합):
  ① EZ **정답** 기하 특징 → log f 상관/설명력 (상한: 정답을 그대로 쓰므로 낙관적)
  ② EZ **예측**(OOF) 기하 특징 → log f (실제 배포 시 쓸 수 있는 값)
  ③ ①의 특징으로 배율을 적합해 적용했을 때 TZL 개선 (그룹 OOF, 짝지어 검정)
①이 되고 ②가 안 되면 "EZ 라벨을 늘려 EZ 예측을 정답 수준으로 끌어올리는 것"이 경로다.

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
ALPHAS = (0.03, 0.1, 0.3, 1.0, 3.0, 10.0)


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
    centre = mid.mean(axis=1, keepdims=True)
    return np.linalg.norm(mid - centre, axis=2).mean(axis=1)


def scale_about_centroid(points, factor):
    centre = midpoints(points).mean(axis=1)[:, None, :]
    return centre + (points - centre) * factor[:, None, None]


def tzl_error(pred, truth, scale):
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2).sum(axis=1) * scale
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2).sum(axis=1) * scale
    return np.abs(pl - tl)


def ez_features(curve: np.ndarray) -> np.ndarray:
    """EZ 폴리라인의 스케일 불변 기하 + 절대 크기 특징.

    절대 크기(현 길이·호 길이)는 이미지 픽셀 단위라 촬영 거리에 좌우되므로,
    치아폭 예측의 산포로 나눈 **비율**도 함께 넣는다(그게 배율의 후보 설명변수다).
    """
    chord = np.linalg.norm(curve[:, -1, :] - curve[:, 0, :], axis=1)
    arc = np.linalg.norm(np.diff(curve, axis=1), axis=2).sum(axis=1)
    centre = curve.mean(axis=1, keepdims=True)
    radial = np.linalg.norm(curve - centre, axis=2)
    # 현 대비 최대 편차(아치 깊이)
    start, end = curve[:, 0, :], curve[:, -1, :]
    axis = (end - start) / np.maximum(np.linalg.norm(end - start, axis=1)[:, None], EPS)
    rel = curve - start[:, None, :]
    along = (rel * axis[:, None, :]).sum(axis=2)
    perp = np.abs(rel[:, :, 0] * -axis[:, None, 1] + rel[:, :, 1] * axis[:, None, 0])
    return np.stack([
        chord, arc, arc / np.maximum(chord, EPS),
        radial.mean(axis=1), radial.std(axis=1),
        perp.max(axis=1), perp.max(axis=1) / np.maximum(chord, EPS),
        along.max(axis=1) - along.min(axis=1),
    ], axis=1)


def ridge_oof(x, y, groups, seed):
    """그룹 5-fold OOF 예측. alpha는 train 안쪽 CV로만 선택."""
    prediction = np.zeros_like(y)
    for index, test in enumerate(tr.grouped_folds(groups, FOLDS, seed), start=1):
        train = ~test
        if train.sum() < 12:
            prediction[test] = y[train].mean() if train.sum() else 0.0
            continue
        inner = tr.grouped_folds(groups[train], min(4, FOLDS), seed + index * 31)
        best, best_err = ALPHAS[0], np.inf
        for alpha in ALPHAS:
            errs = []
            for mask in inner:
                if mask.sum() == 0 or (~mask).sum() < 8:
                    continue
                errs.append(np.abs(_ridge(x[train][~mask], y[train][~mask], x[train][mask], alpha)
                                   - y[train][mask]).mean())
            score = float(np.mean(errs)) if errs else np.inf
            if score < best_err:
                best, best_err = alpha, score
        prediction[test] = _ridge(x[train], y[train], x[test], best)
    return prediction


def _ridge(xt, yt, xv, alpha):
    mu, sd = xt.mean(axis=0), xt.std(axis=0)
    sd = np.where(sd < 1e-9, 1.0, sd)
    zt, zv = (xt - mu) / sd, (xv - mu) / sd
    ym = yt.mean()
    weights = np.linalg.solve(zt.T @ zt + alpha * np.eye(zt.shape[1]), zt.T @ (yt - ym))
    return zv @ weights + ym


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    dims = dims_by_group(HERE / "dataset-index.json")
    width, ez = tasks["width"], tasks["ez"]

    # 이미지 SHA-256(groups)으로만 결합 — 파일 번호로 섞지 않는다.
    ez_index = {str(g): i for i, g in enumerate(ez["groups"])}
    pairs = [(i, ez_index[str(g)]) for i, g in enumerate(width["groups"]) if str(g) in ez_index]
    if len(pairs) < 40:
        raise SystemExit(f"결합 케이스가 너무 적다: {len(pairs)}")
    wi = np.array([p[0] for p in pairs])
    ei = np.array([p[1] for p in pairs])

    corrected, _ = oof_prediction(width, STAGES, PER_STAGE)
    truth = to_pixels(width["target"].reshape(-1, 24, 2), width["groups"], dims)
    base = apply_bias(to_pixels(corrected.reshape(-1, 24, 2), width["groups"], dims), WIDTH_BIAS)
    scale = truth_scale_px(truth)

    factor = spread(truth) / np.maximum(spread(base), EPS)
    y = np.log(np.maximum(factor, EPS))[wi]

    n_ez = ez["target"].shape[1] // 2
    ez_truth = to_pixels(ez["target"].reshape(-1, n_ez, 2), ez["groups"], dims)
    ez_pred_raw, _ = oof_prediction(ez, STAGES, PER_STAGE)
    ez_pred = to_pixels(ez_pred_raw.reshape(-1, n_ez, 2), ez["groups"], dims)

    # 예측 산포로 정규화한 상대 특징도 넣어야 '배율'을 설명할 수 있다.
    base_spread = spread(base)[wi]
    feat_truth = ez_features(ez_truth[ei])
    feat_pred = ez_features(ez_pred[ei])
    for f in (feat_truth, feat_pred):
        f[:, 0] /= np.maximum(base_spread, EPS)
        f[:, 1] /= np.maximum(base_spread, EPS)
        f[:, 3] /= np.maximum(base_spread, EPS)
        f[:, 4] /= np.maximum(base_spread, EPS)
        f[:, 5] /= np.maximum(base_spread, EPS)
        f[:, 7] /= np.maximum(base_spread, EPS)

    groups_sub = width["groups"][wi]
    report = {
        "schemaVersion": "ez-scale-link-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("EZ 곡선 기하가 치아폭 스케일 오차(log f)를 설명하는지 검증. 치아폭·EZ 정답을 "
                 "모두 가진 케이스만, 이미지 SHA-256으로 결합. EZ 정답 특징은 낙관적 상한이고 "
                 "EZ OOF 예측 특징이 실제 배포 조건이다. 픽셀 등방 공간, mm는 정답 최외곽 "
                 "스팬=54mm, WIDTH_BIAS 1.013 적용."),
        "joinedCases": int(len(wi)),
        "logFactor": {"sd": float(y.std(ddof=1)), "meanAbs": float(np.abs(y).mean())},
        "sources": {},
    }

    # ⚠️ 공유 분모 대조군. 특징을 base_spread로 나눴고 타깃도 log(truth) − log(base)이므로
    # 분자가 상수여도 1/base_spread 성분만으로 상관이 생긴다. EZ 정보가 없는 이 대조군의
    # R²를 넘지 못하면 R² 0.74는 EZ의 기여가 아니라 산술적 인공물이다.
    null_feature = np.stack([1.0 / np.maximum(base_spread, EPS)], axis=1)

    base_err = tzl_error(base[wi], truth[wi], scale[wi])
    for tag, feat in (("nullSharedDenominatorControl", null_feature),
                      ("ezTruthFeatures", feat_truth),
                      ("ezOofPredictionFeatures", feat_pred)):
        pred_log = ridge_oof(feat, y, groups_sub, SEED)
        r = float(np.corrcoef(pred_log, y)[0, 1]) if pred_log.std() > 1e-12 else 0.0
        applied = scale_about_centroid(base[wi], np.exp(pred_log))
        new_err = tzl_error(applied, truth[wi], scale[wi])
        entry = {
            "pearsonR": r, "r2": r * r,
            "mae": float(np.abs(pred_log - y).mean()),
            "maeOfMeanBaseline": float(np.abs(y - y.mean()).mean()),
            "tzlAbsError": paired(base_err, new_err),
        }
        # 개별 특징 단독 상관(설명력의 출처 파악)
        entry["perFeaturePearsonR"] = [
            float(np.corrcoef(feat[:, j], y)[0, 1]) if feat[:, j].std() > 1e-12 else 0.0
            for j in range(feat.shape[1])
        ]
        report["sources"][tag] = entry

    oracle_err = tzl_error(scale_about_centroid(base[wi], factor[wi]), truth[wi], scale[wi])
    report["oracleOnJoinedSubset"] = {"tzlAbsError": paired(base_err, oracle_err)}

    truth_entry = report["sources"]["ezTruthFeatures"]
    pred_entry = report["sources"]["ezOofPredictionFeatures"]
    null_entry = report["sources"]["nullSharedDenominatorControl"]
    genuine = truth_entry["r2"] - null_entry["r2"]
    report["verdict"] = {
        "ezTruthExplainsScaleR2": truth_entry["r2"],
        "nullControlR2": null_entry["r2"],
        "ezR2AboveNullControl": genuine,
        "ezPredictionExplainsScaleR2": pred_entry["r2"],
        "ezTruthTzlGainPct": truth_entry["tzlAbsError"]["improvementPct"],
        "ezTruthSignificant": truth_entry["tzlAbsError"]["significant"],
        "conclusion": (
            "EZ 정답의 설명력이 공유 분모 대조군을 유의하게 넘지 못한다. R²는 산술적 "
            "인공물이며 스케일 여력은 라벨로 회수되지 않는다."
            if genuine < 0.10 else
            "EZ 정답은 대조군을 넘어 스케일 오차를 실제로 설명한다. 단 EZ **예측**의 설명력은 "
            "아직 낮으므로, EZ 라벨을 늘려 EZ 예측 정확도를 올리는 것이 치아폭 TZL 여력 "
            "회수의 경로가 된다."),
    }

    (HERE / "ez_scale_link.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"joined {report['joinedCases']} cases, log f sd {report['logFactor']['sd']:.4f}")
    for tag, e in report["sources"].items():
        v = e["tzlAbsError"]
        print(f"{tag:26s} r={e['pearsonR']:+.3f} R2={e['r2']:.3f} mae {e['mae']:.4f} "
              f"(mean-baseline {e['maeOfMeanBaseline']:.4f}) tzl {v['old']:.3f}->{v['new']:.3f} "
              f"({v['improvementPct']:+.2f}%) sig={v['significant']}")
        print("   perFeatureR " + " ".join(f"{x:+.2f}" for x in e["perFeaturePearsonR"]))
    o = report["oracleOnJoinedSubset"]["tzlAbsError"]
    print(f"{'oracle(subset)':26s} tzl {o['old']:.3f}->{o['new']:.3f} ({o['improvementPct']:+.2f}%) "
          f"sig={o['significant']}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
