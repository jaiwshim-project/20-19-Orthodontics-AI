#!/usr/bin/env python3
"""정답 스트립이 안 보이는 원인 실측 — TRUTH_LOOKUP 커버리지 회계.

관찰: "화면에 자동 분석 수치만 보이고 정답 수치는 안 보인다."
검증에서는 정답 줄이 떴으므로(10/10) 기능 자체는 동작한다. 그러면 남는 원인은
**그 사진이 룩업에 없다**는 것이다. 가정하지 말고 층별로 센다.

  A. TRUTH_LOOKUP 항목 수와 그 구성(ezPoints·toothWidths 개수)
  B. dataset-index 기준 정답 보유 케이스 수 — 폭 정답 / EZ 정답 각각
  C. 디스크 이미지 중 룩업에 있는 것 / 폭 정답은 있는데 룩업에 없는 것
  D. 폴더별로 룩업 도달률 — 어느 폴더 사진을 열면 정답이 뜨는가

출력에 파일명·경로·SHA·좌표·담당자명 없음. 폴더는 익명 코드로 표기한다.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
RESEARCH = PROJECT / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
DATASET = HERE / "dataset-index.json"

# 라벨 폴더 → 익명 코호트 코드(출력에 폴더명·담당자명을 쓰지 않기 위해)
# ⚠️ 이전 판은 폴더명 **전체 접두사**로 매칭해서 전부 "other"로 떨어졌다(집계가 무의미).
#    폴더명에는 담당자·클래스 표기가 붙어 있어 접두사가 어긋난다. 키워드 포함으로 판정한다.
# ⚠️ **라벨 폴더명이 아니라 이미지 폴더명**으로 맞춰야 한다. 실측 결과 디스크의 사진은
#    3곳에만 있다: 사진 모음(568) / 교정 후 사진만(114) / 프로젝트 루트(119).
COHORT_KEYWORDS = (
    ("교정 후 사진", "B_postortho_photos"),
    ("사진 모음", "A_photo_pool"),
)


def cohort_for(path: Path) -> str:
    parts = path.relative_to(PROJECT).parts
    for keyword, code in COHORT_KEYWORDS:
        if any(keyword in part for part in parts):
            return code
    return "C_project_root" if len(parts) == 1 else "other"


def truth_lookup() -> dict:
    text = RESEARCH.read_text(encoding="utf-8")
    marker = "window.TRUTH_LOOKUP="
    start = text.index(marker) + len(marker)
    end = text.index("\n", start)
    return json.loads(re.sub(r";\s*$", "", text[start:end]))


def walk_images() -> list[Path]:
    found = []
    for path in PROJECT.rglob("*"):
        if path.is_dir():
            continue
        if path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        if "node_modules" in path.parts or any(p.startswith(".") for p in path.parts):
            continue
        found.append(path)
    return found


def main() -> None:
    lookup = truth_lookup()
    ez_counts = [len(rec.get("ezPoints") or []) for rec in lookup.values()]
    width_counts = [len(rec.get("toothWidths") or []) for rec in lookup.values()]

    document = json.loads(DATASET.read_text(encoding="utf-8"))
    cases = document["cases"]
    has_width = sum(1 for c in cases if (c.get("expert", {}).get("widthAnnotations") or []))
    has_ez = sum(1 for c in cases if (c.get("expert", {}).get("ezAnnotations") or []))
    has_both = sum(1 for c in cases
                   if (c.get("expert", {}).get("widthAnnotations") or [])
                   and (c.get("expert", {}).get("ezAnnotations") or []))

    # 디스크 이미지 SHA → 룩업 존재 여부, 폴더별 집계
    per_cohort: dict[str, dict[str, int]] = {}
    total_images = 0
    in_lookup = 0
    for path in walk_images():
        try:
            sha = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            continue
        total_images += 1
        code = cohort_for(path)
        row = per_cohort.setdefault(code, {"images": 0, "inLookup": 0})
        row["images"] += 1
        if sha in lookup:
            row["inLookup"] += 1
            in_lookup += 1

    report = {
        "schemaVersion": "truth-strip-coverage-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("정답 스트립 커버리지 회계. TRUTH_LOOKUP은 이미지 SHA-256 키로만 조회되므로, "
                 "룩업에 없는 사진에서는 정답 줄이 뜨지 않는다. 폴더는 익명 코드로 표기."),
        "truthLookup": {
            "entries": len(lookup),
            "ezPointsMin": min(ez_counts), "ezPointsMax": max(ez_counts),
            "toothWidthsMin": min(width_counts), "toothWidthsMax": max(width_counts),
            "entriesWithTwelveWidths": sum(1 for n in width_counts if n == 12),
        },
        "datasetIndex": {
            "cases": len(cases),
            "casesWithWidthTruth": has_width,
            "casesWithEzTruth": has_ez,
            "casesWithBoth": has_both,
        },
        "diskImages": {
            "scanned": total_images,
            "matchedInLookup": in_lookup,
            "matchRatePercent": round(in_lookup / max(total_images, 1) * 100, 1),
        },
        "perCohort": {code: {**row,
                             "coveragePercent": round(row["inLookup"] / max(row["images"], 1) * 100, 1)}
                      for code, row in sorted(per_cohort.items())},
    }
    (HERE / "truth_strip_coverage.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"TRUTH_LOOKUP entries: {len(lookup)}")
    print(f"  ezPoints {min(ez_counts)}~{max(ez_counts)} / toothWidths {min(width_counts)}~{max(width_counts)}")
    print(f"dataset-index: cases {len(cases)}  width정답 {has_width}  EZ정답 {has_ez}  둘다 {has_both}")
    print(f"disk images scanned {total_images}, matched in lookup {in_lookup} "
          f"({report['diskImages']['matchRatePercent']}%)")
    print("per cohort (익명 코드):")
    for code, row in report["perCohort"].items():
        print(f"   {code:14s} images {row['images']:4d}  inLookup {row['inLookup']:4d}  "
              f"{row['coveragePercent']:5.1f}%")


if __name__ == "__main__":
    main()
