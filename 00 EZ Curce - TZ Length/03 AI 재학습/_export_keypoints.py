#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 랜드마크 학습용 데이터셋 추출.

## 하는 일
1. 라벨 md 파일에 base64로 박혀 있는 원본 JPEG를 꺼내 파일로 저장한다.
   (검증: md 안의 JPEG SHA-256이 dataset-index.json의 image.sha256과 일치)
2. 12개 치아폭 선분 = 24개 키포인트를 COCO keypoints 형식으로 쓴다.
3. 환자 단위 5-fold 분할을 함께 기록한다(patient_groups.json 경유).

## 좌표 규약
치아 1..12 순서로 (p1, p2). index 빌드의 canonicalize는 (x,y) 사전식 정렬이라
치아가 세로로 서 있을 때(구치부) x가 거의 같아 정렬이 불안정하다 — 실측 29건에서
p2가 p1보다 위에 오는 역전이 나왔다. 학습 대상은 "왼쪽/오른쪽 끝점"이 아니라
고정된 슬롯이어야 하므로, 여기서 **아치 진행 방향 기준으로 재정렬**한다:
치아 1→12로 갈수록 커지는 축(=치아 중심들의 주성분 방향)에 투영해 작은 쪽을 p1로
둔다. 이렇게 하면 회전치·수직 치아에서도 슬롯 의미가 일관된다.

인접 치아 끝점이 정확히 공유되는 비율은 5.5%뿐이고 평균 간격은 55px(약 0.7mm)라
치아별 크롭이 아니라 아치 전체를 한 장으로 다루는 편이 맞다. 그래서 이미지 1장 =
어노테이션 1개(24 키포인트)로 내보낸다.

## 이미지 리사이즈
원본은 최대 6016x4016으로 학습에 그대로 쓰기엔 크다. --long-side로 긴 변을 줄이고
키포인트도 같은 배율로 옮긴다. 원본 대비 배율을 메타에 남겨 mm 환산 시 되돌릴 수
있게 한다. 리사이즈 정밀도는 실측 0.02px(중위 0.01px)로 무해하다.

## 프레임 밖 정답점
말단 치아(1번 p1 또는 12번 p2)가 사진 위쪽으로 잘려 y<0인 정답이 5개 있다. 이걸
0으로 클립하면 정답 위치가 최대 17px 이동한다. 히트맵 모델은 프레임 밖 좌표를
표현할 수 없으므로 클립은 불가피하다 — 대신 해당 점만 visibility=1(labeled but
occluded)로 낮춰 표시하고, 학습 시 손실에서 제외할 수 있게 한다. 클립하지 않은
원본 좌표는 keypointsUnclipped에 남긴다.
"""
from __future__ import annotations

import argparse
import base64
import glob
import hashlib
import io
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

LABEL_DIRS = [
    "01 치아 좌우폭 찍기 (유라쌤)",
    "02 치아 좌우폭 찍기(김원장님)",
    "03 치아 좌우폭 찍기(김원장님-클래스2)",
    "03 치아 좌우폭 찍기(유라쌤-클래스2)",
    "02 이퀼리브리엄 찍기(김원장님)",
    "02 교정 후 치아폭 찍기(김원장님)",
]

RE_DATA_URI = re.compile(r"data:image/(\w+);base64,([A-Za-z0-9+/=\s]+)")
KEYPOINT_NAMES = [f"T{n:02d}_{end}" for n in range(1, 13) for end in ("p1", "p2")]
# 같은 치아의 두 끝점을 잇는다 = 화면에 그릴 선분과 정확히 일치
SKELETON = [[2 * i + 1, 2 * i + 2] for i in range(12)]


def extract_images() -> dict[str, dict]:
    """md 파일에서 base64 JPEG를 꺼내 {imageSha256: {...}} 반환. 저장은 하지 않는다."""
    found: dict[str, dict] = {}
    for directory in LABEL_DIRS:
        for path in sorted(glob.glob(os.path.join(ROOT, directory, "*.md"))):
            text = Path(path).read_text(encoding="utf-8", errors="ignore")
            match = RE_DATA_URI.search(text)
            if not match:
                continue
            raw = base64.b64decode(re.sub(r"\s", "", match.group(2)))
            sha = hashlib.sha256(raw).hexdigest()
            if sha in found:
                continue
            found[sha] = {"bytes": raw, "mime": match.group(1)}
    return found


def full12_widths(case: dict) -> list[tuple[float, float, float, float]] | None:
    """치아 1..12의 (x1,y1,x2,y2) 픽셀 좌표. 여러 주석이 있으면 평균(합의)."""
    stacks: list[list[tuple[float, float, float, float]]] = []
    for annotation in case.get("expert", {}).get("widthAnnotations", []):
        teeth = (annotation.get("raw") or {}).get("toothWidthsPx") or []
        if len(teeth) != 12:
            continue
        try:
            ordered = sorted(teeth, key=lambda t: float(t["toothNo"]))
        except (KeyError, TypeError, ValueError):
            ordered = teeth
        row: list[tuple[float, float, float, float]] = []
        for tooth in ordered:
            p1, p2 = tooth.get("p1"), tooth.get("p2")
            if not (isinstance(p1, dict) and isinstance(p2, dict)):
                row = []
                break
            values = (p1.get("x"), p1.get("y"), p2.get("x"), p2.get("y"))
            if any(v is None or not math.isfinite(float(v)) for v in values):
                row = []
                break
            row.append(tuple(float(v) for v in values))
        if len(row) == 12:
            stacks.append(row)
    if not stacks:
        return None
    if len(stacks) == 1:
        return stacks[0]
    return [
        tuple(sum(stack[i][j] for stack in stacks) / len(stacks) for j in range(4))
        for i in range(12)
    ]


def orient_along_arch(
    widths: list[tuple[float, float, float, float]]
) -> tuple[list[tuple[float, float, float, float]], int]:
    """각 치아의 (p1,p2)를 아치 진행 방향 기준으로 정렬한다.

    사전식 (x,y) 정렬은 구치부처럼 치아가 세로로 선 경우 x가 거의 같아 y의 미세한
    차이로 순서가 뒤집힌다(실측 29건). 대신 치아 1→12 진행 방향 축에 투영해 작은
    쪽을 p1로 고정하면, 회전치에서도 "치아열을 따라 앞쪽 끝점"이라는 일관된 의미가
    유지된다.

    진행 방향 축은 치아 중심들의 첫 주성분으로 잡는다. 부호는 치아 1의 중심에서
    치아 12의 중심으로 향하도록 맞춘다.
    """
    centers = [((x1 + x2) / 2.0, (y1 + y2) / 2.0) for x1, y1, x2, y2 in widths]
    mean_x = sum(c[0] for c in centers) / len(centers)
    mean_y = sum(c[1] for c in centers) / len(centers)
    sxx = sum((c[0] - mean_x) ** 2 for c in centers)
    syy = sum((c[1] - mean_y) ** 2 for c in centers)
    sxy = sum((c[0] - mean_x) * (c[1] - mean_y) for c in centers)
    # 2x2 공분산의 주고유벡터를 닫힌형으로
    theta = 0.5 * math.atan2(2.0 * sxy, sxx - syy)
    axis = (math.cos(theta), math.sin(theta))
    forward = (centers[-1][0] - centers[0][0], centers[-1][1] - centers[0][1])
    if axis[0] * forward[0] + axis[1] * forward[1] < 0:
        axis = (-axis[0], -axis[1])

    oriented: list[tuple[float, float, float, float]] = []
    swaps = 0
    for x1, y1, x2, y2 in widths:
        if (x2 * axis[0] + y2 * axis[1]) < (x1 * axis[0] + y1 * axis[1]):
            oriented.append((x2, y2, x1, y1))
            swaps += 1
        else:
            oriented.append((x1, y1, x2, y2))
    return oriented, swaps


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=HERE / "dataset-index.json")
    parser.add_argument("--groups", type=Path, default=HERE / "patient_groups.json")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--long-side", type=int, default=1280,
                        help="긴 변 픽셀 목표. 0이면 원본 유지")
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20260729)
    parser.add_argument("--quality", type=int, default=95)
    args = parser.parse_args()

    index = json.loads(args.index.read_text(encoding="utf-8-sig"))
    groups = json.loads(args.groups.read_text(encoding="utf-8"))["assignments"]

    print("md 파일에서 원본 JPEG 추출 중...", flush=True)
    embedded = extract_images()
    print(f"  고유 이미지 {len(embedded)}개", flush=True)

    images_dir = args.out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    stats: Counter[str] = Counter()
    records: list[dict] = []
    for case in index["cases"]:
        widths = full12_widths(case)
        if widths is None:
            stats["skipped_no_full12_truth"] += 1
            continue
        image_meta = case.get("image") or {}
        sha = image_meta.get("sha256")
        blob = embedded.get(sha)
        if blob is None:
            stats["skipped_image_not_embedded"] += 1
            continue
        try:
            picture = Image.open(io.BytesIO(blob["bytes"]))
            picture = picture.convert("RGB")
        except Exception:
            stats["skipped_image_unreadable"] += 1
            continue
        source_w, source_h = picture.size
        if source_w != image_meta.get("widthPx") or source_h != image_meta.get("heightPx"):
            # 인덱스가 기록한 크기와 실제가 다르면 좌표계가 어긋난다 → 버린다
            stats["skipped_dimension_mismatch"] += 1
            continue

        scale = 1.0
        if args.long_side and max(source_w, source_h) > args.long_side:
            scale = args.long_side / max(source_w, source_h)
        target_w, target_h = round(source_w * scale), round(source_h * scale)
        if scale != 1.0:
            picture = picture.resize((target_w, target_h), Image.LANCZOS)

        cid = case["caseId"]
        stem = f"{cid}_{sha[:12]}"
        out_path = images_dir / f"{stem}.jpg"
        picture.save(out_path, "JPEG", quality=args.quality, subsampling=0)

        widths, swaps = orient_along_arch(widths)
        if swaps:
            stats["cases_with_endpoints_reoriented"] += 1
            stats["endpoints_reoriented"] += swaps

        keypoints: list[float] = []
        unclipped: list[float] = []
        xs: list[float] = []
        ys: list[float] = []
        clipped = 0
        for x1, y1, x2, y2 in widths:
            for x, y in ((x1, y1), (x2, y2)):
                sx, sy = x * scale, y * scale
                unclipped.extend((round(sx, 2), round(sy, 2)))
                outside = not (0 <= sx <= target_w and 0 <= sy <= target_h)
                if outside:
                    clipped += 1
                sx = min(max(sx, 0.0), float(target_w))
                sy = min(max(sy, 0.0), float(target_h))
                # 2 = labeled & visible, 1 = labeled but truncated by the frame
                keypoints.extend((round(sx, 2), round(sy, 2), 1 if outside else 2))
                xs.append(sx)
                ys.append(sy)
        if clipped:
            stats["cases_with_out_of_frame_points"] += 1
            stats["out_of_frame_points"] += clipped

        pad = 0.02 * max(target_w, target_h)
        bx1 = max(min(xs) - pad, 0.0)
        by1 = max(min(ys) - pad, 0.0)
        bx2 = min(max(xs) + pad, float(target_w))
        by2 = min(max(ys) + pad, float(target_h))

        info = groups.get(cid) or {}
        records.append({
            "caseId": cid,
            "fileName": out_path.name,
            "width": target_w,
            "height": target_h,
            "sourceWidth": source_w,
            "sourceHeight": source_h,
            "scaleFromSource": scale,
            "imageSha256": sha,
            "patientGroupId": info.get("patientGroupId") or f"case:{cid}",
            "patientProvenance": info.get("provenance") or "missing",
            "keypoints": keypoints,
            "keypointsUnclipped": unclipped,
            "bbox": [round(bx1, 2), round(by1, 2), round(bx2 - bx1, 2), round(by2 - by1, 2)],
        })
        stats["exported"] += 1

    if not records:
        raise SystemExit("내보낼 케이스가 없다")

    # 환자 단위 5-fold: 환자를 셔플해 라운드로빈으로 배분
    patients = sorted({r["patientGroupId"] for r in records})
    rng_state = args.seed
    order = []
    pool = list(patients)
    # 결정적 셔플 (numpy 없이도 재현 가능한 LCG)
    while pool:
        rng_state = (rng_state * 1103515245 + 12345) & 0x7FFFFFFF
        order.append(pool.pop(rng_state % len(pool)))
    fold_of = {p: i % args.folds for i, p in enumerate(order)}
    for record in records:
        record["fold"] = fold_of[record["patientGroupId"]]

    fold_sizes = Counter(r["fold"] for r in records)
    per_fold_patients = defaultdict(set)
    for record in records:
        per_fold_patients[record["fold"]].add(record["patientGroupId"])

    # COCO keypoints
    coco = {
        "info": {
            "description": "하악 교합면 치아폭 24 키포인트 (12치아 x 2끝점)",
            "version": "1.0",
            "splitPolicy": "patient_grouped_5fold",
            "seed": args.seed,
        },
        "licenses": [],
        "categories": [{
            "id": 1,
            "name": "mandibular_arch",
            "supercategory": "dentition",
            "keypoints": KEYPOINT_NAMES,
            "skeleton": SKELETON,
        }],
        "images": [],
        "annotations": [],
    }
    for i, record in enumerate(records, start=1):
        coco["images"].append({
            "id": i,
            "file_name": record["fileName"],
            "width": record["width"],
            "height": record["height"],
            "caseId": record["caseId"],
            "patientGroupId": record["patientGroupId"],
            "fold": record["fold"],
            "scaleFromSource": record["scaleFromSource"],
            "sourceWidth": record["sourceWidth"],
            "sourceHeight": record["sourceHeight"],
        })
        bbox = record["bbox"]
        coco["annotations"].append({
            "id": i,
            "image_id": i,
            "category_id": 1,
            "iscrowd": 0,
            "num_keypoints": sum(1 for j in range(2, 72, 3) if record["keypoints"][j] > 0),
            "keypoints": record["keypoints"],
            # 프레임 밖 정답을 클립 전 좌표로 보존(mm 환산·감사용). COCO 표준 필드가
            # 아니라 소비자는 무시해도 되고, 필요하면 손실 마스킹에 쓸 수 있다.
            "keypointsUnclipped": record["keypointsUnclipped"],
            "bbox": bbox,
            "area": round(bbox[2] * bbox[3], 2),
        })
    (args.out / "annotations_coco.json").write_text(
        json.dumps(coco, ensure_ascii=False) + "\n", encoding="utf-8")

    manifest = {
        "schemaVersion": "pixel-dataset-v1",
        "privacy": {
            "containsPatientNames": False,
            "note": "이미지는 환자 구강 사진이다. 파일명은 caseId+이미지해시로 이름을 담지 않는다.",
        },
        "counts": {
            "exportedImages": len(records),
            "keypointsPerImage": 24,
            "totalKeypoints": len(records) * 24,
            "uniquePatients": len(patients),
        },
        "stats": dict(sorted(stats.items())),
        "resize": {"longSide": args.long_side, "quality": args.quality},
        "folds": {
            "count": args.folds,
            "seed": args.seed,
            "imagesPerFold": {str(k): v for k, v in sorted(fold_sizes.items())},
            "patientsPerFold": {str(k): len(v) for k, v in sorted(per_fold_patients.items())},
            "patientOverlapBetweenFolds": sum(
                len(per_fold_patients[a] & per_fold_patients[b])
                for a in per_fold_patients for b in per_fold_patients if a < b
            ),
        },
    }
    (args.out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
