#!/usr/bin/env python3
"""연구용 HTML: 캔버스 아래 · 예상 TZL/EZL 박스 위에 **정답 EZL/TZL** 스트립 추가.

요청: "정답으로 제시된 EZL과 TZL 길이를 캔버스 사진 이미지 아래, 지금 표기된
예상 TZL·예상 EZL 박스 위에 추가해."

구현 방식
  · 기존 `.canvas-width-strip`은 캔버스 좌하단에 absolute로 붙어 있었다. 두 박스를
    위아래로 쌓아야 하므로 `.canvas-bottom-stack`(flex column) 래퍼를 만들고 그 안에
    정답 스트립 → 예상/측정 스트립 순서로 넣는다(첫 자식이 위).
  · 정답값은 `TRUTH_LOOKUP`(학습 이미지 113건)에서 **이미지 SHA-256 일치**로만 찾는다.
    파일명·번호로 매칭하지 않는다.
  · ⚠️ `sha256Hex`는 순수 JS로 이미지 전체 바이트를 훑는다. 렌더마다 재계산하면
    프레임이 죽으므로 `imageRevision` 단위로 캐시한다. EZL/TZL 환산은 스케일 입력
    (molarMm)에 의존하므로 **값 계산은 매 렌더 수행**한다(가벼움).
  · 색: 측정=녹색 / 예상=분홍 / **정답=호박색**으로 구분한다.

HTML은 CRLF. read_text/write_text가 개행을 번역하므로 교체 문자열은 LF로 쓰고,
쓰기 후 CRLF 증가와 \r\r\n 부재를 확인한다. 운영 HTML은 SHA만 확인한다.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent / "EZ Curve - TZ Length - 보정 후 알고리즘 적용.html"
PRODUCTION = HERE.parent / "EZ Curve - TZ Length - 보정 전 알고리즘 적용.html"
PRODUCTION_SHA = "6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197"

CSS_OLD = """\
  .canvas-width-strip { position: absolute; z-index: 6; left: 8px; right: 8px; bottom: 8px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid rgba(16,185,129,.62); border-radius: 9px; background: rgba(15,23,42,.92); box-shadow: 0 4px 18px rgba(0,0,0,.32); backdrop-filter: blur(7px); pointer-events: none; }
"""

CSS_NEW = """\
  .canvas-bottom-stack { position: absolute; z-index: 6; left: 8px; right: 8px; bottom: 8px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .canvas-truth-strip { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border: 1px solid rgba(251,191,36,.66); border-radius: 9px; background: rgba(15,23,42,.92); box-shadow: 0 4px 18px rgba(0,0,0,.32); backdrop-filter: blur(7px); }
  .canvas-truth-strip[hidden] { display: none; }
  .canvas-truth-label { flex: 0 0 auto; color: #fcd34d; font-size: 10px; font-weight: 900; }
  .canvas-truth-values { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
  .canvas-truth-values > span { padding: 3px 7px; border-radius: 5px; background: rgba(180,120,10,.28); color: #fde68a; font: 900 11px/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
  .canvas-width-strip { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid rgba(16,185,129,.62); border-radius: 9px; background: rgba(15,23,42,.92); box-shadow: 0 4px 18px rgba(0,0,0,.32); backdrop-filter: blur(7px); pointer-events: none; }
"""

MARKUP_OLD = """\
      <section class="canvas-width-strip" id="canvasWidthStrip" hidden role="region" aria-label="자동 분석 치아별 좌우폭 길이">
        <ol class="canvas-width-list" id="canvasWidthList"></ol>
        <output class="canvas-width-total" id="canvasWidthTotal">
          <span id="canvasWidthTzl">TZL -</span>
          <span id="canvasWidthEzl">EZL -</span>
          <span id="canvasWidthDiff">TZL−EZL -</span>
        </output>
      </section>
"""

MARKUP_NEW = """\
      <div class="canvas-bottom-stack">
        <section class="canvas-truth-strip" id="canvasTruthStrip" hidden role="region" aria-label="전문가 정답 EZL TZL 길이">
          <span class="canvas-truth-label">정답(전문가)</span>
          <output class="canvas-truth-values" id="canvasTruthValues">
            <span id="canvasTruthTzl">정답 TZL -</span>
            <span id="canvasTruthEzl">정답 EZL -</span>
            <span id="canvasTruthDiff">정답 TZL−EZL -</span>
          </output>
        </section>
        <section class="canvas-width-strip" id="canvasWidthStrip" hidden role="region" aria-label="자동 분석 치아별 좌우폭 길이">
          <ol class="canvas-width-list" id="canvasWidthList"></ol>
          <output class="canvas-width-total" id="canvasWidthTotal">
            <span id="canvasWidthTzl">TZL -</span>
            <span id="canvasWidthEzl">EZL -</span>
            <span id="canvasWidthDiff">TZL−EZL -</span>
          </output>
        </section>
      </div>
"""

JS_ANCHOR = """\
  function updateCanvasWidthStrip() {
"""

JS_NEW = """\
  // 정답 스트립: 업로드 이미지가 학습 데이터(113건)에 있으면 그 **전문가 정답** EZL/TZL을
  // 캔버스 아래(예상/측정 박스 바로 위)에 표시한다. 자동분석 값과 나란히 놓고 비교하는 용도.
  // ⚠️ 매칭은 **이미지 SHA-256 일치**로만 한다(파일명·번호 매칭 금지).
  // ⚠️ sha256Hex는 순수 JS로 이미지 전체 바이트를 훑으므로 렌더마다 계산하면 안 된다.
  //    imageRevision 단위로 캐시한다. 단 mm 환산은 스케일 입력에 의존하므로 값 계산은 매번 한다.
  let truthStripCache = { revision: -1, record: null };
  function truthRecordForCurrentImage() {
    if (truthStripCache.revision === imageRevision) return truthStripCache.record;
    let record = null;
    try {
      if (window.TRUTH_LOOKUP && imageData && window.sha256Hex && window.dataUrlToBytes) {
        const found = window.TRUTH_LOOKUP[window.sha256Hex(window.dataUrlToBytes(imageData))];
        if (found && Array.isArray(found.ezPoints) && found.ezPoints.length >= 2
            && Array.isArray(found.toothWidths) && found.toothWidths.length >= 1) record = found;
      }
    } catch (e) { console.warn('정답 스트립 룩업 실패:', e); }
    truthStripCache = { revision: imageRevision, record: record };
    return record;
  }

  function updateCanvasTruthStrip() {
    const strip = document.getElementById('canvasTruthStrip');
    if (!strip) return;
    const tzlOutput = document.getElementById('canvasTruthTzl');
    const ezlOutput = document.getElementById('canvasTruthEzl');
    const diffOutput = document.getElementById('canvasTruthDiff');
    const record = image ? truthRecordForCurrentImage() : null;
    const metrics = record ? calculateMetricsFor(record.ezPoints, record.toothWidths) : null;
    if (!metrics || !Number.isFinite(metrics.ezl) || !Number.isFinite(metrics.tzl)) {
      strip.hidden = true;
      strip.removeAttribute('data-truth-id');
      if (tzlOutput) tzlOutput.textContent = '정답 TZL -';
      if (ezlOutput) ezlOutput.textContent = '정답 EZL -';
      if (diffOutput) diffOutput.textContent = '정답 TZL−EZL -';
      return;
    }
    if (tzlOutput) tzlOutput.textContent = '정답 TZL ' + metrics.tzl.toFixed(1) + ' mm';
    if (ezlOutput) ezlOutput.textContent = '정답 EZL ' + metrics.ezl.toFixed(1) + ' mm';
    if (diffOutput) {
      const diff = metrics.tzl - metrics.ezl;   // 예상 박스와 같은 부호 규약(TZL−EZL)
      diffOutput.textContent = '정답 TZL−EZL ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ' mm';
    }
    if (record.id) strip.dataset.truthId = String(record.id);
    strip.hidden = false;
  }

  function updateCanvasWidthStrip() {
"""

CALL_RESET_OLD = """\
    updateCanvasWidthStrip();
  }
"""

CALL_RESET_NEW = """\
    updateCanvasWidthStrip();
    updateCanvasTruthStrip();
  }
"""

CALL_RENDER_OLD = """\
    updateCanvasWidthStrip();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
"""

CALL_RENDER_NEW = """\
    updateCanvasWidthStrip();
    updateCanvasTruthStrip();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
"""

REPLACEMENTS = [
    (CSS_OLD, CSS_NEW),
    (MARKUP_OLD, MARKUP_NEW),
    (JS_ANCHOR, JS_NEW),
    (CALL_RESET_OLD, CALL_RESET_NEW),
    (CALL_RENDER_OLD, CALL_RENDER_NEW),
]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "canvasTruthStrip" in text:
        raise SystemExit("truth strip already present - refusing to duplicate")

    for index, (old, new) in enumerate(REPLACEMENTS, start=1):
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"replacement {index}: expected exactly 1 match, found {count}")
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
