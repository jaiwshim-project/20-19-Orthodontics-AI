#!/usr/bin/env python3
"""거리 게이트(미숙지 폴백)가 정확도에 얼마나 기여/손해인가 — 2단계 체제에서 재측정.

_next_gain.py의 force_gate_open은 실패한 측정이었다. tr.predict_krr가 내부에서
비수락 행의 보정을 0으로 만들기 때문에, 그것을 호출하는 방식으로는 게이트를 열 수
없다. 여기서는 커널·alpha를 직접 곱해 게이트를 우회한다.

측정: 폴백된 케이스들만 따로 놓고 (a) 규칙엔진 초안 그대로(=현행 동작),
(b) 게이트를 무시하고 2단계 보정을 강행했을 때를 비교한다.
게이트가 실제로 나쁜 보정을 막아주고 있으면 (a)가 더 좋아야 한다.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
SEED = tr.DEFAULT_SEED
FOLDS = 5
PER_STAGE = 0.05
CUMULATIVE = 0.10
STAGES = 2
MOLAR_TEETH = (1, 2, 11, 12)
MOLAR_POINTS = [p for t in MOLAR_TEETH for p in (2 * (t - 1), 2 * (t - 1) + 1)]


def raw_correction(model, x):
    """게이트를 적용하지 않은 원시 보정량(단계별 캡만 적용)."""
    z = (x - model["featureMean"]) / model["featureScale"]
    distances = tr.squared_distances(z, model["prototypes"])
    correction = np.exp(-float(model["gamma"]) * distances) @ model["alpha"]
    return tr.clip_corrections(correction, PER_STAGE)


def mae(target, prediction, points=None):
    t = target.reshape(len(target), 24, 2)
    p = prediction.reshape(len(prediction), 24, 2)
    if points is not None:
        t, p = t[:, points, :], p[:, points, :]
    err = np.linalg.norm((p - t).reshape(-1, 2), axis=1) / np.sqrt(2.0)
    return float(err.mean())


def main() -> None:
    tasks, _ = tr.build_samples(HERE / "dataset-index.json", HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    x, base, target, groups = width["x"], width["baseline"], width["target"], width["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)

    gated = np.zeros_like(target)
    opened = np.zeros_like(target)
    accepted = np.zeros(x.shape[0], dtype=bool)

    for index, test_mask in enumerate(masks, start=1):
        train = ~test_mask
        chosen = tr.select_stage_hyperparameters(
            x[train], base[train], target[train], groups[train],
            SEED + index * 1009, PER_STAGE, min(4, FOLDS), STAGES, CUMULATIVE)
        fitted = tr.fit_stages(x[train], base[train], target[train], chosen, PER_STAGE, CUMULATIVE)

        fold_gated, fold_accepted, _ = tr.predict_stages(
            fitted, x[test_mask], base[test_mask], PER_STAGE, CUMULATIVE)
        gated[test_mask] = fold_gated
        accepted[test_mask] = fold_accepted

        # 게이트 무시: 커널×alpha를 직접 적용해 전 케이스에 2단계 보정을 강행
        current = base[test_mask]
        for model in fitted:
            current = np.clip(current + raw_correction(model, x[test_mask]), 0.0, 1.0)
            current = tr.clip_cumulative(current, base[test_mask], CUMULATIVE)
        opened[test_mask] = current
        print(f"fold {index} done, accepted {fold_accepted.mean():.3f}")

    fallback = ~accepted
    report = {
        "schemaVersion": "next-gate-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": "게이트 우회는 커널·alpha 직접 적용으로 구현(predict_krr는 비수락 행을 내부에서 0으로 만든다).",
        "acceptedRate": float(accepted.mean()),
        "fallbackCases": int(fallback.sum()),
        "allCases": {
            "gateOn_molarMae": mae(target, gated, MOLAR_POINTS),
            "gateOpen_molarMae": mae(target, opened, MOLAR_POINTS),
            "gateOn_allMae": mae(target, gated),
            "gateOpen_allMae": mae(target, opened),
        },
        "fallbackCasesOnly": {
            "ruleDraft_molarMae": mae(target[fallback], base[fallback], MOLAR_POINTS),
            "forcedCorrection_molarMae": mae(target[fallback], opened[fallback], MOLAR_POINTS),
            "ruleDraft_allMae": mae(target[fallback], base[fallback]),
            "forcedCorrection_allMae": mae(target[fallback], opened[fallback]),
        },
        "acceptedCasesOnly": {
            "corrected_molarMae": mae(target[accepted], gated[accepted], MOLAR_POINTS),
            "rule_molarMae": mae(target[accepted], base[accepted], MOLAR_POINTS),
        },
    }
    fb = report["fallbackCasesOnly"]
    report["gateVerdict"] = (
        "gate helps" if fb["forcedCorrection_molarMae"] > fb["ruleDraft_molarMae"] else "gate costs accuracy")
    report["fallbackMolarGainIfOpenedPct"] = float(
        (fb["ruleDraft_molarMae"] - fb["forcedCorrection_molarMae"]) / fb["ruleDraft_molarMae"] * 100)
    (HERE / "next_gate_metrics.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
