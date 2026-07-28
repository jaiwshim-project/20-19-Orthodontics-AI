#!/usr/bin/env node
// 지적: "측정 결과(오른쪽 패널) EZL 83.4 / TZL 87.9 / 차이 -4.5 — 측정이니 정답이니?
//        왼쪽에 보이는 정답과 같은 수치로 보인다."
//
// 코드 사실: 측정 결과 패널은 calculateEZL()이 갱신하고, 그 함수는 전역 ezPoints/
// toothWidths를 읽는다. showTruth()는 정답 좌표를 그 전역에 **써넣는다**. 즉 이 패널은
// 자동분석 전용 표시가 아니라 **현재 측정 상태**의 표시다. 그러면 정답 확인을 누른 뒤에는
// 정답이 보이는 게 맞다. 추론 대신 3단계에서 직접 읽어 비교한다.
//
//   ① 자동분석 → 초안 적용   → 측정 결과 패널 = 자동분석 값이어야 한다(정답과 달라야)
//   ② `✔ 정답 확인` 클릭      → 측정 결과 패널 = 정답과 같아야 한다(설계된 동작)
//   ③ `자동 분석 적용 전 복원` → 다시 자동분석 값으로 돌아와야 한다
//
// 출력: 콘솔 요약 + metric_panel_repro.json (PHI·파일명·좌표 없음)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MOLAR_MM = 54;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function walk(dir, found = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return found; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let info;
    try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.')) walk(full, found); }
    else if (/\.(jpe?g|png)$/i.test(name)) found.push(full);
  }
  return found;
}

// --- 앱의 EZL 계산을 독립 구현(정답 EZL·TZL을 밖에서 계산해 대조하기 위해) ---
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
              + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
              + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}
function generateCurve(pts) {
  if (pts.length < 2) return [];
  if (pts.length === 2) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let j = 0; j < 25; j++) out.push(catmullRom(p0, p1, p2, p3, j / 25));
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function cumulative(curve) {
  const cum = [0];
  for (let i = 1; i < curve.length; i++) cum.push(cum[i - 1] + dist(curve[i], curve[i - 1]));
  return cum;
}
function projectArc(pt, curve, cum) {
  let best = Infinity, bestArc = 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dd = (pt.x - (a.x + dx * t)) ** 2 + (pt.y - (a.y + dy * t)) ** 2;
    if (dd < best) { best = dd; bestArc = cum[i - 1] + Math.sqrt(l2) * t; }
  }
  return bestArc;
}
function correctedCurveLength(curve, widths) {
  const valid = (widths || []).filter((w) => w && w.p1 && w.p2);
  if (curve.length < 2 || !valid.length) return null;
  const cum = cumulative(curve);
  const segs = valid.map((w) => {
    const a = projectArc(w.p1, curve, cum), b = projectArc(w.p2, curve, cum);
    return [Math.min(a, b), Math.max(a, b)];
  }).sort((x, y) => x[0] - y[0]);
  let union = 0, curS = segs[0][0], curE = segs[0][1];
  for (let i = 1; i < segs.length; i++) {
    if (segs[i][0] <= curE) curE = Math.max(curE, segs[i][1]);
    else { union += curE - curS; curS = segs[i][0]; curE = segs[i][1]; }
  }
  return union + curE - curS;
}

const html = readFileSync(HTML, 'utf8');
const marker = 'window.TRUTH_LOOKUP=';
const from = html.indexOf(marker) + marker.length;
const lookup = JSON.parse(html.slice(from, html.indexOf('\n', from)).replace(/;\s*$/, ''));

// EZ 정답까지 있는 케이스로 시험한다(측정 결과 패널의 EZL은 EZ 좌표가 있어야 계산된다).
let sample = null;
for (const file of walk(PROJECT)) {
  let sha;
  try { sha = sha256(readFileSync(file)); } catch { continue; }
  const record = lookup[sha];
  if (record && (record.ezPoints || []).length >= 12 && (record.toothWidths || []).length >= 12) {
    sample = { file, record };
    break;
  }
}
if (!sample) throw new Error('no suitable trained image found');

const ez = sample.record.ezPoints;
const pxPerMmTruth = dist(ez[ez.length - 1], ez[0]) / MOLAR_MM;
const truthTzl = sample.record.toothWidths.reduce((s, w) => s + dist(w.p1, w.p2), 0) / pxPerMmTruth;
const curve = generateCurve(ez);
const truthEzl = correctedCurveLength(curve, sample.record.toothWidths) / pxPerMmTruth;
const truth = {
  ezl: +truthEzl.toFixed(1), tzl: +truthTzl.toFixed(1),
  difference: +(truthEzl - truthTzl).toFixed(1), pxPerMm: +pxPerMmTruth.toFixed(2),
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

// ⚠️ 앱 스크립트는 IIFE 안이라 analysisState 같은 내부 변수를 page.evaluate로 읽을 수
//    없다. 앱이 내보내는 DOM 신호 dataset.analysisState를 쓴다.
const readPanel = () => page.evaluate(() => {
  const num = (id) => {
    const t = document.getElementById(id)?.textContent || '';
    const m = t.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  return {
    analysisState: document.documentElement.dataset.analysisState || null,
    ezl: num('ezlValue'), pxPerMm: num('scaleValue'), tzl: num('widthTotalValue'),
    difference: num('differenceValue'),
    toothCount: num('toothCount'), ezCount: num('ezCount'), widthCount: num('widthCount'),
    metricSourceBadge: document.getElementById('metricSource')?.textContent || null,
    metricSourceKind: document.getElementById('metricSource')?.dataset.source || null,
    detailSourceKind: document.getElementById('coordSource')?.dataset.source || null,
    canvasTruthTzl: document.getElementById('canvasTruthTzl')?.textContent || null,
    canvasAutoTzl: document.getElementById('canvasWidthTzl')?.textContent || null,
    buildBadge: document.getElementById('buildBadge')?.textContent || null,
  };
});

await (await page.$('#fileInput')).uploadFile(sample.file);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));

await page.click('#autoAnalyzeBtn');
await page.waitForFunction(
  "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
  { timeout: 300000, polling: 500 });
await new Promise((r) => setTimeout(r, 1200));

if ((await page.evaluate(() => document.getElementById('applyAutoBtn')?.disabled)) === false) {
  await page.click('#applyAutoBtn');
  await new Promise((r) => setTimeout(r, 1500));
}
const afterApply = await readPanel();

await page.click('#truthCheckBtn');
await new Promise((r) => setTimeout(r, 1500));
const afterTruth = await readPanel();

// 복원: 정답을 본 뒤 자동분석 값으로 되돌아가는지(정답이 상태에 남아 오염되지 않는지)
let afterRestore = null;
if ((await page.evaluate(() => document.getElementById('restoreAutoBtn')?.disabled)) === false) {
  await page.click('#restoreAutoBtn');
  await new Promise((r) => setTimeout(r, 1500));
  afterRestore = await readPanel();
}
await browser.close();

const near = (a, b, tol = 0.15) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const diffOf = (a, b) => (Number.isFinite(a) && Number.isFinite(b)) ? +Math.abs(a - b).toFixed(2) : null;

const checks = {
  noPageErrors: pageErrors.length === 0,
  // ⭐ 초안 적용 후 측정 결과 패널은 자동분석 값 — 정답과 **같으면 안 된다**.
  panelAfterApplyIsNotTruthTzl: !near(afterApply.tzl, truth.tzl),
  panelAfterApplyIsNotTruthEzl: !near(afterApply.ezl, truth.ezl),
  // ⭐ 정답 확인 후에는 정답과 **같아야** 한다(설계된 동작 — 사용자가 본 상황).
  panelAfterTruthMatchesTruthTzl: near(afterTruth.tzl, truth.tzl),
  panelAfterTruthMatchesTruthEzl: near(afterTruth.ezl, truth.ezl),
  panelAfterTruthMatchesTruthScale: near(afterTruth.pxPerMm, truth.pxPerMm, 0.02),
  // 새 배지: 측정 결과 패널 자체가 출처를 말해야 한다.
  metricBadgeAutoAfterApply: afterApply.metricSourceKind === 'auto',
  metricBadgeTruthAfterTruth: afterTruth.metricSourceKind === 'truth',
  metricBadgeAgreesWithDetailBadge: afterTruth.metricSourceKind === afterTruth.detailSourceKind,
  // 복원하면 자동분석 값으로 돌아와야 한다(정답이 상태에 남지 않는다).
  restoreReturnsToAuto: afterRestore ? !near(afterRestore.tzl, truth.tzl) : true,
  restoreBadgeNotTruth: afterRestore ? afterRestore.metricSourceKind !== 'truth' : true,
};

const report = {
  schemaVersion: 'metric-panel-repro-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: ('오른쪽 "측정 결과" 패널의 출처 확인. 이 패널은 calculateEZL()이 전역 측정 상태를 '
         + '읽어 갱신하므로 정답 확인 후에는 정답을 표시한다. 사진은 SHA-256 일치로만 선택했고 '
         + '파일명·SHA·좌표는 기록하지 않는다. 길이(mm)는 좌표가 아닌 파생 계측값이다.'),
  independentTruth: truth,
  stages: { afterApply, afterTruth, afterRestore },
  distances: {
    panelVsTruthAfterApplyTzlMm: diffOf(afterApply.tzl, truth.tzl),
    panelVsTruthAfterApplyEzlMm: diffOf(afterApply.ezl, truth.ezl),
    panelVsTruthAfterTruthTzlMm: diffOf(afterTruth.tzl, truth.tzl),
    panelVsTruthAfterTruthEzlMm: diffOf(afterTruth.ezl, truth.ezl),
  },
  pageErrors,
  checks,
  pass: Object.values(checks).every((v) => v === true),
};
writeFileSync(path.join(HERE, 'metric_panel_repro.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

const show = (label, s) => s && console.log(
  `${label} EZL ${s.ezl} / px/mm ${s.pxPerMm} / TZL ${s.tzl} / 차이 ${s.difference}`
  + `  [배지 ${s.metricSourceBadge}]`);
console.log(`독립계산 정답     EZL ${truth.ezl} / px/mm ${truth.pxPerMm} / TZL ${truth.tzl} / 차이 ${truth.difference}`);
show('초안 적용 후     ', afterApply);
show('정답 확인 후     ', afterTruth);
show('적용 전 복원 후  ', afterRestore);
console.log('최대차 mm:', JSON.stringify(report.distances));
console.log('build:', afterApply.buildBadge);
for (const [k, v] of Object.entries(checks)) console.log(' ', v ? 'OK  ' : 'FAIL', k);
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
