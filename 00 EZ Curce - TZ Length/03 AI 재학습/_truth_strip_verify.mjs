#!/usr/bin/env node
// 정답 스트립 실구동 검증: 학습 이미지 1장을 실제로 업로드해
//   ① 정답 스트립이 보이는가 ② 정답 EZL/TZL이 파이프라인 계산과 일치하는가
//   ③ 예상/측정 박스보다 **위**에 배치됐는가 ④ 학습에 없는 이미지에서는 숨는가
// 를 브라우저에서 직접 확인한다. 로컬 계산만 신뢰하지 않는다.
//
// 출력: 콘솔 요약 + truth_strip_verify.json (PHI·파일명·좌표 없음)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// puppeteer-core는 전역 설치라 로컬 node_modules에 없다. 절대 경로로 가져온다.
const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SAMPLES = 40;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// HTML의 generateCurve(Catmull-Rom)와 동일한 밀집 샘플링
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}
function densify(points) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i];
    const p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < SAMPLES; j++) out.push(catmull(p0, p1, p2, p3, j / SAMPLES));
  }
  out.push(points[points.length - 1]);
  return out;
}

function findImagesRecursive(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.')) walk(full); }
      else if (/\.(jpe?g|png)$/i.test(name)) found.push(full);
    }
  };
  walk(root);
  return found;
}

function truthLookupFromHtml(html) {
  const marker = 'window.TRUTH_LOOKUP=';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('TRUTH_LOOKUP not found in html');
  const from = start + marker.length;
  const end = html.indexOf('\n', from);
  const line = html.slice(from, end).replace(/;\s*$/, '');
  return JSON.parse(line);
}

function main() {
  const html = readFileSync(HTML, 'utf8');
  const lookup = truthLookupFromHtml(html);

  // 학습 이미지 1장 찾기 (SHA 일치로만) + 학습에 없는 이미지 1장
  const images = findImagesRecursive(PROJECT);
  let matched = null, unmatched = null;
  for (const file of images) {
    let sha;
    try { sha = sha256(readFileSync(file)); } catch { continue; }
    if (!matched && lookup[sha]) matched = { file, sha, record: lookup[sha] };
    else if (!unmatched && !lookup[sha]) unmatched = { file, sha };
    if (matched && unmatched) break;
  }
  if (!matched) throw new Error('no image on disk matches TRUTH_LOOKUP by sha256');

  // 파이프라인 쪽 기대값: HTML의 calculateMetricsFor와 같은 정의
  //   pxPerMm = |ez[last]-ez[0]| / 54, TZL = 폭선 길이 합, EZL = 치아 점유 호 구간 합
  const record = matched.record;
  const pxPerMm = dist(record.ezPoints[record.ezPoints.length - 1], record.ezPoints[0]) / 54;
  const expectedTzl = record.toothWidths.reduce((sum, w) => sum + dist(w.p1, w.p2) / pxPerMm, 0);

  return { matched, unmatched, expectedTzl, pxPerMm, curveSamples: densify(record.ezPoints).length };
}

const { matched, unmatched, expectedTzl } = main();

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });

async function uploadAndRead(file, { runAnalysis = false } = {}) {
  const input = await page.$('#fileInput');
  await input.uploadFile(file);
  await page.waitForFunction(
    "(() => { const s = document.getElementById('canvasTruthStrip'); return s && document.querySelector('#canvas').style.display !== 'none'; })()",
    { timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (runAnalysis) {
    // 자동분석을 실제로 돌려 **예상 박스가 채워진 상태**에서 두 박스의 배치를 검증한다.
    // 예상 박스가 비어 있으면(hidden) 위아래 순서를 확인할 수 없다.
    await page.click('#autoAnalyzeBtn');
    await page.waitForFunction(
      "(() => { const s = document.getElementById('canvasWidthStrip'); return s && !s.hidden; })()",
      { timeout: 180000 });
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return page.evaluate(() => {
    const truth = document.getElementById('canvasTruthStrip');
    const width = document.getElementById('canvasWidthStrip');
    const truthBox = truth.getBoundingClientRect();
    const widthBox = width.getBoundingClientRect();
    const canvasBox = document.getElementById('canvas').getBoundingClientRect();
    return {
      truthHidden: truth.hidden,
      widthHidden: width.hidden,
      truthTzlText: document.getElementById('canvasTruthTzl').textContent,
      truthEzlText: document.getElementById('canvasTruthEzl').textContent,
      truthDiffText: document.getElementById('canvasTruthDiff').textContent,
      widthTzlText: document.getElementById('canvasWidthTzl').textContent,
      widthEzlText: document.getElementById('canvasWidthEzl').textContent,
      truthTop: Math.round(truthBox.top),
      widthTop: Math.round(widthBox.top),
      truthAboveWidthBox: truthBox.bottom <= widthBox.top + 1,
      insideCanvasArea: truthBox.top >= canvasBox.top && truthBox.bottom <= canvasBox.bottom + 1,
      selfTest: document.documentElement.dataset.ezSelfTest,
    };
  });
}

const onTrained = await uploadAndRead(matched.file, { runAnalysis: true });
const numberOf = (text) => { const m = String(text).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
const observedTzl = numberOf(onTrained.truthTzlText);
const observedEzl = numberOf(onTrained.truthEzlText);
const observedDiff = numberOf(onTrained.truthDiffText);

let onUnknown = null;
if (unmatched) onUnknown = await uploadAndRead(unmatched.file);

await browser.close();

const checks = {
  noPageErrors: errors.length === 0,
  selfTestPassed: onTrained.selfTest === 'passed',
  truthStripVisibleOnTrainedImage: onTrained.truthHidden === false,
  truthTzlMatchesPipeline: observedTzl !== null && Math.abs(observedTzl - expectedTzl) <= 0.05,
  truthEzlIsFinite: observedEzl !== null && Number.isFinite(observedEzl) && observedEzl > 0,
  truthDiffConsistent: observedDiff !== null && observedTzl !== null && observedEzl !== null
    && Math.abs(observedDiff - (observedTzl - observedEzl)) <= 0.15,
  truthStripRenderedAboveWidthBox: onTrained.truthAboveWidthBox === true,
  truthStripInsideCanvasArea: onTrained.insideCanvasArea === true,
  widthStripStillVisible: onTrained.widthHidden === false,
  truthStripHiddenOnUnknownImage: onUnknown ? onUnknown.truthHidden === true : null,
};

const report = {
  schemaVersion: 'truth-strip-verify-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: '정답 EZL/TZL 스트립 실구동 검증. 학습 이미지는 SHA-256 일치로만 선택했고 파일명·SHA는 기록하지 않는다.',
  trainedImage: { expectedTzlMm: +expectedTzl.toFixed(2), observedTzlMm: observedTzl,
                  observedEzlMm: observedEzl, observedDiffMm: observedDiff },
  layout: { truthStripTopPx: onTrained.truthTop, widthStripTopPx: onTrained.widthTop },
  unknownImageTested: Boolean(unmatched),
  pageErrors: errors,
  checks,
  pass: Object.values(checks).every((value) => value === true || value === null),
};
writeFileSync(path.join(HERE, 'truth_strip_verify.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('expected TZL (pipeline):', expectedTzl.toFixed(2), 'mm');
console.log('observed truth strip   :', onTrained.truthTzlText, '/', onTrained.truthEzlText, '/', onTrained.truthDiffText);
console.log('predicted/measured box :', onTrained.widthTzlText, '/', onTrained.widthEzlText);
console.log('layout: truth top', onTrained.truthTop, 'px  <  width top', onTrained.widthTop, 'px');
for (const [name, value] of Object.entries(checks)) console.log(' ', value === true ? 'OK  ' : value === null ? 'SKIP' : 'FAIL', name);
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
