#!/usr/bin/env python3
"""conversation.md 섹션 39 추가 — 정답 표시 UI(커버리지·치아별·출처 배지).

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

# 39. 정답 표시 UI 3연속 수정 — 커버리지·치아별 길이·출처 배지 (2026-07-29)

세 가지 지적을 순서대로 실측하고 고쳤다. 모두 연구용 HTML 한정이며 운영 HTML은
SHA `6ee35113…` / 89,330 바이트 그대로다.

## 39-1. "정답 수치가 안 보인다" → 원인은 기능이 아니라 커버리지

전날 정답 스트립은 실구동 검증 10/10을 통과했다. 그런데 사용자 화면에는 안 보였다.
검증이 통과한 이유는 **룩업에 있는 사진 1장으로만** 시험했기 때문이다. 층별로 셌다.

| 항목 | 값 |
|---|---|
| 구 TRUTH_LOOKUP 항목 | 113건 |
| dataset-index 폭 정답 케이스 | 442건 |
| 폭·EZ 둘 다 있는 케이스 | 113건 |
| 디스크 사진 중 룩업 매칭 | 59 / 801 (7.4%) |

구 룩업은 **폭·EZ를 둘 다 가진 케이스만** 담고 있었다. 폭 정답만 있는 329건이
빠져 있었다. 사용자가 어떤 사진을 열어도 정답이 안 뜰 확률이 압도적이었다.

**교훈(기록용).** "내 테스트에서 되니까 사용자 화면에서도 된다"는 5회 오해 검증이
금지하는 바로 그 가정이다. 기능 검증과 **커버리지 회계**는 별개 측정이다.

## 39-2. 룩업 재생성 — 113 → 442건

`_rebuild_truth_lookup.py`: dataset-index에서 케이스별로 폭 주석 + EZ 주석을
**이미지 SHA-256 동일** 기준으로만 합쳐 한 레코드로 만들었다(파일 번호 매칭 금지).

| 구성 | 건수 |
|---|---|
| 폭+EZ 둘 다 | 113 |
| 폭만(EZL 계산 불가) | 329 |
| 정답 없음(제외) | 10 |
| 합계 | 442 |

주석이 여러 판인 케이스(65건)는 **12개 완전판 → 좌표 이상 플래그 없음 → 첫 번째**
순으로 하나를 골랐다. 구 113건은 **전부 그대로 유지**됨을 회귀 가드로 확인했다.

**스케일 규약(중요).** 기존 `calculateMetricsFor`의 px/mm는 **EZ 곡선 현 / 54 mm**다.
EZ 정답이 없으면 이 기준이 없다. 그래서 레코드에 `scaleRef`/`scalePx`를 넣었다.

- `ezChord` → 기존과 완전히 동일한 수치(회귀 없음)
- `widthOuterSpan` → 폭 최외곽 스팬 = 54 mm. **EZL은 정의되지 않아 표시하지 않는다**
  (라벨에 "폭 최외곽 스팬 기준(EZ 정답 없음)"을 명시)

## 39-3. 커버리지 재측정 — 그리고 사진 모음 568장이 0%인 이유

| 코호트(익명) | 사진 | 룩업 매칭 | 비율 |
|---|---|---|---|
| A_photo_pool | 568 | 0 | 0.0% |
| B_postortho_photos | 114 | 109 | 95.6% |
| C_project_root | 119 | 109 | 91.6% |
| 전체 | 801 | 218 | 27.2% |

전체 27.2%는 낮아 보이지만 **원본 사진 폴더는 91~96% 커버**된다. 0%인 568장은
**1600px PNG 파생본**(EZL·TZL 겹침 렌더)이고 원본은 JPEG(6016px 등)다. 바이트가
다르므로 SHA-256이 절대 일치하지 않는다 — 이것은 결함이 아니라 규약대로 동작한 것이다.
**정답을 보려면 원본 사진을 열어야 한다.**

## 39-4. "자동 분석하면 정답 섹션이 사라진다" → 현재 빌드에서 재현 안 됨

`_truth_strip_repro.mjs`로 업로드 → 자동분석 → 초안적용 3단계를 찍었다.

| 단계 | 정답 줄 | 치아 항목 | 예상 줄 |
|---|---|---|---|
| 업로드 직후 | 표시 | 12개 | 숨김 |
| 자동분석(미리보기) | 표시 | 12개 | 표시 |
| 초안 적용 | 표시 | 12개 | 표시 |

폭 정답만 있는 케이스도 3단계 모두 표시(11개 항목, EZL은 `-`). 이전 커밋 버전에서도
사라지지 않았다. 잘림 가설도 기각했다 — `_truth_strip_viewports.mjs`로 1920×1080부터
414 모바일까지 7개 해상도에서 자동분석 전/후 잘린 픽셀은 **전부 0px**이었다.

**남은 유력 원인은 브라우저 캐시(구 빌드)다.** 그래서 화면에 **빌드 배지**를 넣었다:
`정답 442건 · 치아별표기 ON`. 이 값이 113이거나 OFF면 구 빌드를 보고 있는 것이므로
Ctrl+Shift+R로 강제 새로고침해야 한다.

**테스트 결함도 하나 있었다.** 첫 재현 시도는 180초 타임아웃으로 죽었는데, 앱 버그가
아니라 앱 스크립트가 IIFE 안에 있어 `analysisState` 같은 내부 변수를 밖에서 읽을 수
없기 때문이었다. `document.documentElement.dataset.analysisState`(앱이 스스로 내보내는
DOM 신호)로 바꿔 해결했다.

## 39-5. "상세 수치가 정답인 것 같다" → 자동분석은 정답이 아니다. 단 버튼 하나가 바꾼다

`_detail_provenance.mjs`로 하단 '자동 분석 상세 수치' 12칸을 정답과 직접 비교했다.

| 상태 | 상세 수치 TZL | 정답 TZL | 치아별 최대차 |
|---|---|---|---|
| 초안 적용 후 | 97.0 mm | 98.3 mm | **0.80 mm** |
| `✔ 정답 확인` 클릭 후 | 98.3 mm | 98.3 mm | **0.00 mm** |

즉 **자동 분석은 정답을 투영하지 않는다**(`USE_TRUTH_LOOKUP=false`, 상세 수치는 캔버스
자동 박스와 최대차 0.00 mm로 동일 출처). 그런데 `✔ 정답 확인`을 누르면 정답 좌표가
측정값으로 들어가므로 그 뒤 상세 수치는 정답과 **완전히 같아진다**. 헤드라인이 계속
"자동 분석 상세 수치"라서 정답을 엔진 성능으로 오해하게 되는 구조였다.

**수정.** 헤드라인에 출처 배지를 붙였다: `자동 분석 결과` / `자동 초안(미적용)` /
`전문가 정답 표시 중` / `수동 입력` / `데이터 없음`. 배지 색도 각각 다르다.

## 39-6. 변경 이유 / 검증 결과 / 남은 리스크

**변경 이유.** ① 정답이 안 보이는 원인은 커버리지 7.4%였다 ② 치아 번호별 정답 길이
요청 ③ 정답과 자동분석 수치가 화면에서 구분되지 않았다 ④ 사용자 화면 빌드를
식별할 수단이 없었다.

**검증 결과.**
- 룩업 113 → 442건, 구 113건 전수 유지(회귀 가드)
- 원본 사진 폴더 커버리지 91.6% / 95.6%
- 정답 줄 3단계 유지 + 치아별 항목 12개(폭만인 경우 11개), 7개 해상도 잘림 0px
- 정답 스트립 치아별 값 = 독립 계산 정답과 최대차 **0.00 mm**
- 상세 수치 vs 정답 최대차 0.80 mm(누출 없음), 정답 확인 후 0.00 mm(설계된 동작)
- 배지 검사 9/9 통과, 임베드 엔진 파리티 8.7e-15(3단계 유지)
- 산출물 6종 PHI 스캔 통과, 확인용 스크린샷은 열람 후 삭제
- 운영 HTML SHA `6ee35113…` / 89,330 바이트 불변

**남은 리스크.**
- 1600px PNG 파생본 568장은 원리상 영구히 매칭 불가(원본을 열어야 한다)
- 폭 정답만 있는 329건은 스케일 기준이 **폭 최외곽 스팬**이라 `ezChord` 기준 수치와
  직접 비교하면 안 된다(라벨에 명시했지만 오독 여지는 남는다)
- "자동분석 후 정답 사라짐"은 재현하지 못했다. 빌드 배지가 113 또는 OFF로 보이면
  캐시가 원인이고, 442·ON인데도 사라진다면 미측정 조건이 남아 있는 것이다
- 연구용 HTML은 6.40 MB로 커졌다(룩업 442건). 운영 반영 계획은 없다

**다음 수순.** 변동 없음 — **EZ 라벨 100~200건이 1순위**다(폭 라벨은 포화). 이번
작업은 표시·진단 계층이므로 정확도에는 영향이 없다.
"""


def main() -> None:
    if hashlib.sha256(PRODUCTION.read_bytes()).hexdigest() != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - refusing to run")

    raw = CONVERSATION.read_bytes()
    if b"## 39." in raw:
        raise SystemExit("section 39 already present")
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
