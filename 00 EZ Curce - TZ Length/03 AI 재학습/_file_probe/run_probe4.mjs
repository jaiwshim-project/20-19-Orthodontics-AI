// file:// 에서 ORT WASM 글루를 살릴 경로가 있는지 실측한다.
// 후보 4가지(상대/절대file/blob/data)의 import 가능성 + wasmBinary 주입 초기화까지.
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const HERE = path.resolve('.');
// ⚠️ \S+ 를 쓰면 공백 없는 JSON 문자열 전체를 먹어치워 데이터가 사라진다(1차 실측에서
//    blobUrl/dataUrl 결과가 통째로 지워졌다). 경로 문자에만 한정한다.
const redact = (s) => (s == null ? s : String(s)
  .replace(/(blob:)?file:\/\/\/[A-Za-z0-9_%.\-/]*/g, '<로컬경로>')
  .replace(/(?<![a-zA-Z])[A-Za-z]:[\\/][A-Za-z0-9_%.\-][A-Za-z0-9_%.\-\\/]*/g, '<로컬경로>'));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));

const url = 'file:///' + path.join(HERE, 'probe4.html').replace(/\\/g, '/').replace(/ /g, '%20');
await page.goto(url, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction("document.documentElement.dataset.probeDone === 'true'",
  { timeout: 300000, polling: 500 });

const results = await page.evaluate(() =>
  JSON.parse(document.documentElement.dataset.probeResults || '{}'));

const report = {
  schemaVersion: 'file-protocol-probe-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false },
  purpose: 'file:// 에서 ORT WASM 글루(.mjs)를 import할 수 있는 경로 탐색 + wasmBinary 주입 초기화 실측',
  protocol: 'file:',
  candidates: JSON.parse(redact(JSON.stringify(results))),
  pageErrors: errors.slice(0, 8).map(redact),
  verdict: {
    anyImportWorks: ['relativeMjs', 'absoluteFileUrl', 'blobUrl', 'dataUrl']
      .some((k) => results[k]?.imported),
    workingPaths: ['relativeMjs', 'absoluteFileUrl', 'blobUrl', 'dataUrl']
      .filter((k) => results[k]?.imported),
    wasmInstantiates: !!results.wasmInstantiate?.ok,
  },
};
writeFileSync(path.join(HERE, 'probe4_result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
await browser.close();
