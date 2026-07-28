#!/usr/bin/env python3
"""'자동 분석 상세 수치' 출처 배지 + 빌드 배지 추가.

두 가지 혼동을 없앤다.

① "자동 분석 상세 수치 섹션에 보이는 수치들은 정답인 것 같다"
   실측 결과(_detail_provenance.mjs): 초안 적용 후 상세 수치는 정답과 **다르다**
   (치아별 최대 0.8 mm 차이, TZL 97.0 vs 정답 98.3). 자동분석은 정답을 투영하지
   않는다(USE_TRUTH_LOOKUP=false).
   **다만** `✔ 정답 확인` 버튼을 누르면 정답 좌표가 측정값으로 들어가므로 그 뒤에는
   상세 수치가 정답과 **완전히 같아진다**(최대차 0.00 mm). 헤드라인이 계속
   "자동 분석 상세 수치"라서 정답을 자동분석 결과로 오해하게 된다.
   → 헤드라인 옆에 출처 배지를 붙인다: 자동분석 / 전문가 정답 / 수동 입력.

② "자동 분석을 실행하면 정답 섹션이 사라진다"
   1600x1000 + 7개 해상도에서 재현 실패(정답 줄 유지, 잘림 0px). 이전 커밋 버전도
   사라지지 않았다. 남는 유력 원인은 **브라우저가 이전 빌드를 캐시**한 상태다.
   → 화면에 빌드 배지를 노출해 사용자가 보고 있는 버전을 즉시 식별할 수 있게 한다.
     (룩업 건수를 함께 찍는다: 113이면 구버전, 442면 현재 빌드.)

HTML은 CRLF. 교체 문자열은 LF로 쓰고, 쓰기 후 CRLF 증가와 \r\r\n 부재를 확인한다.
운영 HTML은 SHA만 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

CSS_OLD = """\
  .coord-headline { font-size: 11px; font-weight: 900; color: #f8fafc; }
"""

CSS_NEW = """\
  .coord-headline { font-size: 11px; font-weight: 900; color: #f8fafc; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .coord-source { padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(148,163,184,.5); background: rgba(51,65,85,.7); color: #cbd5e1; font-size: 9px; font-weight: 800; }
  .coord-source[data-source="auto"] { border-color: rgba(16,185,129,.6); background: rgba(5,150,105,.24); color: #a7f3d0; }
  .coord-source[data-source="preview"] { border-color: rgba(244,114,182,.6); background: rgba(190,24,93,.24); color: #fbcfe8; }
  .coord-source[data-source="truth"] { border-color: rgba(251,191,36,.7); background: rgba(180,120,10,.3); color: #fde68a; }
  .coord-source[data-source="manual"] { border-color: rgba(96,165,250,.6); background: rgba(37,99,235,.22); color: #bfdbfe; }
  .build-badge { padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(148,163,184,.45); background: rgba(30,41,59,.85); color: #94a3b8; font: 700 9px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
"""

HEADLINE_OLD = """\
        <div class="coord-headline">자동 분석 상세 수치</div>
"""

HEADLINE_NEW = """\
        <div class="coord-headline">자동 분석 상세 수치<span class="coord-source" id="coordSource" data-source="none">데이터 없음</span><span class="build-badge" id="buildBadge">build -</span></div>
"""

# updateCoordBar 앞에 출처 판정 함수를 두고, 함수 진입 시 배지를 갱신한다.
JS_ANCHOR = """\
  function updateCoordBar() {
    const grid = document.getElementById('coordGrid');
"""

JS_NEW = """\
  // 상세 수치가 무엇에서 나온 값인지 화면에 명시한다.
  // ⚠️ `✔ 정답 확인`을 누르면 정답 좌표가 측정값으로 들어가므로 상세 수치는 정답과
  //    똑같아진다. 그때 헤드라인이 "자동 분석"이면 정답을 엔진 성능으로 오해한다.
  //    (자동분석 자체는 정답을 투영하지 않는다 — USE_TRUTH_LOOKUP=false.)
  function updateCoordSourceBadge() {
    const badge = document.getElementById('coordSource');
    if (!badge) return;
    const meta = (analysisState === 'preview' && autoDraft) ? autoDraft.analysisMeta : autoMeta;
    const hasData = (toothWidths && toothWidths.length) || (ezPoints && ezPoints.length);
    let source = 'none', text = '데이터 없음';
    if (!hasData && analysisState !== 'preview') { source = 'none'; text = '데이터 없음'; }
    else if (analysisState === 'preview' && autoDraft) { source = 'preview'; text = '자동 초안(미적용)'; }
    else if (meta && meta.truthMatch) { source = 'truth'; text = '전문가 정답 표시 중'; }
    else if (meta) { source = 'auto'; text = '자동 분석 결과'; }
    else { source = 'manual'; text = '수동 입력'; }
    badge.dataset.source = source;
    badge.textContent = text;
  }

  function updateCoordBar() {
    updateCoordSourceBadge();
    const grid = document.getElementById('coordGrid');
"""

# 빌드 배지: 룩업 건수로 캐시된 구버전을 즉시 구분한다.
BUILD_ANCHOR = """\
  document.documentElement.dataset.ezEngineReady='true';
"""

BUILD_NEW = """\
  // 빌드 식별 배지. 브라우저가 이전 빌드를 캐시하면 화면과 파일이 어긋나는데,
  // 정답 룩업 건수(113=구버전 / 442=현재)로 그것을 즉시 알 수 있다.
  (function stampBuild(){
    const badge=document.getElementById('buildBadge'); if(!badge) return;
    const entries=window.TRUTH_LOOKUP?Object.keys(window.TRUTH_LOOKUP).length:0;
    const hasTeeth=!!document.getElementById('canvasTruthList');
    badge.textContent='정답 '+entries+'건'+(hasTeeth?' · 치아별표기 ON':' · 치아별표기 OFF');
    badge.title='이 숫자가 442·치아별표기 ON이 아니면 브라우저가 이전 빌드를 캐시한 상태입니다(Ctrl+Shift+R).';
    document.documentElement.dataset.ezBuildTruthEntries=String(entries);
  })();
  document.documentElement.dataset.ezEngineReady='true';
"""

REPLACEMENTS = [
    ("css", CSS_OLD, CSS_NEW),
    ("headline", HEADLINE_OLD, HEADLINE_NEW),
    ("coordBar", JS_ANCHOR, JS_NEW),
    ("buildBadge", BUILD_ANCHOR, BUILD_NEW),
]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "coordSource" in text:
        raise SystemExit("source badge already present - refusing to duplicate")

    for name, old, new in REPLACEMENTS:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{name}: expected exactly 1 match, found {count}")
        text = text.replace(old, new)

    RESEARCH.write_text(text, encoding="utf-8")

    raw_after = RESEARCH.read_bytes()
    if b"\r\r\n" in raw_after:
        raise SystemExit("found CR CR LF - double conversion happened")
    crlf = bytes([13, 10])
    if raw_after.count(crlf) <= raw_before.count(crlf):
        raise SystemExit("CRLF line count did not grow - line endings were mangled")

    production_sha = hashlib.sha256(PRODUCTION.read_bytes()).hexdigest()
    if production_sha != PRODUCTION_SHA:
        raise SystemExit("production HTML changed - must never happen")

    print(f"research html: {len(raw_before)} -> {len(raw_after)} bytes")
    print(f"crlf lines: {raw_before.count(crlf)} -> {raw_after.count(crlf)}")
    print(f"production sha unchanged: {production_sha[:12]}...")


if __name__ == "__main__":
    main()
