#!/usr/bin/env python3
"""노트 ⑫에 (h) 추가 — 측정 결과 패널도 정답을 표시한다(실측 확정).

어제 ⑫(f)에 "하단 상세 수치"에 대해 썼지만, 오른쪽 '측정 결과' 패널도 같은 전역
상태를 읽는다는 사실은 빠져 있었다. 그래서 같은 오해가 한 번 더 발생했다.
배지를 두 곳 다 붙였고, 이번에는 **패널을 명시**해서 기록한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

HEADER_OLD = """\
  // ⚠️ **화면 수치를 엔진 성능으로 읽기 전에 출처 배지를 볼 것**(⑫). `✔ 정답 확인`을
  //    누르면 정답 좌표가 측정값으로 들어가서 하단 상세 수치가 **정답과 완전히 같아진다**
  //    (자동분석 자체는 정답을 투영하지 않는다 — USE_TRUTH_LOOKUP=false).
"""

HEADER_NEW = """\
  // ⚠️ **화면 수치를 엔진 성능으로 읽기 전에 출처 배지를 볼 것**(⑫). `✔ 정답 확인`을
  //    누르면 정답 좌표가 측정값으로 들어가서 하단 상세 수치는 물론 **오른쪽 '측정 결과'
  //    패널(EZL·px/mm·TZL·차이)까지 정답과 완전히 같아진다**(⑫h, 실측 확정). 정답을
  //    표시하는 화면 영역은 **3곳**이다: 캔버스 정답 줄 / 상세 수치 / 측정 결과 패널.
  //    (자동분석 자체는 정답을 투영하지 않는다 — USE_TRUTH_LOOKUP=false).
"""

NOTE_ANCHOR = """\
  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e). 여력이 남은 곳은 위치
"""

NOTE_NEW = """\
  //    (h) ⭐️ **'측정 결과' 패널도 정답을 표시한다**(2026-07-29 추가 실측). (f)에서 하단
  //        상세 수치만 다뤘는데, 오른쪽 `측정 결과` 카드(EZL / px/mm / TZL / 공간 차이)도
  //        **같은 전역 상태**를 읽는다 — `calculateEZL()`이 `ezPoints`·`toothWidths`를
  //        읽고, `showTruth()`가 그 전역에 정답 좌표를 **써넣는다**. 그래서 이 패널은
  //        "자동분석 전용 표시"가 아니라 **현재 측정 상태의 표시**다. 실측:
  //          초안 적용 후 : EZL 92.7 / TZL 97.0  (정답과 EZL 1.8mm · TZL 1.3mm 차이)
  //          정답 확인 후 : EZL 94.5 / TZL 98.3  (정답과 **0.00mm** = 완전 동일)
  //          적용전 복원  : EZL 92.7 / TZL 97.0  (자동분석 값으로 정상 복귀)
  //        룩업 442건 전수 대조로도 확정했다 — 사용자가 본 조합(EZL 83.4 / TZL 87.9 /
  //        px/mm 51.76)은 **EZL·TZL·px/mm 3중 일치 정답이 정확히 1건**이었다(다른 441건은
  //        불일치). 즉 그 화면은 정답이었고 자동분석 값이 아니었다.
  //        → `updateMetricSourceBadge()`로 이 패널에도 출처 배지를 붙였고, 정답 표시 중
  //        일 때는 카드 테두리가 호박색이 된다. 검증 `_metric_panel_repro.mjs`(11/11),
  //        전수 대조 `_metric_panel_provenance.py`.
  //        ⚠️ 교훈: 정답이 전역 측정 상태로 들어가므로 **그 상태를 읽는 모든 표시 영역**이
  //        정답을 보여준다. 새 수치 표시를 추가하면 출처 배지도 같이 붙여야 한다.
  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e). 여력이 남은 곳은 위치
"""

REPLACEMENTS = [("header", HEADER_OLD, HEADER_NEW), ("note", NOTE_ANCHOR, NOTE_NEW)]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "(h) ⭐️ **'측정 결과' 패널" in text:
        raise SystemExit("note 12h already present")

    for name, old, new in REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{name}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")

    raw_after = RESEARCH.read_bytes()
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF")
    crlf = bytes([13, 10])
    if raw_after.count(crlf) <= raw_before.count(crlf):
        raise SystemExit("CRLF count did not grow")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    print(f"research html: {len(raw_before)} -> {len(raw_after)} bytes")
    print(f"crlf: {raw_before.count(crlf)} -> {raw_after.count(crlf)}")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
