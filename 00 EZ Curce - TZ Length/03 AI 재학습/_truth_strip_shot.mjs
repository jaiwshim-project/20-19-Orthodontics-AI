#!/usr/bin/env node
// 정답 스트립 배치 확인용 캔버스 영역 스크린샷.
// ⚠️ 결과 png는 환자 사진을 포함하므로 커밋하지 않는다(육안 확인 후 삭제).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const OUT = path.join(PROJECT, '03 AI 재학습', '_truth_strip_shot.png');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const html = readFileSync(HTML, 'utf8');
const marker = 'window.TRUTH_LOOKUP=';
const from = html.indexOf(marker) + marker.length;
const lookup = JSON.parse(html.slice(from, html.indexOf('\n', from)).replace(/;\s*$/, ''));

const images = [];
(function walk(dir) {
  let entries; try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let info; try { info = statSync(full); } catch { continue; }
    if (info.isDirectory()) { if (name !== 'node_modules' && !name.startsWith('.')) walk(full); }
    else if (/\.(jpe?g|png)$/i.test(name)) images.push(full);
  }
})(PROJECT);

let matched = null;
for (const file of images) {
  let sha; try { sha = crypto.createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { continue; }
  if (lookup[sha]) { matched = file; break; }
}
if (!matched) throw new Error('no trained image found');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await (await page.$('#fileInput')).uploadFile(matched);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1000));
await page.click('#autoAnalyzeBtn');
await page.waitForFunction("(() => { const s = document.getElementById('canvasWidthStrip'); return s && !s.hidden; })()", { timeout: 180000 });
await new Promise((r) => setTimeout(r, 1500));
const area = await page.$('#canvasArea');
await area.screenshot({ path: OUT });
await browser.close();
console.log('saved', OUT);
