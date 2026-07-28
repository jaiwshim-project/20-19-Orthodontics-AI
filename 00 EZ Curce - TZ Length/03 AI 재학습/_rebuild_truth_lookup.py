#!/usr/bin/env python3
"""연구용 HTML의 `window.TRUTH_LOOKUP` 재생성 — 113건 → 폭 정답 전수.

관찰: "화면에 자동 분석 수치만 보이고 정답 수치는 안 보인다."
실측(_truth_strip_coverage.py): 룩업 113건 / 디스크 이미지 801장 중 매칭 59장(7.4%).
원인은 기능 버그가 아니라 **커버리지**다. 기존 룩업은 폭·EZ 정답을 **둘 다** 가진
케이스(113건)만 담고 있었는데, 폭 12개 완전 정답은 **384 케이스**나 있다.

여기서 하는 일
  · dataset-index.json에서 케이스별로 폭 주석 + EZ 주석을 **이미지 SHA-256 동일**
    기준으로 합쳐 한 레코드로 만든다(파일 번호 매칭 금지 — dataset-index는 이미
    case 단위로 exact SHA 매칭이 끝나 있고 imageSha256ExactMatch=True를 재확인한다).
  · 폭 정답만 있고 EZ 정답이 없는 케이스도 넣는다. 이 경우 EZL은 계산 불가이므로
    UI에서 `-`로 표시되고 TZL만 보인다(스케일은 폭 최외곽 스팬 = 54 mm).
  · 좌표는 **원본 이미지 픽셀**(기존 룩업과 동일 규약 — 112/112 케이스에서 배율 1.0 확인).
  · 치아 번호(`toothNo`)를 레코드에 보존한다. 캔버스 정답 줄에 치아별 길이를
    번호와 함께 표기해야 하기 때문이다(1~12, 결손 번호가 있으면 그대로 드러남).

주석이 여러 판 있는 경우(64케이스는 2판, 1케이스는 3판) **12개 완전판 우선 →
좌표 이상 플래그 없는 것 우선 → 첫 번째** 순으로 하나를 고른다. 정답끼리도
TZL이 5% 차이 나므로(도달 상한) 어느 판을 골랐는지 리포트에 판수만 익명 집계한다.

`id`는 기존 룩업과 같은 자리에 두되 **caseId(연속번호 001…)** 를 쓴다. 환자
식별자·파일명·담당자명이 아니다. (기존 룩업 id는 원본 파일 번호 문자열이었다.)

HTML은 CRLF. 룩업은 한 줄짜리 `window.TRUTH_LOOKUP={...};` 이므로 그 줄만
바이트 단위로 교체하고, 쓰기 후 CRLF 수 유지와 \r\r\n 부재를 확인한다.
운영 HTML은 SHA만 확인한다(절대 수정 금지).

출력 리포트에 파일명·경로·SHA·좌표·담당자명 없음.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
RESEARCH = PROJECT / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = PROJECT / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"
DATASET = HERE / "dataset-index.json"
MARKER = b"window.TRUTH_LOOKUP="
SCALE_MM = 54.0

BAD_COORD_FLAG = "coordinate_outside_image_bounds"


def pick_annotation(annotations: list[dict], key: str) -> dict | None:
    """여러 판 중 하나 선택: 12개 완전판 → 좌표 이상 없음 → 먼저 나온 것."""
    usable = [a for a in annotations
              if a.get("imageSha256ExactMatch") and (a.get("raw") or {}).get(key)]
    if not usable:
        return None

    def rank(annotation: dict) -> tuple[int, int]:
        complete = (annotation.get("completeness") or {})
        full = complete.get("toothWidths12" if key == "toothWidthsPx" else "ezPoints12")
        flags = annotation.get("qualityFlags") or []
        return (0 if full else 1, 1 if BAD_COORD_FLAG in flags else 0)

    return sorted(usable, key=rank)[0]


def outer_span(points: list[dict]) -> float:
    best = 0.0
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            d = math.hypot(points[i]["x"] - points[j]["x"], points[i]["y"] - points[j]["y"])
            if d > best:
                best = d
    return best


def build() -> tuple[dict, dict]:
    document = json.loads(DATASET.read_text(encoding="utf-8"))
    lookup: dict[str, dict] = {}
    stats = {"cases": 0, "widthOnly": 0, "widthAndEz": 0, "ezOnly": 0,
             "skippedNoTruth": 0, "skippedWidthTooFew": 0,
             "multiVersionWidthCases": 0, "incompleteWidthKept": 0,
             "toothNoCoverage": {}}

    for case in document["cases"]:
        stats["cases"] += 1
        expert = case.get("expert") or {}
        width_annotation = pick_annotation(expert.get("widthAnnotations") or [], "toothWidthsPx")
        ez_annotation = pick_annotation(expert.get("ezAnnotations") or [], "ezPointsPx")
        if not width_annotation and not ez_annotation:
            stats["skippedNoTruth"] += 1
            continue
        if len(expert.get("widthAnnotations") or []) > 1:
            stats["multiVersionWidthCases"] += 1

        widths = []
        if width_annotation:
            raw = width_annotation["raw"]["toothWidthsPx"]
            ordered = sorted(raw, key=lambda w: int(w.get("toothNo") or 0))
            widths = [{"toothNo": int(w["toothNo"]) if w.get("toothNo") else None,
                       "p1": {"x": w["p1"]["x"], "y": w["p1"]["y"]},
                       "p2": {"x": w["p2"]["x"], "y": w["p2"]["y"]}} for w in ordered]
            if len(widths) < 12:
                stats["incompleteWidthKept"] += 1

        ez_points = []
        if ez_annotation:
            ez_points = [{"x": p["x"], "y": p["y"]} for p in ez_annotation["raw"]["ezPointsPx"]]

        # 폭이 1개뿐이면 스케일 기준(최외곽 스팬)이 정의되지 않아 mm 환산이 불가능하다.
        if widths and len(widths) < 2 and not ez_points:
            stats["skippedWidthTooFew"] += 1
            continue
        if not widths and len(ez_points) < 2:
            stats["skippedNoTruth"] += 1
            continue

        # scaleReference: EZ 정답이 있으면 EZ 현(기존 규약 그대로), 없으면 폭 최외곽 스팬.
        if len(ez_points) >= 2:
            scale_px = math.hypot(ez_points[-1]["x"] - ez_points[0]["x"],
                                  ez_points[-1]["y"] - ez_points[0]["y"])
            scale_ref = "ezChord"
        else:
            scale_px = outer_span([p for w in widths for p in (w["p1"], w["p2"])])
            scale_ref = "widthOuterSpan"
        if scale_px <= 0:
            stats["skippedNoTruth"] += 1
            continue

        record = {"id": str(case["caseId"]), "ezPoints": ez_points, "toothWidths": widths,
                  "scaleRef": scale_ref, "scalePx": round(scale_px, 2)}
        lookup[case["image"]["sha256"]] = record

        if widths and ez_points:
            stats["widthAndEz"] += 1
        elif widths:
            stats["widthOnly"] += 1
        else:
            stats["ezOnly"] += 1
        for w in widths:
            key = str(w["toothNo"])
            stats["toothNoCoverage"][key] = stats["toothNoCoverage"].get(key, 0) + 1

    return lookup, stats


def embed(lookup: dict) -> tuple[int, int]:
    raw = RESEARCH.read_bytes()
    start = raw.index(MARKER)
    end = raw.index(b"\n", start)
    line_end = end - 1 if raw[end - 1:end] == b"\r" else end
    payload = (MARKER + json.dumps(lookup, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
               + b";")
    updated = raw[:start] + payload + raw[line_end:]

    crlf_before = raw.count(b"\r\n")
    RESEARCH.write_bytes(updated)
    after = RESEARCH.read_bytes()
    if b"\r\r\n" in after:
        raise SystemExit("found CR CR LF - line endings mangled")
    if after.count(b"\r\n") != crlf_before:
        raise SystemExit(f"CRLF count changed {crlf_before} -> {after.count(chr(13).encode()+chr(10).encode())}")
    if after.count(MARKER) != 1:
        raise SystemExit("TRUTH_LOOKUP marker count != 1")
    return len(raw), len(after)


def main() -> None:
    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - refusing to run")

    old_raw = RESEARCH.read_bytes()
    old_start = old_raw.index(MARKER) + len(MARKER)
    old_end = old_raw.index(b"\n", old_start)
    old_lookup = json.loads(old_raw[old_start:old_end].decode("utf-8").rstrip().rstrip(";"))

    lookup, stats = build()
    kept_old = sum(1 for sha in old_lookup if sha in lookup)
    if kept_old != len(old_lookup):
        raise SystemExit(f"regression: only {kept_old}/{len(old_lookup)} old entries survive")

    before, after = embed(lookup)

    report = {
        "schemaVersion": "truth-lookup-rebuild-v1",
        "privacy": {"containsPhi": False, "containsCaseIdentifiers": False,
                    "containsFilePaths": False, "containsImageCoordinates": False,
                    "containsFileNames": False, "containsAnnotatorNames": False},
        "note": ("정답 룩업 재생성. 폭·EZ 정답을 이미지 SHA-256 동일 기준으로만 합쳤고, "
                 "폭 정답만 있는 케이스도 포함한다(EZL은 UI에서 '-'). 좌표는 원본 이미지 픽셀."),
        "entries": {"before": len(old_lookup), "after": len(lookup),
                    "oldEntriesRetained": kept_old},
        "composition": {k: v for k, v in stats.items() if k != "toothNoCoverage"},
        "toothNoCoverage": dict(sorted(stats["toothNoCoverage"].items(),
                                       key=lambda kv: int(kv[0]) if kv[0].isdigit() else 99)),
        "htmlBytes": {"before": before, "after": after},
        "productionShaUnchanged": True,
    }
    (HERE / "truth_lookup_rebuild.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"lookup entries: {len(old_lookup)} -> {len(lookup)}  (old retained {kept_old})")
    print(f"  widthAndEz {stats['widthAndEz']}  widthOnly {stats['widthOnly']}  ezOnly {stats['ezOnly']}")
    print(f"  skipped: noTruth {stats['skippedNoTruth']}  widthTooFew {stats['skippedWidthTooFew']}")
    print(f"  incomplete width kept {stats['incompleteWidthKept']}  multi-version width cases {stats['multiVersionWidthCases']}")
    print(f"research html: {before} -> {after} bytes")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
