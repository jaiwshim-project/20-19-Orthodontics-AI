#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""추출한 키포인트 데이터셋 검증.

숫자만 맞아도 좌표계가 뒤집혀 있으면 학습이 조용히 망한다. 그래서 두 가지를 한다:
 1) 수치 검증 — 프레임 안에 있는지, 치아폭 mm가 해부학적 범위인지, 원본 좌표를
    되돌렸을 때 dataset-index 값과 일치하는지
 2) 시각 검증 — 선분을 그려 얹은 오버레이 이미지를 몇 장 저장(육안 확인용)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.json")
    parser.add_argument("--overlays", type=int, default=8)
    parser.add_argument("--scale-mm", type=float, default=54.0,
                        help="양쪽 어금니 간 거리 기준 mm (기존 파이프라인과 동일)")
    args = parser.parse_args()

    coco = json.loads((args.dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    index = json.loads(args.index.read_text(encoding="utf-8-sig"))
    by_case = {c["caseId"]: c for c in index["cases"]}
    ann_by_image = {a["image_id"]: a for a in coco["annotations"]}

    problems: Counter[str] = Counter()
    widths_mm: list[float] = []
    roundtrip_err: list[float] = []
    ordering_bad = 0

    for image in coco["images"]:
        ann = ann_by_image[image["id"]]
        kp = ann["keypoints"]
        if len(kp) != 72:
            problems["keypoint_count_not_24"] += 1
            continue
        points = [(kp[i], kp[i + 1], kp[i + 2]) for i in range(0, 72, 3)]
        for _, _, v in points:
            if v == 1:
                problems["frame_truncated_points_visibility1"] += 1
            elif v != 2:
                problems["unexpected_visibility_flag"] += 1
        for x, y, _ in points:
            if not (0 <= x <= image["width"] and 0 <= y <= image["height"]):
                problems["point_outside_frame"] += 1

        # p1은 아치 진행 방향(치아 1→12) 축에서 p2보다 앞이어야 한다.
        # 사전식 (x,y) 비교는 세로로 선 구치부에서 불안정하므로 쓰지 않는다.
        # 축은 추출 시와 동일한 정의(치아 중심들의 첫 주성분)를 써야 한다. 양 끝
        # 중심을 잇는 현(chord)으로 근사하면 아치가 휜 만큼 축이 몇 도 기울어
        # 거의 수직인 치아에서 판정이 뒤집힌다(실측 5건, 축 각도차 0.6~4.2°).
        centers = [((points[2 * i][0] + points[2 * i + 1][0]) / 2.0,
                    (points[2 * i][1] + points[2 * i + 1][1]) / 2.0) for i in range(12)]
        mean_x = sum(c[0] for c in centers) / len(centers)
        mean_y = sum(c[1] for c in centers) / len(centers)
        sxx = sum((c[0] - mean_x) ** 2 for c in centers)
        syy = sum((c[1] - mean_y) ** 2 for c in centers)
        sxy = sum((c[0] - mean_x) * (c[1] - mean_y) for c in centers)
        theta = 0.5 * math.atan2(2.0 * sxy, sxx - syy)
        axis = (math.cos(theta), math.sin(theta))
        forward = (centers[-1][0] - centers[0][0], centers[-1][1] - centers[0][1])
        if axis[0] * forward[0] + axis[1] * forward[1] < 0:
            axis = (-axis[0], -axis[1])
        for i in range(12):
            x1, y1, _ = points[2 * i]
            x2, y2, _ = points[2 * i + 1]
            if (x2 * axis[0] + y2 * axis[1]) < (x1 * axis[0] + y1 * axis[1]):
                ordering_bad += 1

        # 어금니 간 거리로 mm 환산 (치아1 p1 ~ 치아12 p2)
        ax, ay, _ = points[0]
        bx, by, _ = points[23]
        span = math.hypot(ax - bx, ay - by)
        if span > 0:
            mm_per_px = args.scale_mm / span
            for i in range(12):
                x1, y1, _ = points[2 * i]
                x2, y2, _ = points[2 * i + 1]
                widths_mm.append(math.hypot(x1 - x2, y1 - y2) * mm_per_px)

        # 원본 좌표로 되돌려 index 값과 비교
        case = by_case.get(image["caseId"])
        scale = image["scaleFromSource"]
        truth = None
        for annotation in (case or {}).get("expert", {}).get("widthAnnotations", []):
            teeth = (annotation.get("raw") or {}).get("toothWidthsPx") or []
            if len(teeth) == 12:
                truth = sorted(teeth, key=lambda t: float(t["toothNo"]))
                break
        if truth and scale > 0:
            n_ann = sum(
                1 for a in case["expert"]["widthAnnotations"]
                if len((a.get("raw") or {}).get("toothWidthsPx") or []) == 12
            )
            if n_ann == 1:  # 합의 평균이 아닌 경우만 정확 비교
                # 아치축 재정렬로 p1/p2가 뒤바뀔 수 있으므로 두 대응 중 가까운 쪽을 쓴다.
                # 클립된 점(visibility 1)은 프레임 밖 정답이라 원래 어긋나므로 제외한다.
                for i, tooth in enumerate(truth):
                    truth_pair = [(float(tooth[k]["x"]), float(tooth[k]["y"])) for k in ("p1", "p2")]
                    got = [points[2 * i], points[2 * i + 1]]
                    if any(v == 1 for _, _, v in got):
                        continue
                    direct = sum(math.hypot(got[j][0] / scale - truth_pair[j][0],
                                            got[j][1] / scale - truth_pair[j][1]) for j in range(2))
                    swapped = sum(math.hypot(got[j][0] / scale - truth_pair[1 - j][0],
                                             got[j][1] / scale - truth_pair[1 - j][1]) for j in range(2))
                    order = [0, 1] if direct <= swapped else [1, 0]
                    for j in range(2):
                        roundtrip_err.append(math.hypot(
                            got[j][0] / scale - truth_pair[order[j]][0],
                            got[j][1] / scale - truth_pair[order[j]][1],
                        ))

    widths_mm.sort()
    roundtrip_err.sort()

    def q(values: list[float], p: float) -> float:
        return round(values[min(int(len(values) * p), len(values) - 1)], 4) if values else float("nan")

    # 오버레이 저장
    overlay_dir = args.dataset / "_overlay"
    overlay_dir.mkdir(exist_ok=True)
    step = max(1, len(coco["images"]) // max(args.overlays, 1))
    saved = []
    for image in coco["images"][::step][: args.overlays]:
        ann = ann_by_image[image["id"]]
        kp = ann["keypoints"]
        picture = Image.open(args.dataset / "images" / image["file_name"]).convert("RGB")
        draw = ImageDraw.Draw(picture)
        radius = max(3, picture.size[0] // 300)
        for i in range(12):
            x1, y1 = kp[6 * i], kp[6 * i + 1]
            x2, y2 = kp[6 * i + 3], kp[6 * i + 4]
            draw.line((x1, y1, x2, y2), fill=(255, 60, 60), width=max(2, radius // 2))
            for x, y in ((x1, y1), (x2, y2)):
                draw.ellipse((x - radius, y - radius, x + radius, y + radius),
                             fill=(60, 200, 255), outline=(0, 0, 0))
        out = overlay_dir / f"overlay_{image['caseId']}.jpg"
        picture.save(out, "JPEG", quality=88)
        saved.append(out.name)

    report = {
        "schemaVersion": "keypoint-verify-v1",
        "images": len(coco["images"]),
        "problems": dict(sorted(problems.items())),
        "endpointOrderingViolations": ordering_bad,
        "toothWidthMm": {
            "n": len(widths_mm),
            "p01": q(widths_mm, 0.01), "p05": q(widths_mm, 0.05),
            "median": q(widths_mm, 0.50),
            "p95": q(widths_mm, 0.95), "p99": q(widths_mm, 0.99),
            "plausibleRange": "하악 치아 근원심폭 대략 5~13mm",
            "outsideRange3to20mm": sum(1 for w in widths_mm if not 3.0 <= w <= 20.0),
        },
        "roundtripToSourcePx": {
            "n": len(roundtrip_err),
            "median": q(roundtrip_err, 0.50),
            "p95": q(roundtrip_err, 0.95),
            "max": round(roundtrip_err[-1], 4) if roundtrip_err else None,
            "note": "리사이즈 역변환 오차. 서브픽셀(<1px)이면 정상",
        },
        "overlaysSaved": saved,
    }
    (args.dataset / "verify.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
