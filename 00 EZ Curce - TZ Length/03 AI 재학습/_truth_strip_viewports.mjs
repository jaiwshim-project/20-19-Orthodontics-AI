#!/usr/bin/env node
// "자동 분석을 실행하면 정답 섹션이 사라진다"를 1600x1000에서는 재현하지 못했다.
// 남은 유력 후보는 **화면 크기**다: 두 박스가 캔버스 영역 바닥에 쌓여 있고
// `.canvas-area { overflow: hidden }`이므로, 자동분석으로 예상 박스가 커지면
// 위에 있는 정답 박스가 영역 밖으로 밀려 잘릴 수 있다(hidden=false인데 안 보임).
// 그래서 여러 실제 해상도에서 자동분석 전/후 정답 박스의 잘림 여부를 직접 재본다.
//
// clippedTopPx > 0 이면 정답 줄의 위쪽이 실제로 잘린 것이다.
// 출력: 콘솔 표 + truth_strip_viewports.json (PHI·파일명·좌표 없음)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = process.argv[2] || path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// 실제로 흔한 노트북·모니터 해상도(브라우저 크롬 높이 감안한 뷰포트)
const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 950 },
  { name: '1600x900', width: 1600, height: 780 },
  { name: '1366x768', width: 1366, height: 650 },
  { name: '1280x720', width: 1280, height: 600 },
  { name: '1024x768', width: 1024, height: 650 },
  { name: '768 tablet', width: 768, height: 900 },
  { name: '414 mobile', width: 414, height: 800 },
];

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

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

let sample = null;
for (const file of walk(PROJECT)) {
  let sha;
  try { sha = sha256(readFileSync(file)); } catch { continue; }
  const record = lookup[sha];
  if (record && (record.toothWidths || []).length >= 12) { sample = file; break; }
}
if (!sample) throw new Error('no trained image found');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const rows = [];
const pageErrors = [];

const probe = (page) => page.evaluate(() => {
  const truth = document.getElementById('canvasTruthStrip');
  const width = document.getElementById('canvasWidthStrip');
  const area = document.getElementById('canvasArea');
  const t = truth.getBoundingClientRect();
  const w = width.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  return {
    truthHidden: truth.hidden,
    widthHidden: width.hidden,
    areaHeight: Math.round(a.height),
    truthHeight: Math.round(t.height),
    widthHeight: Math.round(w.height),
    // 캔버스 영역 위쪽으로 밀려 잘린 양(양수면 실제로 안 보인다)
    clippedTopPx: Math.max(0, Math.round(a.top - t.top)),
    truthVisibleHeight: Math.max(0, Math.round(Math.min(t.bottom, a.bottom) - Math.max(t.top, a.top))),
    stackHeight: Math.round(document.querySelector('.canvas-bottom-stack').getBoundingClientRect().height),
    truthItems: document.querySelectorAll('#canvasTruthList .canvas-truth-item').length,
  };
});

for (const viewport of VIEWPORTS) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${viewport.name}: ${String(e.message || e).slice(0, 200)}`));
  await page.setViewport({ width: viewport.width, height: viewport.height });
  await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await (await page.$('#fileInput')).uploadFile(sample);
  await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  const before = await probe(page);
  await page.click('#autoAnalyzeBtn');
  await page.waitForFunction(
    "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
    { timeout: 300000, polling: 500 });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await probe(page);
  await page.close();
  rows.push({ viewport: viewport.name, before, after,
              regression: before.clippedTopPx === 0 && after.clippedTopPx > 0 });
}
await browser.close();

const clipped = rows.filter((r) => r.after.clippedTopPx > 0).map((r) => r.viewport);
const report = {
  schemaVersion: 'truth-strip-viewports-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: '해상도별로 자동분석 전/후 정답 스트립이 캔버스 영역(overflow:hidden) 밖으로 잘리는지 실측.',
  lookupEntries: Object.keys(lookup).length,
  rows,
  viewportsWithClippingAfterAnalyze: clipped,
  pageErrors,
  pass: clipped.length === 0 && pageErrors.length === 0,
};
writeFileSync(path.join(HERE, 'truth_strip_viewports.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('viewport     area  stack  truthH  clipTop(before→after)  visibleH  hidden');
for (const r of rows) {
  console.log(`${r.viewport.padEnd(12)} ${String(r.after.areaHeight).padEnd(5)} ${String(r.after.stackHeight).padEnd(6)}`
    + ` ${String(r.after.truthHeight).padEnd(7)} ${String(r.before.clippedTopPx).padStart(4)} → ${String(r.after.clippedTopPx).padStart(4)}`
    + `            ${String(r.after.truthVisibleHeight).padEnd(9)} ${r.after.truthHidden}`);
}
console.log('clipped after analyze:', clipped.length ? clipped : 'none');
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
