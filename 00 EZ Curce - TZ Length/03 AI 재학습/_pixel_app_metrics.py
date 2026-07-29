#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 모델을 앱이 실제로 표시하는 EZL/TZL(mm)로 평가한다.

## 왜 좌표 지표만으로는 부족한가
pixel_ab.json의 위치 0.311mm는 **좌표 오차**다. 그런데 화면에 뜨는 숫자는
EZL·TZL·차이(mm)이고, 이 값들은 px/mm 스케일을 거쳐 나온다. 앱의 스케일 규약은
`calculateMetricsFor`가 하는 대로 **EZ 끝점 현(chord) = 54mm**다:

    pxPerMm = |ez[last] - ez[0]| / 54

그리고 **픽셀 모델은 EZ 점을 예측하지 않는다** — 치아폭 24점만 낸다. 따라서
픽셀 모델을 붙여도 px/mm은 여전히 규칙엔진 EZ가 정한다. 이것이 통합 설계의
핵심 제약이며, 좌표 +91.8%가 화면 숫자 +91.8%로 이어지지 않는 이유다.

## 재는 조합
  1. rule        : 규칙엔진 EZ + 규칙엔진 폭        (현행 초안)
  2. krr         : KRR EZ + KRR 폭                  (현행 운영/연구 보정)
  3. pixelOnWidth: 규칙엔진 EZ + **픽셀 모델 폭**   ← 실제 통합안
  4. pixelKrrEz  : KRR EZ + 픽셀 모델 폭            ← 통합안(EZ는 KRR 유지)
  5. truthEzPixel: 정답 EZ + 픽셀 모델 폭           ← 오라클. EZ가 완벽하면 어디까지 가는가
                                                     (달성 불가, 상한 표시용)

TZL은 스케일에만 의존하므로 3·4에서 바로 개선된다. EZL은 EZ 곡선 길이라
픽셀 모델이 손대지 못한다 — 다만 EZL 계산이 "치아 점유 구간만 합산"하므로
폭선이 EZL에도 간접적으로 들어간다(correctedCurveLength).

⚠️ 이 스크립트는 EZ 곡선을 앱과 같은 Catmull-Rom으로 생성해야 한다. 그래서
evaluate_residual_clinical.py의 curve 구현을 그대로 재사용한다.

출력에 PHI·좌표 없음.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_case, to_pixels
from evaluate_residual_clinical import generated_curve, polyline_length
from _pixel_ab import oof_stage_prediction, paired, task_case_ids

HERE = Path(__file__).resolve().parent
CALIBRATION_MM = 54.0


def tooth_lengths(widths: np.ndarray) -> np.ndarray:
    """(cases,24,2) -> (cases,12) 선분 길이(px)."""
    return np.linalg.norm(widths[:, 1::2, :] - widths[:, 0::2, :], axis=2)


def app_scale(ez: np.ndarray) -> np.ndarray:
    """EZ 끝점 현 = 54mm. 앱 calculateMetricsFor와 동일."""
    chord = np.linalg.norm(ez[:, -1, :] - ez[:, 0, :], axis=1)
    return chord / CALIBRATION_MM


def ez_curve_px(ez: np.ndarray) -> np.ndarray:
    """케이스별 EZ 곡선 길이(px). 앱과 같은 Catmull-Rom."""
    return np.asarray([polyline_length(generated_curve(row)) for row in ez])


def app_metrics(ez: np.ndarray, widths: np.ndarray) -> dict[str, np.ndarray]:
    """앱이 표시하는 EZL/TZL/차이(mm).

    ⚠️ EZL은 앱에서 `correctedCurveLength`(치아 점유 구간만)를 쓰지만, 그 구현은
    HTML 안에만 있고 여기서 재현하면 또 하나의 검증 대상이 된다. 대신 전체 곡선
    길이를 쓴다 — 세 조합 모두 같은 방식이므로 **비교는 공정하다**. 절대값은
    앱 표시보다 크게 나온다는 점만 유의한다.
    """
    scale = app_scale(ez)
    ezl = ez_curve_px(ez) / scale
    tzl = tooth_lengths(widths).sum(axis=1) / scale
    return {"ezlMm": ezl, "tzlMm": tzl, "differenceMm": ezl - tzl}


def load_pixel_truth_widths(dataset: Path) -> dict[str, np.ndarray]:
    """caseId -> 픽셀 파이프라인의 **정답** 폭 24점(원본 좌표계).

    정렬 자기검사용. KRR 파이프라인 정답과 같은 사진이면 거의 일치해야 한다.
    """
    coco = json.loads((dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    ann = {a["image_id"]: a for a in coco["annotations"]}
    out = {}
    for image in coco["images"]:
        unclipped = np.asarray(ann[image["id"]]["keypointsUnclipped"],
                               dtype=np.float64).reshape(24, 2)
        out[image["caseId"]] = unclipped / image["scaleFromSource"]
    return out


def load_pixel_widths(predictions: Path) -> dict[str, np.ndarray]:
    """caseId -> 픽셀 모델 OOF 폭 24점(원본 좌표계)."""
    data = json.loads(predictions.read_text(encoding="utf-8"))
    out = {}
    for rows in data.values():
        for row in rows:
            out[row["caseId"]] = np.asarray(row["predSourcePx"], dtype=np.float64)
    return out


def load_truth_ez(index_path: Path) -> dict[str, np.ndarray]:
    """caseId -> 전문가 EZ 12점(원본 픽셀 좌표계)."""
    index = tr.read_json(index_path)
    quality: Counter[str] = Counter()
    out = {}
    for case in tr.dataset_cases(index):
        dims = tr.dimensions(case)
        if dims is None:
            continue
        ez = tr.truth_consensus(case, "ez", dims, index_path.parent, quality)
        if ez is None or ez.shape != (12, 2):
            continue
        out[str(tr.get_case_id(case))] = ez * np.asarray((float(dims[0]), float(dims[1])))
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.patientgrouped.json")
    parser.add_argument("--baseline", type=Path, default=HERE / "baseline_predictions_all.json")
    parser.add_argument("--predictions", type=Path,
                        default=HERE / "pixel_model" / "predictions.json")
    parser.add_argument("--dataset-manifest", type=Path, default=HERE / "pixel_dataset",
                        help="정렬 자기검사에 쓸 픽셀 데이터셋 디렉터리")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_app_metrics.json")
    args = parser.parse_args()

    pixel_widths = load_pixel_widths(args.predictions)
    print(f"픽셀 OOF 폭 {len(pixel_widths)}건", flush=True)

    tasks, summary = tr.build_samples(args.index, args.baseline)
    width, ez_task = tasks["width"], tasks["ez"]
    # ⚠️ dims는 **caseId** 기준이다. 환자 차트 그룹(`dims_by_group`)으로 잡으면 같은
    # 환자의 두 번째 사진이 첫 사진의 W/H로 변환된다 — 실측 343그룹 중 106그룹이
    # 해상도가 달라, 폭 384건 중 52건이 최대 24.9mm 틀어졌다.
    dims = dims_by_case(args.index)

    w_ids = task_case_ids(args.index, args.baseline, "width")
    w_keys = np.asarray(w_ids, dtype=object)
    truth_w = to_pixels(width["target"].reshape(-1, 24, 2), w_keys, dims)
    draft_w = to_pixels(width["baseline"].reshape(-1, 24, 2), w_keys, dims)
    if len(w_ids) != len(truth_w):
        raise SystemExit(f"폭 케이스 대응 실패: {len(w_ids)} != {len(truth_w)}")

    print("KRR 3단 폭 OOF...", flush=True)
    krr_w = to_pixels(oof_stage_prediction(width).reshape(-1, 24, 2), w_keys, dims)

    # EZ 쪽: 규칙엔진 초안 EZ와 KRR 보정 EZ.
    #
    # ⚠️ 태스크 간 대응에 `groups`(splitGrouping.minimumGroupId)를 키로 쓰면 안 된다.
    # 그것은 환자 차트 ID라서 같은 환자의 사진 2장이 같은 값이고, 폭과 EZ가 **다른
    # 사진**끼리 짝지어진다. 실측: 그룹 키로 붙였을 때 정답끼리도 TZL 오차 11.3mm가
    # 나왔다(같은 사진이면 0이어야 한다). caseId로 맞춘다.
    ez_ids = task_case_ids(args.index, args.baseline, "ez")
    ez_keys = np.asarray(ez_ids, dtype=object)
    truth_ez_arr = to_pixels(ez_task["target"].reshape(-1, 12, 2), ez_keys, dims)
    draft_ez = to_pixels(ez_task["baseline"].reshape(-1, 12, 2), ez_keys, dims)
    if len(ez_ids) != len(truth_ez_arr):
        raise SystemExit(f"EZ 케이스 대응 실패: {len(ez_ids)} != {len(truth_ez_arr)}")
    print("KRR 3단 EZ OOF...", flush=True)
    krr_ez = to_pixels(oof_stage_prediction(ez_task).reshape(-1, 12, 2), ez_keys, dims)
    ez_pos = {case_id: i for i, case_id in enumerate(ez_ids)}

    shared = []
    for i, case_id in enumerate(w_ids):
        if case_id in pixel_widths and case_id in ez_pos:
            shared.append((i, ez_pos[case_id], case_id))
    print(f"EZ+폭+픽셀 3중 교집합 {len(shared)}건 "
          f"(EZ 라벨 {len(truth_ez_arr)}건이 제약)", flush=True)
    if not shared:
        raise SystemExit("교집합 없음 — caseId 규약 확인")

    # 정렬 자기검사: 픽셀 파이프라인 정답과 KRR 파이프라인 정답은 같은 사진이면
    # 거의 동일하다(_pixel_sanity: 중위 0.0002mm). 케이스가 밀리면 이 값이 폭발한다.
    # 정답끼리의 TZL 차이로 잰다 — mm 환산은 24점 최대 쌍거리 기준(스케일 무관 검사).
    pixel_truth_widths = load_pixel_truth_widths(args.dataset_manifest)
    gaps = []
    for w_index, _, case_id in shared:
        other = pixel_truth_widths.get(case_id)
        if other is None:
            continue
        mine = truth_w[w_index]
        span = max(float(np.linalg.norm(mine[i + 1:] - mine[i], axis=1).max())
                   for i in range(23))
        gaps.append(float(np.linalg.norm(mine - other, axis=1).mean() * CALIBRATION_MM / span))
    if gaps:
        worst = float(np.quantile(gaps, 0.95))
        print(f"정렬 자기검사: 두 파이프라인 정답 차이 중위 {np.median(gaps):.4f}mm "
              f"p95 {worst:.4f}mm", flush=True)
        if worst > 0.5:
            raise SystemExit(
                f"케이스 정렬 의심: 정답끼리 p95 {worst:.3f}mm 차이 (정상 <0.05mm). "
                "caseId 대응을 확인하라")

    wi = np.asarray([s[0] for s in shared])
    ei = np.asarray([s[1] for s in shared])
    pix_w = np.stack([pixel_widths[s[2]] for s in shared])

    combos = {
        "rule": (draft_ez[ei], draft_w[wi]),
        "krr": (krr_ez[ei], krr_w[wi]),
        "pixelOnRuleEz": (draft_ez[ei], pix_w),
        "pixelOnKrrEz": (krr_ez[ei], pix_w),
        "pixelOnTruthEz": (truth_ez_arr[ei], pix_w),
    }
    truth = app_metrics(truth_ez_arr[ei], truth_w[wi])
    measured = {name: app_metrics(ez, w) for name, (ez, w) in combos.items()}

    keys = ("ezlMm", "tzlMm", "differenceMm")

    def errors(block: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        return {k: np.abs(block[k] - truth[k]) for k in keys}

    err = {name: errors(block) for name, block in measured.items()}

    report = {
        "schemaVersion": "pixel-app-metrics-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "purpose": ("좌표 오차가 아니라 **앱이 화면에 띄우는 EZL/TZL(mm)** 기준 평가. "
                    "픽셀 모델은 EZ를 예측하지 않으므로 px/mm 스케일은 여전히 EZ가 정한다."),
        "scaleConvention": "pxPerMm = |ez[last]-ez[0]| / 54 (앱 calculateMetricsFor와 동일)",
        "ezlCaveat": ("앱은 EZL에 correctedCurveLength(치아 점유 구간만)를 쓰지만 여기서는 "
                      "전체 곡선 길이를 쓴다. 모든 조합에 같은 방식이라 비교는 공정하지만 "
                      "절대값은 앱 표시와 다르다."),
        "cases": len(shared),
        "limitedBy": f"EZ 라벨 {len(truth_ez_arr)}건",
        "combinations": {
            "rule": "규칙엔진 EZ + 규칙엔진 폭 (현행 초안)",
            "krr": "KRR 3단 EZ + KRR 3단 폭 (현행 연구 보정)",
            "pixelOnRuleEz": "규칙엔진 EZ + 픽셀 모델 폭 (통합안 A)",
            "pixelOnKrrEz": "KRR EZ + 픽셀 모델 폭 (통합안 B, 권장)",
            "pixelOnTruthEz": "정답 EZ + 픽셀 모델 폭 (**오라클**, 달성 불가 — EZ 상한)",
        },
        "maeMm": {name: {k: round(float(v[k].mean()), 4) for k in keys}
                  for name, v in err.items()},
        "p95Mm": {name: {k: round(float(np.quantile(v[k], 0.95)), 4) for k in keys}
                  for name, v in err.items()},
        "paired": {
            f"{name}VsKrr": {k: paired(err["krr"][k], err[name][k]) for k in keys}
            for name in ("pixelOnRuleEz", "pixelOnKrrEz", "pixelOnTruthEz")
        },
        "inputSummary": summary["inputSummary"],
    }
    report["paired"]["pixelOnKrrEzVsRule"] = {
        k: paired(err["rule"][k], err["pixelOnKrrEz"][k]) for k in keys
    }

    tzl = report["paired"]["pixelOnKrrEzVsKrr"]["tzlMm"]
    ezl = report["paired"]["pixelOnKrrEzVsKrr"]["ezlMm"]
    oracle = report["maeMm"]["pixelOnTruthEz"]
    report["verdict"] = {
        "tzlImprovesOverKrr": bool(tzl["significant"]),
        "ezlImprovesOverKrr": bool(ezl["significant"]),
        "conclusion": (
            f"앱 표시 기준 TZL {tzl['old']}→{tzl['new']}mm ({tzl['improvementPct']:+.1f}%, "
            f"유의={tzl['significant']}), EZL {ezl['old']}→{ezl['new']}mm "
            f"({ezl['improvementPct']:+.1f}%, 유의={ezl['significant']}). "
            f"EZ가 완벽하면 TZL {oracle['tzlMm']}mm까지 가므로, 남은 여력은 폭이 아니라 "
            "**EZ 곡선**에 있다 — 픽셀 모델은 EZ를 예측하지 않는다."
        ),
    }

    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    header = f"{'조합':18s} " + " ".join(f"{k:>14s}" for k in keys)
    print()
    print(header)
    print("-" * len(header))
    for name in combos:
        row = report["maeMm"][name]
        print(f"{name:18s} " + " ".join(f"{row[k]:14.4f}" for k in keys))
    print()
    for group, block in report["paired"].items():
        print(f"[{group}]")
        for k in keys:
            v = block[k]
            print(f"  {k:14s} {v['old']:8.4f} -> {v['new']:8.4f} "
                  f"({v['improvementPct']:+7.2f}%) CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] "
                  f"sig={v['significant']}")
    print("\n해석:", report["verdict"]["conclusion"])
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
