#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""픽셀 데이터셋의 fold 간 누출 5중 감사.

## 왜 5중인가
픽셀 모델은 환자 고유의 치아 형태를 외운다. 좌표 전용 KRR은 이 누출에 거의
면역이었지만(width -0.12%, patient_leak_impact.json) 픽셀 모델은 아니다. 그래서
"환자 ID가 같으면 같은 fold"만으로는 부족하고, 환자 ID 복원이 틀렸을 경우까지
잡아야 한다. 서로 독립적인 5가지 축으로 본다:

  1. 이미지 SHA-256 중복        — 같은 파일이 두 케이스로 들어왔는가
  2. 리사이즈 후 바이트 동일    — 다른 원본이 같은 이미지로 수렴했는가
  3. 환자 ID의 fold 일관성      — 복원한 환자 단위가 실제로 잠겼는가
  4. 정규화 키포인트 근접 일치  — 같은 촬영을 두 번 주석했는가(라벨 중복)
  5. 지각 해시 근접 중복        — SHA는 다르지만 사실상 같은 사진인가
                                  (재저장·크롭·미세 재촬영)

5번은 환자 ID 복원 실패까지 우회해서 잡는 유일한 검사다: 파일명 규약이 틀려
환자를 놓쳤더라도 사진이 닮았으면 걸린다.

출력에 PHI·좌표·파일 경로 없음.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
PHASH_SIZE = 32
NEAR_KEYPOINT_TOL = 0.01   # 정규화 좌표 평균 거리
PHASH_THRESHOLDS = (0.99, 0.97, 0.95, 0.90, 0.85, 0.80)
PHASH_ALERT = 0.95         # 이 이상이면 사실상 같은 사진으로 본다


def normalized_keypoints(keypoints: list[float]) -> list[tuple[float, float]]:
    """중심·스케일을 정규화한 24점. 촬영 배율·평행이동에 불변."""
    xy = [(keypoints[i], keypoints[i + 1]) for i in range(0, 72, 3)]
    cx = sum(p[0] for p in xy) / 24.0
    cy = sum(p[1] for p in xy) / 24.0
    span = max(math.hypot(p[0] - cx, p[1] - cy) for p in xy) or 1.0
    return [((p[0] - cx) / span, (p[1] - cy) / span) for p in xy]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=HERE / "pixel_dataset")
    parser.add_argument("--out", type=Path, default=HERE / "pixel_leak_audit.json")
    args = parser.parse_args()

    coco = json.loads((args.dataset / "annotations_coco.json").read_text(encoding="utf-8"))
    ann_by_image = {a["image_id"]: a for a in coco["annotations"]}
    images = coco["images"]

    rows = []
    for image in images:
        path = args.dataset / "images" / image["file_name"]
        blob = path.read_bytes()
        gray = np.asarray(
            Image.open(path).convert("L").resize((PHASH_SIZE, PHASH_SIZE), Image.BILINEAR),
            dtype=np.float32,
        )
        gray = (gray - gray.mean()) / (gray.std() + 1e-6)
        rows.append({
            "caseId": image["caseId"],
            "fold": image["fold"],
            "patient": image["patientGroupId"],
            "sourceSha": image["file_name"].rsplit("_", 1)[-1].removesuffix(".jpg"),
            "fileSha": hashlib.sha256(blob).hexdigest(),
            "phash": gray.ravel(),
            "keypoints": normalized_keypoints(ann_by_image[image["id"]]["keypoints"]),
        })

    def cross_fold_groups(key: str) -> list[list[str]]:
        buckets: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            buckets[row[key]].append(row)
        return [
            sorted(r["caseId"] for r in group)
            for group in buckets.values()
            if len(group) > 1 and len({r["fold"] for r in group}) > 1
        ]

    # 1~2: 해시 중복
    source_dup = cross_fold_groups("sourceSha")
    file_dup = cross_fold_groups("fileSha")

    # 3: 환자 ID 일관성
    patient_folds: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        patient_folds[row["patient"]].add(row["fold"])
    patient_split = sorted(p for p, folds in patient_folds.items() if len(folds) > 1)

    # 4: 키포인트 근접 일치
    keypoint_pairs = []
    for a, b in itertools.combinations(range(len(rows)), 2):
        ka, kb = rows[a]["keypoints"], rows[b]["keypoints"]
        distance = sum(math.hypot(ka[j][0] - kb[j][0], ka[j][1] - kb[j][1])
                       for j in range(24)) / 24.0
        if distance < NEAR_KEYPOINT_TOL:
            keypoint_pairs.append({
                "caseIds": sorted((rows[a]["caseId"], rows[b]["caseId"])),
                "sameFold": rows[a]["fold"] == rows[b]["fold"],
                "samePatient": rows[a]["patient"] == rows[b]["patient"],
                "meanDistance": round(distance, 5),
            })

    # 5: 지각 해시
    matrix = np.stack([row["phash"] for row in rows])
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    similarity = matrix @ matrix.T
    np.fill_diagonal(similarity, -1.0)
    sweep = {}
    for threshold in PHASH_THRESHOLDS:
        pairs = [(i, j) for i, j in zip(*np.where(similarity > threshold)) if i < j]
        sweep[str(threshold)] = {
            "pairs": len(pairs),
            "crossFold": sum(1 for i, j in pairs if rows[i]["fold"] != rows[j]["fold"]),
            "samePatient": sum(1 for i, j in pairs if rows[i]["patient"] == rows[j]["patient"]),
        }
    alert = [
        {
            "caseIds": sorted((rows[i]["caseId"], rows[j]["caseId"])),
            "similarity": round(float(similarity[i, j]), 4),
            "sameFold": rows[i]["fold"] == rows[j]["fold"],
            "samePatient": rows[i]["patient"] == rows[j]["patient"],
        }
        for i, j in ((i, j) for i, j in zip(*np.where(similarity > PHASH_ALERT)) if i < j)
    ]

    checks = {
        "sourceImageShaCrossFold": len(source_dup),
        "resizedFileShaCrossFold": len(file_dup),
        "patientsSplitAcrossFolds": len(patient_split),
        "nearIdenticalKeypointPairsCrossFold": sum(1 for p in keypoint_pairs if not p["sameFold"]),
        "perceptualNearDuplicateCrossFold": sum(1 for p in alert if not p["sameFold"]),
    }
    report = {
        "schemaVersion": "pixel-leak-audit-v1",
        "privacy": {"containsPhi": False, "containsPatientNames": False,
                    "containsFilePaths": False, "containsImageCoordinates": False},
        "images": len(rows),
        "uniquePatients": len(patient_folds),
        "checks": checks,
        "clean": all(value == 0 for value in checks.values()),
        "detail": {
            "sourceShaDuplicateGroups": source_dup,
            "resizedFileShaDuplicateGroups": file_dup,
            "patientsSplitAcrossFolds": patient_split,
            "nearIdenticalKeypointPairs": keypoint_pairs,
            "perceptualHash": {
                "maxSimilarity": round(float(similarity.max()), 4),
                "alertThreshold": PHASH_ALERT,
                "thresholdSweep": sweep,
                "alertPairs": alert,
            },
        },
        "interpretation": {
            "phashMaxBelowAlert": bool(float(similarity.max()) <= PHASH_ALERT),
            "note": ("지각 해시 최대 유사도가 경보선 아래면 SHA가 다른 '사실상 같은 사진'이 "
                     "없다는 뜻이다 — 환자 ID 복원이 틀렸어도 우회해서 잡는 검사다."),
            "samePatientPairsAreVisuallyDissimilar": (
                "같은 환자 쌍이 유사도 상위에 없는 것은 정상이다: 교정 전/후 사진이라 "
                "치열 배치가 실제로 다르다. 그래도 환자 단위로 같은 fold에 잠겨 있다."
            ),
        },
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "detail"},
                     ensure_ascii=False, indent=2))
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
