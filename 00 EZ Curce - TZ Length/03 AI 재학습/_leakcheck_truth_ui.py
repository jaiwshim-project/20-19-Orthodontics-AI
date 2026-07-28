#!/usr/bin/env python3
"""이번 작업 산출물 PHI·식별자 누출 점검.

검사 대상: truth_lookup_rebuild.json / truth_strip_coverage.json /
truth_strip_repro.json / truth_strip_repro_prev.json / detail_provenance.json /
truth_strip_viewports.json

금지: 환자명·파일명·경로·이미지 SHA·좌표·담당자명. 코호트는 익명 코드만.
폭 길이(mm)는 좌표가 아닌 파생 계측값이므로 허용한다.
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = Path(__file__).resolve().parent
TARGETS = [
    "truth_lookup_rebuild.json", "truth_strip_coverage.json", "truth_strip_repro.json",
    "truth_strip_repro_prev.json", "detail_provenance.json", "truth_strip_viewports.json",
]

PATTERNS = [
    ("64-hex sha", re.compile(r"\b[0-9a-f]{64}\b")),
    ("windows path", re.compile(r"[A-Za-z]:\\")),
    ("image filename", re.compile(r"\.(jpe?g|png|webp)\b", re.I)),
    ("annotator honorific", re.compile(r"원장|선생|김[가-힣]{2}\b")),
    ("pixel coordinate object", re.compile(r'"(p1|p2|ezPointsPx|toothWidthsPx)"')),
]

ALLOWED_PRIVACY_KEYS = {"containsPhi", "containsCaseIdentifiers", "containsFilePaths",
                        "containsImageCoordinates", "containsFileNames", "containsAnnotatorNames"}


def main() -> None:
    problems: list[str] = []
    for name in TARGETS:
        path = HERE / name
        if not path.exists():
            problems.append(f"{name}: 파일 없음")
            continue
        text = path.read_text(encoding="utf-8")
        document = json.loads(text)
        privacy = document.get("privacy") or {}
        missing = ALLOWED_PRIVACY_KEYS - set(privacy)
        if missing:
            problems.append(f"{name}: privacy 키 누락 {sorted(missing)}")
        for key, value in privacy.items():
            if value is not False:
                problems.append(f"{name}: privacy.{key} != false")
        for label, pattern in PATTERNS:
            hits = pattern.findall(text)
            if hits:
                problems.append(f"{name}: {label} {len(hits)}건 발견")
        print(f"{name:32s} {len(text):7d} bytes  검사 완료")

    print("문제:", problems if problems else "없음")
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
