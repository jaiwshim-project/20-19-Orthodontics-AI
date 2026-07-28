#!/usr/bin/env python3
"""오른쪽 '측정 결과' 패널에 출처 배지 추가.

지적: "측정 결과 EZL 83.4 / TZL 87.9 — 측정이니 정답이니? 왼쪽 정답과 같아 보인다."

실측 결과 **정답이 맞다**. 원인은 구조다. 측정 결과 패널은 calculateEZL()이 갱신하고
그 함수는 전역 ezPoints/toothWidths를 읽는다. showTruth()가 정답 좌표를 그 전역에
써넣으므로, `✔ 정답 확인` 이후 이 패널은 정답을 표시한다. 하단 상세 수치에는 어제
출처 배지를 붙였지만 **이 패널에는 없어서** 여전히 구분이 안 됐다.

수정: 제목 옆에 같은 배지를 붙이고, 정답 표시 중일 때는 카드 테두리도 호박색으로.
배지는 calculateEZL()에서 갱신한다(패널을 갱신하는 유일한 지점).

HTML은 CRLF. 교체 문자열은 LF로 쓰고, 쓰기 후 CRLF 증가와 \r\r\n 부재를 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

# ── ① CSS: 측정 결과 카드 헤더 + 정답일 때 강조 ────────────────────────────────
CSS_OLD = """\
  .build-badge { padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(148,163,184,.45); background: rgba(30,41,59,.85); color: #94a3b8; font: 700 9px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
"""

CSS_NEW = """\
  .build-badge { padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(148,163,184,.45); background: rgba(30,41,59,.85); color: #94a3b8; font: 700 9px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
  /* 측정 결과 카드도 출처를 말해야 한다 — 이 패널은 '자동분석 전용'이 아니라 현재 측정 상태다. */
  .metric-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
  .metric-head h3 { margin: 0; }
  .card[data-metric-source="truth"] { border-color: rgba(251,191,36,.75); box-shadow: 0 0 0 1px rgba(251,191,36,.25) inset; }
"""

# ── ② 마크업: 제목 옆 배지 ─────────────────────────────────────────────────────
MARKUP_OLD = """\
    <div class="card">
      <h3>측정 결과</h3>
      <div class="metric"><span class="label">EZL (보정·치아 점유 구간)</span><span class="value" id="ezlValue">-</span></div>
"""

MARKUP_NEW = """\
    <div class="card" id="metricCard" data-metric-source="none">
      <div class="metric-head"><h3>측정 결과</h3><span class="coord-source" id="metricSource" data-source="none">데이터 없음</span></div>
      <div class="metric"><span class="label">EZL (보정·치아 점유 구간)</span><span class="value" id="ezlValue">-</span></div>
"""

# ── ③ 배지 갱신 함수 + calculateEZL 훅 ────────────────────────────────────────
JS_OLD = """\
  function calculateEZL() {
    document.getElementById('toothCount').textContent = toothCenters.length;
"""

JS_NEW = """\
  // 측정 결과 패널의 출처를 화면에 명시한다.
  // ⚠️ 이 패널은 자동분석 전용 표시가 **아니다**. calculateEZL()이 전역 ezPoints/
  //    toothWidths를 읽어 갱신하고, showTruth()가 그 전역에 정답 좌표를 써넣으므로
  //    `✔ 정답 확인` 이후에는 EZL·TZL·차이가 **정답 그대로** 나온다(실측 확인).
  //    상세 수치 배지(updateCoordSourceBadge)와 같은 규칙을 쓴다.
  function updateMetricSourceBadge() {
    const badge = document.getElementById('metricSource');
    const card = document.getElementById('metricCard');
    if (!badge) return;
    const hasData = (toothWidths && toothWidths.length) || (ezPoints && ezPoints.length);
    let source = 'none', text = '데이터 없음';
    if (!hasData) { source = 'none'; text = '데이터 없음'; }
    else if (autoMeta && autoMeta.truthMatch) { source = 'truth'; text = '전문가 정답 표시 중'; }
    else if (autoMeta) { source = 'auto'; text = '자동 분석 결과'; }
    else { source = 'manual'; text = '수동 입력'; }
    badge.dataset.source = source;
    badge.textContent = text;
    if (card) card.dataset.metricSource = source;
  }

  function calculateEZL() {
    updateMetricSourceBadge();
    document.getElementById('toothCount').textContent = toothCenters.length;
"""

REPLACEMENTS = [("css", CSS_OLD, CSS_NEW), ("markup", MARKUP_OLD, MARKUP_NEW), ("js", JS_OLD, JS_NEW)]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if 'id="metricSource"' in text:
        raise SystemExit("metric source badge already present")

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
