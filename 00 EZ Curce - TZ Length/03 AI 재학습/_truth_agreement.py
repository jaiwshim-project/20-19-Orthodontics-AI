#!/usr/bin/env python3
"""정답끼리 얼마나 일치하나 — 같은 이미지를 두 폴더가 주석한 65건 (모델 미개입).

사용자 전제: 제공된 폭 정답 5개 폴더 전부 원장 지도로 만든 정답이다. 그렇다면
같은 이미지에 두 개의 정답이 있을 때 둘의 차이는 **오류가 아니라 이 과제의
고유 허용 오차(intrinsic tolerance)**다. 그리고 그 허용 오차가 AI가 도달할 수
있는 **정확도 상한**이다 — AI를 정답 하나에 완벽히 맞추면 다른 정답 기준으로는
그만큼 틀린 것으로 보인다.

"AI 결과가 정답처럼 나와야 한다"는 목표를 수치로 세우려면 이 상한을 먼저 알아야
한다. 상한을 모르면 남은 오차가 모델 잘못인지 과제 고유 변동인지 구분할 수 없다.

측정: dataset-index에서 폭 주석이 2개 이상이고 둘 다 12치 완전한 케이스를 골라
  · 치아별 끝점 거리(mm)      — 위치가 얼마나 다른가
  · 치아별 폭 길이 차(mm)      — 길이가 얼마나 다른가
  · TZL 총합 차(mm, 부호 포함) — 스케일이 계통적으로 다른가
  · 필요 폭 배율 비(A/B)        — 한쪽이 일관되게 크게 찍는가

mm 환산은 각 주석의 scaleMm(정답 최외곽 스팬=54mm) 기준으로, **주석 자신의
스팬으로 정규화**한다. 두 주석이 같은 이미지이므로 픽셀 공간은 공유하지만,
스팬을 54mm로 고정하는 관례 자체가 스케일을 흡수하므로 두 방식 다 보고한다.
  (a) 공통 픽셀 → 한쪽(사전순 앞) 주석의 스팬으로 mm 환산: 스케일 차가 보인다
  (b) 각자 자기 스팬으로 환산: 스케일 차가 지워지고 형태 차만 남는다

출력에 PHI·파일명·좌표·담당자명 없음(익명 코드).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from _cohort_scale_map import label_sha_to_cohort

HERE = Path(__file__).resolve().parent
SPAN_MM = 54.0


def annotation_points(annotation: dict) -> np.ndarray | None:
    """12치 완전 주석을 (12, 2, 2) 픽셀 배열로. 불완전하면 None."""
    widths = annotation["raw"]["toothWidthsPx"]
    if len(widths) != 12:
        return None
    numbers = [w["toothNo"] for w in widths]
    if sorted(numbers) != list(range(1, 13)):
        return None
    ordered = sorted(widths, key=lambda w: w["toothNo"])
    return np.asarray([[[w["p1"]["x"], w["p1"]["y"]], [w["p2"]["x"], w["p2"]["y"]]]
                       for w in ordered], dtype=np.float64)


def outermost_span_px(points: np.ndarray) -> float:
    """최외곽 폭 끝점 사이 거리 = mm 환산 기준(54mm에 대응)."""
    flat = points.reshape(-1, 2)
    first, last = points[0].reshape(-1, 2), points[-1].reshape(-1, 2)
    best = 0.0
    for a in first:
        for b in last:
            best = max(best, float(np.linalg.norm(a - b)))
    if best <= 0:  # 퇴화 방어: 전체 점 쌍 최대거리로 대체
        d = np.linalg.norm(flat[:, None, :] - flat[None, :, :], axis=2)
        best = float(d.max())
    return best


def cohort_of(annotation: dict, sha_to_cohort: dict[str, str]) -> str | None:
    for sha in annotation.get("sourceAnnotationSha256s") or []:
        code = sha_to_cohort.get(sha)
        if code:
            return code
    return None


def paired_bootstrap_mean(values: np.ndarray, seed: int, draws: int = 5000) -> list[float]:
    rng = np.random.default_rng(seed)
    n = len(values)
    means = [float(values[rng.integers(0, n, n)].mean()) for _ in range(draws)]
    return [round(float(np.quantile(means, 0.025)), 4),
            round(float(np.quantile(means, 0.975)), 4)]


def main() -> None:
    document = json.loads((HERE / "dataset-index.json").read_text(encoding="utf-8"))
    sha_to_cohort = label_sha_to_cohort()

    rows = []
    for case in document["cases"]:
        complete = []
        for annotation in case["expert"]["widthAnnotations"]:
            points = annotation_points(annotation)
            if points is None:
                continue
            code = cohort_of(annotation, sha_to_cohort)
            complete.append((code or "unknown", points))
        if len(complete) < 2:
            continue
        complete.sort(key=lambda item: item[0])
        (code_a, pts_a), (code_b, pts_b) = complete[0], complete[1]

        span_a = outermost_span_px(pts_a)
        span_b = outermost_span_px(pts_b)
        mm_common = SPAN_MM / span_a  # (a) 공통 스케일: A의 스팬 기준

        length_a_px = np.linalg.norm(pts_a[:, 0, :] - pts_a[:, 1, :], axis=1)
        length_b_px = np.linalg.norm(pts_b[:, 0, :] - pts_b[:, 1, :], axis=1)

        # (a) 공통 스케일에서
        endpoint_mm = float(np.linalg.norm(pts_a - pts_b, axis=2).mean() * mm_common)
        length_diff_mm = float(np.abs(length_a_px - length_b_px).mean() * mm_common)
        tzl_a_mm = float(length_a_px.sum() * mm_common)
        tzl_b_mm = float(length_b_px.sum() * mm_common)

        # (b) 각자 자기 스팬으로 환산 = 스팬 고정 관례 적용 후
        own_a = length_a_px.sum() * (SPAN_MM / span_a)
        own_b = length_b_px.sum() * (SPAN_MM / span_b)

        rows.append({
            "pair": f"{code_a}|{code_b}",
            "endpointMm": endpoint_mm,
            "lengthDiffMm": length_diff_mm,
            "tzlDiffMm": tzl_a_mm - tzl_b_mm,
            "tzlAbsDiffMm": abs(tzl_a_mm - tzl_b_mm),
            "tzlRatio": tzl_a_mm / max(tzl_b_mm, 1e-9),
            "tzlOwnScaleDiffMm": own_a - own_b,
            "tzlOwnScaleAbsMm": abs(own_a - own_b),
            "spanRatio": span_a / max(span_b, 1e-9),
        })

    if not rows:
        raise SystemExit("no image has two complete width annotations")

    def stats(key: str, subset: list[dict]) -> dict:
        values = np.asarray([r[key] for r in subset], dtype=np.float64)
        return {
            "mean": round(float(values.mean()), 4),
            "median": round(float(np.median(values)), 4),
            "p95": round(float(np.quantile(values, 0.95)), 4),
            "ci95Mean": paired_bootstrap_mean(values, 20260728) if values.size >= 8 else None,
        }

    keys = ["endpointMm", "lengthDiffMm", "tzlDiffMm", "tzlAbsDiffMm", "tzlRatio",
            "tzlOwnScaleDiffMm", "tzlOwnScaleAbsMm", "spanRatio"]
    overall = {key: stats(key, rows) for key in keys}

    per_pair = {}
    for pair in sorted({r["pair"] for r in rows}):
        subset = [r for r in rows if r["pair"] == pair]
        per_pair[pair] = {"cases": len(subset)} | {key: stats(key, subset) for key in keys}

    report = {
        "schemaVersion": "truth-agreement-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("같은 이미지에 두 개의 완전 폭 정답이 있는 케이스에서 정답끼리 직접 비교. "
                 "모델은 개입하지 않는다. 사용자 전제(모든 정답은 원장 지도)에 따르면 이 "
                 "차이는 오류가 아니라 과제의 고유 허용 오차이며, AI 정확도의 상한이다. "
                 "(a) 공통 픽셀을 사전순 앞 주석의 최외곽 스팬=54mm로 환산 → 스케일 차가 "
                 "보인다. (b) tzlOwnScale*은 각자 자기 스팬으로 환산 → 스팬 고정 관례가 "
                 "스케일 차를 흡수한 뒤 남는 형태 차."),
        "casesCompared": len(rows),
        "overall": overall,
        "perPair": per_pair,
    }
    (HERE / "truth_agreement.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"images with two complete width truths: {len(rows)}")
    for pair, row in per_pair.items():
        print(f"\n[{pair}]  n={row['cases']}")
        for key in keys:
            s = row[key]
            ci = f" ci {s['ci95Mean']}" if s["ci95Mean"] else ""
            print(f"   {key:20s} mean {s['mean']:+8.4f}  median {s['median']:+8.4f}"
                  f"  p95 {s['p95']:+8.4f}{ci}")
    print("\n[ALL]")
    for key in keys:
        s = overall[key]
        ci = f" ci {s['ci95Mean']}" if s["ci95Mean"] else ""
        print(f"   {key:20s} mean {s['mean']:+8.4f}  median {s['median']:+8.4f}"
              f"  p95 {s['p95']:+8.4f}{ci}")


if __name__ == "__main__":
    main()
