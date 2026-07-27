#!/usr/bin/env python3
"""부분 주석 케이스의 치아 번호는 무엇을 가리키나 — 매핑 식별.

`_more_labels_why.py`에서 나온 단서: 부분 주석(10개) 케이스의 상대폭은 **양 끝이 모두
크다**(0.253 / 0.226). 완전 주석 케이스는 1번만 크고 10번은 중간이다(0.261 / 0.169).
즉 부분 주석의 마지막 번호가 최말단 치아라는 뜻이고, 번호 1~10이 정본 1~10이 아니다.

가장 그럴듯한 해석: 발치 케이스다. 소구치 2개를 뽑으면 12개 → 10개가 된다. 이때
annotator가 남은 치아에 1~10을 다시 매겼다면, 정본 번호로는 중간 두 자리가 빈다.

식별 방법: 단조 증가하는 10-of-12 매핑 66가지를 모두 시도해, 부분 주석의 평균 상대폭이
완전 주석의 해당 위치 분포(z 기준)에 가장 잘 맞는 조합을 찾는다. 상대폭은 자기 케이스의
주석된 치아 스팬으로 정규화하므로, 비교 대상 완전 주석 쪽도 **같은 부분집합의 스팬**으로
다시 정규화해야 공정하다(그래서 조합마다 완전 주석 통계를 다시 계산한다).

⚠️ 이건 통계적 추정이다. 채택 판단의 근거로 쓰기 전에 사람이 원본 이미지에서 확인해야
한다. 이 스크립트의 결론은 "확인해야 할 가설"까지다.

출력에 PHI·좌표·모델 파라미터 없음.
"""
from __future__ import annotations

import itertools
import json
from collections import Counter
from pathlib import Path

import numpy as np

import train_residual as tr
from _more_labels import tooth_truth_by_case

HERE = Path(__file__).resolve().parent


def isotropic(points: np.ndarray, aspect: float) -> np.ndarray:
    return points * np.array([aspect, 1.0])


def relative_by_subset(points_by_tooth: dict[int, np.ndarray], teeth: list[int],
                       aspect: float) -> np.ndarray | None:
    """주어진 치아 부분집합의 폭을, 그 부분집합의 최외곽 스팬으로 정규화."""
    if any(t not in points_by_tooth for t in teeth):
        return None
    iso = {t: isotropic(points_by_tooth[t], aspect) for t in teeth}
    widths = np.array([np.linalg.norm(iso[t][0] - iso[t][1]) for t in teeth])
    ends = np.concatenate([iso[teeth[0]], iso[teeth[-1]]])
    span = max(np.linalg.norm(a - b) for a in ends for b in ends)
    return widths / span if span > 0 else None


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    full_groups = width["groups"].tolist()
    per_case, _ = tooth_truth_by_case(dataset_path)

    baseline_document = json.loads((HERE / "baseline_predictions_all.json").read_text(encoding="utf-8"))
    by_sha = {tr.baseline_sha(i): i for i in tr.records_from_baseline(baseline_document) if tr.baseline_sha(i)}
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    aspects, quality = {}, Counter()
    for case in tr.dataset_cases(document):
        image = case.get("image") if isinstance(case.get("image"), dict) else {}
        sha = tr.sha256_text(image.get("sha256"))
        record = by_sha.get(sha) if sha else None
        if not sha or record is None:
            continue
        base_dims = tr.dimensions(record)
        if base_dims and tr.baseline_components(record, quality) is not None:
            aspects[sha] = base_dims[0] / base_dims[1]

    full_points = {sha: {t: width["target"][i].reshape(12, 2, 2)[t - 1] for t in range(1, 13)}
                   for i, sha in enumerate(full_groups)}
    full_set = set(full_groups)

    # 정확히 10개가 주석된 부분 케이스만 본다(번호 1~10).
    ten = {sha: teeth for sha, teeth in per_case.items()
           if sha not in full_set and sha in aspects
           and sorted(teeth) == list(range(1, 11))}
    partial_rows = [relative_by_subset(ten[sha], list(range(1, 11)), aspects[sha]) for sha in sorted(ten)]
    partial_rows = [r for r in partial_rows if r is not None]
    partial_mean = np.stack(partial_rows).mean(axis=0)

    results = []
    for subset in itertools.combinations(range(1, 13), 10):
        teeth = list(subset)
        rows = []
        for sha, points in full_points.items():
            row = relative_by_subset(points, teeth, aspects.get(sha, 1.0))
            if row is not None:
                rows.append(row)
        if not rows:
            continue
        stacked = np.stack(rows)
        z = np.abs(partial_mean - stacked.mean(axis=0)) / (stacked.std(axis=0) + 1e-12)
        results.append({"missingTeeth": [t for t in range(1, 13) if t not in subset],
                        "meanAbsoluteZ": float(z.mean()), "maxAbsoluteZ": float(z.max())})
    results.sort(key=lambda item: item["meanAbsoluteZ"])
    best, identity = results[0], next(r for r in results if r["missingTeeth"] == [11, 12])

    report = {
        "schemaVersion": "more-labels-map-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False, "containsFilePaths": False,
                    "containsImageCoordinates": False, "containsModelParameters": False},
        "note": ("10개만 주석된 케이스의 번호 1~10이 정본 12개 중 어느 자리인지 추정. 단조 "
                 "10-of-12 매핑 66가지를 상대폭 z 적합도로 비교. 상대폭은 조합별 스팬으로 "
                 "재정규화해 공정 비교. 통계적 추정이며 사람 확인이 필요하다."),
        "tenToothCasesCompared": len(partial_rows),
        "bestFit": best,
        "currentImplicitAssumption": identity,
        "topCandidates": results[:5],
        "worstCandidate": results[-1],
        "conclusion": (
            f"가장 잘 맞는 해석은 정본 치아 {best['missingTeeth']}가 빠진 배열(z={best['meanAbsoluteZ']:.3f})이다. "
            f"반면 지금 코드가 암묵적으로 가정하는 '11·12번이 빠졌다'는 z={identity['meanAbsoluteZ']:.3f}로 "
            f"{'더 나쁘다 — 번호를 그대로 믿고 학습하면 다른 치아의 정답을 배우게 된다.' if identity['meanAbsoluteZ'] > best['meanAbsoluteZ'] else '동등하거나 더 낫다.'}"),
    }
    (HERE / "more_labels_map.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"ten-tooth cases compared: {len(partial_rows)}")
    print("\nrank  missingTeeth   meanAbsZ  maxAbsZ")
    for row in results[:8]:
        print(f"      {str(row['missingTeeth']):12s} {row['meanAbsoluteZ']:8.3f} {row['maxAbsoluteZ']:8.3f}")
    print(f"\nassumed-now [11, 12]: meanAbsZ={identity['meanAbsoluteZ']:.3f} "
          f"(rank {results.index(identity) + 1} of {len(results)})")
    print(f"worst: {results[-1]['missingTeeth']} meanAbsZ={results[-1]['meanAbsoluteZ']:.3f}")


if __name__ == "__main__":
    main()
