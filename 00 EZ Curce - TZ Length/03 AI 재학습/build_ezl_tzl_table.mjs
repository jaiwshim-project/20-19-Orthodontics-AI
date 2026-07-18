#!/usr/bin/env node
// 114개 치아 데이터(EZ 폴더 · TS 폴더)의 전문가 정답 EZL/TZL/차이 표 생성.
// - EZL: EZ 점을 잇는 Catmull-Rom 곡선의 호 길이 (evaluate_baseline.mjs와 동일한 방식)
// - TZL: 12개 치아폭 선분(p1-p2) 길이의 합
// - 스케일: EZ 곡선 양끝점(chord)을 어금니 간 거리 54mm로 고정 -> mm/px
// 파일번호(파일명 stem) 기준으로 EZ와 TS를 1:1 매칭한다.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const EZ_DIR = path.join(PROJECT, '02 이퀼리브리엄 찍기');
const TS_DIR = path.join(PROJECT, 'TS');
// 아래 상수·계산 로직은 파이프라인 공식 정답 계산기(evaluate_baseline.mjs)와 동일하게 맞춘다.
const SCALE_CHORD_MM = 54;
const SAMPLES_PER_SEGMENT = 50;   // CURVE_DENSE_SAMPLES_PER_SEGMENT
const COMPARE_POINTS = 200;       // CURVE_COMPARE_POINTS
const GAP_THRESHOLD = 25;         // 치아 간격 합 "큰" 기준(mm) = 완전케이스 평균(18.9)+1SD(6.5)≈25

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function generateCatmullRom(points) {
  if (points.length < 2) return [];
  if (points.length === 2) return points.slice();
  const result = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < SAMPLES_PER_SEGMENT; j += 1) result.push(catmull(p0, p1, p2, p3, j / SAMPLES_PER_SEGMENT));
  }
  result.push(points[points.length - 1]);
  return result;
}

function resampleByArcLength(points, count) {
  if (!Array.isArray(points) || points.length === 0 || count <= 0) return [];
  if (count === 1) return [{ ...points[0] }];
  if (points.length === 1) return Array.from({ length: count }, () => ({ ...points[0] }));
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + dist(points[i - 1], points[i]));
  const total = cumulative[cumulative.length - 1];
  if (total <= 1e-12) return Array.from({ length: count }, () => ({ ...points[0] }));
  const out = [];
  let cursor = 1;
  for (let k = 0; k < count; k += 1) {
    const target = total * k / (count - 1);
    while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor += 1;
    const lo = Math.max(0, cursor - 1), hi = cursor;
    const span = cumulative[hi] - cumulative[lo];
    const t = span <= 1e-12 ? 0 : (target - cumulative[lo]) / span;
    out.push({ x: points[lo].x + (points[hi].x - points[lo].x) * t, y: points[lo].y + (points[hi].y - points[lo].y) * t });
  }
  return out;
}

function polyLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i += 1) s += dist(pts[i - 1], pts[i]);
  return s;
}

// 파이프라인 buildCurve와 동일: Catmull-Rom 조밀 생성 -> 200점 arc-length 재표본화 -> 길이/chord
function buildCurve(pts) {
  const generated = generateCatmullRom(pts);
  const dense = resampleByArcLength(generated, COMPARE_POINTS);
  return { lengthPx: polyLength(dense), chordPx: dist(dense[0], dense[dense.length - 1]) };
}

// 조밀 폴리라인 + 누적 호길이 (점 투영용)
function densifyWithCum(pts) {
  const d = generateCatmullRom(pts);
  const cum = [0];
  for (let i = 1; i < d.length; i += 1) cum.push(cum[i - 1] + dist(d[i - 1], d[i]));
  return { d, cum };
}

// 점을 조밀 폴리라인에 투영해 누적 호길이(위치) 반환
function projectArc(pt, d, cum) {
  let best = Infinity, bestArc = 0;
  for (let i = 1; i < d.length; i += 1) {
    const a = d[i - 1], b = d[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + dx * t, py = a.y + dy * t;
    const dd = (pt.x - px) ** 2 + (pt.y - py) ** 2;
    if (dd < best) { best = dd; bestArc = cum[i - 1] + Math.sqrt(L2) * t; }
  }
  return bestArc;
}

// 보정 EZL(px): EZ 곡선 위에서 "치아가 실제 점유하는 호 구간"만 합산(치아 간 간격 제외).
// 각 치아 p1·p2를 곡선에 투영해 [min,max] 호구간을 얻고, 겹침(총생)은 union 병합으로 1회만 계산.
function correctedEzlPx(ezPts, toothWidths) {
  const { d, cum } = densifyWithCum(ezPts);
  const segs = toothWidths
    .filter(w => w?.p1 && w?.p2 && Number.isFinite(w.p1.x) && Number.isFinite(w.p2.x))
    .map(w => {
      const a = projectArc(w.p1, d, cum), b = projectArc(w.p2, d, cum);
      return [Math.min(a, b), Math.max(a, b)];
    });
  if (!segs.length) return 0;
  segs.sort((x, y) => x[0] - y[0]);
  let union = 0, curS = segs[0][0], curE = segs[0][1];
  for (let i = 1; i < segs.length; i += 1) {
    if (segs[i][0] <= curE) curE = Math.max(curE, segs[i][1]);
    else { union += curE - curS; curS = segs[i][0]; curE = segs[i][1]; }
  }
  union += curE - curS;
  return union;
}

// 치아 간 간격 합(px): 인접 치아 선분의 끝점(p2_i) ~ 다음 치아 시작점(p1_{i+1}) 직선거리 합
function toothGapPx(toothWidths) {
  const tw = toothWidths.filter(w => w?.p1 && w?.p2 && Number.isFinite(w.p1.x) && Number.isFinite(w.p2.x));
  let gap = 0;
  for (let i = 1; i < tw.length; i += 1) gap += dist(tw[i - 1].p2, tw[i].p1);
  return gap;
}

function stem(name) { return path.basename(name, path.extname(name)); }

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 웹에서 보기 좋은 정렬 가능 HTML 표 생성
function buildHtml(rows, stat, SCALE_CHORD_MM) {
  const c = stat['완전(치아폭12개)'];
  const p = stat['불완전(치아폭10~11개·치아결손)'];
  const pctTzl = c.사례수 ? Math.round(c['TZL>보정EZL건수'] / c.사례수 * 100) : 0;
  const bigGapCount = rows.filter(r => r.toothCount === 12 && r.gapMm !== null && r.gapMm >= GAP_THRESHOLD).length;

  const bodyRows = rows.map((r, i) => {
    const complete = r.toothCount === 12 ? '완전' : (r.toothCount ? '불완전' : '—');
    const cls = r.toothCount === 12 ? '' : (r.toothCount ? 'partial' : 'nocalc');
    const largerCls = r.larger === 'TZL' ? 'tzl' : (r.larger === 'EZL' ? 'ezl' : '');
    const num = v => (v === null || v === undefined) ? '—' : v.toFixed(2);
    return `<tr class="${cls}">
<td class="num">${i + 1}</td>
<td class="mono">${esc(r.caseId)}</td>
<td class="num">${r.toothCount ?? '—'}</td>
<td class="num">${r.ezPoints ?? '—'}</td>
<td><span class="badge ${cls || 'ok'}">${complete}</span></td>
<td class="num" style="color:#999">${num(r.ezlMm)}</td>
<td class="num"><b>${num(r.ezlAdjMm)}</b></td>
<td class="num">${num(r.tzlMm)}</td>
<td class="num ${r.gapMm >= GAP_THRESHOLD ? 'biggap' : ''}">${num(r.gapMm)}</td>
<td class="num ${r.diffMm > 0 ? 'pos' : (r.diffMm < 0 ? 'neg' : '')}">${r.diffMm === null ? '—' : (r.diffMm > 0 ? '+' : '') + r.diffMm.toFixed(2)}</td>
<td class="num">${r.ratio ?? '—'}</td>
<td><span class="tag ${largerCls}">${esc(r.larger || '—')}</span></td>
<td class="note">${esc(r.note)}</td>
</tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>EZL · TZL 114개 치아 데이터 분석표</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Malgun Gothic', -apple-system, sans-serif; margin: 0; background: #f4f6f9; color: #222; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #667; font-size: 13px; margin-bottom: 20px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card .label { font-size: 12px; color: #789; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .card .value small { font-size: 13px; font-weight: 400; color: #789; }
  .card.hl { background: linear-gradient(135deg,#2b6cb0,#3182ce); color: #fff; }
  .card.hl .label, .card.hl .value small { color: #cfe3f7; }
  .defbox { background: #eef4fb; border-left: 4px solid #3182ce; border-radius: 6px; padding: 12px 16px; font-size: 13px; line-height: 1.7; margin-bottom: 20px; }
  .defbox b { color: #2b6cb0; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar input { padding: 7px 10px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 13px; }
  .toolbar label { font-size: 13px; color: #556; display: flex; align-items: center; gap: 5px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; }
  thead th { background: #2d3748; color: #fff; padding: 10px 8px; text-align: center; cursor: pointer; user-select: none; white-space: nowrap; position: sticky; top: 0; }
  thead th:hover { background: #3a4a63; }
  thead th::after { content: ' ⇅'; opacity: .4; font-size: 11px; }
  tbody td { padding: 7px 8px; border-bottom: 1px solid #edf0f4; text-align: center; }
  tbody tr:hover { background: #f7fafc; }
  tr.partial { background: #fffbea; }
  tr.partial:hover { background: #fff5d6; }
  tr.nocalc { background: #fde8e8; color: #999; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: 'Consolas', monospace; text-align: left; }
  .note { text-align: left; color: #a05a00; font-size: 12px; }
  .pos { color: #2f855a; font-weight: 600; }
  .neg { color: #c53030; font-weight: 600; }
  .biggap { color: #b7791f; font-weight: 700; background: #fff7e6; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.ok { background: #c6f6d5; color: #22543d; }
  .badge.partial { background: #feebc8; color: #7b341e; }
  .badge.nocalc { background: #fed7d7; color: #742a2a; }
  .tag { padding: 2px 9px; border-radius: 6px; font-size: 12px; font-weight: 700; }
  .tag.tzl { background: #bee3f8; color: #2a4365; }
  .tag.ezl { background: #fbb6ce; color: #702459; }
  .tabs { display: flex; gap: 6px; margin-bottom: 18px; border-bottom: 2px solid #d7dee7; }
  .tab { padding: 10px 20px; font-size: 14px; font-weight: 600; color: #667; cursor: pointer; border: none; background: none; border-bottom: 3px solid transparent; margin-bottom: -2px; }
  .tab:hover { color: #2b6cb0; }
  .tab.active { color: #2b6cb0; border-bottom-color: #3182ce; }
  .panel { display: none; }
  .panel.active { display: block; }
  .frame-wrap { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .frame-wrap iframe { width: 100%; height: 82vh; border: 0; display: block; }
</style>
</head>
<body>
<div class="wrap">
  <h1>EZL · TZL 114개 치아 데이터 분석</h1>
  <div class="sub">전문가 정답 기준 · EZL = EZ점 Catmull-Rom 곡선 호 길이 · TZL = 12개 치아폭 선분 길이 합 · 스케일 = 어금니간 ${SCALE_CHORD_MM}mm</div>

  <div class="tabs">
    <button class="tab active" onclick="showTab('table', this)">📊 분석표</button>
    <button class="tab" onclick="showTab('compareEzl', this)">🖼️ EZL &gt; TZL 사진 비교 보기</button>
    <button class="tab" onclick="showTab('compareTzl', this)">🖼️ TZL &gt; EZL 사진 비교 보기</button>
    <button class="tab" onclick="showTab('compareGap', this)">🦷 치아 간격 큰 사례 보기</button>
    <button class="tab" onclick="showTab('compareInflate', this)">📈 EZL 증가 원인 보기</button>
  </div>

  <div class="panel active" id="panel-table">

  <div class="cards">
    <div class="card"><div class="label">총 파일</div><div class="value">${stat.총파일}<small> 개</small></div></div>
    <div class="card"><div class="label">완전 케이스 (치아 12개)</div><div class="value">${c.사례수}<small> 건</small></div></div>
    <div class="card"><div class="label">평균 EZL (보정)</div><div class="value">${c.평균EZL_보정}<small> mm</small></div></div>
    <div class="card"><div class="label">평균 TZL</div><div class="value">${c.평균TZL}<small> mm</small></div></div>
    <div class="card hl"><div class="label">평균 차이 (TZL−보정EZL)</div><div class="value">+${c.평균차이_TZL_보정EZL}<small> mm</small></div></div>
    <div class="card"><div class="label">TZL &gt; 보정EZL</div><div class="value">${c['TZL>보정EZL건수']}<small> 건 (${pctTzl}%)</small></div></div>
  </div>

  <div class="defbox">
    <b>정의</b> — <b>EZL(곡선원본)</b>: EZ 점을 잇는 Catmull-Rom 곡선의 호 길이 &nbsp;|&nbsp; <b>EZL(보정)</b>: 곡선 위에서 치아가 점유하는 호 구간만(치아 간 간격 제외) &nbsp;|&nbsp; <b>TZL</b>: 12개 치아폭 선분(p1–p2) 길이의 합 &nbsp;|&nbsp; <b>스케일</b>: EZ 곡선 양끝 chord = ${SCALE_CHORD_MM}mm 고정<br>
    ※ EZ 곡선의 <b>위치·표기는 원본 그대로</b>이며, 길이 계산 시에만 치아 간 간격을 제외해 TZL과 동일 기준(치아만)으로 비교합니다. 대소·차이 판정은 <b>보정 EZL 기준</b>.<br>
    <b>완전 케이스 ${c.사례수}건</b>: TZL&gt;보정EZL ${c['TZL>보정EZL건수']}건 / 보정EZL&gt;TZL ${c['보정EZL>TZL건수']}건 &nbsp;·&nbsp;
    <b>불완전(치아결손) ${typeof p === 'object' ? p.사례수 : 0}건</b>: 치아 10~11개로 TZL 과소평가 → 노란 배경, 참고용 &nbsp;·&nbsp; 계산불가 ${stat.계산불가}건 (빨간 배경)<br>
    <b>치아 간격 합 ≥ ${GAP_THRESHOLD}mm</b>(주황 강조 = 간격 큼, 완전케이스 평균+1SD): <b>${bigGapCount}건</b> — [🦷 치아 간격 큰 사례 보기] 탭에서 사진 확인
  </div>

  <div class="toolbar">
    <input id="q" type="text" placeholder="🔍 파일번호 검색..." oninput="filterRows()">
    <label><input type="checkbox" id="only12" onchange="filterRows()"> 완전(12개)만 보기</label>
    <label><input type="checkbox" id="onlyEz" onchange="filterRows()"> 보정EZL&gt;TZL만 보기</label>
    <span id="count" style="margin-left:auto;color:#667;font-size:13px;"></span>
  </div>

  <table id="tbl">
    <thead><tr>
      <th onclick="sortBy(0,'n')">#</th>
      <th onclick="sortBy(1,'s')">파일번호</th>
      <th onclick="sortBy(2,'n')">치아개수</th>
      <th onclick="sortBy(3,'n')">EZ점</th>
      <th onclick="sortBy(4,'s')">완전성</th>
      <th onclick="sortBy(5,'n')">EZL 곡선원본(mm)</th>
      <th onclick="sortBy(6,'n')">EZL 보정(mm)</th>
      <th onclick="sortBy(7,'n')">TZL(mm)</th>
      <th onclick="sortBy(8,'n')">치아간격 합(mm)</th>
      <th onclick="sortBy(9,'n')">차이 TZL−보정EZL</th>
      <th onclick="sortBy(10,'n')">TZL/보정EZL</th>
      <th onclick="sortBy(11,'s')">큰값</th>
      <th onclick="sortBy(12,'s')">비고</th>
    </tr></thead>
    <tbody id="tbody">
${bodyRows}
    </tbody>
  </table>
  </div><!-- /panel-table -->

  <div class="panel" id="panel-compareEzl">
    <div class="frame-wrap">
      <iframe id="frame-compareEzl" data-src="ezl_gt_tzl_compare.html" title="EZL>TZL 사진 비교"></iframe>
    </div>
  </div>

  <div class="panel" id="panel-compareTzl">
    <div class="frame-wrap">
      <iframe id="frame-compareTzl" data-src="tzl_gt_ezl_compare.html" title="TZL>EZL 사진 비교"></iframe>
    </div>
  </div>

  <div class="panel" id="panel-compareGap">
    <div class="frame-wrap">
      <iframe id="frame-compareGap" data-src="big_gap_compare.html" title="치아 간격 큰 사례"></iframe>
    </div>
  </div>

  <div class="panel" id="panel-compareInflate">
    <div class="frame-wrap">
      <iframe id="frame-compareInflate" data-src="ezl_inflate_compare.html" title="EZL 증가 원인"></iframe>
    </div>
  </div>
</div>

<script>
  function showTab(name, btn) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-' + name).classList.add('active');
    // 해당 패널에 lazy-load 대상 iframe이 있으면 첫 진입 시 로드
    const f = document.getElementById('frame-' + name);
    if (f && !f.src && f.dataset.src) f.src = f.dataset.src;
  }

  const tbody = document.getElementById('tbody');
  const allRows = Array.from(tbody.rows);
  let sortCol = -1, sortDir = 1;

  function sortBy(col, type) {
    sortDir = (sortCol === col) ? -sortDir : 1;
    sortCol = col;
    const rows = Array.from(tbody.rows);
    rows.sort((a, b) => {
      let x = a.cells[col].textContent.trim(), y = b.cells[col].textContent.trim();
      if (type === 'n') {
        x = parseFloat(x.replace('+','')) ; y = parseFloat(y.replace('+',''));
        if (isNaN(x)) x = -Infinity; if (isNaN(y)) y = -Infinity;
        return (x - y) * sortDir;
      }
      return x.localeCompare(y, 'ko') * sortDir;
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  function filterRows() {
    const q = document.getElementById('q').value.toLowerCase();
    const only12 = document.getElementById('only12').checked;
    const onlyEz = document.getElementById('onlyEz').checked;
    let shown = 0;
    for (const r of allRows) {
      const id = r.cells[1].textContent.toLowerCase();
      const is12 = r.cells[2].textContent.trim() === '12';
      const isEz = r.cells[11].textContent.trim() === 'EZL';
      const ok = id.includes(q) && (!only12 || is12) && (!onlyEz || isEz);
      r.style.display = ok ? '' : 'none';
      if (ok) shown++;
    }
    document.getElementById('count').textContent = shown + ' / ' + allRows.length + ' 행 표시';
  }
  filterRows();
</script>
</body>
</html>`;
}

async function parseMd(dir, fileName) {
  const buf = await readFile(path.join(dir, fileName));
  if (buf.length === 0) return { empty: true };
  const text = buf.toString('utf8');
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) return { noJson: true };
  try { return { json: JSON.parse(m[1]) }; } catch (e) { return { parseError: e.message }; }
}

async function main() {
  const ezFiles = (await readdir(EZ_DIR)).filter(f => /\.md$/i.test(f));
  const tsFiles = new Set((await readdir(TS_DIR)).filter(f => /\.md$/i.test(f)));
  const rows = [];

  for (const ezFile of ezFiles.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const caseId = stem(ezFile);
    const row = { caseId, ezPoints: null, toothCount: null, ezlMm: null, ezlAdjMm: null, tzlMm: null, gapMm: null, diffMm: null, ratio: null, larger: '', note: '' };

    const ez = await parseMd(EZ_DIR, ezFile);
    const hasTs = tsFiles.has(ezFile);
    const ts = hasTs ? await parseMd(TS_DIR, ezFile) : { missing: true };

    const notes = [];
    if (ez.empty || ez.noJson || ez.parseError) notes.push('EZ파일오류');
    if (!hasTs) notes.push('TS파일없음');
    else if (ts.empty) notes.push('TS빈파일');
    else if (ts.noJson || ts.parseError) notes.push('TS파일오류');

    const ezPts = ez.json?.ezPoints?.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) || [];
    const tw = ts.json?.toothWidths || [];
    row.ezPoints = ezPts.length;
    row.toothCount = tw.length;

    if (ezPts.length >= 3 && tw.length >= 1) {
      const curve = buildCurve(ezPts);
      // 스케일: 파이프라인과 동일하게 재표본화된 곡선의 양끝 chord를 54mm로 고정
      const chord = curve.chordPx;
      if (chord > 1e-6) {
        const mmPerPx = SCALE_CHORD_MM / chord;
        const ezlMm = curve.lengthPx * mmPerPx;
        let twPx = 0, twValid = 0;
        for (const w of tw) {
          if (w?.p1 && w?.p2 && Number.isFinite(w.p1.x) && Number.isFinite(w.p2.x)) { twPx += dist(w.p1, w.p2); twValid += 1; }
        }
        const tzlMm = twPx * mmPerPx;
        // 보정 EZL: 곡선에서 치아가 실제 점유하는 호 구간만(치아 간 간격 제외) — EZL/TZL을 동일 기준으로 비교
        const ezlAdjMm = correctedEzlPx(ezPts, tw) * mmPerPx;
        const gapMm = toothGapPx(tw) * mmPerPx;
        row.ezlMm = Number(ezlMm.toFixed(2));
        row.ezlAdjMm = Number(ezlAdjMm.toFixed(2));
        row.tzlMm = Number(tzlMm.toFixed(2));
        row.gapMm = Number(gapMm.toFixed(2));
        // 대소·차이는 보정 EZL 기준(원장 정의)으로 판정
        row.diffMm = Number((tzlMm - ezlAdjMm).toFixed(2));
        row.ratio = Number((tzlMm / ezlAdjMm).toFixed(3));
        row.larger = tzlMm > ezlAdjMm ? 'TZL' : (ezlAdjMm > tzlMm ? 'EZL' : '=');
        if (twValid !== 12) notes.push(`치아폭 ${twValid}개(불완전)`);
        if (ezPts.length !== 12) notes.push(`EZ점 ${ezPts.length}개`);
      } else notes.push('스케일계산불가');
    } else {
      notes.push('EZL/TZL계산불가');
    }
    row.note = notes.join('; ');
    rows.push(row);
  }

  // 통계
  const mean = (a, k) => a.reduce((s, r) => s + r[k], 0) / a.length;
  const calc = rows.filter(r => r.ezlMm !== null && r.tzlMm !== null);
  const complete = calc.filter(r => r.toothCount === 12);           // 치아폭 12개 완전 케이스
  const partial = calc.filter(r => r.toothCount !== 12);            // 치아폭 10~11개 불완전(치아 결손)
  const statOf = (a) => ({
    사례수: a.length,
    평균EZL_곡선원본: Number(mean(a, 'ezlMm').toFixed(2)),
    평균EZL_보정: Number(mean(a, 'ezlAdjMm').toFixed(2)),
    평균TZL: Number(mean(a, 'tzlMm').toFixed(2)),
    평균차이_TZL_보정EZL: Number(mean(a, 'diffMm').toFixed(2)),
    'TZL>보정EZL건수': a.filter(r => r.tzlMm > r.ezlAdjMm).length,
    '보정EZL>TZL건수': a.filter(r => r.ezlAdjMm > r.tzlMm).length,
  });
  const stat = {
    총파일: rows.length,
    계산불가: rows.length - calc.length,
    '완전(치아폭12개)': statOf(complete),
    '불완전(치아폭10~11개·치아결손)': partial.length ? statOf(partial) : '해당없음',
  };

  // xlsx 생성
  const XLSX = require('xlsx');
  const header = ['파일번호', '치아개수', 'EZ점개수', '완전성', 'EZL 곡선원본(mm)', 'EZL 보정(mm)', 'TZL(mm)', '치아간격 합(mm)', '차이 TZL-보정EZL(mm)', 'TZL/보정EZL 비율', '큰값', '비고'];
  const aoa = [header];
  for (const r of rows) {
    const completeness = r.toothCount === 12 ? '완전(12개)' : (r.toothCount ? `불완전(${r.toothCount}개)` : '');
    aoa.push([r.caseId, r.toothCount, r.ezPoints, completeness, r.ezlMm, r.ezlAdjMm, r.tzlMm, r.gapMm, r.diffMm, r.ratio, r.larger, r.note]);
  }
  aoa.push([]);
  aoa.push(['[요약 통계]']);
  aoa.push(['총파일', stat.총파일]);
  aoa.push(['계산불가(EZ점<3 등)', stat.계산불가]);
  aoa.push([]);
  aoa.push(['▶ 완전 케이스 (치아폭 12개)']);
  for (const [k, v] of Object.entries(stat['완전(치아폭12개)'])) aoa.push(['  ' + k, v]);
  aoa.push([]);
  aoa.push(['▶ 불완전 케이스 (치아폭 10~11개, 치아 결손 — 참고용, TZL 과소평가됨)']);
  if (typeof stat['불완전(치아폭10~11개·치아결손)'] === 'object') {
    for (const [k, v] of Object.entries(stat['불완전(치아폭10~11개·치아결손)'])) aoa.push(['  ' + k, v]);
  } else aoa.push(['  ' + stat['불완전(치아폭10~11개·치아결손)']]);
  aoa.push([]);
  aoa.push(['[정의]']);
  aoa.push(['EZL 곡선원본', 'EZ 점을 잇는 Catmull-Rom 곡선의 호 길이']);
  aoa.push(['EZL 보정', '곡선 위에서 치아가 점유하는 호 구간만(치아 간 간격 제외). EZ 곡선 위치·표기는 원본 그대로']);
  aoa.push(['TZL', '12개 치아폭 선분(p1-p2) 길이의 합']);
  aoa.push(['치아간격 합', '인접 치아 끝점(p2)~다음 치아 시작점(p1) 직선거리의 합. ' + GAP_THRESHOLD + 'mm 이상이면 "간격 큼"(주황 강조)']);
  aoa.push(['대소·차이·비율', '보정 EZL 기준으로 판정']);
  aoa.push(['스케일', `EZ 곡선 양끝점(chord)을 어금니 간 거리 ${SCALE_CHORD_MM}mm로 고정`]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 15 }, { wch: 13 }, { wch: 10 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 8 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'EZL_TZL_114');
  const outPath = path.join(PROJECT, 'EZL_TZL_114_분석표.xlsx');
  XLSX.writeFile(wb, outPath);

  // excel.html 생성
  const html = buildHtml(rows, stat, SCALE_CHORD_MM);
  const htmlPath = path.join(PROJECT, 'excel.html');
  await writeFile(htmlPath, html, 'utf8');

  console.log('생성 완료:');
  console.log('  xlsx:', outPath);
  console.log('  html:', htmlPath);
  console.log(JSON.stringify(stat, null, 2));
}

main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
