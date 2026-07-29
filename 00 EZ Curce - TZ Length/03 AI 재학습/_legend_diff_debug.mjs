#!/usr/bin/env node
// 범례 차분이 예상(215x115)보다 훨씬 크게 나온 원인 진단.
// 대조군을 둔다: 아무것도 바꾸지 않고 두 번 캡처했을 때의 차분(=비결정성 크기).
// 대조군이 크면 렌더 자체가 비결정적이라 차분법을 쓸 수 없다는 뜻이다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await (await page.$('#fileInput')).uploadFile(file);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await page.click('#truthCheckBtn');
await new Promise((r) => setTimeout(r, 1500));

const grab = () => page.evaluate(() => {
  const c = document.getElementById('canvas');
  const ctx = c.getContext('2d');
  return { w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
});

const bbox = (a, b) => {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, n = 0;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
        n++;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
    }
  }
  return n ? { n, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 } : { n: 0 };
};

const a1 = await grab();
await new Promise((r) => setTimeout(r, 800));
const a2 = await grab();                       // 대조군: 아무 변경 없음
console.log('대조군(변경 없음)   :', JSON.stringify(bbox(a1, a2)));

await page.click('.layer-btn[data-layer="legend"]');
await new Promise((r) => setTimeout(r, 800));
const off = await grab();
console.log('범례 ON vs OFF      :', JSON.stringify(bbox(a2, off)));

await page.click('.layer-btn[data-layer="legend"]');
await new Promise((r) => setTimeout(r, 800));
const back = await grab();
console.log('OFF 후 다시 ON vs a2:', JSON.stringify(bbox(a2, back)));
await browser.close();
