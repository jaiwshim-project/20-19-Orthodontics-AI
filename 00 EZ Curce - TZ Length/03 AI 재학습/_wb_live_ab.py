#!/usr/bin/env python3
"""연구용 HTML의 WIDTH_BIAS 변경을 **실구동** 산출물로 짝지어 A/B 한다.

`_px_width_bias.py`는 파이썬 스테이지 재현 위에서 배율을 홀드아웃으로 골랐다.
여기서는 그 배율이 **HTML 안에서 실제로 먹히는지**와 실측 개선 방향을 확인한다
([[project_embedded_engine_staleness]]: 이 HTML은 모델과 추론엔진 사본을 둘 다 품는다).

사용법: `python _wb_live_ab.py <before.json> <after.json>`
정답 결합은 이미지 SHA-256 동일성만 사용. 픽셀 등방 공간, mm는 정답 최외곽 스팬=54mm.

주의(정직한 한계): 라이브 root 83건은 임베드 모델의 학습에 포함된 코호트다. 따라서
이 A/B는 "배율 상수가 코드 경로에서 실제로 적용되고 방향이 일치하는가"의 확인이며,
개선폭의 근거는 `px_width_bias.json`의 폴드 홀드아웃 수치다.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_eval import inject_sha
from _rule_ab_px import components, paired

HERE = Path(__file__).resolve().parent
EPS = 1e-12
MOLAR_IDX = [0, 1, 10, 11]


def load(json_name: str):
    src = HERE / json_name
    dst = HERE / f"_sha_{Path(json_name).name}"
    inject_sha(src, dst)
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", dst)
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    return groups, truth, draft, truth_scale_px(truth)


def summarize(c, scale_len):
    m = MOLAR_IDX
    return {
        "allPositionMm": float(c["position"].mean()),
        "molarPositionMm": float(c["position"][:, m].mean()),
        "allLengthAbsMm": float(np.abs(c["lenSigned"]).mean()),
        "molarLengthAbsMm": float(np.abs(c["lenSigned"][:, m]).mean()),
        "allLengthSignedPct": float((c["lenSigned"] / np.maximum(c["lenTruth"], EPS)).mean() * 100),
        "tzlSumMm": float(scale_len.mean()),
        "allAngleDeg": float(c["angle"].mean()),
    }


def main() -> None:
    before_name, after_name = sys.argv[1], sys.argv[2]
    gb, tb, db, sb = load(before_name)
    ga, ta, da, sa = load(after_name)
    assert np.array_equal(gb, ga), "케이스 집합 불일치"
    assert np.allclose(tb, ta), "정답 불일치"

    cb, ca = components(db, tb, sb), components(da, ta, sa)

    def tzl(draft, scale):
        total = np.zeros(len(draft))
        for t in range(12):
            total += np.linalg.norm(draft[:, 2 * t, :] - draft[:, 2 * t + 1, :], axis=1) * scale
        return total

    tzl_truth = tzl(tb, sb)
    report = {
        "schemaVersion": "wb-live-ab-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("연구용 HTML WIDTH_BIAS 변경의 실구동 짝지은 A/B. 픽셀 등방 공간, "
                 "mm는 정답 최외곽 스팬=54mm. 정답 결합은 이미지 SHA-256만 사용. "
                 "라이브 root 코호트는 임베드 모델의 학습 범위이므로 개선폭 근거는 "
                 "px_width_bias.json의 폴드 홀드아웃 수치다."),
        "pairedCases": int(len(tb)),
        "absolute": {
            "before": summarize(cb, tzl(db, sb)),
            "after": summarize(ca, tzl(da, sa)),
            "truthTzlSumMm": float(tzl_truth.mean()),
        },
        "paired": {
            "allLengthAbs": paired(np.abs(cb["lenSigned"]).mean(axis=1), np.abs(ca["lenSigned"]).mean(axis=1)),
            "molarLengthAbs": paired(np.abs(cb["lenSigned"][:, MOLAR_IDX]).mean(axis=1),
                                     np.abs(ca["lenSigned"][:, MOLAR_IDX]).mean(axis=1)),
            "allPosition": paired(cb["position"].mean(axis=1), ca["position"].mean(axis=1)),
            "tzlAbsError": paired(np.abs(tzl(db, sb) - tzl_truth), np.abs(tzl(da, sa) - tzl_truth)),
        },
    }
    p = report["paired"]
    report["verdict"] = {
        "codePathEffective": bool(abs(report["absolute"]["before"]["allLengthAbsMm"]
                                     - report["absolute"]["after"]["allLengthAbsMm"]) > 1e-6),
        "lengthImproved": bool(p["allLengthAbs"]["new"] < p["allLengthAbs"]["old"]),
        "lengthSignificant": bool(p["allLengthAbs"]["significant"]),
        "positionUnchanged": bool(abs(p["allPosition"]["new"] - p["allPosition"]["old"]) < 0.01),
        "promote": bool(p["allLengthAbs"]["significant"] and p["allLengthAbs"]["new"] < p["allLengthAbs"]["old"]
                        and p["allPosition"]["new"] <= p["allPosition"]["old"] + 0.01),
    }
    (HERE / "wb_live_ab.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"paired cases {report['pairedCases']} (live, 픽셀 공간)")
    print(f"truth TZL sum {report['absolute']['truthTzlSumMm']:.3f} mm")
    for tag in ("before", "after"):
        a = report["absolute"][tag]
        print(f"{tag:6s} pos {a['allPositionMm']:.4f}  lenAbs {a['allLengthAbsMm']:.4f}  "
              f"lenSigned {a['allLengthSignedPct']:+.2f}%  molarLenAbs {a['molarLengthAbsMm']:.4f}  "
              f"TZL {a['tzlSumMm']:.3f}  angle {a['allAngleDeg']:.2f}")
    for key, v in p.items():
        print(f"  {key:15s} {v['old']:.4f} -> {v['new']:.4f} ({v['improvementPct']:+.2f}%) "
              f"CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] sig={v['significant']} "
              f"better/worse {v['casesImproved']}/{v['casesWorsened']}")
    print("verdict:", json.dumps(report["verdict"], ensure_ascii=True))


if __name__ == "__main__":
    main()
