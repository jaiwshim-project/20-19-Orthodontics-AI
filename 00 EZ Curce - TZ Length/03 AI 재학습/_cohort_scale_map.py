#!/usr/bin/env python3
"""폭 스케일 차가 "유라쌤 vs 나머지"인가, 아니면 폴더마다 다른가 — 코호트별 실측.

배경: 신규 116건(유라쌤-클래스2)을 넣으면 좌표는 개선되고 치아 폭 길이는 4/4 시드
유의 악화한다(`class2b_width_ab.json`). 원인으로 코호트 스케일 차를 지목했는데
(기존 268건 평균 필요배율 1.071 vs 신규 1.169), **"기존 268건"은 폴더 4개가 섞인
덩어리**다. 그 덩어리 평균과 신규를 비교한 것이므로 다음을 구분할 수 없다.

  가설 A: 유라쌤 폴더만 유별나다 → 그 폴더 기준이 다른 것
  가설 B: 폴더마다 다 다르다  → 애초에 "하나의 정답 기준"이 없다

원장 지도로 만든 정답이라면 A가 아니라 B일 가능성이 높다. 그러면 "신규가 이상하다"는
프레이밍이 틀린 것이고, 옳은 결론은 "**케이스별 배율을 추정해야 한다**"가 된다.

필요배율 = 케이스별 (정답 폭 합 / 규칙엔진 초안 폭 합). 픽셀 등방 공간에서 계산하며
정답·초안 모두 같은 케이스의 같은 스케일이므로 mm 환산은 불필요(비율이라 상쇄된다).

코호트 라벨은 **폴더명이 아니라 라벨 파일 SHA**로 역추적한다. dataset-index는 폴더
경로를 담지 않으므로(PHI 회피), 각 폴더의 md를 직접 읽어 sourceAnnotationSha256 →
폴더 매핑을 만든다. 원본 폴더는 읽기만 한다.

출력에 파일명·좌표·PHI 없음. 폴더명은 담당자 표기가 들어가므로 익명 코호트 코드로 바꾼다.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

import numpy as np

import train_residual as tr
from _px_decompose import dims_by_group, to_pixels

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent

# 폴더 → 익명 코호트 코드. 담당자 이름을 산출물에 남기지 않기 위한 매핑이다.
# (폴더명 자체는 로컬 디스크에만 있고 리포트에는 코드만 들어간다.)
COHORT_CODES = {
    "01 치아 좌우폭 찍기": "A_width_1st",
    "02 치아 좌우폭 찍기": "B_width_2nd",
    "02 교정 후 치아폭 찍기": "C_postortho",
    "03 치아 좌우폭 찍기(김원장님-클래스2)": "D_class2_a",
    "03 치아 좌우폭 찍기(유라쌤-클래스2)": "E_class2_b",
}


def label_sha_to_cohort() -> dict[str, str]:
    """각 라벨 md의 SHA-256 → 익명 코호트 코드.

    dataset-index의 `sourceAnnotationSha256s`가 md 파일 본문의 SHA다. 폴더를 직접
    훑어 같은 방식으로 해시해 대조한다(파일명·번호 매칭 금지 원칙 유지).
    """
    mapping: dict[str, str] = {}
    for name in sorted(os.listdir(PROJECT)):
        directory = PROJECT / name
        if not directory.is_dir():
            continue
        code = None
        for prefix, candidate in COHORT_CODES.items():
            if name == prefix or name.startswith(prefix):
                code = candidate
                break
        if code is None:
            continue
        for entry in sorted(os.listdir(directory)):
            if not entry.lower().endswith(".md"):
                continue
            path = directory / entry
            if path.stat().st_size == 0:
                continue
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            mapping.setdefault(digest, code)
    return mapping


def case_cohorts(dataset_path: Path, sha_to_cohort: dict[str, str]) -> dict[str, set[str]]:
    """이미지 SHA(그룹 키) → 그 케이스에 폭 주석을 준 코호트 코드 집합."""
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    out: dict[str, set[str]] = {}
    for case in document["cases"]:
        group = case["splitGrouping"]["minimumGroupId"]
        codes: set[str] = set()
        for annotation in case["expert"]["widthAnnotations"]:
            for sha in annotation.get("sourceAnnotationSha256s") or []:
                code = sha_to_cohort.get(sha)
                if code:
                    codes.add(code)
        if codes:
            out[group] = codes
    return out


def needed_bias(pred_px: np.ndarray, truth_px: np.ndarray) -> np.ndarray:
    """케이스별 필요 폭 배율 = 정답 폭 합 / 초안 폭 합."""
    tl = np.linalg.norm(truth_px[:, 0::2, :] - truth_px[:, 1::2, :], axis=2).sum(axis=1)
    pl = np.linalg.norm(pred_px[:, 0::2, :] - pred_px[:, 1::2, :], axis=2).sum(axis=1)
    return tl / np.maximum(pl, 1e-12)


def bootstrap_ci(values: np.ndarray, seed: int, draws: int = 5000) -> list[float]:
    rng = np.random.default_rng(seed)
    n = len(values)
    medians = [float(np.median(values[rng.integers(0, n, n)])) for _ in range(draws)]
    return [round(float(np.quantile(medians, 0.025)), 4),
            round(float(np.quantile(medians, 0.975)), 4)]


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    groups = width["groups"]
    dims = dims_by_group(dataset_path)

    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    base_px = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    ratios = needed_bias(base_px, truth_px)

    cohorts = case_cohorts(dataset_path, label_sha_to_cohort())
    labels = [sorted(cohorts.get(sha, set())) for sha in groups.tolist()]

    # 단일 코호트 케이스만 코호트별 통계에 쓴다(여러 폴더가 같은 이미지를 주석한
    # 케이스는 어느 기준인지 특정할 수 없어 섞으면 비교가 흐려진다).
    per_cohort: dict[str, list[float]] = {}
    multi = 0
    unknown = 0
    for ratio, codes in zip(ratios.tolist(), labels):
        if not codes:
            unknown += 1
        elif len(codes) > 1:
            multi += 1
        else:
            per_cohort.setdefault(codes[0], []).append(ratio)

    report_cohorts = {}
    for code in sorted(per_cohort):
        values = np.asarray(per_cohort[code], dtype=np.float64)
        report_cohorts[code] = {
            "cases": int(values.size),
            "medianNeededBias": round(float(np.median(values)), 4),
            "meanNeededBias": round(float(values.mean()), 4),
            "iqr": [round(float(np.quantile(values, 0.25)), 4),
                    round(float(np.quantile(values, 0.75)), 4)],
            "medianCi95": bootstrap_ci(values, 20260728) if values.size >= 8 else None,
        }

    medians = [v["medianNeededBias"] for v in report_cohorts.values()]
    within = np.concatenate([np.asarray(v) - np.median(v) for v in per_cohort.values()])
    spread_between = float(np.max(medians) - np.min(medians)) if medians else 0.0
    spread_within = float(np.quantile(within, 0.75) - np.quantile(within, 0.25))

    report = {
        "schemaVersion": "cohort-scale-map-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("필요 폭 배율(정답 폭 합 / 규칙엔진 초안 폭 합)을 라벨 폴더별로 분해. "
                 "코호트는 라벨 md의 SHA-256으로 역추적하며 폴더명·담당자명은 산출물에 "
                 "담지 않는다(익명 코드). 여러 폴더가 주석한 케이스는 제외."),
        "cohorts": report_cohorts,
        "excluded": {"multipleCohortsPerCase": multi, "cohortUnresolved": unknown},
        "spread": {
            "betweenCohortMedianRange": round(spread_between, 4),
            "withinCohortIqr": round(spread_within, 4),
            "interpretation": ("betweenCohortMedianRange가 withinCohortIqr보다 작으면 "
                               "'폴더별 기준 차이'보다 '케이스별 변동'이 지배적이라는 뜻 "
                               "= 코호트 지시자로는 해결되지 않는다."),
        },
    }
    (HERE / "cohort_scale_map.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("needed width bias by cohort (median):")
    for code, row in report_cohorts.items():
        ci = row["medianCi95"]
        ci_text = f" ci {ci}" if ci else ""
        print(f"   {code:14s} n={row['cases']:3d}  median {row['medianNeededBias']:.4f}"
              f"  iqr {row['iqr']}{ci_text}")
    print(f"\nexcluded: multi-cohort {multi}, unresolved {unknown}")
    print(f"between-cohort median range {spread_between:.4f}  vs  "
          f"within-cohort IQR {spread_within:.4f}")


if __name__ == "__main__":
    main()
