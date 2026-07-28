#!/usr/bin/env python3
"""연구용 HTML 노트 ⑫ 추가 — 정답 표시 UI(커버리지·치아별·출처 배지) + 헤더 경고.

정확도 결론이 아니라 **표시·진단 계층**의 사실이지만, 다음 세션에서 화면 수치를
잘못 해석하는 것을 막으려면 여기에 남아야 한다. 특히 두 가지가 함정이다.
  · `✔ 정답 확인`을 누른 뒤의 상세 수치는 **정답**이다(엔진 성능이 아니다).
  · 폭 정답만 있는 케이스는 px/mm 기준이 **폭 최외곽 스팬**이라 ezChord 기준과
    직접 비교하면 안 된다.

HTML은 CRLF. 교체 문자열은 LF로 쓰고, 쓰기 후 CRLF 증가와 \r\r\n 부재를 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

HEADER_OLD = """\
  // ⚠️ **좌우 어금니 격차는 이제 실재한다**(⑪ — 구판정 "편향 없음"은 폐기). 다만
  //    측정상 정확한 쪽은 **오른쪽**(위치 −8.01% / 길이 −11.26%, 시드 4/4 유의)이고
  //    이는 육안 관찰과 방향이 반대다. 좌우 전용 대책을 짜기 전에 ⑪을 읽을 것.
"""

HEADER_NEW = """\
  // ⚠️ **좌우 어금니 격차는 이제 실재한다**(⑪ — 구판정 "편향 없음"은 폐기). 다만
  //    측정상 정확한 쪽은 **오른쪽**(위치 −8.01% / 길이 −11.26%, 시드 4/4 유의)이고
  //    이는 육안 관찰과 방향이 반대다. 좌우 전용 대책을 짜기 전에 ⑪을 읽을 것.
  // ⚠️ **화면 수치를 엔진 성능으로 읽기 전에 출처 배지를 볼 것**(⑫). `✔ 정답 확인`을
  //    누르면 정답 좌표가 측정값으로 들어가서 하단 상세 수치가 **정답과 완전히 같아진다**
  //    (자동분석 자체는 정답을 투영하지 않는다 — USE_TRUTH_LOOKUP=false).
"""

NOTE_ANCHOR = """\
  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e). 여력이 남은 곳은 위치
"""

NOTE_NEW = """\
  // ⑫ **정답 표시 UI — 커버리지·치아별 길이·출처 배지**(2026-07-29, 표시 계층. 정확도
  //    결론이 아니다). 원인 규명과 검증은 conversation.md 섹션 39.
  //    (a) "정답 수치가 안 보인다"의 원인은 기능이 아니라 **커버리지**였다. 구 룩업은
  //        폭·EZ를 **둘 다** 가진 113건만 담고 있었다(폭 정답 케이스는 442건). 디스크
  //        사진 매칭률 7.4%. 실구동 검증 10/10을 통과했는데도 사용자 화면에서 안 보인
  //        이유다 — **기능 검증과 커버리지 회계는 별개 측정**이다.
  //    (b) `_rebuild_truth_lookup.py`로 **113 → 442건** 재생성. 케이스별 폭 주석 + EZ
  //        주석을 **이미지 SHA-256 동일** 기준으로만 병합(파일 번호 매칭 금지). 구 113건
  //        전수 유지를 회귀 가드로 확인. 주석 여러 판(65건)은 12개 완전판 → 좌표 이상
  //        플래그 없음 → 첫 번째 순으로 선택.
  //    (c) ⚠️ **스케일 기준이 두 종류로 섞였다.** 레코드의 `scaleRef`를 볼 것.
  //        `ezChord`(113건) = EZ 곡선 현 / 54mm → 기존과 동일 수치. `widthOuterSpan`
  //        (329건) = 폭 최외곽 스팬 / 54mm → **EZL은 정의되지 않아 표시하지 않는다**.
  //        두 기준의 수치를 직접 비교하면 안 된다(UI 라벨에 기준을 명시해 둠).
  //    (d) 커버리지 재측정: 전체 218/801(27.2%)이지만 **원본 사진 폴더는 91.6% / 95.6%**.
  //        0%인 568장은 **1600px PNG 파생본**(겹침 렌더)이고 원본은 JPEG(6016px 등)라
  //        SHA가 원리상 다르다 — 결함이 아니다. **정답을 보려면 원본 사진을 열어야 한다.**
  //    (e) "자동분석하면 정답 줄이 사라진다"는 **재현 실패**. 업로드→분석→적용 3단계 모두
  //        표시(치아 12개, 폭만인 경우 11개 + EZL `-`), 7개 해상도에서 잘림 **0px**,
  //        이전 커밋 버전도 동일. 남은 유력 원인은 **브라우저 캐시(구 빌드)**여서 화면에
  //        빌드 배지를 넣었다: `정답 442건 · 치아별표기 ON`. 113 또는 OFF면 구 빌드다.
  //    (f) ⭐️ **상세 수치는 자동분석 결과다 — 단 `✔ 정답 확인` 뒤에는 정답이다.**
  //        초안 적용 후: 상세 TZL 97.0 vs 정답 98.3, 치아별 최대차 **0.80mm**(누출 없음,
  //        캔버스 자동 박스와는 최대차 0.00mm로 동일 출처). 정답 확인 클릭 후: **0.00mm**
  //        = 완전 동일. 헤드라인이 계속 "자동 분석"이라 오해를 낳던 구조라서 출처 배지
  //        (자동 분석 결과 / 자동 초안(미적용) / 전문가 정답 표시 중 / 수동 입력)를 붙였다.
  //    (g) 검증 도구: `_truth_strip_repro.mjs`(3단계 표시), `_truth_strip_viewports.mjs`
  //        (해상도별 잘림), `_detail_provenance.mjs`(정답 누출 9/9), `_embed_verify.js`
  //        (파리티 8.7e-15·3단계 유지), `_leakcheck_truth_ui.py`(산출물 PHI 6종).
  //        ⚠️ 앱 스크립트는 IIFE 안이라 `analysisState` 등 내부 변수를 page.evaluate로
  //        읽을 수 없다(첫 시도 180초 타임아웃 = 테스트 결함). DOM 신호
  //        `document.documentElement.dataset.analysisState`를 쓸 것.
  // 다음 과제: (a) **EZ 라벨 100~200건 — 1순위로 복귀**(⑩d·e). 여력이 남은 곳은 위치
"""

REPLACEMENTS = [("header", HEADER_OLD, HEADER_NEW), ("note", NOTE_ANCHOR, NOTE_NEW)]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "⑫" in text:
        raise SystemExit("note 12 already present")

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
