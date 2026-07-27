#!/usr/bin/env python3
"""다단(반복) 잔차보정의 Python↔JS 비트 동등성 기준값 생성.

기존 residual-parity-fixture.json은 2026-07-11 모델 + 은퇴한 배포정책 문서를
전제로 하므로 현재 모델로는 재생성할 수 없다. 이 스크립트는 배포정책과 무관하게
`train_residual.predict_stages`(학습 측 진실)의 출력을 그대로 덤프해서
residual_inference.js의 스테이지 루프와 비교할 수 있게 한다.

캡 정책은 legacy-axis-normalized를 쓴다. 그것이 train_residual.clip_corrections와
정확히 같은 식이기 때문이다(픽셀대각 정책은 JS 쪽에만 있는 변형).

출력에는 이미지 픽셀·파일명·환자 식별자가 들어가지 않는다.
"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path
from typing import Any, Mapping

import numpy as np

import train_residual as tr

HERE = Path(__file__).resolve().parent
CASE_COUNT = 14


def numpy_stage_models(task: Mapping[str, Any]) -> list[dict[str, Any]]:
    shared = {
        "featureMean": np.asarray(task["featureMean"], dtype=np.float64),
        "featureScale": np.asarray(task["featureScale"], dtype=np.float64),
        "prototypes": np.asarray(task["prototypes"], dtype=np.float64),
        "gateDistance": float(task["distanceGate"]["threshold"]),
    }
    entries = task.get("stages")
    if entries is None:
        entries = [{"gamma": task["hyperparameters"]["gamma"], "alpha": task["alpha"]}]
    return [
        {
            **shared,
            "gamma": float(entry["gamma"]),
            "alpha": np.asarray(entry["alpha"], dtype=np.float64),
        }
        for entry in entries
    ]


def safe_input(record: Mapping[str, Any]) -> dict[str, Any]:
    prediction = tr.nested(record, ("prediction", "baseline", "result", "autoDraft", "analysis", "outputs"))
    dims = tr.dimensions(record) or tr.dimensions(prediction)
    width_value = next(
        (prediction.get(key) for key in ("toothWidths", "toothWidthsPx", "tooth_widths", "widths") if key in prediction),
        None,
    )
    ez_value = next(
        (prediction.get(key) for key in ("ezPoints", "ezPointsPx", "ez_points") if key in prediction),
        None,
    )
    center_value = next(
        (prediction.get(key) for key in ("toothCenters", "toothCentersPx", "tooth_centers") if key in prediction),
        None,
    )
    widths = tr.width_list(width_value, Counter(), "parity")
    ez = tr.point_list(ez_value)
    centers = tr.point_list(center_value)
    return {
        "imageWidth": float(dims[0]),
        "imageHeight": float(dims[1]),
        "toothWidths": [
            {"p1": {"x": p1[0], "y": p1[1]}, "p2": {"x": p2[0], "y": p2[1]}} for p1, p2 in widths
        ],
        "ezPoints": [{"x": item[0], "y": item[1]} for item in ez],
        "toothCenters": [{"x": item[0], "y": item[1]} for item in centers],
    }


def build(model_path: Path, label: str) -> dict[str, Any]:
    model = tr.read_json(model_path)
    per_stage = float(model["correctionPolicy"]["maximumPerLandmarkCorrectionDiagonalFraction"])
    declared_cumulative = model["correctionPolicy"].get("maximumCumulativeCorrectionDiagonalFraction")
    stage_models = {name: numpy_stage_models(model["tasks"][name]) for name in ("width", "ez")}
    stage_count = len(stage_models["width"])
    cumulative = float(declared_cumulative) if declared_cumulative is not None else per_stage * stage_count

    records = tr.records_from_baseline(tr.read_json(HERE / "baseline_predictions_all.json"))
    candidates = []
    for record in records:
        try:
            components = tr.baseline_components(record, Counter())
            dims = tr.dimensions(record) or tr.dimensions(
                tr.nested(record, ("prediction", "baseline", "result", "autoDraft", "analysis", "outputs"))
            )
        except (TypeError, ValueError):
            continue
        if components is None or dims is None:
            continue
        width_points, ez_points, centers = components
        features = tr.feature_vector(width_points, ez_points, centers, dims[0] / dims[1])
        nearest = []
        for name in ("width", "ez"):
            shared = stage_models[name][0]
            z = ((features - shared["featureMean"]) / shared["featureScale"])[None, :]
            nearest.append(float(np.sqrt(np.min(tr.squared_distances(z, shared["prototypes"])))))
        # 자기 프로토타입 행은 거리 0 부근에서 BLAS 취소오차가 생겨 구현 산물을
        # 시험하게 되므로 제외한다(기존 픽스처 생성기와 같은 규칙).
        if min(nearest) > 1e-4:
            candidates.append((record, components, dims, features, nearest))
    if len(candidates) < CASE_COUNT:
        raise ValueError(f"usable independent baselines: {len(candidates)} < {CASE_COUNT}")

    # 게이트 양쪽(적용/미숙지폴백)을 모두 밟도록 경계 근처를 반드시 포함한다.
    selected: list[int] = []
    for index_of_task, name in enumerate(("width", "ez")):
        threshold = stage_models[name][0]["gateDistance"]
        below = [(threshold - c[4][index_of_task], i) for i, c in enumerate(candidates) if c[4][index_of_task] <= threshold]
        above = [(c[4][index_of_task] - threshold, i) for i, c in enumerate(candidates) if c[4][index_of_task] > threshold]
        for values in (below, above):
            if values:
                _, index = min(values)
                if index not in selected:
                    selected.append(index)
    remaining = [i for i in range(len(candidates)) if i not in selected]
    needed = max(0, CASE_COUNT - len(selected))
    if needed:
        positions = np.linspace(0, len(remaining) - 1, needed, dtype=int).tolist()
        selected.extend(remaining[p] for p in positions)

    cases = []
    accepted_counts = {"width": 0, "ez": 0}
    for order, index in enumerate(selected, start=1):
        record, components, dims, features, _ = candidates[index]
        width_points, ez_points, centers = components
        baselines = {"width": width_points.reshape(-1), "ez": ez_points.reshape(-1)}
        expected = {}
        for name in ("width", "ez"):
            prediction, accepted, nearest = tr.predict_stages(
                stage_models[name], features[None, :], baselines[name][None, :], per_stage, cumulative
            )
            expected[name] = {
                "accepted": bool(accepted[0]),
                "nearestDistance": float(nearest[0]),
                "normalizedPoints": np.asarray(prediction[0]).reshape(-1, 2).tolist(),
            }
            accepted_counts[name] += int(bool(accepted[0]))
        cases.append({
            "caseId": f"stage-parity-{order:02d}",
            "input": safe_input(record),
            "expectedFeatureVector": features.tolist(),
            "expected": expected,
        })

    # 미숙지 입력 강제 폴백 케이스: 좌표가 규칙엔진 초안과 정확히 같아야 한다.
    outlier = {
        "imageWidth": 1000.0,
        "imageHeight": 600.0,
        "toothWidths": [], "ezPoints": [], "toothCenters": [],
    }
    for i in range(12):
        cx = (-2.0 + i * 0.5) * 1000.0
        cy = (-1.5 if i % 2 == 0 else 2.5) * 600.0
        outlier["toothCenters"].append({"x": cx, "y": cy})
        outlier["toothWidths"].append({
            "p1": {"x": cx - 300.0, "y": cy - 120.0},
            "p2": {"x": cx + 300.0, "y": cy + 120.0},
        })
        outlier["ezPoints"].append({"x": cx, "y": cy + (750.0 if i % 3 == 0 else -750.0)})
    outlier_components = tr.baseline_components(outlier, Counter())
    outlier_dims = tr.dimensions(outlier)
    o_width, o_ez, o_centers = outlier_components
    o_features = tr.feature_vector(o_width, o_ez, o_centers, outlier_dims[0] / outlier_dims[1])
    o_expected = {}
    for name, baseline in (("width", o_width.reshape(-1)), ("ez", o_ez.reshape(-1))):
        prediction, accepted, nearest = tr.predict_stages(
            stage_models[name], o_features[None, :], baseline[None, :], per_stage, cumulative
        )
        if bool(accepted[0]):
            raise AssertionError("synthetic outlier was accepted by the distance gate")
        if float(np.max(np.abs(prediction[0] - np.clip(baseline, 0.0, 1.0)))) > 0.0:
            raise AssertionError("unfamiliar fallback did not return the rule-engine draft exactly")
        o_expected[name] = {
            "accepted": False,
            "nearestDistance": float(nearest[0]),
            "normalizedPoints": np.asarray(prediction[0]).reshape(-1, 2).tolist(),
            # 폴백 검증용: 보정 이전 규칙엔진 초안(정규화 좌표). Python 쪽에서는
            # 위 assert로 출력 == 이 초안임을 이미 비트 단위로 확인했다.
            "ruleEngineDraftNormalized": np.clip(baseline, 0.0, 1.0).reshape(-1, 2).tolist(),
        }
    cases.append({
        "caseId": "stage-parity-gate-outlier",
        "syntheticOutlier": True,
        "input": outlier,
        "expectedFeatureVector": o_features.tolist(),
        "expected": o_expected,
    })

    return {
        "schemaVersion": "ez-tzl-staged-parity/v1",
        "privacy": {
            "containsPhi": False,
            "containsCaseIdentifiers": False,
            "containsFilePaths": False,
            "containsImagePixels": False,
            "content": "numeric rule-engine landmarks and Python predict_stages reference output only",
        },
        "label": label,
        "modelVersion": model.get("schemaVersion"),
        "capPolicy": "legacy-axis-normalized",
        "stageCount": stage_count,
        "perStageCap": per_stage,
        "cumulativeCap": cumulative,
        "declaredCumulativeCap": declared_cumulative,
        "acceptedCases": accepted_counts,
        "caseCount": len(cases),
        "cases": cases,
    }


def main() -> None:
    targets = [
        # 1단계 모델은 하위호환(stages 키 없음) 경로를 계속 검증하기 위해 스테이지 도입
        # 직전 백업을 쓴다. residual-model.json은 이제 2단계 모델이다.
        (HERE / "residual-model.before-stage2-20260727.json.bak", HERE / "_stage_parity_single.json", "single-stage-pre-stage2-backup"),
        (HERE / "residual-model.json.stage2-backup", HERE / "_stage_parity_two.json", "two-stage-previous"),
        (HERE / "residual-model.json", HERE / "_stage_parity_three.json", "three-stage-shipped"),
    ]
    summary = []
    for model_path, output_path, label in targets:
        fixture = build(model_path, label)
        output_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary.append({
            "output": output_path.name,
            "label": label,
            "stageCount": fixture["stageCount"],
            "cases": fixture["caseCount"],
            "accepted": fixture["acceptedCases"],
            "cumulativeCap": fixture["cumulativeCap"],
        })
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
