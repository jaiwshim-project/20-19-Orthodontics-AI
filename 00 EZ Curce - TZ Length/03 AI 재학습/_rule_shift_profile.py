#!/usr/bin/env python3
"""규칙엔진 초안의 선분 위치 밀림이 계통적인가 — 치아별 방향 프로파일.

`_molar_offset.py` 결과에서 규칙엔진 초안의 밀림 coherence가 좌 0.763 / 우 0.809로
매우 높게 나왔다(=거의 항상 같은 방향으로 밀린다). 부호는 왼쪽 어금니 along
+3.82mm, 오른쪽 어금니 along −4.09mm였다. tangent는 치아1→12 방향이므로 양쪽
모두 **아치 안쪽(중앙 방향)**으로 밀린다는 뜻이다.

이것이 최말단 전용인지 아치 전체에 걸친 것인지 확인한다. 학습이 필요 없으므로
(초안 vs 정답만 비교) 즉시 계산된다.

부호 규약: along > 0 = tangent(치아1→12) 방향. 치아 인덱스가 작으면 +가 안쪽,
크면 −가 안쪽이다. 그래서 "안쪽 방향 성분"(inward)을 따로 계산해 부호를 통일한다.

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


def points(arr):
    return arr.reshape(len(arr), 24, 2)


def truth_scale(target):
    pt = points(target)
    scale = np.zeros(len(target))
    for k in range(len(target)):
        span = 0.0
        for i in range(24):
            d = np.linalg.norm(pt[k][i + 1:] - pt[k][i], axis=1)
            if d.size:
                span = max(span, float(d.max()))
        scale[k] = SCALE_MM / span if span > 0 else 0.0
    return scale


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    base, target = width["baseline"], width["target"]
    scale = truth_scale(target)
    pt, pb = points(target), points(base)

    # 아치 중앙 = 정답 12치아 중점들의 무게중심
    midpoints = (pt[:, 0::2, :] + pt[:, 1::2, :]) / 2.0
    arch_center = midpoints.mean(axis=1)

    rows = []
    for t in range(12):
        a, b = 2 * t, 2 * t + 1
        t0, t1 = pt[:, a, :], pt[:, b, :]
        b0, b1 = pb[:, a, :], pb[:, b, :]
        truth_vec = t1 - t0
        truth_len = np.linalg.norm(truth_vec, axis=1)
        unit = truth_vec / np.maximum(truth_len[:, None], EPS)
        normal = np.stack((-unit[:, 1], unit[:, 0]), axis=1)

        shift = (b0 + b1) / 2.0 - (t0 + t1) / 2.0
        along = (shift * unit).sum(axis=1) * scale
        perp = (shift * normal).sum(axis=1) * scale

        # 아치 중앙을 향하는 단위벡터에 투영 = "안쪽으로 밀린 양"
        to_center = arch_center - (t0 + t1) / 2.0
        to_center_norm = np.linalg.norm(to_center, axis=1)
        inward_unit = to_center / np.maximum(to_center_norm[:, None], EPS)
        inward = (shift * inward_unit).sum(axis=1) * scale

        magnitude = np.hypot(along, perp)
        rows.append({
            "tooth": t + 1,
            "alongSignedMm": float(along.mean()),
            "perpSignedMm": float(perp.mean()),
            "inwardSignedMm": float(inward.mean()),
            "inwardAbsMm": float(np.abs(inward).mean()),
            "shiftMagnitudeMm": float(magnitude.mean()),
            "coherence": float(np.hypot(along.mean(), perp.mean()) / max(magnitude.mean(), EPS)),
            "inwardCasesPct": float((inward > 0).mean() * 100),
            "inwardAsPctOfToothWidth": float(
                (inward / np.maximum(truth_len * scale, EPS)).mean() * 100),
            "lengthSignedMm": float((np.linalg.norm(b1 - b0, axis=1) - truth_len).mean()
                                    * scale.mean()),
        })

    inward_all = np.array([r["inwardSignedMm"] for r in rows])
    report = {
        "schemaVersion": "rule-shift-profile-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("규칙엔진 초안 vs 정답, width 268건 전수(학습 무관). "
                 "inward>0 = 선분 중점이 아치 중앙 쪽으로 밀림. "
                 "coherence 1에 가까울수록 항상 같은 방향으로 밀린다."),
        "samples": int(len(target)),
        "perTooth": rows,
        "summary": {
            "allTeethMeanInwardMm": float(inward_all.mean()),
            "terminalTeeth_1_2_11_12_meanInwardMm": float(
                np.mean([rows[i]["inwardSignedMm"] for i in (0, 1, 10, 11)])),
            "middleTeeth_5to8_meanInwardMm": float(
                np.mean([rows[i]["inwardSignedMm"] for i in (4, 5, 6, 7)])),
            "teethWithInwardOver1mm": [r["tooth"] for r in rows if r["inwardSignedMm"] > 1.0],
            "teethWithCoherenceOver05": [r["tooth"] for r in rows if r["coherence"] > 0.5],
            "verdict": ("systematic inward pull across arch"
                        if (inward_all > 0.5).sum() >= 10 else
                        "terminal-teeth-specific" if np.mean([inward_all[i] for i in (0, 1, 10, 11)])
                        > 2 * np.mean([inward_all[i] for i in (4, 5, 6, 7)]) else "mixed"),
        },
    }
    (HERE / "rule_shift_profile.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
