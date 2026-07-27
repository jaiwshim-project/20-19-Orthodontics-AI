#!/usr/bin/env python3
"""규칙엔진의 폭 탐색 범위가 정답 폭에 도달 가능한가 — 하드 클램프 검증.

운영/연구용 HTML의 `findWidthBoundary()`는 치아 폭 절반을 사전값(prior)의
ratio = 0.74 ~ 1.20 배 구간에서만 탐색한다:

    for k in 0..24: ratio = .74 + .46*k/24   →  0.74 … 1.20
    d = expectedHalf * ratio
    expectedHalf = AUTO_TOOTH_WIDTHS_MM[i] * pxPerMm * .5

즉 어떤 영상 증거가 있어도 치아 i의 폭은 아래 범위를 벗어날 수 없다:

    prior_i * 0.74  ≤  폭  ≤  prior_i * 1.20

정답 폭이 이 범위 밖이면 **규칙엔진은 구조적으로 정답에 도달할 수 없다**.
그러면 선분은 필연적으로 짧아지고, 인접 경계 배분까지 틀어져 위치가 밀린다.

여기서는 268건 정답 폭(mm, 최외곽 스팬=54mm 기준)이 각 치아의 도달 가능 범위를
얼마나 벗어나는지 센다. 학습 무관 — 사전값과 정답만 비교한다.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
SCALE_MM = 54.0
EPS = 1e-12
# 운영 HTML `AUTO_TOOTH_WIDTHS_MM` (보정 전/후 동일)
PRIOR_MM = (12.19, 7.92, 8.13, 7.30, 6.49, 5.91, 5.91, 6.46, 7.21, 8.15, 8.04, 12.31)
RATIO_MIN, RATIO_MAX = 0.74, 1.20


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    target = tasks["width"]["target"]
    pt = target.reshape(len(target), 24, 2)

    # mm 스케일: 정답 최외곽 스팬 = 54 mm
    scale = np.zeros(len(target))
    for k in range(len(target)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale[k] = SCALE_MM / span if span > 0 else 0.0

    rows = []
    for t in range(12):
        truth = np.linalg.norm(pt[:, 2 * t, :] - pt[:, 2 * t + 1, :], axis=1) * scale
        prior = PRIOR_MM[t]
        reachable_min, reachable_max = prior * RATIO_MIN, prior * RATIO_MAX
        over = truth > reachable_max
        under = truth < reachable_min
        rows.append({
            "tooth": t + 1,
            "priorMm": prior,
            "reachableMinMm": round(reachable_min, 3),
            "reachableMaxMm": round(reachable_max, 3),
            "truthMeanMm": float(truth.mean()),
            "truthP95Mm": float(np.quantile(truth, 0.95)),
            "casesAboveReachableMaxPct": float(over.mean() * 100),
            "casesBelowReachableMinPct": float(under.mean() * 100),
            "casesUnreachablePct": float((over | under).mean() * 100),
            "meanShortfallWhenOverMm": float((truth[over] - reachable_max).mean()) if over.any() else 0.0,
            "priorVsTruthMeanErrorPct": float((prior - truth.mean()) / truth.mean() * 100),
        })

    total = np.array([r["casesUnreachablePct"] for r in rows])
    report = {
        "schemaVersion": "rule-clamp-check-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("규칙엔진 findWidthBoundary()의 탐색 범위(prior x 0.74~1.20)가 정답 폭에 "
                 "도달 가능한지 268건 전수 검사. 학습 무관. mm는 정답 최외곽 스팬=54mm 기준."),
        "samples": int(len(target)),
        "searchRatioRange": [RATIO_MIN, RATIO_MAX],
        "perTooth": rows,
        "summary": {
            "worstTeethByUnreachableRate": [r["tooth"] for r in sorted(
                rows, key=lambda r: -r["casesUnreachablePct"])[:4]],
            "terminalTeeth_1_2_11_12_unreachablePct": [
                rows[i]["casesUnreachablePct"] for i in (0, 1, 10, 11)],
            "middleTeeth_5to8_unreachablePct": [rows[i]["casesUnreachablePct"] for i in (4, 5, 6, 7)],
            "meanUnreachablePctAllTeeth": float(total.mean()),
        },
    }
    (HERE / "rule_clamp_check.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("tooth prior  reach[min..max]   truthMean truthP95  >max%  <min%  unreach%  priorErr%")
    for r in rows:
        print(f"{r['tooth']:5d} {r['priorMm']:5.2f}  "
              f"{r['reachableMinMm']:6.2f}..{r['reachableMaxMm']:6.2f}  "
              f"{r['truthMeanMm']:8.2f} {r['truthP95Mm']:8.2f} "
              f"{r['casesAboveReachableMaxPct']:6.1f} {r['casesBelowReachableMinPct']:6.1f} "
              f"{r['casesUnreachablePct']:8.1f}  {r['priorVsTruthMeanErrorPct']:8.1f}")
    print()
    print(json.dumps(report["summary"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
