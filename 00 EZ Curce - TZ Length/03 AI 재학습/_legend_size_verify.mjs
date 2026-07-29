#!/usr/bin/env node
// 범례 배율 검증 — 요청 배율이 실제로 반영됐는지 + 좁은 캔버스에서 잘리지 않는지.
// 배율 변경 경위: 0.7 → (2배 요청) 1.4 → (70% 요청) 0.98. 세션 시작 대비 1.4배.
//
// 범례는 캔버스에 그리므로 DOM 요소가 없다. 그래서 두 가지로 확인한다.
//   ① LEGEND_SCALE 상수와 박스 원본 크기로 렌더 크기를 계산해 캔버스 폭·높이와 대조
//   ② Legend 레이어를 **끄고/켜고** 두 프레임을 픽셀 차분해 실제 범례 경계를 측정
//      → 계산값과 일치해야 하고, 캔버스 안에 완전히 들어가야 한다
//
// ⚠️ 첫 판은 "범례 배경색이 이어지는 범위"를 스캔했는데 1024 이하에서 FAIL이 났다.
//    앱 버그가 아니라 **측정 결함**이었다: 배경이 반투명(0.88)이라 좁은 캔버스에서
//    사진 위에 겹치면 색이 균일하지 않아 스캔이 조기 종료된다. 레이어 on/off 차분은
//    배경 투명도와 무관하게 "범례가 바꾼 픽셀"만 잡으므로 이 문제가 없다.
// ⚠️ 앱 스크립트는 IIFE 안이라 LEGEND_SCALE을 page.evaluate로 읽을 수 없다.
//    HTML 소스에서 파싱한다.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const BOX_W = 220, BOX_H = 118;   // 범례 박스 원본(코드의 fillRect)
const SESSION_START_SCALE = 0.7;  // 세션 시작 배율
const EXPECTED_SCALE = 0.98;      // 현재 요청값(1.4의 70%)
const LEGEND_ORIGIN = { x: 10, y: 10 };

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
function walk(dir, found = []) {
  let entries; try { entries = readdirSync(dir); } catch { return found; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let info; try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.')) walk(full, found); }
    else if (/\.(jpe?g|png)$/i.test(name)) found.push(full);
  }
  return found;
}

const html = readFileSync(HTML, 'utf8');
const scaleMatch = html.match(/const LEGEND_SCALE = ([\d.]+);/);
if (!scaleMatch) throw new Error('LEGEND_SCALE not found in source');
const legendScale = Number(scaleMatch[1]);

const marker = 'window.TRUTH_LOOKUP=';
const from = html.indexOf(marker) + marker.length;
const lookup = JSON.parse(html.slice(from, html.indexOf('\n', from)).replace(/;\s*$/, ''));

let file = null;
for (const candidate of walk(PROJECT)) {
  let sha; try { sha = sha256(readFileSync(candidate)); } catch { continue; }
  const r = lookup[sha];
  if (r && (r.ezPoints || []).length >= 12 && (r.toothWidths || []).length >= 12) { file = candidate; break; }
}
if (!file) throw new Error('no suitable trained image found');

// 가장 좁은 조건까지 포함한다. 414는 aspect-ratio:1 분기라 캔버스가 정사각형이 된다.
const VIEWPORTS = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1600x900', width: 1600, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768 tablet', width: 768, height: 1024 },
  { name: '414 mobile', width: 414, height: 896 },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const pageErrors = [];
const rows = [];

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${vp.name}: ${String(e.message || e).slice(0, 200)}`));
  await page.setViewport({ width: vp.width, height: vp.height });
  await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await (await page.$('#fileInput')).uploadFile(file);
  await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));
  // 정답을 표시해 범례에 EZL/TZL 텍스트까지 채운 상태로 측정한다.
  await page.click('#truthCheckBtn');
  await new Promise((r) => setTimeout(r, 1200));

  // 범례 있는 프레임을 저장 → Legend 레이어를 끈 프레임과 차분한다.
  const grab = () => page.evaluate(() => {
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    return { w, h, data: Array.from(ctx.getImageData(0, 0, w, h).data) };
  });
  const withLegend = await grab();
  await page.click('.layer-btn[data-layer="legend"]');   // 범례 OFF
  await new Promise((r) => setTimeout(r, 600));
  const withoutLegend = await grab();
  await page.click('.layer-btn[data-layer="legend"]');   // 다시 ON(상태 원복)
  await new Promise((r) => setTimeout(r, 400));
  await page.close();

  // 두 프레임이 다른 픽셀의 바운딩 박스 = 범례가 실제로 차지한 영역.
  const { w, h } = withLegend;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, changed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (withLegend.data[i] !== withoutLegend.data[i]
          || withLegend.data[i + 1] !== withoutLegend.data[i + 1]
          || withLegend.data[i + 2] !== withoutLegend.data[i + 2]) {
        changed++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const measured = {
    canvasWidth: w, canvasHeight: h, changedPixels: changed,
    measuredWidth: maxX >= 0 ? maxX - minX + 1 : 0,
    measuredHeight: maxY >= 0 ? maxY - minY + 1 : 0,
    boxLeft: maxX >= 0 ? minX : null, boxTop: maxY >= 0 ? minY : null,
  };

  const expectedW = BOX_W * legendScale, expectedH = BOX_H * legendScale;
  rows.push({
    viewport: vp.name,
    canvasWidth: measured.canvasWidth, canvasHeight: measured.canvasHeight,
    expectedWidthPx: +expectedW.toFixed(1), expectedHeightPx: +expectedH.toFixed(1),
    measuredWidthPx: measured.measuredWidth, measuredHeightPx: measured.measuredHeight,
    changedPixels: measured.changedPixels,
    boxLeftPx: measured.boxLeft, boxTopPx: measured.boxTop,
    // 잘림: 범례가 그려져야 할 끝(계산)이 캔버스를 넘는가 — 실측 경계로도 교차 확인한다.
    overflowRightPx: +Math.max(0, LEGEND_ORIGIN.x + expectedW - measured.canvasWidth).toFixed(1),
    overflowBottomPx: +Math.max(0, LEGEND_ORIGIN.y + expectedH - measured.canvasHeight).toFixed(1),
  });
}
await browser.close();

// 측정값과 계산값의 오차 허용: 안티에일리어싱 경계 때문에 ±2px.
const widthOk = rows.every((r) => Math.abs(r.measuredWidthPx - r.expectedWidthPx) <= 2);
const heightOk = rows.every((r) => Math.abs(r.measuredHeightPx - r.expectedHeightPx) <= 2);

const checks = {
  noPageErrors: pageErrors.length === 0,
  scaleMatchesRequest: Math.abs(legendScale - EXPECTED_SCALE) < 1e-9,
  measuredWidthMatchesExpected: widthOk,
  measuredHeightMatchesExpected: heightOk,
  noOverflowInAnyViewport: rows.every((r) => r.overflowRightPx === 0 && r.overflowBottomPx === 0),
  legendActuallyDrawnEverywhere: rows.every((r) => r.changedPixels > 1000),
  legendStartsAtOrigin: rows.every((r) => r.boxLeftPx === LEGEND_ORIGIN.x && r.boxTopPx === LEGEND_ORIGIN.y),
};

const report = {
  schemaVersion: 'legend-size-verify-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: ('캔버스 범례 배율 검증. 범례는 캔버스에 그려지므로 DOM이 없어 픽셀에서 박스 경계를 '
         + '측정한다. 사진은 SHA-256 일치로만 선택했고 파일명·SHA·좌표는 기록하지 않는다.'),
  legendBoxSource: { width: BOX_W, height: BOX_H },
  scale: { sessionStart: SESSION_START_SCALE, current: legendScale,
           ratioVsSessionStart: +(legendScale / SESSION_START_SCALE).toFixed(3) },
  renderedSize: { sessionStart: [+(BOX_W * SESSION_START_SCALE).toFixed(1), +(BOX_H * SESSION_START_SCALE).toFixed(1)],
                  current: [+(BOX_W * legendScale).toFixed(1), +(BOX_H * legendScale).toFixed(1)] },
  perViewport: rows,
  pageErrors,
  checks,
  pass: Object.values(checks).every((v) => v === true),
};
writeFileSync(path.join(HERE, 'legend_size_verify.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log(`LEGEND_SCALE ${SESSION_START_SCALE} -> ${legendScale} (세션 시작 대비 ${report.scale.ratioVsSessionStart}x)`);
console.log(`렌더 크기 ${report.renderedSize.sessionStart.join('x')} -> ${report.renderedSize.current.join('x')} px`);
for (const r of rows) {
  console.log(`  ${r.viewport.padEnd(11)} 캔버스 ${String(r.canvasWidth).padStart(4)}x${String(r.canvasHeight).padStart(4)}`
    + `  범례 측정 ${String(r.measuredWidthPx).padStart(3)}x${String(r.measuredHeightPx).padStart(3)}`
    + ` (계산 ${r.expectedWidthPx}x${r.expectedHeightPx})`
    + `  넘침 우 ${r.overflowRightPx} 하 ${r.overflowBottomPx}`);
}
for (const [k, v] of Object.entries(checks)) console.log(' ', v ? 'OK  ' : 'FAIL', k);
console.log('pass:', report.pass);
if (!report.pass) process.exitCode = 1;
