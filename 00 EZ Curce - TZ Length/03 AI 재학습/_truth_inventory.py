#!/usr/bin/env python3
"""제공된 폭 정답 ~550건 중 몇 건이 실제로 학습에 들어갔고, 무엇이 버려졌나.

사용자 지적: "550장의 정답을 줬는데 정확도가 왜 안 올라가나."
학습 표본은 384건이다. 격차 ~166건이 어디서 사라졌는지 먼저 회계한다.
회계 없이 "정확도가 왜 안 오르나"를 논하면 안 된다.

세 층을 각각 센다.
  층1. 디스크의 라벨 md 파일 수 (폴더별)
  층2. dataset-index에 폭 주석으로 실린 케이스 수
  층3. 학습 표본(=규칙엔진 초안이 있고 24점 완전 라벨) 수

그리고 **같은 이미지를 두 폴더가 주석한 짝**을 찾는다. 짝이 있으면
"주석자 차이"와 "케이스 차이"를 같은 이미지 위에서 직접 가릴 수 있다
(케이스가 같으므로 남는 변수는 주석자 하나뿐).

원본 폴더는 읽기만 한다. 출력에 파일명·좌표·담당자명 없음(익명 코드).
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np

import train_residual as tr
from _cohort_scale_map import COHORT_CODES, case_cohorts, label_sha_to_cohort, needed_bias
from _px_decompose import dims_by_group, to_pixels

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent


def disk_counts() -> dict[str, dict]:
    """폴더별 md 파일 수와 그 SHA 목록."""
    out: dict[str, dict] = {}
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
        shas, empty = [], 0
        for entry in sorted(os.listdir(directory)):
            if not entry.lower().endswith(".md"):
                continue
            path = directory / entry
            if path.stat().st_size == 0:
                empty += 1
                continue
            shas.append(hashlib.sha256(path.read_bytes()).hexdigest())
        row = out.setdefault(code, {"mdFiles": 0, "emptyFiles": 0, "shas": []})
        row["mdFiles"] += len(shas) + empty
        row["emptyFiles"] += empty
        row["shas"].extend(shas)
    return out


def index_counts(dataset_path: Path, sha_to_cohort: dict[str, str]) -> dict:
    """dataset-index 기준: 라벨 SHA가 실렸는지, 케이스가 완전 라벨인지."""
    document = json.loads(dataset_path.read_text(encoding="utf-8"))
    seen_label_shas: set[str] = set()
    per_case = []
    for case in document["cases"]:
        group = case["splitGrouping"]["minimumGroupId"]
        codes: set[str] = set()
        points = 0
        for annotation in case["expert"]["widthAnnotations"]:
            for sha in annotation.get("sourceAnnotationSha256s") or []:
                seen_label_shas.add(sha)
                code = sha_to_cohort.get(sha)
                if code:
                    codes.add(code)
            points = max(points, len(annotation.get("points") or []))
        if codes or points:
            per_case.append({"group": group, "codes": codes, "points": points})
    return {"labelShasInIndex": seen_label_shas, "cases": per_case}


def main() -> None:
    dataset_path = HERE / "dataset-index.json"
    sha_to_cohort = label_sha_to_cohort()
    disk = disk_counts()
    idx = index_counts(dataset_path, sha_to_cohort)

    tasks, _ = tr.build_samples(dataset_path, HERE / "baseline_predictions_all.json")
    width = tasks["width"]
    trained_groups = set(width["groups"].tolist())

    # ── 층별 회계 ────────────────────────────────────────────────────────────
    index_cases_by_code: dict[str, set[str]] = {}
    trained_by_code: dict[str, set[str]] = {}
    for row in idx["cases"]:
        for code in row["codes"]:
            index_cases_by_code.setdefault(code, set()).add(row["group"])
            if row["group"] in trained_groups:
                trained_by_code.setdefault(code, set()).add(row["group"])

    ledger = {}
    for code in sorted(disk):
        shas = disk[code]["shas"]
        in_index = sum(1 for s in shas if s in idx["labelShasInIndex"])
        ledger[code] = {
            "mdFilesOnDisk": disk[code]["mdFiles"],
            "emptyFiles": disk[code]["emptyFiles"],
            "labelsReachingIndex": in_index,
            "labelsNotInIndex": len(shas) - in_index,
            "casesInIndex": len(index_cases_by_code.get(code, set())),
            "casesInTraining": len(trained_by_code.get(code, set())),
        }

    total_md = sum(v["mdFilesOnDisk"] for v in ledger.values())
    total_trained_union = len(
        set().union(*[trained_by_code.get(c, set()) for c in ledger]) if ledger else set())

    # ── 같은 이미지를 두 폴더가 주석한 짝 ──────────────────────────────────────
    cohorts = case_cohorts(dataset_path, sha_to_cohort)
    pair_counts: dict[str, int] = {}
    for codes in cohorts.values():
        if len(codes) < 2:
            continue
        for a in sorted(codes):
            for b in sorted(codes):
                if a < b:
                    pair_counts[f"{a}|{b}"] = pair_counts.get(f"{a}|{b}", 0) + 1

    # 짝 케이스에서 필요 폭 배율 — 같은 이미지이므로 남는 변수는 주석자뿐이다.
    dims = dims_by_group(dataset_path)
    groups = width["groups"]
    truth_px = to_pixels(width["target"].reshape(-1, 24, 2), groups, dims)
    base_px = to_pixels(width["baseline"].reshape(-1, 24, 2), groups, dims)
    ratios = needed_bias(base_px, truth_px)
    paired_ratios: dict[str, list[float]] = {}
    for ratio, sha in zip(ratios.tolist(), groups.tolist()):
        codes = cohorts.get(sha, set())
        if len(codes) >= 2:
            paired_ratios.setdefault("|".join(sorted(codes)), []).append(ratio)

    report = {
        "schemaVersion": "truth-inventory-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("제공된 폭 정답 md 파일이 dataset-index를 거쳐 학습 표본까지 "
                 "몇 건 살아남는지 층별 회계. 코호트는 라벨 md SHA-256으로 역추적하며 "
                 "산출물에는 익명 코드만 담는다."),
        "ledger": ledger,
        "totals": {
            "mdFilesOnDisk": total_md,
            "widthTrainingSamples": int(width["x"].shape[0]),
            "distinctCasesInTraining": len(trained_groups),
            "casesAttributableToCohorts": total_trained_union,
        },
        "sharedImages": {
            "pairCaseCounts": pair_counts,
            "neededBiasOnSharedImages": {
                key: {"cases": len(values),
                      "medianNeededBias": round(float(np.median(values)), 4)}
                for key, values in sorted(paired_ratios.items())
            },
        },
    }
    (HERE / "truth_inventory.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("layer accounting (md file -> index -> training):")
    header = f"{'cohort':14s} {'md':>4s} {'empty':>6s} {'inIdx':>6s} {'noIdx':>6s} {'cases':>6s} {'train':>6s}"
    print("   " + header)
    for code, row in ledger.items():
        print(f"   {code:14s} {row['mdFilesOnDisk']:4d} {row['emptyFiles']:6d} "
              f"{row['labelsReachingIndex']:6d} {row['labelsNotInIndex']:6d} "
              f"{row['casesInIndex']:6d} {row['casesInTraining']:6d}")
    print(f"\ntotal md on disk {total_md} | width training samples "
          f"{report['totals']['widthTrainingSamples']} | distinct cases {len(trained_groups)}")
    print("\nimages annotated by MORE THAN ONE folder:")
    for key, count in sorted(pair_counts.items(), key=lambda kv: -kv[1]):
        print(f"   {key:32s} {count:4d} cases")
    print("\nneeded width bias on shared images (same image = annotator is the only variable):")
    for key, row in sorted(paired_ratios.items()):
        print(f"   {key:32s} n={len(row):3d}  median {np.median(row):.4f}")


if __name__ == "__main__":
    main()
