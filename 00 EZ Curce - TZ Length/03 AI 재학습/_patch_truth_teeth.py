#!/usr/bin/env python3
"""정답 스트립 2차 개편: ① 치아 번호별 정답 길이 표기 ② EZ 정답 없는 케이스도 표시.

요청
  · "지금 화면에는 자동 분석한 수치만 보이고, 정답 수치는 안 보여. 확인해"
    → 원인은 커버리지(룩업 113건). `_rebuild_truth_lookup.py`로 442건으로 늘렸다.
      다만 폭 정답만 있고 EZ 정답이 없는 케이스가 329건이라, 기존 가드
      (`ezPoints.length >= 2` **AND** `toothWidths.length >= 1`)로는 여전히 숨는다.
      가드를 폭 기준으로 바꾸고, EZL은 계산 불가일 때 `-`로 표시한다.
  · "정답 섹션에, 각 치아 번호별 길이를 표기해"
    → 예상/측정 박스와 같은 12칸 그리드를 정답 스트립에도 넣는다. 번호는 자동분석의
      `i+1`이 아니라 **정답의 toothNo**를 쓴다(결손 번호가 있으면 그대로 드러나야 한다).

스케일 규약(⚠️ 중요)
  기존 `calculateMetricsFor`는 pxPerMm를 **EZ 곡선의 현 / molarMm** 으로 잡는다.
  EZ 정답이 없으면 이 값이 없다. 그래서 룩업 레코드에 `scaleRef`/`scalePx`를
  넣어 두었고(EZ 있으면 ezChord, 없으면 폭 최외곽 스팬), UI는 그 값을 쓴다.
  · scaleRef=ezChord      → 기존과 완전히 동일한 수치가 나온다(회귀 없음).
  · scaleRef=widthOuterSpan → 폭 최외곽 스팬 = molarMm 로 환산. EZL은 표시하지 않는다.
  두 기준이 섞이면 오해를 부르므로, 후자일 때 라벨에 `폭기준`을 붙여 명시한다.

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

# ── ① CSS: 정답 스트립을 예상 박스와 같은 2열(리스트 + 합계) 그리드로 ──────────
CSS_OLD = """\
  .canvas-truth-strip { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border: 1px solid rgba(251,191,36,.66); border-radius: 9px; background: rgba(15,23,42,.92); box-shadow: 0 4px 18px rgba(0,0,0,.32); backdrop-filter: blur(7px); }
  .canvas-truth-strip[hidden] { display: none; }
  .canvas-truth-label { flex: 0 0 auto; color: #fcd34d; font-size: 10px; font-weight: 900; }
  .canvas-truth-values { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
  .canvas-truth-values > span { padding: 3px 7px; border-radius: 5px; background: rgba(180,120,10,.28); color: #fde68a; font: 900 11px/1.1 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
"""

CSS_NEW = """\
  .canvas-truth-strip { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid rgba(251,191,36,.66); border-radius: 9px; background: rgba(15,23,42,.92); box-shadow: 0 4px 18px rgba(0,0,0,.32); backdrop-filter: blur(7px); pointer-events: none; }
  .canvas-truth-strip[hidden] { display: none; }
  .canvas-truth-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .canvas-truth-label { color: #fcd34d; font-size: 10px; font-weight: 900; letter-spacing: .2px; }
  .canvas-truth-list { min-width: 0; list-style: none; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 3px; }
  .canvas-truth-item { min-width: 0; padding: 3px 2px; border: 1px solid rgba(251,191,36,.42); border-radius: 5px; background: rgba(41,32,12,.92); text-align: center; line-height: 1.05; }
  .canvas-truth-number { display: block; color: #fcd34d; font-size: 9px; font-weight: 800; }
  .canvas-truth-value { display: block; margin-top: 2px; color: #fef3c7; font: 700 10px/1.05 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
  .canvas-truth-values { align-self: stretch; min-width: 82px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; padding: 4px 6px; border-radius: 6px; background: rgba(180,120,10,.28); color: #fde68a; font-size: 11px; font-weight: 900; line-height: 1.1; white-space: nowrap; }
  .canvas-truth-values > span + span { width: 100%; padding-top: 3px; border-top: 1px solid rgba(253,230,138,.28); text-align: center; }
"""

# 좁은 화면에서 예상 박스는 6열로 접힌다. 정답 리스트도 같이 접어야 줄이 깨지지 않는다.
NARROW_OLD_1 = """\
    .canvas-width-list { grid-template-columns: repeat(6, minmax(0, 1fr)); }
"""

# ② 마크업: 라벨 + 치아별 리스트 + 합계
MARKUP_OLD = """\
        <section class="canvas-truth-strip" id="canvasTruthStrip" hidden role="region" aria-label="전문가 정답 EZL TZL 길이">
          <span class="canvas-truth-label">정답(전문가)</span>
          <output class="canvas-truth-values" id="canvasTruthValues">
            <span id="canvasTruthTzl">정답 TZL -</span>
            <span id="canvasTruthEzl">정답 EZL -</span>
            <span id="canvasTruthDiff">정답 TZL−EZL -</span>
          </output>
        </section>
"""

MARKUP_NEW = """\
        <section class="canvas-truth-strip" id="canvasTruthStrip" hidden role="region" aria-label="전문가 정답 치아별 좌우폭과 EZL TZL 길이">
          <div class="canvas-truth-main">
            <span class="canvas-truth-label" id="canvasTruthLabel">정답(전문가) · 치아별 좌우폭</span>
            <ol class="canvas-truth-list" id="canvasTruthList"></ol>
          </div>
          <output class="canvas-truth-values" id="canvasTruthValues">
            <span id="canvasTruthTzl">정답 TZL -</span>
            <span id="canvasTruthEzl">정답 EZL -</span>
            <span id="canvasTruthDiff">정답 TZL−EZL -</span>
          </output>
        </section>
"""

# ③ 룩업 가드 완화: 폭 정답만 있어도 채택(EZ는 있으면 쓰고 없으면 EZL 생략)
GUARD_OLD = """\
        const found = window.TRUTH_LOOKUP[window.sha256Hex(window.dataUrlToBytes(imageData))];
        if (found && Array.isArray(found.ezPoints) && found.ezPoints.length >= 2
            && Array.isArray(found.toothWidths) && found.toothWidths.length >= 1) record = found;
"""

GUARD_NEW = """\
        const found = window.TRUTH_LOOKUP[window.sha256Hex(window.dataUrlToBytes(imageData))];
        // 폭 정답만 있고 EZ 정답이 없는 케이스가 다수(329/442)다. 폭 2개 이상이면 채택하고
        // EZL은 계산 불가로 두면 된다. EZ만 있는 레코드도 EZL만 보여주면 된다.
        if (found && (
              (Array.isArray(found.toothWidths) && found.toothWidths.length >= 2)
              || (Array.isArray(found.ezPoints) && found.ezPoints.length >= 2)
            )) record = found;
"""

# ④ 표시 로직 전면 교체: 치아별 길이 + 스케일 기준 분기
RENDER_OLD = """\
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
"""

RENDER_NEW = """\
  // 정답 레코드의 px→mm 배율. ⚠️ 두 기준이 섞여 있다.
  //   · EZ 정답이 있으면 EZ 현 / molarMm  ← calculateMetricsFor와 동일(기존 수치 유지)
  //   · 없으면 폭 최외곽 스팬 / molarMm    ← 이때 EZL은 정의되지 않으므로 표시하지 않는다
  function truthPxPerMm(record) {
    const molarMm = Number(document.getElementById('molarMm').value) || 54;
    if (!(molarMm > 0)) return 0;
    const ez = record.ezPoints;
    if (Array.isArray(ez) && ez.length >= 2) {
      return Math.hypot(ez[ez.length - 1].x - ez[0].x, ez[ez.length - 1].y - ez[0].y) / molarMm;
    }
    if (Number.isFinite(record.scalePx) && record.scalePx > 0) return record.scalePx / molarMm;
    const widths = record.toothWidths || [];
    let span = 0;
    for (let i = 0; i < widths.length; i++) {
      for (const a of [widths[i].p1, widths[i].p2]) {
        for (let j = i; j < widths.length; j++) {
          for (const b of [widths[j].p1, widths[j].p2]) {
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d > span) span = d;
          }
        }
      }
    }
    return span > 0 ? span / molarMm : 0;
  }

  function updateCanvasTruthStrip() {
    const strip = document.getElementById('canvasTruthStrip');
    if (!strip) return;
    const label = document.getElementById('canvasTruthLabel');
    const list = document.getElementById('canvasTruthList');
    const tzlOutput = document.getElementById('canvasTruthTzl');
    const ezlOutput = document.getElementById('canvasTruthEzl');
    const diffOutput = document.getElementById('canvasTruthDiff');
    const record = image ? truthRecordForCurrentImage() : null;

    const hide = () => {
      strip.hidden = true;
      strip.removeAttribute('data-truth-id');
      strip.removeAttribute('data-scale-ref');
      if (list) list.replaceChildren();
      if (tzlOutput) tzlOutput.textContent = '정답 TZL -';
      if (ezlOutput) ezlOutput.textContent = '정답 EZL -';
      if (diffOutput) diffOutput.textContent = '정답 TZL−EZL -';
    };

    if (!record) { hide(); return; }
    const pxPerMm = truthPxPerMm(record);
    if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) { hide(); return; }

    const widths = Array.isArray(record.toothWidths) ? record.toothWidths : [];
    const hasEz = Array.isArray(record.ezPoints) && record.ezPoints.length >= 2;
    // 치아별 정답 폭. 번호는 정답의 toothNo를 그대로 쓴다(결손이 있으면 번호가 건너뛴다).
    const values = widths.map((w, i) => ({
      number: Number.isFinite(w.toothNo) ? w.toothNo : (i + 1),
      mm: Math.hypot(w.p2.x - w.p1.x, w.p2.y - w.p1.y) / pxPerMm
    })).filter(item => Number.isFinite(item.mm));
    if (!values.length && !hasEz) { hide(); return; }

    if (list) {
      list.innerHTML = values.map(item => {
        const mm = item.mm.toFixed(1);
        return '<li class="canvas-truth-item" data-tooth-number="' + item.number + '" data-value-mm="' + mm
          + '" aria-label="' + item.number + '번 치아 정답 좌우폭 ' + mm + ' 밀리미터">'
          + '<span class="canvas-truth-number">' + item.number + '번</span>'
          + '<span class="canvas-truth-value">' + mm + ' mm</span></li>';
      }).join('');
    }

    const tzl = values.reduce((sum, item) => sum + item.mm, 0);
    const metrics = hasEz ? calculateMetricsFor(record.ezPoints, widths) : null;
    const ezl = metrics && Number.isFinite(metrics.ezl) ? metrics.ezl : null;

    if (tzlOutput) tzlOutput.textContent = values.length
      ? '정답 TZL ' + tzl.toFixed(1) + ' mm' : '정답 TZL -';
    if (ezlOutput) ezlOutput.textContent = ezl !== null
      ? '정답 EZL ' + ezl.toFixed(1) + ' mm' : '정답 EZL -';
    if (diffOutput) {
      if (ezl !== null && values.length) {
        const diff = tzl - ezl;   // 예상 박스와 같은 부호 규약(TZL−EZL)
        diffOutput.textContent = '정답 TZL−EZL ' + (diff >= 0 ? '+' : '') + diff.toFixed(1) + ' mm';
      } else {
        diffOutput.textContent = '정답 TZL−EZL -';
      }
    }
    if (label) {
      // 스케일 기준이 EZ 현이 아니면(EZ 정답 없음) 그 사실을 라벨에 명시한다.
      label.textContent = '정답(전문가) · 치아별 좌우폭 ' + values.length + '개'
        + (hasEz ? '' : ' · 폭 최외곽 스팬 기준(EZ 정답 없음)');
    }
    if (record.id) strip.dataset.truthId = String(record.id);
    strip.dataset.scaleRef = hasEz ? 'ezChord' : 'widthOuterSpan';
    strip.hidden = false;
  }
"""

REPLACEMENTS = [
    ("css", CSS_OLD, CSS_NEW, 1),
    ("markup", MARKUP_OLD, MARKUP_NEW, 1),
    ("guard", GUARD_OLD, GUARD_NEW, 1),
    ("render", RENDER_OLD, RENDER_NEW, 1),
]


def main() -> None:
    raw_before = RESEARCH.read_bytes()
    text = RESEARCH.read_text(encoding="utf-8")

    if "canvasTruthList" in text:
        raise SystemExit("truth tooth list already present - refusing to duplicate")

    for name, old, new, expected in REPLACEMENTS:
        count = text.count(old)
        if count != expected:
            raise SystemExit(f"{name}: expected {expected} match, found {count}")
        text = text.replace(old, new)

    # 좁은 화면 6열 규칙 2군데(@media)에 정답 리스트도 함께 추가
    narrow_count = text.count(NARROW_OLD_1)
    if narrow_count != 2:
        raise SystemExit(f"narrow media rule: expected 2 matches, found {narrow_count}")
    text = text.replace(
        NARROW_OLD_1,
        NARROW_OLD_1 + "    .canvas-truth-list { grid-template-columns: repeat(6, minmax(0, 1fr)); }\n")

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
