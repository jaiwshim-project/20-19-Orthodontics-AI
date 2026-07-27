#!/usr/bin/env python3
"""라벨 vs 코드 — 어느 쪽에 여력이 남았나(오라클 상한 측정).

`_label_need.py`는 라벨 곡선이 거의 소진됐음을 보였다(width 위치 slope −0.085 →
라벨 100건에 3.2%). 그럼 남은 여력은 어디 있는가? **알고리즘으로 고칠 수 있는 몫**을
오라클(정답을 훔쳐보는 이상적 보정)으로 상한을 잡아 라벨 환산으로 비교한다.

측정(2단계 OOF 예측 위, 픽셀 등방 공간, 268건):
  ① oracleSimilarity  — 케이스별 최적 상사변환(이동+회전+등방스케일)을 예측에 적용.
                        = "아치 경로 정합을 완벽히 맞췄다면" 상한.
  ② oracleTranslation — 케이스별 최적 평행이동만.
  ③ oracleArcRepar    — ①에 더해 아치 접선방향 1차 재배분(offset+gain)까지.
  ④ oracleScaleOnly   — 등방 스케일만(=pxPerMm 추정을 완벽히 맞췄다면).
각 상한의 개선폭을 `_label_need.py`의 학습곡선 기울기로 **라벨 환산**한다.

오라클은 배포 가능한 방법이 아니다. "정합을 고치면 최대 이만큼"이라는 상한이며,
실제 구현은 이 값의 일부만 회수한다. 출력에 PHI·좌표·모델 파라미터 없음.
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
STAGES = 2
PER_STAGE = 0.05
WIDTH_BIAS = 1.013
MOLAR_IDX = [0, 1, 10, 11]


def midpoints(points: np.ndarray) -> np.ndarray:
    return (points[:, 0::2, :] + points[:, 1::2, :]) / 2.0


def apply_bias(points: np.ndarray, bias: float) -> np.ndarray:
    out = points.copy()
    mid = midpoints(points)
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def as_complex(points: np.ndarray) -> np.ndarray:
    return points[..., 0] + 1j * points[..., 1]


def from_complex(z: np.ndarray) -> np.ndarray:
    return np.stack([z.real, z.imag], axis=-1)


def oracle_transform(pred: np.ndarray, truth: np.ndarray, mode: str) -> np.ndarray:
    """케이스별로 예측 전체에 최적 변환을 적용. 정답 중점들에 맞춘다(오라클)."""
    out = pred.copy()
    pm, tm = midpoints(pred), midpoints(truth)
    for k in range(len(pred)):
        zs, zd = as_complex(pm[k]), as_complex(tm[k])
        zp = as_complex(pred[k])
        cs, cd = zs.mean(), zd.mean()
        if mode == "translation":
            zp = zp + (cd - cs)
        elif mode == "scale":
            num = np.abs(zs - cs).sum()
            factor = (np.abs(zd - cd).sum() / max(num, EPS)) if num > EPS else 1.0
            zp = cs + (zp - cs) * factor
        elif mode == "similarity":
            a = np.vdot(zs - cs, zd - cd) / max(np.vdot(zs - cs, zs - cs).real, EPS)
            zp = cd + (zp - cs) * a
        else:
            raise ValueError(mode)
        out[k] = from_complex(zp)
    return out


def oracle_arc_reparam(pred: np.ndarray, truth: np.ndarray) -> np.ndarray:
    """중점들의 배열 방향(1차 주축)으로 offset+gain을 최적 적합해 재배분."""
    out = pred.copy()
    pm, tm = midpoints(pred), midpoints(truth)
    for k in range(len(pred)):
        p, t = pm[k], tm[k]
        centre = p.mean(axis=0)
        # 주축(치열 진행 방향) 추정
        direction = np.linalg.svd((p - centre).T @ (p - centre))[0][:, 0]
        s = (p - centre) @ direction
        d = ((t - centre) @ direction) - s
        design = np.stack([np.ones_like(s), s], axis=1)
        coef, *_ = np.linalg.lstsq(design, d, rcond=None)
        shift_per_point = (coef[0] + coef[1] * s)
        for tooth in range(12):
            delta = direction * shift_per_point[tooth]
            out[k, 2 * tooth, :] += delta
            out[k, 2 * tooth + 1, :] += delta
    return out


def score(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray) -> dict:
    pos = np.linalg.norm(midpoints(pred) - midpoints(truth), axis=2) * scale[:, None]
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    return {
        "positionMm": float(pos.mean()),
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "lengthAbsMm": float(np.abs(pl - tl).mean()),
        "tzlAbsErrorMm": float(np.abs(pl.sum(axis=1) - tl.sum(axis=1)).mean()),
        "_posCase": pos.mean(axis=1),
        "_tzlCase": np.abs(pl.sum(axis=1) - tl.sum(axis=1)),
    }


def labels_for_gain(current_n: float, gain_fraction: float, slope: float):
    """오차 ~ N^slope 가정에서 gain_fraction만큼 줄이려면 라벨이 몇 건 필요한가."""
    if gain_fraction <= 0 or gain_fraction >= 1 or slope >= -1e-6:
        return None
    required = current_n * (1.0 - gain_fraction) ** (1.0 / slope)
    return int(round(required - current_n))


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    corrected, _ = oof_prediction(width, STAGES, PER_STAGE)

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)
    base = apply_bias(to_pixels(corrected.reshape(-1, 24, 2), groups, dims), WIDTH_BIAS)

    variants = {
        "current(2단계+bias)": base,
        "oracleTranslation": oracle_transform(base, truth, "translation"),
        "oracleScaleOnly": oracle_transform(base, truth, "scale"),
        "oracleSimilarity": oracle_transform(base, truth, "similarity"),
    }
    variants["oracleSimilarity+arcRepar"] = oracle_arc_reparam(variants["oracleSimilarity"], truth)

    scores = {name: score(v, truth, scale) for name, v in variants.items()}
    curve = json.loads((HERE / "label_need.json").read_text(encoding="utf-8"))
    slope_pos = curve["analysis"]["width"]["positionMm"]["slope"]
    slope_tzl = curve["analysis"]["width"]["tzlAbsErrorMm"]["slope"]
    current_n = curve["analysis"]["width"]["positionMm"]["currentTrainSamples"]

    base_s = scores["current(2단계+bias)"]
    report = {
        "schemaVersion": "headroom-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("오라클 상한 측정. 케이스별 최적 변환을 정답에 맞춰 적용했을 때 남는 오차이므로 "
                 "배포 가능한 방법이 아니라 '정합을 고치면 최대 이만큼'의 상한이다. "
                 "라벨 환산은 label_need.json의 학습곡선 기울기를 사용. 픽셀 등방 공간, "
                 "mm는 정답 최외곽 스팬=54mm, WIDTH_BIAS 1.013 적용."),
        "samples": int(len(truth)),
        "curveSlopes": {"positionMm": slope_pos, "tzlAbsErrorMm": slope_tzl,
                        "currentTrainSamples": current_n},
        "variants": {},
    }
    for name, s in scores.items():
        gain_pos = (base_s["positionMm"] - s["positionMm"]) / max(base_s["positionMm"], EPS)
        gain_tzl = (base_s["tzlAbsErrorMm"] - s["tzlAbsErrorMm"]) / max(base_s["tzlAbsErrorMm"], EPS)
        entry = {k: v for k, v in s.items() if not k.startswith("_")}
        entry["positionGainPct"] = float(gain_pos * 100)
        entry["tzlGainPct"] = float(gain_tzl * 100)
        entry["equivalentLabelsForPosition"] = labels_for_gain(current_n, gain_pos, slope_pos)
        entry["equivalentLabelsForTzl"] = labels_for_gain(current_n, gain_tzl, slope_tzl)
        if name != "current(2단계+bias)":
            entry["pairedPosition"] = paired(base_s["_posCase"], s["_posCase"])
            entry["pairedTzl"] = paired(base_s["_tzlCase"], s["_tzlCase"])
        report["variants"][name] = entry

    sim = report["variants"]["oracleSimilarity"]
    report["verdict"] = {
        "arch_registration_headroom_positionPct": sim["positionGainPct"],
        "arch_registration_equivalentLabels": sim["equivalentLabelsForPosition"],
        "labels_per_100_positionPct": curve["analysis"]["width"]["positionMm"]["gainPctFor"]["100"],
        "conclusion": ("아치 경로 정합(전역 이동·회전·스케일) 개선이 라벨 수천 건에 상당하는 "
                       "여력을 갖고 있다면 코드가 우선, 아니면 라벨이 우선."),
    }

    (HERE / "headroom.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']} (2단계 OOF + bias {WIDTH_BIAS}, 픽셀 공간)")
    print(f"{'variant':28s} {'pos':>7s} {'molarPos':>9s} {'lenAbs':>7s} {'tzl':>7s} "
          f"{'posGain%':>9s} {'eqLabels':>9s}")
    for name, e in report["variants"].items():
        lab = e["equivalentLabelsForPosition"]
        print(f"{name:28s} {e['positionMm']:7.3f} {e['molarPositionMm']:9.3f} "
              f"{e['lengthAbsMm']:7.3f} {e['tzlAbsErrorMm']:7.3f} {e['positionGainPct']:9.2f} "
              f"{('-' if lab is None else format(lab, ',')):>9s}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
