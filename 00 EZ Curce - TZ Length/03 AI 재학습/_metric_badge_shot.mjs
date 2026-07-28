#!/usr/bin/env node
// 측정 결과 패널 배지 육안 확인용 스크린샷(정답 확인 후 상태).
// ⚠️ 환자 사진이 담기므로 열람 후 즉시 삭제한다. 커밋 금지.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(PROJECT, '03 AI 재학습', '_metric_badge_shot.png');

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
for (const candidate of walk(PROJECT)) {
  let sha; try { sha = sha256(readFileSync(candidate)); } catch { continue; }
  const r = lookup[sha];
  if (r && (r.ezPoints || []).length >= 12 && (r.toothWidths || []).length >= 12) { file = candidate; break; }
}
if (!file) throw new Error('no suitable image');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1100 });
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'", { timeout: 120000 });
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await (await page.$('#fileInput')).uploadFile(file);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'", { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));
await page.click('#truthCheckBtn');
await new Promise((r) => setTimeout(r, 1500));
const card = await page.$('#metricCard');
await card.screenshot({ path: OUT });
await browser.close();
console.log('saved:', OUT);
