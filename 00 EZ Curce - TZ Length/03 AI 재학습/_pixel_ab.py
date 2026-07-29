#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 랜드마크 모델 vs 규칙엔진 vs KRR 잔차보정 — 동일 지표 짝지어 A/B.

## 왜 별도 스크립트인가
세 방식은 서로 다른 코드 경로에서 나온다:
  - 규칙엔진 초안   : baseline_predictions_all.json (정규화 좌표)
  - KRR 3단 잔차보정: train_residual의 grouped OOF 예측 (정규화 좌표)
  - 픽셀 랜드마크   : pixel_model/metrics.json의 perCase (이미 mm)
정규화 좌표는 종횡비만큼 길이를 왜곡하므로 **픽셀 등방 공간으로 되돌린 뒤**
_px_decompose.py와 같은 정의로 mm를 계산해야 숫자를 나란히 놓을 수 있다
(project_segment_position_bottleneck: 정규화 공간 분해는 최대 1.5배 왜곡).

## 공정성 조건
1) **같은 케이스 집합.** 픽셀 모델이 평가한 384건 중 규칙/KRR 쪽에도 존재하는
   교집합만 쓴다. 케이스는 이미지 SHA-256으로 맞춘다.
2) **같은 분할 정책.** KRR 쪽도 환자 단위 그룹(dataset-index.patientgrouped.json)으로
   OOF를 만든다. 픽셀 모델은 환자 단위 5-fold를 이미 쓴다.
   ⚠️ 단 fold 경계 자체는 다르다(셔플 알고리즘이 다름). 둘 다 OOF이므로
   in-sample 누출은 없지만, fold 구성 차이에서 오는 잡음은 남는다 —
   그래서 케이스 단위 짝지어진 부트스트랩으로 신뢰구간을 낸다.
3) **같은 mm 스케일.** 정답 24점 최대 쌍거리 = 54mm.

출력에 PHI·좌표 없음. caseId와 이미지 해시 접두만.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_case, to_pixels, truth_scale_px

HERE = Path(__file__).resolve().parent
FOLDS = 5
SEED = tr.DEFAULT_SEED
PER_STAGE = 0.05
STAGES = 3          # 연구용 HTML이 채택한 구성 (project_stage3_adopted_20260727)
CUMULATIVE = 0.15
MOLAR_IDX = [0, 1, 10, 11]
BOOTSTRAP = 5000


def metrics_from_px(pred: np.ndarray, truth: np.ndarray, scale: np.ndarray) -> dict[str, np.ndarray]:
    """(cases,24,2) 픽셀 좌표 -> 케이스별 mm 지표. train_pixel_landmarks와 동일 정의."""
    pred_mid = (pred[:, 0::2, :] + pred[:, 1::2, :]) / 2.0
    truth_mid = (truth[:, 0::2, :] + truth[:, 1::2, :]) / 2.0
    s = scale[:, None]
    position = np.linalg.norm(pred_mid - truth_mid, axis=2) * s
    endpoint = np.linalg.norm(pred - truth, axis=2) * scale[:, None]
    pred_len = np.linalg.norm(pred[:, 1::2, :] - pred[:, 0::2, :], axis=2)
    truth_len = np.linalg.norm(truth[:, 1::2, :] - truth[:, 0::2, :], axis=2)
    length_signed = (pred_len - truth_len) * s
    return {
        "position": position.mean(axis=1),
        "molar": position[:, MOLAR_IDX].mean(axis=1),
        "endpoint": endpoint.mean(axis=1),
        "lengthAbs": np.abs(length_signed).mean(axis=1),
        "molarLengthAbs": np.abs(length_signed[:, MOLAR_IDX]).mean(axis=1),
        "tzl": np.abs(length_signed.sum(axis=1)),
    }


def oof_stage_prediction(data: dict) -> np.ndarray:
    """KRR 3단 잔차보정의 out-of-fold 예측 (정규화 좌표)."""
    x, baseline, target, groups = data["x"], data["baseline"], data["target"], data["groups"]
    masks = tr.grouped_folds(groups, FOLDS, SEED)
    out = np.zeros_like(target)
    for i, test in enumerate(masks, start=1):
        train = ~test
        hyper = tr.select_stage_hyperparameters(
            x[train], baseline[train], target[train], groups[train],
            SEED + i * 1009, PER_STAGE, min(4, FOLDS), STAGES, CUMULATIVE)
        models = tr.fit_stages(x[train], baseline[train], target[train], hyper,
                               PER_STAGE, CUMULATIVE)
        pred, _, _ = tr.predict_stages(models, x[test], baseline[test], PER_STAGE, CUMULATIVE)
        out[test] = pred
    return out


def paired(old: np.ndarray, new: np.ndarray, seed: int = SEED) -> dict:
    """짝지어진 부트스트랩. old-new의 평균 차이가 0보다 큰가(=new가 더 좋은가)."""
    delta = old - new
    rng = np.random.default_rng(seed)
    n = len(delta)
    means = np.array([delta[rng.integers(0, n, n)].mean() for _ in range(BOOTSTRAP)])
    lo, hi = float(np.quantile(means, 0.025)), float(np.quantile(means, 0.975))
    old_mean = float(old.mean())
    return {
        "old": round(old_mean, 4),
        "new": round(float(new.mean()), 4),
        "improvementPct": round(float(delta.mean() / old_mean * 100.0), 2) if old_mean else None,
        "ci95": [round(lo, 4), round(hi, 4)],
        "significant": bool(lo > 0),
        "casesImproved": int((delta > 0).sum()),
        "casesWorsened": int((delta < 0).sum()),
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.patientgrouped.json")
    parser.add_argument("--baseline", type=Path, default=HERE / "baseline_predictions_all.json")
    parser.add_argument("--pixel", type=Path, default=HERE / "pixel_model" / "metrics.json")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_ab.json")
    args = parser.parse_args()

    pixel = json.loads(args.pixel.read_text(encoding="utf-8"))
    pixel_rows = {row["caseId"]: row for row in pixel["perCase"]}
    print(f"픽셀 모델 OOF 케이스 {len(pixel_rows)}건", flush=True)

    tasks, summary = tr.build_samples(args.index, args.baseline)
    width = tasks["width"]
    groups = width["groups"]
    # ⚠️ dims는 **caseId** 기준이어야 한다. 환자 차트 그룹으로 잡으면 같은 환자의
    # 두 번째 사진이 첫 사진의 W/H로 변환돼 좌표가 틀어진다(실측 106/343 그룹).
    case_ids = task_case_ids(args.index, args.baseline, "width")
    if len(case_ids) != len(truth_normalized := width["target"].reshape(-1, 24, 2)):
        raise SystemExit(f"케이스 대응 실패: {len(case_ids)} != {len(truth_normalized)}")
    dims = dims_by_case(args.index)
    keys = np.asarray(case_ids, dtype=object)
    truth = to_pixels(truth_normalized, keys, dims)
    draft = to_pixels(width["baseline"].reshape(-1, 24, 2), keys, dims)
    scale = truth_scale_px(truth)
    print(f"규칙/KRR 샘플 {len(truth)}건 (그룹 {len(set(groups.tolist()))})", flush=True)

    print("KRR 3단 잔차보정 OOF 계산 중...", flush=True)
    krr = to_pixels(oof_stage_prediction(width).reshape(-1, 24, 2), keys, dims)

    rule_m = metrics_from_px(draft, truth, scale)
    krr_m = metrics_from_px(krr, truth, scale)

    shared = [i for i, cid in enumerate(case_ids) if cid in pixel_rows]
    print(f"교집합 {len(shared)}건 "
          f"(픽셀 전용 {len(pixel_rows) - len(shared)}, 규칙 전용 {len(truth) - len(shared)})",
          flush=True)
    if not shared:
        raise SystemExit("교집합이 없다 — caseId 규약을 확인하라")

    idx = np.asarray(shared)
    metric_keys = ("position", "molar", "endpoint", "lengthAbs", "molarLengthAbs", "tzl")
    pix_m = {k: np.asarray([pixel_rows[case_ids[i]][k] for i in shared], dtype=float)
             for k in metric_keys}

    def block(m, sel=None) -> dict:
        return {k: round(float((m[k] if sel is None else m[k][sel]).mean()), 4)
                for k in metric_keys}

    report = {
        "schemaVersion": "pixel-ab-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "note": ("픽셀 랜드마크 모델 vs 규칙엔진 초안 vs KRR 3단 잔차보정. 모두 "
                 "out-of-fold, 픽셀 등방 공간, mm는 정답 24점 최대 쌍거리=54mm 기준. "
                 "케이스 단위 짝지어진 부트스트랩 5,000회."),
        "sampleCounts": {
            "pixelModelCases": len(pixel_rows),
            "ruleKrrCases": int(len(truth)),
            "sharedCases": len(shared),
        },
        "splitPolicy": {
            "pixelModel": "patient_grouped_5fold (pixel_dataset manifest, seed 20260729)",
            "ruleKrr": f"grouped_{FOLDS}fold on minimumGroupId of {args.index.name}",
            "caveat": ("두 방식의 fold 경계는 다르다(셔플 알고리즘 상이). 둘 다 OOF라 "
                       "in-sample 누출은 없지만 fold 구성 잡음은 남는다."),
        },
        "krrConfig": {"stages": STAGES, "perStageCap": PER_STAGE, "cumulativeCap": CUMULATIVE},
        "onSharedCases": {
            "ruleEngine": block(rule_m, idx),
            "krrStage3": block(krr_m, idx),
            "pixelLandmark": block(pix_m),
        },
        "onAllCases": {
            "ruleEngine": block(rule_m),
            "krrStage3": block(krr_m),
            "pixelLandmark": {k: round(float(np.mean([r[k] for r in pixel_rows.values()])), 4)
                              for k in metric_keys},
        },
        "paired": {
            "pixelVsRule": {k: paired(rule_m[k][idx], pix_m[k]) for k in metric_keys},
            "pixelVsKrr": {k: paired(krr_m[k][idx], pix_m[k]) for k in metric_keys},
            "krrVsRule": {k: paired(rule_m[k][idx], krr_m[k][idx]) for k in metric_keys},
        },
        "inputSummary": summary["inputSummary"],
    }

    position = report["paired"]["pixelVsKrr"]["position"]
    molar = report["paired"]["pixelVsKrr"]["molar"]
    report["verdict"] = {
        "pixelBeatsKrrOnPosition": bool(position["significant"]),
        "pixelBeatsKrrOnMolar": bool(molar["significant"]),
        "pixelBeatsRuleOnPosition": bool(report["paired"]["pixelVsRule"]["position"]["significant"]),
        "conclusion": (
            f"픽셀 모델이 KRR 대비 위치 {position['improvementPct']:+.1f}%"
            f" (CI {position['ci95']}), 어금니 {molar['improvementPct']:+.1f}%"
            if position["significant"]
            else "픽셀 모델의 위치 개선이 KRR 대비 유의하지 않다 — 학습량·증강 재검토"
        ),
    }

    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print()
    header = f"{'방식':16s} " + " ".join(f"{k:>14s}" for k in metric_keys)
    print(header)
    print("-" * len(header))
    for name, label in (("ruleEngine", "규칙엔진"), ("krrStage3", "KRR 3단"),
                        ("pixelLandmark", "픽셀 랜드마크")):
        row = report["onSharedCases"][name]
        print(f"{label:16s} " + " ".join(f"{row[k]:14.4f}" for k in metric_keys))
    print()
    for group, label in (("krrVsRule", "KRR vs 규칙"), ("pixelVsRule", "픽셀 vs 규칙"),
                         ("pixelVsKrr", "픽셀 vs KRR")):
        print(f"[{label}]")
        for k in metric_keys:
            v = report["paired"][group][k]
            print(f"  {k:16s} {v['old']:8.4f} -> {v['new']:8.4f} ({v['improvementPct']:+7.2f}%) "
                  f"CI [{v['ci95'][0]:+.4f},{v['ci95'][1]:+.4f}] sig={v['significant']} "
                  f"개선/악화 {v['casesImproved']}/{v['casesWorsened']}")
    print("\nverdict:", json.dumps(report["verdict"], ensure_ascii=False, indent=2))
    print(f"-> {args.out}")


def task_case_ids(index_path: Path, baseline_path: Path,
                  task: str = "width") -> list[str]:
    """build_samples의 해당 태스크와 **정확히 같은 순서**의 caseId 목록.

    build_samples는 caseId를 반환하지 않는다. 그래서 같은 필터·같은 순회로 재구성한다.
    조건이 어긋나면 케이스가 밀려 A/B가 조용히 틀리므로, 호출부에서 길이를 검증한다.

    ⚠️ `groups`(=splitGrouping.minimumGroupId)를 케이스 식별자로 쓰면 안 된다. 그것은
    **환자 차트 ID**라서 같은 환자의 사진 2장이 같은 값을 갖는다. 실측에서 폭과 EZ를
    그룹으로 짝지었더니 다른 사진끼리 붙어 TZL 오차가 11.3mm로 나왔다(정상 2%).
    태스크 간 대응은 반드시 caseId로 한다.
    """
    from collections import Counter
    from collections.abc import Mapping

    shape = {"width": (24, 2), "ez": (12, 2)}[task]
    dataset = tr.dataset_cases(tr.read_json(index_path))
    baseline = tr.records_from_baseline(tr.read_json(baseline_path))
    by_sha = {tr.baseline_sha(item): item for item in baseline if tr.baseline_sha(item)}
    by_id = {tr.get_case_id(item): item for item in baseline if tr.get_case_id(item)}
    quality: Counter[str] = Counter()
    out: list[str] = []
    for case in dataset:
        image = case.get("image") if isinstance(case.get("image"), Mapping) else case
        image_sha = tr.sha256_text(image.get("sha256")) if isinstance(image, Mapping) else None
        record = by_sha.get(image_sha) if image_sha else None
        if record is None:
            record = by_id.get(tr.get_case_id(case))
        if record is None or str(record.get("status", "ok")).casefold() != "ok":
            continue
        truth_dims = tr.dimensions(case)
        if truth_dims is None or tr.dimensions(record) is None:
            continue
        if tr.baseline_components(record, quality) is None:
            continue
        truth = tr.truth_consensus(case, task, truth_dims, index_path.parent, quality)
        if truth is not None and truth.shape == shape:
            out.append(str(tr.get_case_id(case)))
    return out


def width_case_ids(index_path: Path, baseline_path: Path) -> list[str]:
    """하위 호환 별칭. 신규 코드는 task_case_ids를 쓴다."""
    return task_case_ids(index_path, baseline_path, "width")


if __name__ == "__main__":
    main()
