#!/usr/bin/env python3
"""캔버스 범례 크기 2배 — ctx.scale(0.7) → ctx.scale(1.4).

범례는 캔버스에 그리므로 CSS가 아니라 렌더 코드의 스케일 한 곳으로 제어된다.
박스 원본 220x118 → 렌더 크기 154x82.6에서 **308x165.2**로 정확히 2배가 된다.
좌표·폰트를 개별로 만지면 비율이 깨지므로 scale만 바꾼다.

⚠️ 캔버스 폭을 넘으면 범례가 잘린다. 가장 좁은 조건(414 모바일, aspect-ratio 1)에서
   실제 캔버스 크기와 대조하는 검증은 `_legend_size_verify.mjs`가 맡는다.

HTML은 CRLF. 교체 문자열은 LF로 쓰고, 쓰기 후 \r\r\n 부재를 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

OLD = """\
    // 범례 (70% 축소)
    if (layers.legend) {
      const lx = 10, ly = 10;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.scale(0.7, 0.7);
"""

NEW = """\
    // 범례 (140% — 구 70%의 2배. 박스 220x118 → 렌더 308x165.2)
    // ⚠️ 좌표·폰트를 개별로 키우면 비율이 깨진다. **이 scale 한 곳만** 바꿀 것.
    if (layers.legend) {
      const lx = 10, ly = 10;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.scale(LEGEND_SCALE, LEGEND_SCALE);
"""

# 스케일을 상수로 빼서 다음에 조정할 때 찾기 쉽게 한다.
ANCHOR_OLD = """\
  const layers = { grid: true, toothNum: true, ezCurve: true, toothWidth: true, legend: true };
"""

ANCHOR_NEW = """\
  const layers = { grid: true, toothNum: true, ezCurve: true, toothWidth: true, legend: true };
  // 캔버스 범례 배율. 박스 원본 220x118px이므로 렌더 크기 = 220*S x 118*S.
  // 1.4 = 구 0.7의 2배(사용자 요청). 좁은 캔버스에서 잘리지 않는지는
  // _legend_size_verify.mjs가 실제 캔버스 폭과 대조해 검증한다.
  const LEGEND_SCALE = 1.4;
"""

REPLACEMENTS = [("legendScaleConst", ANCHOR_OLD, ANCHOR_NEW), ("legendScaleUse", OLD, NEW)]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "LEGEND_SCALE" in text:
        raise SystemExit("legend scale constant already present")

    for name, old, new in REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{name}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")

    raw_after = RESEARCH.read_bytes()
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF")
    if b"ctx.scale(0.7, 0.7)" in raw_after:
        raise SystemExit("old 0.7 scale still present")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    crlf = bytes([13, 10])
    print(f"research html: {len(raw_before)} -> {len(raw_after)} bytes")
    print(f"crlf: {raw_before.count(crlf)} -> {raw_after.count(crlf)}")
    print("legend render size: 154.0 x 82.6 -> 308.0 x 165.2 px (2.0x)")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
