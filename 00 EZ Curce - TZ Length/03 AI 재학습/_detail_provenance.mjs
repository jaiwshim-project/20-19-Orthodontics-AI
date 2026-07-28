#!/usr/bin/env node
// 지적: "자동 분석 상세 수치 섹션에 보이는 수치들은 정답인 것 같다 — 확인해."
//
// 확인해야 하는 것: `USE_TRUTH_LOOKUP = false`라 자동분석이 정답을 투영하지 **않아야**
// 하는데, 하단 '자동 분석 상세 수치'(치아별 좌우폭 mm)가 정답과 같은 값이면 누출이다.
// 추론하지 않고 숫자를 직접 비교한다:
//   ① 업로드 → 자동분석 → 초안적용 상태에서 상세 수치 12칸을 읽는다
//   ② 같은 사진의 정답 폭(mm)을 룩업에서 독립 계산한다
//   ③ 상세 수치 vs 정답, 상세 수치 vs 캔버스 예상/측정 박스 값을 각각 비교한다
//   ④ 대조로 '✔ 정답 확인' 버튼을 누른 뒤에도 읽는다(이때는 정답과 같아야 정상)
//
// 출력: 콘솔 요약 + detail_provenance.json (PHI·파일명·좌표 없음)
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

const html = readFileSync(HTML, 'utf8');
const marker = 'window.TRUTH_LOOKUP=';
const from = html.indexOf(marker) + marker.length;
const lookup = JSON.parse(html.slice(from, html.indexOf('\n', from)).replace(/;\s*$/, ''));

// EZ 정답까지 있는 케이스로 시험한다(스케일 규약이 앱과 동일해 비교가 깔끔하다).
let sample = null;
for (const file of walk(PROJECT)) {
  let sha;
  try { sha = sha256(readFileSync(file)); } catch { continue; }
  const record = lookup[sha];
  if (record && (record.ezPoints || []).length >= 2 && (record.toothWidths || []).length >= 12) {
    sample = { file, record };
    break;
  }
}
if (!sample) throw new Error('no suitable trained image found');

const pxPerMm = dist(sample.record.ezPoints[sample.record.ezPoints.length - 1], sample.record.ezPoints[0]) / MOLAR_MM;
const truthWidthsMm = sample.record.toothWidths.map((w) => +(dist(w.p1, w.p2) / pxPerMm).toFixed(1));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

const readDetail = () => page.evaluate(() => {
  const nums = (root) => Array.from(root.querySelectorAll('.coord-item'))
    .map((el) => { const m = el.textContent.match(/-?\d+(\.\d+)?/g); return m ? m[m.length - 1] : null; });
  const widthGrid = document.getElementById('widthCoordGrid');
  return {
    analysisState: document.documentElement.dataset.analysisState || null,
    detailWidths: widthGrid ? nums(widthGrid).map(Number) : [],
    detailWidthSummary: document.getElementById('widthSummaryInline')?.textContent,
    detailEzSummary: document.getElementById('ezSummaryInline')?.textContent,
    canvasWidthTzl: document.getElementById('canvasWidthTzl')?.textContent,
    canvasTruthTzl: document.getElementById('canvasTruthTzl')?.textContent,
    canvasTruthItems: Array.from(document.querySelectorAll('#canvasTruthList .canvas-truth-item'))
      .map((el) => Number(el.dataset.valueMm)),
    canvasWidthItems: Array.from(document.querySelectorAll('#canvasWidthList .canvas-width-item'))
      .map((el) => Number(el.dataset.valueMm)),
    sourceBadge: document.getElementById('coordSource')?.textContent || null,
    sourceBadgeKind: document.getElementById('coordSource')?.dataset.source || null,
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
const afterPreview = await readDetail();

if ((await page.evaluate(() => document.getElementById('applyAutoBtn')?.disabled)) === false) {
  await page.click('#applyAutoBtn');
  await new Promise((r) => setTimeout(r, 1200));
}
const afterApply = await readDetail();

// 대조군: 정답 확인 버튼을 누르면 상세 수치가 정답으로 바뀌는 게 **정상**이다.
await page.click('#truthCheckBtn');
await new Promise((r) => setTimeout(r, 1200));
const afterTruthButton = await readDetail();
await browser.close();

const same = (a, b, tol = 0.15) => a.length === b.length && a.length > 0
  && a.every((v, i) => Number.isFinite(v) && Number.isFinite(b[i]) && Math.abs(v - b[i]) <= tol);
const maxAbsDiff = (a, b) => (a.length === b.length && a.length)
  ? +Math.max(...a.map((v, i) => Math.abs(v - b[i]))).toFixed(2) : null;

const checks = {
  noPageErrors: pageErrors.length === 0,
  // ⭐ 핵심: 자동분석 상세 수치가 정답과 같으면 정답 누출이다.
  detailAfterApplyIsNotTruth: !same(afterApply.detailWidths, truthWidthsMm),
  detailAfterApplyMatchesAutoCanvas: same(afterApply.detailWidths, afterApply.canvasWidthItems),
  truthCanvasItemsMatchIndependentTruth: same(afterApply.canvasTruthItems, truthWidthsMm),
  // 대조: 정답 확인 버튼 후에는 상세 수치가 정답과 같아야 한다(설계된 동작).
  detailAfterTruthButtonIsTruth: same(afterTruthButton.detailWidths, truthWidthsMm),
  // 배지: 값이 정답으로 바뀌는 순간 화면에 그 사실이 명시돼야 한다.
  badgeSaysAutoAfterApply: afterApply.sourceBadgeKind === 'auto',
  badgeSaysTruthAfterTruthButton: afterTruthButton.sourceBadgeKind === 'truth',
  // ⚠️ 배지는 **상세 섹션**의 출처를 말한다. 미리보기 단계에서는 초안이 아직 측정값에
  //    들어가지 않아 상세 섹션이 비어 있으므로(TZL -) '데이터 없음'이 맞다.
  //    첫 시도에서 'preview'를 기대했다가 FAIL이 났는데, 틀린 쪽은 기대치였다.
  //    계약은 "값이 없거나 정답이 아닌데 정답이라고 말하지 않는다"이다.
  badgeNotTruthDuringPreview: afterPreview.sourceBadgeKind !== 'truth',
  badgeMatchesEmptyDetailDuringPreview:
    afterPreview.detailWidths.length === 0 ? afterPreview.sourceBadgeKind === 'none' : true,
  buildBadgeShowsLookupCount: /정답 \d+건/.test(String(afterApply.buildBadge)),
};

const report = {
  schemaVersion: 'detail-provenance-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: ('하단 "자동 분석 상세 수치"가 정답을 투영하고 있는지 확인. 사진은 SHA-256 일치로만 선택했고 '
         + '파일명·SHA·좌표는 기록하지 않는다. 폭 길이(mm)는 좌표가 아닌 파생 계측값이다.'),
  toothCount: truthWidthsMm.length,
  distances: {
    detailVsTruthAfterApplyMaxMm: maxAbsDiff(afterApply.detailWidths, truthWidthsMm),
    detailVsAutoCanvasAfterApplyMaxMm: maxAbsDiff(afterApply.detailWidths, afterApply.canvasWidthItems),
    truthCanvasVsIndependentTruthMaxMm: maxAbsDiff(afterApply.canvasTruthItems, truthWidthsMm),
    detailVsTruthAfterTruthButtonMaxMm: maxAbsDiff(afterTruthButton.detailWidths, truthWidthsMm),
  },
  summaries: {
    afterPreview: { state: afterPreview.analysisState, width: afterPreview.detailWidthSummary,
                    canvasAuto: afterPreview.canvasWidthTzl, canvasTruth: afterPreview.canvasTruthTzl,
                    badge: afterPreview.sourceBadge },
    afterApply: { state: afterApply.analysisState, width: afterApply.detailWidthSummary,
                  canvasAuto: afterApply.canvasWidthTzl, canvasTruth: afterApply.canvasTruthTzl,
                  badge: afterApply.sourceBadge, build: afterApply.buildBadge },
    afterTruthButton: { state: afterTruthButton.analysisState, width: afterTruthButton.detailWidthSummary,
                        canvasAuto: afterTruthButton.canvasWidthTzl, canvasTruth: afterTruthButton.canvasTruthTzl,
                        badge: afterTruthButton.sourceBadge },
  },
  pageErrors,
  checks,
  pass: Object.values(checks).every((v) => v === true),
};
writeFileSync(path.join(HERE, 'detail_provenance.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('독립계산 정답 폭 (mm):', truthWidthsMm.join(' '));
console.log('상세수치(초안적용후)  :', afterApply.detailWidths.join(' '));
console.log('캔버스 자동박스 항목  :', afterApply.canvasWidthItems.join(' '));
console.log('캔버스 정답박스 항목  :', afterApply.canvasTruthItems.join(' '));
console.log('상세수치(정답확인후)  :', afterTruthButton.detailWidths.join(' '));
console.log('요약:', JSON.stringify(report.summaries, null, 1));
console.log('최대차 mm:', JSON.stringify(report.distances));
for (const [k, v] of Object.entries(checks)) console.log(' ', v ? 'OK  ' : 'FAIL', k);
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
