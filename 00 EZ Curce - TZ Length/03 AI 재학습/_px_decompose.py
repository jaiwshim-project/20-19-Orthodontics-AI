#!/usr/bin/env python3
"""픽셀 공간에서의 치아폭 선분 오차 재분해 — 섹션28 측정 오류 정정.

**정정 대상.** `_molar_offset.py` / `_rule_shift_profile.py` / `_rule_clamp_check.py`
/ `_calibrate_prior.py`는 모두 `train_residual.build_samples`가 돌려주는
**정규화 좌표(x/W, y/H)** 위에서 길이를 계산했다. 이미지가 정사각형이 아니면
정규화는 x·y를 서로 다른 배율로 줄이므로(예 5514x3681, 종횡비 1.5) 길이가
**방향에 따라 최대 1.5배까지 왜곡**된다. 즉 "치아1 정답폭 14.92mm > 도달가능
최대 14.63mm" 같은 결론은 측정 인공물이었다.

여기서는 정규화 좌표를 이미지 픽셀로 되돌린 뒤(등방 공간) 동일한 분해를 다시 한다:

  along / perp = 정답 선분 방향·법선 성분,  position = 중점 이동 크기
  inward = 아치 중앙을 향하는 성분(>0 안쪽으로 밀림)
  coherence = |평균 벡터| / 평균 |벡터|

mm 환산은 정답 최외곽 폭 끝점 스팬 = 54 mm(항상 정답 기준, 예측 기준 아님).
학습 없음 — 규칙엔진 초안과 정답만 비교하므로 268건 전수 사용이 정당하다.

출력에 PHI·좌표·파일명 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
SCALE_MM = 54.0
EPS = 1e-12
SEED = tr.DEFAULT_SEED
BOOTSTRAP = 5000
MOLAR = (1, 2, 11, 12)
PRIOR_MM = (12.19, 7.92, 8.13, 7.30, 6.49, 5.91, 5.91, 6.46, 7.21, 8.15, 8.04, 12.31)
RATIO = (0.74, 1.20)


def dims_by_case(dataset_path: Path) -> dict[str, tuple[float, float]]:
    """caseId -> (width, height). 정규화 좌표를 픽셀로 되돌릴 때 쓴다.

    ⚠️ `dims_by_group`을 쓰면 안 되는 경우가 있다. 그 함수의 키는
    `splitGrouping.minimumGroupId` = **환자 차트 ID**이고 `setdefault`로 첫 사진의
    크기만 기억한다. 그런데 같은 환자의 사진 2장은 해상도가 다른 경우가 많다 —
    실측 343그룹 중 **106그룹**이 서로 다른 크기다(예 chart:2960 = 3666x2444와
    5514x3681). 그 그룹의 두 번째 사진은 잘못된 W/H로 픽셀 변환돼 좌표가 틀어진다.
    실측 영향: 폭 정답 384건 중 52건이 다른 파이프라인 정답과 최대 24.9mm 어긋났다.

    caseId는 케이스마다 고유하므로(384건 전수 확인) 이 함수는 그 충돌이 없다.
    """
    out: dict[str, tuple[float, float]] = {}
    for case in tr.dataset_cases(tr.read_json(dataset_path)):
        size = tr.dimensions(case)
        if size:
            out[str(tr.get_case_id(case))] = size
    return out


def dims_by_group(dataset_path: Path) -> dict[str, tuple[float, float]]:
    """그룹(환자 차트) -> 첫 사진의 (width, height).

    ⚠️ 같은 그룹에 크기가 다른 사진이 섞이면 두 번째 이후가 틀린다
    (실측 106/343 그룹). 케이스 단위 변환에는 `dims_by_case`를 쓴다. 이 함수는
    기존 측정 스크립트의 재현성을 위해 남겨 둔다.
    """
    out: dict[str, tuple[float, float]] = {}
    for case in tr.dataset_cases(tr.read_json(dataset_path)):
        image = case.get("image") if isinstance(case.get("image"), dict) else case
        sha = tr.sha256_text(image.get("sha256")) if isinstance(image, dict) else None
        split = case.get("splitGrouping") if isinstance(case.get("splitGrouping"), dict) else {}
        group = str(split.get("minimumGroupId") or sha)
        size = tr.dimensions(case)
        if size:
            out.setdefault(group, size)
    return out


def to_pixels(points: np.ndarray, groups, dims) -> np.ndarray:
    """정규화 좌표 (cases,24,2) -> 픽셀 좌표(등방)."""
    out = points.copy()
    for k, group in enumerate(groups):
        w, h = dims[group]
        out[k, :, 0] *= w
        out[k, :, 1] *= h
    return out


def truth_scale_px(truth_px: np.ndarray) -> np.ndarray:
    scale = np.zeros(len(truth_px))
    for k in range(len(truth_px)):
        span = max(float(np.linalg.norm(truth_px[k][i + 1:] - truth_px[k][i], axis=1).max())
                   for i in range(23))
        scale[k] = SCALE_MM / span if span > 0 else 0.0
    return scale


def decompose(draft_px: np.ndarray, truth_px: np.ndarray, scale: np.ndarray):
    midpoints = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    arch_center = midpoints.mean(axis=1)
    keys = ("along", "perp", "position", "inward", "lenSigned", "lenTruth", "angle")
    out = {k: [] for k in keys}
    for t in range(12):
        a, b = 2 * t, 2 * t + 1
        t0, t1 = truth_px[:, a, :], truth_px[:, b, :]
        d0, d1 = draft_px[:, a, :], draft_px[:, b, :]
        vec = t1 - t0
        tlen = np.linalg.norm(vec, axis=1)
        unit = vec / np.maximum(tlen[:, None], EPS)
        normal = np.stack((-unit[:, 1], unit[:, 0]), axis=1)
        shift = (d0 + d1) / 2.0 - (t0 + t1) / 2.0
        to_center = arch_center - (t0 + t1) / 2.0
        inward_unit = to_center / np.maximum(np.linalg.norm(to_center, axis=1)[:, None], EPS)
        dvec = d1 - d0
        dlen = np.linalg.norm(dvec, axis=1)
        cos = np.clip((dvec * unit).sum(axis=1) / np.maximum(dlen, EPS), -1.0, 1.0)
        out["along"].append((shift * unit).sum(axis=1) * scale)
        out["perp"].append((shift * normal).sum(axis=1) * scale)
        out["position"].append(np.linalg.norm(shift, axis=1) * scale)
        out["inward"].append((shift * inward_unit).sum(axis=1) * scale)
        out["lenSigned"].append((dlen - tlen) * scale)
        out["lenTruth"].append(tlen * scale)
        out["angle"].append(np.degrees(np.arccos(np.abs(cos))))
    return {k: np.stack(v, axis=1) for k, v in out.items()}


def paired_bootstrap(values: np.ndarray, seed: int = SEED) -> list[float]:
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
    d = decompose(draft_px, truth_px, scale)

    left_idx = [0, 1]        # 치아 1,2
    right_idx = [10, 11]     # 치아 11,12
    molar_idx = [t - 1 for t in MOLAR]
    middle_idx = [4, 5, 6, 7]

    def block(idx) -> dict:
        pos = d["position"][:, idx]
        along, perp = d["along"][:, idx], d["perp"][:, idx]
        return {
            "positionShiftMm": float(pos.mean()),
            "positionShiftP95Mm": float(np.quantile(pos, 0.95)),
            "lengthAbsErrorMm": float(np.abs(d["lenSigned"][:, idx]).mean()),
            "lengthSignedErrorMm": float(d["lenSigned"][:, idx].mean()),
            "lengthSignedPct": float((d["lenSigned"][:, idx] / np.maximum(d["lenTruth"][:, idx], EPS)).mean() * 100),
            "angleDeg": float(d["angle"][:, idx].mean()),
            "alongAbsMm": float(np.abs(along).mean()),
            "perpAbsMm": float(np.abs(perp).mean()),
            "inwardSignedMm": float(d["inward"][:, idx].mean()),
            "coherence": float(np.hypot(along.mean(), perp.mean()) / max(pos.mean(), EPS)),
            "positionOverLengthRatio": float(pos.mean() / max(np.abs(d["lenSigned"][:, idx]).mean(), EPS)),
            "shiftAsPctOfToothWidth": float((pos / np.maximum(d["lenTruth"][:, idx], EPS)).mean() * 100),
            "casesShiftedOverQuarterPct": float((pos > d["lenTruth"][:, idx] * 0.25).mean() * 100),
            "positionCi95": paired_bootstrap(pos.mean(axis=1)),
        }

    report = {
        "schemaVersion": "px-decompose-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("섹션28 정정: 오차 분해를 **픽셀(등방) 공간**에서 재계산. 이전 측정은 정규화 좌표"
                 "(x/W, y/H)에서 길이를 재어 종횡비만큼 방향 의존 왜곡이 있었다. "
                 "mm는 정답 최외곽 스팬=54mm 기준. 규칙엔진 초안 vs 정답, 학습 없음."),
        "samples": int(len(truth_px)),
        "ruleDraft": {
            "molar": block(molar_idx),
            "middleTeeth5to8": block(middle_idx),
            "leftMolar_1_2": block(left_idx),
            "rightMolar_11_12": block(right_idx),
            "allTeeth": block(list(range(12))),
        },
        "perTooth": [{
            "tooth": t + 1,
            "positionMm": round(float(d["position"][:, t].mean()), 3),
            "inwardSignedMm": round(float(d["inward"][:, t].mean()), 3),
            "lengthSignedMm": round(float(d["lenSigned"][:, t].mean()), 3),
            "lengthSignedPct": round(float((d["lenSigned"][:, t] / np.maximum(d["lenTruth"][:, t], EPS)).mean() * 100), 1),
            "truthWidthMm": round(float(d["lenTruth"][:, t].mean()), 2),
            "priorMm": PRIOR_MM[t],
            "priorVsTruthPct": round(float((PRIOR_MM[t] - d["lenTruth"][:, t].mean()) / d["lenTruth"][:, t].mean() * 100), 1),
            "reachableMaxMm": round(PRIOR_MM[t] * RATIO[1], 2),
            "unreachablePct": round(float((((d["lenTruth"][:, t] > PRIOR_MM[t] * RATIO[1]) |
                                            (d["lenTruth"][:, t] < PRIOR_MM[t] * RATIO[0])).mean()) * 100), 1),
            "coherence": round(float(np.hypot(d["along"][:, t].mean(), d["perp"][:, t].mean())
                                     / max(d["position"][:, t].mean(), EPS)), 3),
        } for t in range(12)],
    }

    unreach = np.array([r["unreachablePct"] for r in report["perTooth"]])
    prior_err = np.array([r["priorVsTruthPct"] for r in report["perTooth"]])
    report["clampVerdict"] = {
        "maxUnreachablePct": float(unreach.max()),
        "meanUnreachablePct": float(unreach.mean()),
        "maxAbsPriorErrorPct": float(np.abs(prior_err).max()),
        "verdict": ("clamp is a real bottleneck" if unreach.max() > 10
                    else "clamp is NOT a bottleneck in pixel space"),
        "correctsPreviousClaim": ("섹션28의 '최말단 치아 도달불가율 63.8%'는 정규화 좌표 측정 인공물. "
                                  f"픽셀 공간에서는 최대 {unreach.max():.1f}%다."),
    }
    molar = report["ruleDraft"]["molar"]
    report["dominantComponent"] = {
        "molarPositionMm": molar["positionShiftMm"],
        "molarLengthAbsMm": molar["lengthAbsErrorMm"],
        "positionOverLengthRatio": molar["positionOverLengthRatio"],
        "verdict": ("position dominates" if molar["positionOverLengthRatio"] > 1.5
                    else "comparable" if molar["positionOverLengthRatio"] > 0.8 else "length dominates"),
    }

    (HERE / "px_decompose.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}  (픽셀 공간 재측정)")
    for name in ("molar", "middleTeeth5to8", "leftMolar_1_2", "rightMolar_11_12", "allTeeth"):
        b = report["ruleDraft"][name]
        print(f"[{name:18s}] pos {b['positionShiftMm']:.3f} mm  lenAbs {b['lengthAbsErrorMm']:.3f} mm  "
              f"ratio {b['positionOverLengthRatio']:.2f}  inward {b['inwardSignedMm']:+.3f}  "
              f"coher {b['coherence']:.3f}  lenSigned {b['lengthSignedPct']:+.1f}%")
    print("\ntooth truthW prior priorErr% reachMax unreach%  pos   inward  lenSigned%  coher")
    for r in report["perTooth"]:
        print(f"{r['tooth']:5d} {r['truthWidthMm']:6.2f} {r['priorMm']:5.2f} {r['priorVsTruthPct']:9.1f} "
              f"{r['reachableMaxMm']:8.2f} {r['unreachablePct']:8.1f} {r['positionMm']:6.3f} "
              f"{r['inwardSignedMm']:+7.3f} {r['lengthSignedPct']:10.1f} {r['coherence']:6.3f}")
    print("\nclampVerdict:", json.dumps(report["clampVerdict"], ensure_ascii=False, indent=2))
    print("dominantComponent:", json.dumps(report["dominantComponent"], ensure_ascii=True))


if __name__ == "__main__":
    main()
