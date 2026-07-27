#!/usr/bin/env python3
"""위치 오차 4.77 mm는 어디서 오는가 — 전역 정합 vs 치아별 배분 분해 (픽셀 공간).

`_px_decompose.py`가 픽셀 공간에서도 위치 오차가 길이 오차의 4.0배로 지배적임을
확인했다. 다만 클램프(prior x 0.74~1.20)는 병목이 아니었다(최대 도달불가율 4.5%).
그럼 무엇이 선분을 밀어내는가? 규칙엔진 구조상 후보는 세 층이다.

  ① 아치 경로 자체의 오정합 — `pxPerMmAnalysis = |path[last]-path[0]| / 54`,
     그리고 12개 중심이 이 경로 위에 배치되므로 경로가 밀리면 전부 밀린다.
  ② 경계 배분 오차 — `findToothBoundaries()`가 prior 누적비율 주변에서만 탐색.
  ③ 중심 법선 이동 — `refineToothCenter()`가 법선 방향 ±h*0.022 안에서만 이동.

12개 중심점 집합에 대해 단계적으로 자유도를 제거하면서 남는 오차를 본다:

  raw            아무 것도 제거하지 않음 (= 실제 관측 오차)
  -translation   전역 평행이동 제거 (아치 위치 오정합)
  -similarity    평행이동+회전+등방스케일 제거 (아치 위치·기울기·크기 오정합)
  -arcRepar      위 + 아치 방향 1차 재배분(호길이 offset·gain) 제거 (경계 배분)

각 단계에서 줄어드는 양이 그 층의 기여분이다. 남는 잔차가 곧 "구조적으로
전역 보정으로는 못 없애는" 치아별 오차다.

학습 없음(초안 vs 정답 직접 비교). mm는 정답 최외곽 스팬=54mm 기준.
출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
EPS = 1e-12
SEED = tr.DEFAULT_SEED
BOOTSTRAP = 5000
MOLAR_IDX = [0, 1, 10, 11]


def similarity_fit(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """src를 dst에 맞추는 최적 상사변환(회전+등방스케일+평행이동) 적용 결과."""
    sc, dc = src.mean(axis=0), dst.mean(axis=0)
    s, d = src - sc, dst - dc
    var = float((s * s).sum())
    if var < EPS:
        return src - sc + dc
    # 2D 상사변환: 복소수 최소제곱으로 회전+스케일 동시 해
    zs = s[:, 0] + 1j * s[:, 1]
    zd = d[:, 0] + 1j * d[:, 1]
    a = np.vdot(zs, zd) / np.vdot(zs, zs)
    z = zs * a
    return np.stack((z.real, z.imag), axis=1) + dc


def arc_reparam(draft: np.ndarray, truth: np.ndarray) -> np.ndarray:
    """아치 접선 방향 1차 재배분(offset+gain)을 최소제곱으로 제거.

    치아 순서를 호길이 파라미터로 보고, 각 중심을 자기 접선 방향으로만 이동시켜
    정답에 가장 가깝게 만드는 (a + b*s) 이동량을 구한다. s는 정규화 누적 호길이.
    """
    seg = np.linalg.norm(np.diff(draft, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(seg)))
    s = cum / max(float(cum[-1]), EPS)
    tangent = np.zeros_like(draft)
    tangent[1:-1] = draft[2:] - draft[:-2]
    tangent[0] = draft[1] - draft[0]
    tangent[-1] = draft[-1] - draft[-2]
    tangent /= np.maximum(np.linalg.norm(tangent, axis=1)[:, None], EPS)
    delta = truth - draft
    # 각 점에서 접선 성분만 맞춘다: proj_i ~= a + b*s_i
    proj = (delta * tangent).sum(axis=1)
    design = np.stack((np.ones_like(s), s), axis=1)
    coef, *_ = np.linalg.lstsq(design, proj, rcond=None)
    shift = design @ coef
    return draft + tangent * shift[:, None]


def stage_errors(draft: np.ndarray, truth: np.ndarray, scale: float) -> dict[str, np.ndarray]:
    """단계별 (12,) 점오차 mm."""
    def err(pred):
        return np.linalg.norm(pred - truth, axis=1) * scale
    translated = draft - draft.mean(axis=0) + truth.mean(axis=0)
    similar = similarity_fit(draft, truth)
    repar = arc_reparam(similar, truth)
    return {"raw": err(draft), "minusTranslation": err(translated),
            "minusSimilarity": err(similar), "minusArcRepar": err(repar)}


def ci95(values: np.ndarray, seed: int = SEED) -> list[float]:
    rng = np.random.default_rng(seed)
    n = len(values)
    means = np.array([values[rng.integers(0, n, n)].mean() for _ in range(BOOTSTRAP)])
    return [float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))]


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    draft_px = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth_px)

    truth_c = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    draft_c = (draft_px[:, 0::2, :] + draft_px[:, 1::2, :]) / 2.0

    stages = ("raw", "minusTranslation", "minusSimilarity", "minusArcRepar")
    per_case = {k: np.zeros((len(truth_px), 12)) for k in stages}
    for k in range(len(truth_px)):
        out = stage_errors(draft_c[k], truth_c[k], float(scale[k]))
        for name in stages:
            per_case[name][k] = out[name]

    # 아치 스팬 오차: 규칙엔진의 pxPerMmAnalysis 근거(양끝 코드길이)가 정답 대비 얼마나 틀린가
    span_draft = np.linalg.norm(draft_c[:, -1, :] - draft_c[:, 0, :], axis=1)
    span_truth = np.linalg.norm(truth_c[:, -1, :] - truth_c[:, 0, :], axis=1)
    span_err_pct = (span_draft - span_truth) / np.maximum(span_truth, EPS) * 100

    report = {
        "schemaVersion": "px-position-source-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("픽셀 공간에서 규칙엔진 중심점 위치 오차를 자유도별로 분해. 전역 평행이동 → 상사변환 "
                 "→ 아치 방향 1차 재배분 순으로 제거하며 남는 오차를 본다. 학습 없음. "
                 "mm는 정답 최외곽 스팬=54mm 기준."),
        "samples": int(len(truth_px)),
        "stages": {},
        "molarStages": {},
        "archSpan": {
            "draftVsTruthSpanErrorPct": float(span_err_pct.mean()),
            "absSpanErrorPct": float(np.abs(span_err_pct).mean()),
            "spanErrorP95Pct": float(np.quantile(np.abs(span_err_pct), 0.95)),
            "note": ("pxPerMmAnalysis는 아치 경로 양끝 코드길이/54로 정의된다. 이 스팬이 틀리면 "
                     "expectedHalf 전체가 같은 비율로 틀어진다."),
        },
    }
    raw_mean = per_case["raw"].mean()
    raw_molar = per_case["raw"][:, MOLAR_IDX].mean()
    for name in stages:
        allv, molarv = per_case[name], per_case[name][:, MOLAR_IDX]
        report["stages"][name] = {
            "meanMm": float(allv.mean()),
            "p95Mm": float(np.quantile(allv, 0.95)),
            "removedVsRawPct": round(float((raw_mean - allv.mean()) / raw_mean * 100), 2),
            "ci95": ci95(allv.mean(axis=1)),
        }
        report["molarStages"][name] = {
            "meanMm": float(molarv.mean()),
            "removedVsRawPct": round(float((raw_molar - molarv.mean()) / raw_molar * 100), 2),
        }

    residual = report["stages"]["minusArcRepar"]["meanMm"]
    report["attribution"] = {
        "globalTranslationSharePct": report["stages"]["minusTranslation"]["removedVsRawPct"],
        "similarityCumulativeSharePct": report["stages"]["minusSimilarity"]["removedVsRawPct"],
        "arcReparCumulativeSharePct": report["stages"]["minusArcRepar"]["removedVsRawPct"],
        "irreducibleResidualMm": residual,
        "irreducibleSharePct": round(float(residual / raw_mean * 100), 2),
        "verdict": ("global arch misregistration dominates"
                    if report["stages"]["minusSimilarity"]["removedVsRawPct"] >= 50
                    else "per-tooth distribution dominates"),
    }
    report["perTooth"] = [{
        "tooth": t + 1,
        "rawMm": round(float(per_case["raw"][:, t].mean()), 3),
        "minusSimilarityMm": round(float(per_case["minusSimilarity"][:, t].mean()), 3),
        "minusArcReparMm": round(float(per_case["minusArcRepar"][:, t].mean()), 3),
    } for t in range(12)]

    (HERE / "px_position_source.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}")
    print("stage                 allMm   removed%   molarMm  removed%")
    for name in stages:
        s, m = report["stages"][name], report["molarStages"][name]
        print(f"{name:20s} {s['meanMm']:6.3f} {s['removedVsRawPct']:9.2f}   "
              f"{m['meanMm']:7.3f} {m['removedVsRawPct']:8.2f}")
    print("\narchSpan:", json.dumps(report["archSpan"], ensure_ascii=False))
    print("attribution:", json.dumps(report["attribution"], ensure_ascii=False, indent=2))
    print("\ntooth   raw  -similarity  -arcRepar")
    for r in report["perTooth"]:
        print(f"{r['tooth']:5d} {r['rawMm']:6.3f} {r['minusSimilarityMm']:11.3f} {r['minusArcReparMm']:10.3f}")


if __name__ == "__main__":
    main()
