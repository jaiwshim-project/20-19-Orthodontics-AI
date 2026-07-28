#!/usr/bin/env node
// 증상 재현: "정답 길이가 표기되다가, 자동 분석을 실행하면 정답 섹션이 사라지고
// 자동 분석 섹션만 보인다." — 단계별로 상태를 찍어 어느 단계에서 숨는지 특정한다.
//   ① 업로드 직후 ② 자동분석(미리보기) ③ 초안 적용 후
// 각 단계에서 hidden 플래그·텍스트·사각형·콘솔경고를 모두 수집한다. 추측하지 않는다.
//
// 출력: 콘솔 요약 + truth_strip_repro.json (PHI·파일명·좌표 없음)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
// 이전 커밋 버전에서도 같은 증상을 재현하려면 HTML 경로를 바꿔 끼울 수 있어야 한다.
const HTML = process.argv[2] || path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const OUT_NAME = process.argv[3] || 'truth_strip_repro.json';
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

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

// 두 종류를 각각 시험한다: EZ 정답까지 있는 케이스 / 폭 정답만 있는 케이스
let withEz = null, widthOnly = null;
for (const file of walk(PROJECT)) {
  let sha;
  try { sha = sha256(readFileSync(file)); } catch { continue; }
  const record = lookup[sha];
  if (!record) continue;
  const hasEz = Array.isArray(record.ezPoints) && record.ezPoints.length >= 2;
  if (hasEz && !withEz) withEz = { file, record };
  if (!hasEz && !widthOnly) widthOnly = { file, record };
  if (withEz && widthOnly) break;
}
if (!withEz && !widthOnly) throw new Error('no image on disk matches TRUTH_LOOKUP');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const consoleMessages = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consoleMessages.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });

// ⚠️ 앱 스크립트는 IIFE 안에 있어 analysisState·image 같은 내부 변수를 page.evaluate로
//    읽을 수 없다(첫 시도에서 waitForFunction이 180초 타임아웃했다 — 앱 버그가 아니라
//    테스트 결함이었다). 앱이 밖으로 내보내는 DOM 신호만 쓴다:
//      document.documentElement.dataset.analysisState  ← updateAutoPanel()이 갱신
const snapshot = (stage) => page.evaluate((stageName) => {
  const truth = document.getElementById('canvasTruthStrip');
  const width = document.getElementById('canvasWidthStrip');
  const stack = document.querySelector('.canvas-bottom-stack');
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  const list = document.getElementById('canvasTruthList');
  return {
    stage: stageName,
    analysisState: document.documentElement.dataset.analysisState || null,
    canvasShown: document.getElementById('canvas').style.display !== 'none',
    truthHidden: truth ? truth.hidden : null,
    truthDisplay: truth ? getComputedStyle(truth).display : null,
    truthVisibleRect: truth ? rect(truth) : null,
    truthItems: list ? list.children.length : null,
    truthFirstItem: list && list.children[0] ? list.children[0].textContent : null,
    truthLastItem: list && list.children.length ? list.children[list.children.length - 1].textContent : null,
    truthTzl: document.getElementById('canvasTruthTzl')?.textContent,
    truthEzl: document.getElementById('canvasTruthEzl')?.textContent,
    truthLabel: document.getElementById('canvasTruthLabel')?.textContent,
    scaleRef: truth ? truth.dataset.scaleRef || null : null,
    widthHidden: width ? width.hidden : null,
    widthTzl: document.getElementById('canvasWidthTzl')?.textContent,
    stackRect: stack ? rect(stack) : null,
    canvasAreaRect: rect(document.getElementById('canvasArea')),
  };
}, stage);

async function runCase(name, sample) {
  const stages = [];
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  const input = await page.$('#fileInput');
  await input.uploadFile(sample.file);
  await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1500));
  stages.push(await snapshot('afterUpload'));

  await page.click('#autoAnalyzeBtn');
  await page.waitForFunction(
    "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
    { timeout: 300000, polling: 500 });
  await new Promise((r) => setTimeout(r, 1500));
  stages.push(await snapshot('afterAnalyze'));

  const applyDisabled = await page.evaluate(() => document.getElementById('applyAutoBtn')?.disabled);
  if (applyDisabled === false) {
    await page.click('#applyAutoBtn');
    await new Promise((r) => setTimeout(r, 1500));
    stages.push(await snapshot('afterApply'));
  }
  return { case: name, stages };
}

const results = [];
if (withEz) results.push(await runCase('withEzTruth', withEz));
if (widthOnly) results.push(await runCase('widthOnlyTruth', widthOnly));
await browser.close();

const problems = [];
for (const result of results) {
  const visible = result.stages.map((s) => s.truthHidden === false);
  if (!visible[0]) problems.push(`${result.case}: 업로드 직후 정답 줄이 안 보임`);
  for (let i = 1; i < visible.length; i++) {
    if (visible[0] && !visible[i]) problems.push(`${result.case}: ${result.stages[i].stage} 단계에서 정답 줄이 사라짐`);
  }
  const last = result.stages[result.stages.length - 1];
  if (last.truthHidden === false && !(last.truthItems > 0)) problems.push(`${result.case}: 치아별 항목이 비어 있음`);
}

const report = {
  schemaVersion: 'truth-strip-repro-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: '자동 분석 전/후 정답 스트립 표시 상태 단계별 재현. 이미지는 SHA-256 일치로만 선택하고 파일명·SHA는 기록하지 않는다.',
  lookupEntries: Object.keys(lookup).length,
  testedCases: results.map((r) => r.case),
  results,
  consoleWarnings: consoleMessages.slice(0, 20),
  pageErrors,
  problems,
  pass: problems.length === 0 && pageErrors.length === 0,
};
writeFileSync(path.join(HERE, OUT_NAME), JSON.stringify(report, null, 2) + '\n', 'utf8');

for (const result of results) {
  console.log('==', result.case);
  for (const s of result.stages) {
    console.log(`  ${s.stage.padEnd(13)} state=${String(s.analysisState).padEnd(8)} truthHidden=${String(s.truthHidden).padEnd(5)}`
      + ` items=${String(s.truthItems).padEnd(3)} widthHidden=${String(s.widthHidden).padEnd(5)}`
      + ` truthTop=${s.truthVisibleRect?.top} h=${s.truthVisibleRect?.h} scale=${s.scaleRef}`);
    console.log(`      ${s.truthTzl} | ${s.truthEzl} | 예상측정 ${s.widthTzl}`);
  }
}
console.log('lookup entries:', Object.keys(lookup).length);
if (consoleMessages.length) console.log('console warnings:', consoleMessages.slice(0, 5));
if (pageErrors.length) console.log('page errors:', pageErrors);
console.log('problems:', problems.length ? problems : 'none');
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
