#!/usr/bin/env python3
"""정답 자체의 재현오차(라벨 노이즈 바닥) — 더 학습해서 갈 수 있는 하한.

같은 이미지에 폭 주석이 2개 이상 있는 케이스가 53건이다. 학습은 이들을 평균해서
하나의 정답으로 쓴다. 그런데 **두 주석이 서로 얼마나 다른지**가 곧 "정답의 재현오차"이고,
이는 어떤 모델도 그 아래로 내려갈 수 없는 바닥이다. 지금 OOF 위치오차가 이 바닥에
닿아 있다면 폭 라벨을 더 학습해도 소용이 없다 — 남은 오차의 상당부분이 정답의 흔들림이다.

측정:
  - 주석 쌍 사이의 중점 이동(위치)·폭 차이(길이)를 mm로. mm 환산은 다른 측정과 동일하게
    **정답 최외곽 스팬 = 54mm**, 픽셀 등방 공간.
  - 두 주석의 평균을 정답으로 쓸 때 각 주석이 평균에서 벗어난 양(=합의 정답의 잔여 불확실성)도
    함께 낸다. 모델이 겨눌 표적은 평균이므로 이쪽이 더 직접적인 하한이다.
  - 3단계 모델의 OOF 오차와 나란히 놓아 여유 배수를 계산한다.

⚠️ 이 하한은 "재현오차"이지 "정확도"가 아니다. 두 주석이 같은 방향으로 함께 틀렸다면
잡히지 않는다(공통 편향은 [[project-label-cohort-scale-gap]] 쪽 문제).
또한 53건은 재주석된 케이스라 어려운 케이스로 치우쳐 있을 수 있어, 전체 코호트의
노이즈를 과대추정할 수 있다. 그래서 이 53건만의 OOF 오차와도 따로 비교한다.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np

import train_residual as tr
from _more_labels import (CUMULATIVE, MOLAR_IDX, PER_STAGE, SEED, STAGE_HYPER,
                          WIDTH_BIAS, apply_bias)
from _px_decompose import dims_by_group, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
FOLDS = 5
MM_SPAN = 54.0


def annotation_sets(dataset_path: Path):
    """케이스별로 '완전한 12개' 폭 주석들을 각각 따로 모은다(평균하지 않고)."""
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    per_case: dict[str, list[np.ndarray]] = {}
    quality: Counter[str] = Counter()
    for case in tr.dataset_cases(document):
        image = case.get("image") if isinstance(case.get("image"), dict) else {}
        sha = tr.sha256_text(image.get("sha256"))
        dims = tr.dimensions(case)
        if not sha or dims is None:
            continue
        for annotation in tr.case_annotations(case, "width"):
            try:
                raw = tr.annotation_raw(annotation, dataset_path.parent)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            value = next((raw.get(k) for k in ("toothWidthsPx", "toothWidths", "tooth_widths", "widths")
                          if k in raw), None)
            widths = tr.width_list(value, quality, "expert")
            if len(widths) == 12:
                per_case.setdefault(sha, []).append(tr.normalize_widths(widths, dims))
    return per_case


def to_iso_mm(points_norm: np.ndarray, height: float, aspect: float, scale: float) -> np.ndarray:
    """정규화 좌표 → 픽셀 → mm. scale은 케이스별 mm/px 계수.

    ⚠️ 픽셀 환산에서 높이 곱을 빼먹으면 안 된다: (x/W, y/H) → (x, y)는
    `* [W, H]` = `* H * [aspect, 1]`이다. aspect만 곱하면 mm가 H배 작게 나와
    "라벨 노이즈가 0.0001mm"라는 무의미한 값이 된다(실제로 한 번 그랬다).
    """
    return points_norm * np.array([aspect, 1.0]) * height * scale


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, info = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)
    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    case_scale = truth_scale_px(truth_px)
    scale_by_sha = {sha: float(case_scale[i]) for i, sha in enumerate(groups.tolist())}
    aspect_by_sha, height_by_sha = {}, {}
    for sha in groups.tolist():
        w, h = dims[sha]
        aspect_by_sha[sha] = w / h
        height_by_sha[sha] = float(h)

    per_case = annotation_sets(dataset_path)
    multi = {sha: sets for sha, sets in per_case.items()
             if len(sets) >= 2 and sha in scale_by_sha}

    pos_pair, len_pair, pos_to_mean, len_to_mean, tzl_pair = [], [], [], [], []
    tzl_to_mean = []
    for sha, sets in multi.items():
        aspect, scale = aspect_by_sha[sha], scale_by_sha[sha]
        iso = [to_iso_mm(s.reshape(12, 2, 2), height_by_sha[sha], aspect, scale) for s in sets]
        mean = np.mean(np.stack(iso), axis=0)
        for a in range(len(iso)):
            mid_a = iso[a].mean(axis=1)
            wid_a = np.linalg.norm(iso[a][:, 0] - iso[a][:, 1], axis=1)
            mid_m = mean.mean(axis=1)
            wid_m = np.linalg.norm(mean[:, 0] - mean[:, 1], axis=1)
            pos_to_mean.append(np.linalg.norm(mid_a - mid_m, axis=1))
            len_to_mean.append(np.abs(wid_a - wid_m))
            tzl_to_mean.append(abs(wid_a.sum() - wid_m.sum()))
            for b in range(a + 1, len(iso)):
                mid_b = iso[b].mean(axis=1)
                wid_b = np.linalg.norm(iso[b][:, 0] - iso[b][:, 1], axis=1)
                pos_pair.append(np.linalg.norm(mid_a - mid_b, axis=1))
                len_pair.append(np.abs(wid_a - wid_b))
                tzl_pair.append(abs(wid_a.sum() - wid_b.sum()))

    pos_pair = np.stack(pos_pair)
    len_pair = np.stack(len_pair)
    pos_to_mean = np.stack(pos_to_mean)
    len_to_mean = np.stack(len_to_mean)

    # ── 같은 조건의 3단계 OOF 오차 (비교 대상) ──────────────────────────────
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    predicted = np.zeros_like(width["target"])
    for test in masks:
        train = ~test
        models = tr.fit_stages(width["x"][train], width["baseline"][train], width["target"][train],
                               STAGE_HYPER, PER_STAGE, CUMULATIVE)
        predicted[test] = tr.predict_stages(models, width["x"][test], width["baseline"][test],
                                            PER_STAGE, CUMULATIVE)[0]
    pred_px = apply_bias(to_pixels(predicted.reshape(-1, 24, 2), groups, dims))
    mid_p = (pred_px[:, 0::2, :] + pred_px[:, 1::2, :]) / 2.0
    mid_t = (truth_px[:, 0::2, :] + truth_px[:, 1::2, :]) / 2.0
    oof_pos = np.linalg.norm(mid_p - mid_t, axis=2) * case_scale[:, None]
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2) * case_scale[:, None]
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2) * case_scale[:, None]
    oof_len = np.abs(pl - tl)

    multi_rows = [i for i, sha in enumerate(groups.tolist()) if sha in multi]
    noise = {
        "multiAnnotatedCases": len(multi),
        "annotationPairs": int(pos_pair.shape[0]),
        "betweenAnnotationPositionMm": float(pos_pair.mean()),
        "betweenAnnotationPositionMolarMm": float(pos_pair[:, MOLAR_IDX].mean()),
        "betweenAnnotationLengthMm": float(len_pair.mean()),
        "betweenAnnotationTzlMm": float(np.mean(tzl_pair)),
        "toConsensusPositionMm": float(pos_to_mean.mean()),
        "toConsensusPositionMolarMm": float(pos_to_mean[:, MOLAR_IDX].mean()),
        "toConsensusLengthMm": float(len_to_mean.mean()),
        "toConsensusTzlMm": float(np.mean(tzl_to_mean)),
    }
    model_side = {
        "oofPositionMmAllCases": float(oof_pos.mean()),
        "oofPositionMmMultiAnnotatedOnly": float(oof_pos[multi_rows].mean()),
        "oofPositionMolarMmMultiAnnotatedOnly": float(oof_pos[multi_rows][:, MOLAR_IDX].mean()),
        "oofLengthMmAllCases": float(oof_len.mean()),
        "oofLengthMmMultiAnnotatedOnly": float(oof_len[multi_rows].mean()),
        "oofTzlMmMultiAnnotatedOnly": float(
            np.abs(pl.sum(axis=1) - tl.sum(axis=1))[multi_rows].mean()),
    }
    ratios = {
        "positionErrorOverLabelNoise": round(
            model_side["oofPositionMmMultiAnnotatedOnly"] / max(noise["toConsensusPositionMm"], 1e-9), 2),
        "molarPositionErrorOverLabelNoise": round(
            model_side["oofPositionMolarMmMultiAnnotatedOnly"] / max(noise["toConsensusPositionMolarMm"], 1e-9), 2),
        "lengthErrorOverLabelNoise": round(
            model_side["oofLengthMmMultiAnnotatedOnly"] / max(noise["toConsensusLengthMm"], 1e-9), 2),
        "tzlErrorOverLabelNoise": round(
            model_side["oofTzlMmMultiAnnotatedOnly"] / max(noise["toConsensusTzlMm"], 1e-9), 2),
    }

    at_floor = ratios["positionErrorOverLabelNoise"] < 1.5
    tzl_at_floor = ratios["tzlErrorOverLabelNoise"] < 2.5
    report = {
        "schemaVersion": "label-noise-floor-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("같은 이미지의 폭 주석 2개 이상을 이용해 정답의 재현오차를 재고, 3단계 OOF "
                 "오차와 비교한다. mm는 정답 최외곽 스팬=54mm, 픽셀 등방 공간. "
                 "재현오차는 공통 편향을 잡지 못하며, 재주석 케이스는 어려운 쪽으로 치우쳤을 "
                 "수 있어 하한을 과대추정할 수 있다."),
        "labelNoise": noise,
        "modelError": model_side,
        "errorOverNoiseRatio": ratios,
        "verdict": {
            "modelIsAtLabelNoiseFloor": bool(at_floor),
            "tzlIsNearLabelNoiseFloor": bool(tzl_at_floor),
            "tzlNote": (
                "TZL 총합은 다르다. 같은 이미지에 두 번 주석하면 총합이 서로 "
                f"{noise['betweenAnnotationTzlMm']:.2f}mm(합의값 대비 {noise['toConsensusTzlMm']:.2f}mm) "
                f"흔들리는데, 모델 오차는 {model_side['oofTzlMmMultiAnnotatedOnly']:.2f}mm로 "
                f"{ratios['tzlErrorOverLabelNoise']}배에 불과하다. TZL 정확도를 더 올리려면 "
                "학습량이 아니라 **주석 규약의 일관성**을 먼저 잡아야 한다 — 정답이 흔들리는 "
                "폭만큼은 어떤 모델도 맞출 수 없다."),
            "conclusion": (
                f"모델 위치오차가 라벨 재현오차의 {ratios['positionErrorOverLabelNoise']}배다. "
                + ("바닥에 근접했다 — 폭 라벨을 더 학습해도 얻을 게 거의 없다."
                   if at_floor else
                   "아직 바닥보다 충분히 크다 — 원리적으로는 배울 여지가 남아 있지만, "
                   "그 여지가 '기존 특징으로 회수 가능한가'는 별개 문제다.")),
        },
    }
    (HERE / "label_noise_floor.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("label noise (annotator repeatability):")
    for key, value in noise.items():
        print(f"   {key:38s} {value if isinstance(value, int) else round(value, 4)}")
    print("\nmodel OOF error (3-stage):")
    for key, value in model_side.items():
        print(f"   {key:38s} {round(value, 4)}")
    print("\nratios:", ratios)
    print("verdict:", report["verdict"]["modelIsAtLabelNoiseFloor"])


if __name__ == "__main__":
    main()
