#!/usr/bin/env node
// 패치된 연구용 HTML을 **실제 브라우저에서 구동**해 픽셀 랜드마크 층을 검증한다.
//
// ## 왜 필요한가
// project_embedded_engine_staleness: 이 HTML은 모델과 추론 엔진 사본을 둘 다 품는다.
// 파일에 코드가 들어간 것과 그 코드가 실제로 도는 것은 다른 문제다. 확인할 것:
//   ① ONNX Runtime Web이 WASM을 로드하는가 (경로·스레드 설정)
//   ② 49MB fp16 모델이 브라우저에서 열리는가
//   ③ dataset.ezPixelApplied가 'true'인가 (조용한 폴백이 아닌가)
//   ④ 좌표가 파이썬 예측과 같은 수준인가 (전처리·디코딩 동등성의 최종 확인)
//
// ## 비교 기준
// 브라우저는 배포 모델(final.pt = 384건 전수 학습), 파이썬 예측은 fold 모델(OOF)이다.
// 좌표가 완전히 같을 수 없으므로 두 가지를 따로 본다:
//   (a) 정답 대비 위치오차 — 브라우저가 파이썬 OOF와 비슷한 수준인가 ← 본 검증
//       ⚠️ 브라우저 쪽은 이 사진이 배포 모델 학습에 들어갔으므로 **in-sample**이다.
//          "층이 돌고 좌표가 정상 범위인가"의 확인용이며 성능 근거가 아니다.
//   (b) 브라우저 vs 파이썬 좌표 차 — 참고값(모델 세대 차 포함)
//
// ## 정답 룩업 우회
// 학습된 사진은 tryTruthLookup이 가로채 픽셀 층까지 오지 않는다. 검증에서는
// window.TRUTH_LOOKUP을 비워 자동 경로를 강제한다(운영 동작은 그대로 둔다).
//
// 출력: pixel_html_verify.json (PHI·파일명·좌표 없음)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// puppeteer-core는 전역 설치라 로컬 node_modules에 없다(_metric_panel_repro.mjs와 동일).
const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// 기본은 http. PROTOCOL=file 을 주면 **file:// 로 직접 열어** 같은 검증을 돌린다.
// file://에서는 fetch·XHR·모듈 import가 막히지만, HTML의 EzPixelFileMode가
// 글루/wasm/모델을 classic script로 주입해 통과한다(_file_probe 실측 근거).
const HTML_NAME = 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html';
const USE_FILE = (process.env.PROTOCOL || '').toLowerCase() === 'file';
const BASE = process.env.BASE || 'http://127.0.0.1:8791';
const PAGE_URL = USE_FILE
  ? 'file:///' + path.join(PROJECT, HTML_NAME).replace(/\\/g, '/').replace(/ /g, '%20')
  : BASE + '/' + encodeURIComponent(HTML_NAME);
const CASES = Number(process.env.CASES || 3);
const OUT_NAME = process.env.OUT || (USE_FILE
  ? 'pixel_html_verify_file.json' : 'pixel_html_verify.json');

// ORT/브라우저 오류 메시지에는 절대 경로가 박힌다. 산출물이 containsFilePaths:false를
// 선언하므로 기록 전에 지운다(폴백 이유·페이지 오류 모두).
const redact = (s) => (s == null ? s : String(s)
  .replace(/file:\/\/\/\S+?\/pixel_runtime\//g, '<로컬경로>/pixel_runtime/')
  .replace(/file:\/\/\/[A-Za-z]:\/\S*/g, '<로컬경로>')
  .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<로컬경로>'));

function mmPerPx(truth) {
  let span = 0;
  for (let i = 0; i < truth.length; i += 1) {
    for (let j = i + 1; j < truth.length; j += 1) {
      span = Math.max(span, Math.hypot(truth[j][0] - truth[i][0], truth[j][1] - truth[i][1]));
    }
  }
  return 54 / span;
}

// 파이썬 metrics_from_px의 position과 같은 정의: 치아별 **중점 이동**의 평균
function positionMm(pred, truth, mm) {
  let sum = 0;
  for (let t = 0; t < 12; t += 1) {
    const px = (pred[2 * t][0] + pred[2 * t + 1][0]) / 2;
    const py = (pred[2 * t][1] + pred[2 * t + 1][1]) / 2;
    const tx = (truth[2 * t][0] + truth[2 * t + 1][0]) / 2;
    const ty = (truth[2 * t][1] + truth[2 * t + 1][1]) / 2;
    sum += Math.hypot(px - tx, py - ty) * mm;
  }
  return sum / 12;
}

function loadFixtures() {
  const dataset = path.join(HERE, 'pixel_dataset');
  const coco = JSON.parse(readFileSync(path.join(dataset, 'annotations_coco.json'), 'utf8'));
  const preds = JSON.parse(readFileSync(path.join(HERE, 'pixel_model', 'predictions.json'), 'utf8'));
  const byCase = new Map();
  for (const rows of Object.values(preds)) for (const row of rows) byCase.set(row.caseId, row.predSourcePx);
  const ann = new Map(coco.annotations.map((a) => [a.image_id, a]));
  const out = [];
  for (const image of coco.images) {
    const pred = byCase.get(image.caseId);
    if (!pred) continue;
    const file = path.join(dataset, 'images', image.file_name);
    if (!existsSync(file)) continue;
    const kp = ann.get(image.id).keypointsUnclipped;
    // 브라우저에는 1280px 파생본을 업로드한다. 파이썬 좌표는 원본계이므로
    // scaleFromSource를 곱해 같은 계로 맞춘다.
    const s = image.scaleFromSource;
    const truth = [];
    for (let i = 0; i < 24; i += 1) truth.push([kp[2 * i], kp[2 * i + 1]]);
    out.push({
      caseId: image.caseId,
      file,
      truthDerived: truth,
      pythonPredDerived: pred.map(([x, y]) => [x * s, y * s]),
    });
    if (out.length >= CASES) break;
  }
  return out;
}

const fixtures = loadFixtures();
if (!fixtures.length) throw new Error('검증용 케이스를 찾지 못했다');

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1050 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 300)));
page.on('console', (m) => {
  // ⚠️ favicon 404의 console 메시지 본문에는 URL이 없다("Failed to load resource:
  //    the server responded with a status of 404"). 그래서 본문 정규식으로는 걸러지지
  //    않는다 — location().url을 봐야 한다. 실측으로 확인한 유일한 404가 favicon이다.
  if (m.type() !== 'error') return;
  const url = m.location()?.url || '';
  if (/favicon/i.test(url) || /favicon/i.test(m.text())) return;
  pageErrors.push('console: ' + m.text().slice(0, 200) + ' @' + url.slice(-60));
});
page.on('requestfailed', (r) => {
  if (!/favicon/i.test(r.url())) pageErrors.push('requestfailed: ' + r.url().slice(-90));
});

await page.goto(PAGE_URL, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'",
  { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });

const env = await page.evaluate(() => ({
  ortLoaded: typeof ort !== 'undefined',
  pixelModuleLoaded: !!window.EzPixelLandmarks,
  selfTest: document.documentElement.dataset.ezSelfTest || null,
  truthEntries: window.TRUTH_LOOKUP ? Object.keys(window.TRUTH_LOOKUP).length : 0,
  buildBadge: document.getElementById('buildBadge')?.textContent || null,
}));

// 학습된 사진은 정답 룩업이 가로챈다. 자동 경로를 강제한다.
await page.evaluate(() => { window.TRUTH_LOOKUP = {}; });

const readPanel = () => page.evaluate(() => {
  const num = (id) => {
    const t = document.getElementById(id)?.textContent || '';
    const m = t.match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const root = document.documentElement.dataset;
  return {
    analysisState: root.analysisState || null,
    pixelApplied: root.ezPixelApplied || null,
    pixelFallbackReason: root.ezPixelFallbackReason || null,
    pixelConfidenceMin: root.ezPixelConfidenceMin ? Number(root.ezPixelConfidenceMin) : null,
    autoStatus: (document.getElementById('autoStatus')?.textContent || '').slice(0, 160),
    // 상세 수치의 출처 배지. 'truth'면 정답이 들어간 것이라 성능으로 읽으면 안 된다.
    coordSource: document.getElementById('coordSource')?.dataset.source || null,
    ezl: num('ezlValue'), tzl: num('widthTotalValue'), difference: num('differenceValue'),
    pxPerMm: num('scaleValue'), widthCount: num('widthCount'),
  };
});

/** 한 사진을 자동 분석해 화면 상태를 읽는다. pixelOn=false면 픽셀 층을 끈다. */
async function runOne(fx, pixelOn) {
  await page.evaluate((on) => {
    const btn = document.getElementById('clearBtn');
    if (btn) { window.confirm = () => true; btn.click(); }
    window.TRUTH_LOOKUP = {};
    // pixelAvailable()은 window.EzPixelLandmarks를 본다. 이걸 치우면 픽셀 층이
    // 비활성되고 KRR 결과가 그대로 남는다 — **같은 브라우저·같은 사진** A/B.
    if (on) { if (window.__ezPixelStash) window.EzPixelLandmarks = window.__ezPixelStash; }
    else if (window.EzPixelLandmarks) {
      window.__ezPixelStash = window.EzPixelLandmarks;
      delete window.EzPixelLandmarks;
    }
  }, pixelOn);
  await new Promise((r) => setTimeout(r, 400));

  await (await page.$('#fileInput')).uploadFile(fx.file);
  await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'",
    { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 800));

  await page.click('#autoAnalyzeBtn');
  await page.waitForFunction(
    "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
    { timeout: 600000, polling: 1000 });
  await new Promise((r) => setTimeout(r, 800));
  if ((await page.evaluate(() => document.getElementById('applyAutoBtn')?.disabled)) === false) {
    await page.click('#applyAutoBtn');
    await new Promise((r) => setTimeout(r, 1000));
  }

  const panel = await readPanel();
  // 치아별 폭(mm). 확정된 toothWidths는 IIFE 안이라 못 읽으므로 그 값으로 렌더된
  // #widthCoordGrid를 읽는다("1번  8.3 mm" 형태 12칸).
  const perToothMm = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#widthCoordGrid .coord-item .xy')];
    return items.map((el) => Number((el.textContent.match(/-?\d+(\.\d+)?/) || [NaN])[0]));
  });
  return { panel, perToothMm };
}

const rows = [];
for (const fx of fixtures) {
  // 정답 폭을 **앱과 같은 단위**로 환산한다. 앱의 pxPerMm은 EZ 현/54mm이고
  // 픽셀 층은 EZ를 건드리지 않으므로 두 모드의 pxPerMm이 같다 → 공정한 비교.
  const truthSegPx = [];
  for (let t = 0; t < 12; t += 1) {
    const a = fx.truthDerived[2 * t]; const b = fx.truthDerived[2 * t + 1];
    truthSegPx.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }

  const off = await runOne(fx, false);
  const on = await runOne(fx, true);

  const summarize = (run) => {
    const p = run.panel;
    const scale = p.pxPerMm;
    if (!scale || run.perToothMm.length !== 12) return null;
    const truthApp = truthSegPx.map((v) => v / scale);
    const truthTzl = truthApp.reduce((s, v) => s + v, 0);
    const perToothAbs = run.perToothMm.map((v, t) => Math.abs(v - truthApp[t]));
    return {
      pixelApplied: p.pixelApplied,
      pixelFallbackReason: redact(p.pixelFallbackReason),
      pixelConfidenceMin: p.pixelConfidenceMin,
      coordSource: p.coordSource,
      analysisState: p.analysisState,
      widthCount: p.widthCount,
      displayed: { ezl: p.ezl, tzl: p.tzl, difference: p.difference, pxPerMm: scale },
      truthTzlAppMm: Number(truthTzl.toFixed(2)),
      tzlAbsErrorMm: Number(Math.abs(p.tzl - truthTzl).toFixed(3)),
      perToothMaeMm: Number((perToothAbs.reduce((s, v) => s + v, 0) / 12).toFixed(3)),
      perToothMaxMm: Number(Math.max(...perToothAbs).toFixed(3)),
    };
  };

  const mm = mmPerPx(fx.truthDerived);
  const a = summarize(off); const b = summarize(on);
  rows.push({
    caseId: fx.caseId,
    pixelOff: a, pixelOn: b,
    perToothMaeImprovementPct: (a && b && a.perToothMaeMm)
      ? Number(((a.perToothMaeMm - b.perToothMaeMm) / a.perToothMaeMm * 100).toFixed(1)) : null,
    tzlErrorImprovementPct: (a && b && a.tzlAbsErrorMm)
      ? Number(((a.tzlAbsErrorMm - b.tzlAbsErrorMm) / a.tzlAbsErrorMm * 100).toFixed(1)) : null,
    pythonOofPositionMm: Number(positionMm(fx.pythonPredDerived, fx.truthDerived, mm).toFixed(4)),
  });
  console.error(`  ${fx.caseId}: applied=${b && b.pixelApplied} conf=${b && b.pixelConfidenceMin} `
    + `치아별MAE ${a && a.perToothMaeMm} -> ${b && b.perToothMaeMm}mm  `
    + `TZL오차 ${a && a.tzlAbsErrorMm} -> ${b && b.tzlAbsErrorMm}mm`);
}

const appliedRows = rows.filter((r) => r.pixelOn && r.pixelOn.pixelApplied === 'true');
const offApplied = rows.filter((r) => r.pixelOff && r.pixelOff.pixelApplied === 'true');
const mean = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
const report = {
  schemaVersion: 'pixel-html-verify-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false },
  purpose: '패치된 연구용 HTML을 실제 브라우저에서 구동해 픽셀 랜드마크 층이 도는지 실측',
  protocol: USE_FILE ? 'file:' : 'http:',
  environment: env,
  cases: rows,
  summary: {
    casesRun: rows.length,
    casesPixelApplied: appliedRows.length,
    casesPixelAppliedWhenDisabled: offApplied.length,   // 0이어야 한다(A/B 대조 무결성)
    meanPerToothMaeOffMm: Number((mean(rows.map((r) => r.pixelOff?.perToothMaeMm)) ?? 0).toFixed(3)),
    meanPerToothMaeOnMm: Number((mean(rows.map((r) => r.pixelOn?.perToothMaeMm)) ?? 0).toFixed(3)),
    meanTzlErrorOffMm: Number((mean(rows.map((r) => r.pixelOff?.tzlAbsErrorMm)) ?? 0).toFixed(3)),
    meanTzlErrorOnMm: Number((mean(rows.map((r) => r.pixelOn?.tzlAbsErrorMm)) ?? 0).toFixed(3)),
    meanPythonOofPositionMm: rows.length
      ? Number((rows.reduce((s, r) => s + r.pythonOofPositionMm, 0) / rows.length).toFixed(4)) : null,
    note: ('브라우저는 배포 모델(384건 전수 학습, 홀드아웃 없음)이라 이 3건은 **in-sample**이다. '
      + '따라서 여기의 개선율은 성능 근거가 아니며 "층이 실제로 돌고 좌표가 정상 범위인가"의 '
      + '확인이다. 보고 가능한 성능은 5-fold OOF(위치 0.3113mm)뿐이다.'),
  },
  pageErrors: pageErrors.slice(0, 12).map(redact),
  verdict: {
    runtimeLoaded: env.ortLoaded && env.pixelModuleLoaded,
    pixelLayerRuns: appliedRows.length === rows.length && rows.length > 0,
    abControlClean: offApplied.length === 0,
    selfTestPassed: env.selfTest === 'passed',
    noPageErrors: pageErrors.length === 0,
  },
};
writeFileSync(path.join(HERE, OUT_NAME),
  JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
await browser.close();
