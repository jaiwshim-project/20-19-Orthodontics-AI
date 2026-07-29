#!/usr/bin/env node
// 지적: "화면 리프레시를 하면 곡선의 배율이 50%로 보여주고 있다."
//
// 단서: 범례 검증 중 Legend 레이어 토글만으로 **사진 영역(1101x433)** 픽셀이 바뀌었다.
// render()는 displayScale을 안 만지므로, 배율을 정하는 fitCanvas()의 입력
// (canvasArea.clientWidth/clientHeight)이 시점에 따라 달라진다는 뜻이다.
//
//   displayScale = min(w/image.width, h/image.height) * 0.60
//   → w·h가 레이아웃 확정 전 값이면 배율이 작게 굳는다. 이후 render()는 그 값을 그대로 쓴다.
//
// 측정: 캔버스에 실제로 그려진 사진의 바운딩 박스를 배경색(#0f172a) 대비로 잡아
//       ① 업로드 직후 ② 리프레시(localStorage 복원 경로) 후 ③ 리렌더 후를 비교한다.
// 출력에 파일명·SHA·좌표 없음.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const HERE = path.join(PROJECT, '03 AI 재학습');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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
const marker = 'window.TRUTH_LOOKUP=';
const from = html.indexOf(marker) + marker.length;
const lookup = JSON.parse(html.slice(from, html.indexOf('\n', from)).replace(/;\s*$/, ''));
let file = null;
for (const c of walk(PROJECT)) {
  let sha; try { sha = sha256(readFileSync(c)); } catch { continue; }
  const r = lookup[sha];
  if (r && (r.ezPoints || []).length >= 12 && (r.toothWidths || []).length >= 12) { file = c; break; }
}
if (!file) throw new Error('no image');

const URL = 'file:///' + HTML.replace(/\\/g, '/');

// 캔버스에 그려진 사진의 바운딩 박스. 배경 #0f172a(15,23,42)가 아닌 픽셀을 찾는다.
// 범례는 좌상단 고정이므로 x<330 && y<180 영역은 제외해 사진만 남긴다.
const IMAGE_PROBE = () => {
  const c = document.getElementById('canvas');
  const ctx = c.getContext('2d');
  const { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 330 && y < 180) continue;            // 범례 영역 제외
      const i = (y * w + x) * 4;
      if (d[i] === 15 && d[i + 1] === 23 && d[i + 2] === 42) continue;
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
  }
  const area = document.getElementById('canvasArea');
  return {
    canvasWidth: w, canvasHeight: h,
    areaClientWidth: area.clientWidth, areaClientHeight: area.clientHeight,
    imageWidthPx: maxX >= 0 ? maxX - minX + 1 : 0,
    imageHeightPx: maxY >= 0 ? maxY - minY + 1 : 0,
  };
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)));

await page.goto(URL, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await (await page.$('#fileInput')).uploadFile(file);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
await page.click('#truthCheckBtn');                 // 곡선까지 그려진 상태
await new Promise((r) => setTimeout(r, 1500));
const afterUpload = await page.evaluate(IMAGE_PROBE);

// ② 리프레시 — localStorage 복원 경로를 탄다(사용자가 겪은 경로).
await page.reload({ waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 2000));
const afterReload = await page.evaluate(IMAGE_PROBE);

// ③ 리렌더(레이어 토글 2회 = 상태 원복 + render 2회)
await page.click('.layer-btn[data-layer="legend"]');
await new Promise((r) => setTimeout(r, 500));
await page.click('.layer-btn[data-layer="legend"]');
await new Promise((r) => setTimeout(r, 700));
const afterRerender = await page.evaluate(IMAGE_PROBE);

// ④ 리사이즈 이벤트를 주면 fitCanvas가 다시 돌아 정상 배율이 되는지
await page.setViewport({ width: 1919, height: 1080 });
await new Promise((r) => setTimeout(r, 900));
await page.setViewport({ width: 1920, height: 1080 });
await new Promise((r) => setTimeout(r, 900));
const afterResize = await page.evaluate(IMAGE_PROBE);
await browser.close();

const ratio = (a, b) => (b.imageWidthPx > 0 && a.imageWidthPx > 0)
  ? +(b.imageWidthPx / a.imageWidthPx).toFixed(3) : null;

const report = {
  schemaVersion: 'display-scale-bug-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
             containsImageCoordinates: false, containsFileNames: false, containsAnnotatorNames: false },
  note: ('리프레시 후 사진·곡선 표시 배율이 줄어드는지 실측. 캔버스에 그려진 사진의 바운딩 박스를 '
         + '배경색 대비로 측정한다(범례 영역 제외). 파일명·SHA·좌표는 기록하지 않는다.'),
  stages: { afterUpload, afterReload, afterRerender, afterResize },
  ratios: {
    reloadVsUpload: ratio(afterUpload, afterReload),
    rerenderVsUpload: ratio(afterUpload, afterRerender),
    resizeVsUpload: ratio(afterUpload, afterResize),
  },
  pageErrors,
};
writeFileSync(path.join(HERE, 'display_scale_bug.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

const show = (label, s) => console.log(
  `${label} 캔버스 ${s.canvasWidth}x${s.canvasHeight}  area ${s.areaClientWidth}x${s.areaClientHeight}`
  + `  사진 ${s.imageWidthPx}x${s.imageHeightPx}`);
show('업로드 직후 ', afterUpload);
show('리프레시 후 ', afterReload);
show('리렌더 후   ', afterRerender);
show('리사이즈 후 ', afterResize);
console.log('배율비(업로드=1):', JSON.stringify(report.ratios));
console.log('pageErrors:', pageErrors.length ? pageErrors : 'none');
