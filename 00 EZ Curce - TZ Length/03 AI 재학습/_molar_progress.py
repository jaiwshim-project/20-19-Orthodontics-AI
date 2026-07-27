#!/usr/bin/env python3
"""어금니 분석이 실제로 얼마나 개선됐나 — 단계별 기여를 픽셀 공간에서 분리.

어금니(치아 1·2·11·12 = 인덱스 0,1,10,11)는 줄곧 가장 나쁜 구간이었다. 지금까지의
개선 조치가 각각 어금니에 얼마를 기여했는지 **같은 척도(픽셀 등방 공간, mm)**로
한 표에 놓는다. 기존 보고들은 정규화 좌표 시절 수치가 섞여 있어 직접 비교가 안 된다.

비교 대상(모두 그룹 5-fold OOF, 268건, mm는 정답 최외곽 스팬=54mm):
  ① ruleDraft        — 규칙 엔진 원안(보정 없음) = 운영 HTML이 내는 값
  ② stage1           — KRR 잔차보정 1단계(상한 5%)
  ③ stage2           — 2단계 반복 잔차보정(단계별 5%, 누적 10%)
  ④ stage2+bias      — 여기에 WIDTH_BIAS 1.013까지 = 연구용 HTML 현행
지표: 어금니 위치(중점 이동) mm, 어금니 길이 절대오차 mm, 어금니 길이 부호편향 %,
      비교용으로 전체 12치아 값도 같이. 짝지어 부트스트랩 5,000회로 유의성 확인.

또한 "어금니가 여전히 나쁜가"를 상대값으로 본다(어금니/전체 비, 최말단 치아 비교).

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
MOLAR_IDX = [0, 1, 10, 11]
TERMINAL_IDX = [0, 11]
CENTRAL_IDX = [5, 6]
WIDTH_BIAS = 1.013


def midpoints(p):
    return (p[:, 0::2, :] + p[:, 1::2, :]) / 2.0


def apply_bias(points, bias):
    out = points.copy()
    mid = midpoints(points)
    for t in range(12):
        for j in (2 * t, 2 * t + 1):
            out[:, j, :] = mid[:, t, :] + (points[:, j, :] - mid[:, t, :]) * bias
    return out


def per_tooth(pred, truth, scale):
    pos = np.linalg.norm(midpoints(pred) - midpoints(truth), axis=2) * scale[:, None]
    tl = np.linalg.norm(truth[:, 0::2, :] - truth[:, 1::2, :], axis=2) * scale[:, None]
    pl = np.linalg.norm(pred[:, 0::2, :] - pred[:, 1::2, :], axis=2) * scale[:, None]
    return pos, pl, tl


def summarise(pred, truth, scale):
    pos, pl, tl = per_tooth(pred, truth, scale)
    signed = (pl - tl) / np.maximum(tl, EPS) * 100
    return {
        "molarPositionMm": float(pos[:, MOLAR_IDX].mean()),
        "allPositionMm": float(pos.mean()),
        "molarLengthAbsMm": float(np.abs(pl - tl)[:, MOLAR_IDX].mean()),
        "allLengthAbsMm": float(np.abs(pl - tl).mean()),
        "molarLengthSignedPct": float(signed[:, MOLAR_IDX].mean()),
        "allLengthSignedPct": float(signed.mean()),
        "terminalPositionMm": float(pos[:, TERMINAL_IDX].mean()),
        "centralPositionMm": float(pos[:, CENTRAL_IDX].mean()),
        "molarOverAllRatio": float(pos[:, MOLAR_IDX].mean() / max(pos.mean(), EPS)),
        "terminalOverCentralRatio": float(pos[:, TERMINAL_IDX].mean() / max(pos[:, CENTRAL_IDX].mean(), EPS)),
        "_molarPos": pos[:, MOLAR_IDX].mean(axis=1),
        "_molarLenAbs": np.abs(pl - tl)[:, MOLAR_IDX].mean(axis=1),
    }


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)
    rule = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    stage1, _ = oof_prediction(width, 1, 0.05)
    stage2, _ = oof_prediction(width, 2, 0.05)
    stage1_px = to_pixels(stage1.reshape(-1, 24, 2), groups, dims)
    stage2_px = to_pixels(stage2.reshape(-1, 24, 2), groups, dims)

    variants = {
        "① 규칙엔진 원안(운영HTML)": rule,
        "② +1단계 잔차보정": stage1_px,
        "③ +2단계 반복보정": stage2_px,
        "④ +WIDTH_BIAS 1.013(현행)": apply_bias(stage2_px, WIDTH_BIAS),
    }
    scored = {name: summarise(v, truth, scale) for name, v in variants.items()}
    names = list(scored)
    baseline = scored[names[0]]

    report = {
        "schemaVersion": "molar-progress-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("어금니(치아 1·2·11·12) 개선의 단계별 기여를 픽셀 등방 공간에서 분리. "
                 "모두 그룹 5-fold OOF, mm는 정답 최외곽 스팬=54mm. 짝지어 부트스트랩으로 "
                 "직전 단계 대비/원안 대비 유의성 확인. 운영 HTML은 ①에 해당한다."),
        "samples": int(len(truth)),
        "stages": {},
    }
    for index, name in enumerate(names):
        s = scored[name]
        entry = {k: v for k, v in s.items() if not k.startswith("_")}
        if index > 0:
            prev = scored[names[index - 1]]
            entry["vsPreviousStage"] = {
                "molarPosition": paired(prev["_molarPos"], s["_molarPos"]),
                "molarLengthAbs": paired(prev["_molarLenAbs"], s["_molarLenAbs"]),
            }
            entry["vsRuleDraft"] = {
                "molarPosition": paired(baseline["_molarPos"], s["_molarPos"]),
                "molarLengthAbs": paired(baseline["_molarLenAbs"], s["_molarLenAbs"]),
            }
        report["stages"][name] = entry

    final = scored[names[-1]]
    report["verdict"] = {
        "molarPositionMm": {"ruleDraft": baseline["molarPositionMm"], "current": final["molarPositionMm"],
                            "improvementPct": float((baseline["molarPositionMm"] - final["molarPositionMm"])
                                                    / max(baseline["molarPositionMm"], EPS) * 100)},
        "molarLengthAbsMm": {"ruleDraft": baseline["molarLengthAbsMm"], "current": final["molarLengthAbsMm"],
                             "improvementPct": float((baseline["molarLengthAbsMm"] - final["molarLengthAbsMm"])
                                                     / max(baseline["molarLengthAbsMm"], EPS) * 100)},
        "molarStillWorseThanAverageBy": float(final["molarOverAllRatio"]),
        "terminalOverCentralRatio": {"ruleDraft": baseline["terminalOverCentralRatio"],
                                     "current": final["terminalOverCentralRatio"]},
        "note": ("이 개선은 연구용 HTML에만 반영돼 있다. 운영 HTML은 ① 상태이므로 "
                 "환자에게 보이는 어금니 정확도는 아직 개선 전이다."),
    }

    (HERE / "molar_progress.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}")
    head = f"{'stage':26s} {'molarPos':>9s} {'allPos':>8s} {'molarLen':>9s} {'molarSign%':>11s} {'term/cent':>10s}"
    print(head)
    for name in names:
        s = scored[name]
        print(f"{name:26s} {s['molarPositionMm']:9.3f} {s['allPositionMm']:8.3f} "
              f"{s['molarLengthAbsMm']:9.3f} {s['molarLengthSignedPct']:11.2f} "
              f"{s['terminalOverCentralRatio']:10.2f}")
    print("\npaired (molar position):")
    for name in names[1:]:
        e = report["stages"][name]
        p, r = e["vsPreviousStage"]["molarPosition"], e["vsRuleDraft"]["molarPosition"]
        print(f"  {name:26s} vs prev {p['improvementPct']:+6.2f}% sig={str(p['significant']):5s} "
              f"| vs rule {r['improvementPct']:+6.2f}% sig={r['significant']}")
    print("\npaired (molar length abs):")
    for name in names[1:]:
        e = report["stages"][name]
        p, r = e["vsPreviousStage"]["molarLengthAbs"], e["vsRuleDraft"]["molarLengthAbs"]
        print(f"  {name:26s} vs prev {p['improvementPct']:+6.2f}% sig={str(p['significant']):5s} "
              f"| vs rule {r['improvementPct']:+6.2f}% sig={r['significant']}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
