#!/usr/bin/env python3
"""conversation.md 섹션 40 추가 — '측정 결과' 패널도 정답을 표시한다(실측 확정).

CRLF 안전: 본문을 LF로 쓰고 CRLF로 변환해 바이트 단위로 append한다.
"""
from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

HERE = Path(__file__).resolve().parent
CONVERSATION = HERE.parent / "conversation.md"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

SECTION = """
---

# 40. "측정 결과 수치가 정답 같다" → 정답이 맞다 (2026-07-29)

## 40-1. 지적과 결론

화면에서 읽은 값: **EZL 83.4 / px/mm 51.76 / 좌표 12·12·12 / TZL 87.9 / 차이 -4.5**.
"측정 결과가 맞니, 아니면 정답이니? 왼쪽에 보이는 정답과 같은 수치로 보인다."

**정답이다.** 자동 분석 값이 아니다. 두 방향으로 확정했다.

## 40-2. 구조적 원인 — 이 패널은 '자동분석 전용'이 아니다

| 함수 | 하는 일 |
|---|---|
| `calculateEZL()` | 측정 결과 패널(EZL·px/mm·TZL·차이)을 갱신. **전역** `ezPoints`·`toothWidths`를 읽는다 |
| `applyAutoDraft()` | 자동 초안 좌표를 그 전역에 써넣고 `calculateEZL()` 호출 |
| `showTruth()` | **정답 좌표를 그 전역에 써넣고** `calculateEZL()` 호출 |

즉 측정 결과 패널은 "자동분석 결과 표시"가 아니라 **현재 측정 상태의 표시**다.
`✔ 정답 확인`을 누르면 정답이 측정 상태가 되므로 이 패널도 정답을 보여준다.

섹션 39-5에서 하단 상세 수치에는 출처 배지를 붙였지만, **이 패널에는 붙이지 않았다.**
그래서 같은 오해가 한 번 더 발생했다. 정답이 들어가는 표시 영역은 **3곳**이다:
캔버스 정답 줄 / 하단 상세 수치 / 오른쪽 측정 결과 패널.

## 40-3. 실측 ① — 룩업 442건 전수 대조

`_metric_panel_provenance.py`: 화면 조합과 442건 정답을 앱과 동일한 식으로 대조했다
(px/mm = EZ 양 끝점 거리 / 54, EZL = 치아 점유 호 구간 보정, Catmull-Rom 25분할).

| 대조 항목 | 일치 건수 |
|---|---|
| 정답 TZL = 87.9 (±0.05mm) | 1 |
| 정답 px/mm = 51.76 (±0.005) | 1 |
| 정답 보정EZL = 83.4 (±0.05mm) | 1 |
| **EZL·TZL·px/mm 3중 일치** | **1** |

일치한 그 1건: 보정EZL **83.36** / TZL **87.88** / 차이 **-4.52** / px/mm **51.76**
(EZ 12점, 폭 12개). 나머지 441건은 불일치. 우연히 세 값이 동시에 맞을 수 없다 —
**화면 수치는 그 정답 레코드다.**

참고로 같은 케이스의 EZ 곡선 **전체** 길이는 88.44mm다. 화면의 83.4는 보정값
(치아 사이 간격 제외)이므로, 보정 알고리즘까지 앱과 같아야 일치한다 — 맞았다.

## 40-4. 실측 ② — 3단계 실구동

`_metric_panel_repro.mjs` (EZ 정답까지 있는 케이스, 독립 계산 정답 EZL 94.5 / TZL 98.3):

| 단계 | EZL | px/mm | TZL | 차이 | 배지 | 정답과의 차 |
|---|---|---|---|---|---|---|
| 초안 적용 후 | 92.7 | 48.48 | 97.0 | -4.3 | 자동 분석 결과 | EZL **1.8** / TZL **1.3** mm |
| `✔ 정답 확인` 후 | 94.5 | 48.44 | 98.3 | -3.8 | 전문가 정답 표시 중 | **0.00 / 0.00 mm** |
| 적용 전 복원 후 | 92.7 | 48.48 | 97.0 | -4.3 | 자동 분석 결과 | 자동값으로 정상 복귀 |

**자동분석은 정답을 투영하지 않는다**(1.3~1.8mm 차이, `USE_TRUTH_LOOKUP=false`).
**정답 확인 후에는 완전히 같다**(0.00mm). 복원하면 정답이 상태에 남지 않고 되돌아간다.
검사 11/11 통과.

## 40-5. 수정 — 측정 결과 패널에도 출처 배지

`updateMetricSourceBadge()`를 추가해 `calculateEZL()` 최상단에서 호출한다
(패널을 갱신하는 유일한 지점이므로 누락이 불가능하다).

- 제목 옆 배지: `전문가 정답 표시 중` / `자동 분석 결과` / `수동 입력` / `데이터 없음`
- 정답 표시 중이면 **카드 테두리가 호박색**으로 바뀐다(`data-metric-source="truth"`)
- 하단 상세 수치 배지와 같은 규칙 — 두 배지가 어긋나지 않음을 검사로 고정했다
  (`metricBadgeAgreesWithDetailBadge`)

## 40-6. 변경 이유 / 검증 결과 / 남은 리스크

**변경 이유.** 정답이 전역 측정 상태로 들어가므로 **그 상태를 읽는 모든 표시 영역**이
정답을 보여준다. 섹션 39에서 상세 수치만 표시했더니 측정 결과 패널에서 같은 오해가
재발했다. 수치를 보고 엔진 성능을 판단하는 화면이므로 출처 표기는 선택이 아니다.

**검증 결과.**
- 룩업 442건 전수 대조: EZL·TZL·px/mm **3중 일치 1건** → 화면 수치는 정답 확정
- 실구동 3단계: 초안 적용 후 정답과 1.3~1.8mm 차이(**누출 없음**), 정답 확인 후 0.00mm,
  복원 시 자동값 복귀 — 검사 11/11 통과
- 임베드 엔진 파리티 8.687e-15, 3단계 유지(width 384 / ez 113 / widthBias 1.013)
- 산출물 8종 PHI 스캔 통과
- 운영 HTML SHA `6ee35113…` / 89,330 바이트 불변

**남은 리스크.**
- 앞으로 수치 표시 영역을 새로 추가하면 **출처 배지도 같이** 붙여야 한다. 지금은 3곳이
  전부지만 코드 차원의 강제 장치는 없다(검사로만 고정).
- 정확도에는 영향이 없는 표시·진단 계층 변경이다. 다음 최우선은 그대로
  **EZ 라벨 100~200건**.
"""


def main() -> None:
    if hashlib.sha256(PRODUCTION.read_bytes()).hexdigest() != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - refusing to run")

    raw = CONVERSATION.read_bytes()
    if b"# 40." in raw:
        raise SystemExit("section 40 already present")
    if not raw.endswith(b"\n"):
        raise SystemExit("conversation.md does not end with newline")

    body = SECTION.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
    CONVERSATION.write_bytes(raw + body)

    after = CONVERSATION.read_bytes()
    if b"\r\r\n" in after:
        raise SystemExit("found CR CR LF")
    crlf = bytes([13, 10])
    print(f"conversation.md: {len(raw)} -> {len(after)} bytes")
    print(f"crlf: {raw.count(crlf)} -> {after.count(crlf)}")


if __name__ == "__main__":
    main()
