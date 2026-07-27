#!/usr/bin/env python3
"""2단계 잔차보정이 픽셀 공간에서도 위치/길이 오차를 줄이는가 — OOF 재확인.

`_px_decompose.py`가 앞선 측정의 공간 오류를 정정했으므로, "잔차보정이 옳은 층"이라는
결론도 픽셀 공간에서 다시 확인해야 한다. 여기서는 grouped 5-fold **out-of-fold**
예측을 만들어(in-sample 금지) 규칙엔진 초안과 나란히 분해한다.

지표: position(중점 이동), lengthAbs/Signed, angle — 전부 픽셀 등방 공간,
mm는 정답 최외곽 스팬=54mm 기준. 케이스 단위 짝지어진 부트스트랩 5,000회.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels, truth_scale_px
from _rule_ab_px import components, paired

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEED = tr.DEFAULT_SEED
PER_STAGE = 0.05
STAGES = 2
MOLAR_IDX = [0, 1, 10, 11]


def oof_prediction(data, stages: int, per_stage: float):
    x, baseline, target, groups = data["x"], data["baseline"], data["target"], data["groups"]
    cumulative = per_stage * stages
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    out = np.zeros_like(target)
    accepted = np.zeros(len(target), dtype=bool)
    for i, test in enumerate(masks, start=1):
        train = ~test
        hyper = tr.select_stage_hyperparameters(
            x[train], baseline[train], target[train], groups[train],
            SEED + i * 1009, per_stage, min(4, FOLDS), stages, cumulative)
        models = tr.fit_stages(x[train], baseline[train], target[train], hyper, per_stage, cumulative)
        pred, acc, _ = tr.predict_stages(models, x[test], baseline[test], per_stage, cumulative)
        out[test] = pred
        accepted[test] = acc
    return out, accepted


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(HERE / "dataset-index.json")
    corrected, accepted = oof_prediction(width, STAGES, PER_STAGE)

    truth = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    fixed = to_pixels(corrected.reshape(-1, 24, 2), groups, dims)
    scale = truth_scale_px(truth)

    c_draft = components(draft, truth, scale)
    c_fixed = components(fixed, truth, scale)

    def block(c) -> dict:
        m = MOLAR_IDX
        return {
            "molarPositionMm": float(c["position"][:, m].mean()),
            "allPositionMm": float(c["position"].mean()),
            "molarLengthAbsMm": float(np.abs(c["lenSigned"][:, m]).mean()),
            "allLengthAbsMm": float(np.abs(c["lenSigned"]).mean()),
            "allLengthSignedPct": float((c["lenSigned"] / np.maximum(c["lenTruth"], 1e-12)).mean() * 100),
            "allAngleDeg": float(c["angle"].mean()),
        }

    report = {
        "schemaVersion": "px-stage-check-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("2단계 잔차보정의 **out-of-fold** 예측을 픽셀 등방 공간에서 분해. "
                 f"grouped {FOLDS}-fold, per-stage cap {PER_STAGE}, stages {STAGES}. "
                 "mm는 정답 최외곽 스팬=54mm 기준."),
        "samples": int(len(truth)),
        "acceptedRate": float(accepted.mean()),
        "ruleDraft": block(c_draft),
        "stage2Oof": block(c_fixed),
        "paired": {
            "allPosition": paired(c_draft["position"].mean(axis=1), c_fixed["position"].mean(axis=1)),
            "molarPosition": paired(c_draft["position"][:, MOLAR_IDX].mean(axis=1),
                                    c_fixed["position"][:, MOLAR_IDX].mean(axis=1)),
            "allLengthAbs": paired(np.abs(c_draft["lenSigned"]).mean(axis=1),
                                   np.abs(c_fixed["lenSigned"]).mean(axis=1)),
            "molarLengthAbs": paired(np.abs(c_draft["lenSigned"][:, MOLAR_IDX]).mean(axis=1),
                                     np.abs(c_fixed["lenSigned"][:, MOLAR_IDX]).mean(axis=1)),
        },
    }
    report["verdict"] = {
        "residualLayerHelpsPosition": bool(report["paired"]["allPosition"]["ci95"][0] > 0),
        "residualLayerHelpsLength": bool(report["paired"]["allLengthAbs"]["ci95"][0] > 0),
        "conclusion": ("잔차보정이 픽셀 공간에서도 위치·길이를 모두 줄인다 → 전역 prior가 아니라 "
                       "케이스별 조건화가 옳은 층"
                       if report["paired"]["allPosition"]["ci95"][0] > 0
                       else "픽셀 공간에서는 잔차보정의 위치 개선이 유의하지 않다 — 재검토 필요"),
    }

    (HERE / "px_stage_check.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"samples {report['samples']}  acceptedRate {report['acceptedRate']:.4f}")
    for name in ("ruleDraft", "stage2Oof"):
        b = report[name]
        print(f"[{name:10s}] allPos {b['allPositionMm']:.3f}  molarPos {b['molarPositionMm']:.3f}  "
              f"allLenAbs {b['allLengthAbsMm']:.3f}  molarLenAbs {b['molarLengthAbsMm']:.3f}  "
              f"lenSigned {b['allLengthSignedPct']:+.1f}%  angle {b['allAngleDeg']:.2f}")
    for key, v in report["paired"].items():
        print(f"  {key:16s} {v['old']:.4f} -> {v['new']:.4f} ({v['improvementPct']:+6.2f}%) "
              f"CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] sig={v['significant']} "
              f"better/worse {v['casesImproved']}/{v['casesWorsened']}")
    print("verdict:", json.dumps(report["verdict"], ensure_ascii=True))


if __name__ == "__main__":
    main()
