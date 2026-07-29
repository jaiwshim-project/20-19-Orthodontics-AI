#!/usr/bin/env python3
"""캔버스 범례 배율 조정 — LEGEND_SCALE 1.4 → 0.98.

경위: 세션 시작 시 0.7 → "2배로 키워" → 1.4 → "70%로 만들어" → 0.98.

⚠️ "70%"의 기준을 **직전 크기(1.4)**로 해석했다. 근거: 원래 값이 이미 0.7이었으므로
   절대 0.7을 뜻했다면 요청이 무의미(no-op)해진다. 따라서 1.4 × 0.7 = 0.98.
   결과적으로 세션 시작(0.7) 대비 **1.4배**다. 단순 원복을 원하면 0.7로 바꾸면 된다.

박스 원본 220x118 → 렌더 215.6x115.6 px.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

SESSION_START_SCALE = 0.7
NEW_SCALE = 0.98

OLD = """\
  // 캔버스 범례 배율. 박스 원본 220x118px이므로 렌더 크기 = 220*S x 118*S.
  // 1.4 = 구 0.7의 2배(사용자 요청). 좁은 캔버스에서 잘리지 않는지는
  // _legend_size_verify.mjs가 실제 캔버스 폭과 대조해 검증한다.
  const LEGEND_SCALE = 1.4;
"""

NEW = """\
  // 캔버스 범례 배율. 박스 원본 220x118px이므로 렌더 크기 = 220*S x 118*S.
  // 변경 경위: 0.7 → (2배 요청) 1.4 → (70% 요청) **0.98**. 세션 시작 대비 1.4배.
  // ⚠️ "70%"의 기준은 직전 크기(1.4)다. 원래 값이 이미 0.7이었으므로 절대 0.7로 읽으면
  //    요청이 no-op가 된다. 좁은 캔버스에서 잘리지 않는지는 _legend_size_verify.mjs가
  //    실제 캔버스 폭과 대조해 검증한다(414 모바일 포함).
  const LEGEND_SCALE = 0.98;
"""

HEADLINE_OLD = "    // 범례 (140% — 구 70%의 2배. 박스 220x118 → 렌더 308x165.2)\n"
HEADLINE_NEW = "    // 범례 (98% — 박스 220x118 → 렌더 215.6x115.6)\n"

REPLACEMENTS = [("scaleConst", OLD, NEW), ("headline", HEADLINE_OLD, HEADLINE_NEW)]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    for name, old, new in REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{name}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")

    raw_after = RESEARCH.read_bytes()
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF")
    if b"LEGEND_SCALE = 1.4" in raw_after:
        raise SystemExit("old 1.4 scale still present")
    if raw_after.count(b"LEGEND_SCALE") != 3:
        raise SystemExit(f"unexpected LEGEND_SCALE occurrences: {raw_after.count(b'LEGEND_SCALE')}")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    crlf = bytes([13, 10])
    print(f"research html: {len(raw_before)} -> {len(raw_after)} bytes")
    print(f"crlf: {raw_before.count(crlf)} -> {raw_after.count(crlf)}")
    print(f"LEGEND_SCALE 1.4 -> {NEW_SCALE}"
          f"  (직전의 {NEW_SCALE / 1.4:.0%}, 세션 시작 {SESSION_START_SCALE} 대비 "
          f"{NEW_SCALE / SESSION_START_SCALE:.2f}배)")
    print(f"legend render size: 308.0 x 165.2 -> {220 * NEW_SCALE:.1f} x {118 * NEW_SCALE:.1f} px")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
