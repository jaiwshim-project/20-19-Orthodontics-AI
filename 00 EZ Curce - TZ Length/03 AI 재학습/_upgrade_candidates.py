#!/usr/bin/env python3
"""연구용 HTML 업그레이드 후보 — 실측 A/B로 채택 여부를 가린다.

현행(연구용 HTML): 규칙엔진 → KRR 잔차보정 2단계(단계별 5%, 누적 10%) → 전역
`WIDTH_BIAS` 1.013. 지금까지의 학습에서 나온 개선 후보를 홀드아웃으로 검증한다.

후보:
  A. 치아별 폭 편향 벡터 — 현행은 전역 상수 1개인데, 치아별 부호편향이
     −4.7%~−10.8%로 갈린다(`px_decompose.json`). 치아 12개별 배율을 폴드별 train
     에서 뽑아 test에 적용한다. 라벨 0건.
  B. 3단계 잔차보정 — 2단계가 1단계 대비 +12.9%(어금니)였다. 한 단계 더.
     누적 상한 15%.
  C. A+B 결합.

⚠️ 편향 배율은 **길이만** 바꾼다(중점 고정 확대). 위치는 수학적으로 불변이므로
A의 평가 지표는 길이·TZL이고 위치는 불변 확인용이다([[project-width-bias-stale]]).

프로토콜: 전부 폴드별 train에서만 상수/모델을 뽑아 test에 적용(누출 없음).
짝지어 부트스트랩 5,000회. 픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm.
채택 기준: 현행 대비 개선이 **유의**하고, 어금니·전체 어느 쪽도 악화되지 않을 때만.

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
PER_STAGE = 0.05
WIDTH_BIAS = 1.013
MOLAR_IDX = [0, 1, 10, 11]


def midpoints(p):
    return (p[:, 0::2, :] + p[:, 1::2, :]) / 2.0


def apply_bias_vector(points, bias):
    """치아별 배율 벡터(길이 12) 또는 스칼라를 중점 고정으로 적용."""
    vector = np.full(12, float(bias)) if np.isscalar(bias) else np.asarray(bias, float)
    out = points.copy()
    mid = midpoints(points)
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * vector[t]
    return out


def best_bias_per_tooth(pred, truth, scale):
    """치아별 최적 배율 = 정답폭/예측폭 비의 중앙값(길이 오차 최소화 방향)."""
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2)
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2)
    return np.median(tl / np.maximum(pl, EPS), axis=0)


def metrics(pred, truth, scale):
    pos = np.linalg.norm(midpoints(pred) - midpoints(truth), axis=2) * scale[:, None]
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    signed = (pl - tl) / np.maximum(tl, EPS) * 100
    return {
        "positionMm": float(pos.mean()),
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "lengthAbsMm": float(np.abs(pl - tl).mean()),
        "molarLengthAbsMm": float(np.abs(pl - tl)[:, MOLAR_IDX].mean()),
        "lengthSignedPct": float(signed.mean()),
        "molarLengthSignedPct": float(signed[:, MOLAR_IDX].mean()),
        "tzlAbsErrorMm": float(np.abs(pl.sum(axis=1) - tl.sum(axis=1)).mean()),
        "_len": np.abs(pl - tl).mean(axis=1),
        "_molarLen": np.abs(pl - tl)[:, MOLAR_IDX].mean(axis=1),
        "_tzl": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
        "_pos": pos.mean(axis=1),
        "_molarPos": pos[:, MOLAR_IDX].mean(axis=1),
    }


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)
    stage2, _ = oof_prediction(width, 2, PER_STAGE)
    stage3, _ = oof_prediction(width, 3, PER_STAGE)
    px2 = to_pixels(stage2.reshape(-1, 24, 2), groups, dims)
    px3 = to_pixels(stage3.reshape(-1, 24, 2), groups, dims)

    masks = list(tr.grouped_folds(groups, FOLDS, SEED))

    def holdout_vector_bias(pred):
        """폴드별 train에서 치아별 배율을 뽑아 test에만 적용."""
        out = pred.copy()
        vectors = []
        for test in masks:
            vector = best_bias_per_tooth(pred[~test], truth[~test], scale[~test])
            vectors.append(vector)
            out[test] = apply_bias_vector(pred[test], vector)
        return out, np.array(vectors)

    vec2, vectors2 = holdout_vector_bias(px2)
    vec3, vectors3 = holdout_vector_bias(px3)

    variants = {
        "현행: 2단계+전역1.013": apply_bias_vector(px2, WIDTH_BIAS),
        "A: 2단계+치아별벡터": vec2,
        "B: 3단계+전역1.013": apply_bias_vector(px3, WIDTH_BIAS),
        "C: 3단계+치아별벡터": vec3,
    }
    scored = {name: metrics(v, truth, scale) for name, v in variants.items()}
    current = scored["현행: 2단계+전역1.013"]

    report = {
        "schemaVersion": "upgrade-candidates-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("연구용 HTML 업그레이드 후보의 홀드아웃 A/B. 치아별 배율과 3단계 모델은 모두 "
                 "폴드별 train에서만 뽑아 test에 적용(누출 없음). 짝지어 부트스트랩 5,000회. "
                 "픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm. 배율은 길이만 바꾸므로 위치 "
                 "지표는 불변 확인용이다."),
        "samples": int(len(truth)),
        "toothBiasVector": {
            "foldMedian": [round(float(v), 4) for v in np.median(vectors2, axis=0)],
            "foldSpread": [round(float(v), 4) for v in (vectors2.max(axis=0) - vectors2.min(axis=0))],
            "globalConstant": WIDTH_BIAS,
        },
        "variants": {},
    }
    for name, s in scored.items():
        entry = {k: v for k, v in s.items() if not k.startswith("_")}
        if name != "현행: 2단계+전역1.013":
            entry["vsCurrent"] = {
                "lengthAbs": paired(current["_len"], s["_len"]),
                "molarLengthAbs": paired(current["_molarLen"], s["_molarLen"]),
                "tzlAbsError": paired(current["_tzl"], s["_tzl"]),
                "position": paired(current["_pos"], s["_pos"]),
                "molarPosition": paired(current["_molarPos"], s["_molarPos"]),
            }
        report["variants"][name] = entry

    def accept(name):
        v = report["variants"][name]["vsCurrent"]
        gains = [v["lengthAbs"], v["molarLengthAbs"], v["tzlAbsError"]]
        any_sig_gain = any(g["significant"] and g["improvementPct"] > 0 for g in gains)
        harm = [k for k, g in v.items() if g["significant"] and g["improvementPct"] < 0]
        return {"anySignificantGain": any_sig_gain, "significantRegressions": harm,
                "accepted": bool(any_sig_gain and not harm)}

    report["decision"] = {name: accept(name) for name in scored if name != "현행: 2단계+전역1.013"}
    chosen = [n for n, d in report["decision"].items() if d["accepted"]]
    report["verdict"] = {
        "acceptedCandidates": chosen,
        "conclusion": ("채택 후보 없음 — 연구용 HTML 엔진은 현행 유지가 최선이다."
                       if not chosen else f"채택: {', '.join(chosen)}"),
    }

    (HERE / "upgrade_candidates.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}")
    print("tooth bias vector (fold median):", report["toothBiasVector"]["foldMedian"])
    print("             fold spread       :", report["toothBiasVector"]["foldSpread"])
    print(f"\n{'variant':26s} {'lenAbs':>7s} {'molarLen':>9s} {'tzl':>7s} {'signed%':>8s} "
          f"{'pos':>7s} {'molarPos':>9s}")
    for name, s in scored.items():
        print(f"{name:26s} {s['lengthAbsMm']:7.4f} {s['molarLengthAbsMm']:9.4f} "
              f"{s['tzlAbsErrorMm']:7.3f} {s['lengthSignedPct']:8.2f} "
              f"{s['positionMm']:7.3f} {s['molarPositionMm']:9.3f}")
    print("\nvs current (paired bootstrap):")
    for name in scored:
        if name == "현행: 2단계+전역1.013":
            continue
        v = report["variants"][name]["vsCurrent"]
        print(f"  {name}")
        for key in ("lengthAbs", "molarLengthAbs", "tzlAbsError", "position", "molarPosition"):
            g = v[key]
            print(f"    {key:16s} {g['old']:.4f} -> {g['new']:.4f} ({g['improvementPct']:+6.2f}%) "
                  f"CI [{g['ci95'][0]:+.4f},{g['ci95'][1]:+.4f}] sig={g['significant']}")
        print(f"    decision: {json.dumps(report['decision'][name], ensure_ascii=True)}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
