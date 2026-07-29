// file:// 로 열었을 때 픽셀 층이 도는가?
//
// ⚠️ 이 스크립트의 **1차 실행 결과(자동·수동 둘 다 false)는 이미 낡았다**.
//    당시 결론 "file://는 우회 불가"는 틀렸다. ORT 로더를 뜯어 재측정한 결과
//    (`_file_probe/probe2~4`) file://에서 막히는 것은 fetch·XHR·모듈 import뿐이고
//    **classic script + blob URL import + wasmBinary 주입**으로 완전히 동작한다.
//    HTML에 EzPixelFileMode를 넣은 뒤 재실행하면 자동 경로가 true로 바뀐다.
//    실측 동등성: PROTOCOL=file 검증이 http와 케이스별 수치까지 완전히 일치
//    (pixel_html_verify_file.json vs pixel_html_verify.json).
//
// 이 스크립트는 그 회귀를 지키는 감시용으로 남긴다 — file:// 자동 경로가 다시
// 깨지면 여기서 false로 드러난다.
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const { default: puppeteer } = await import(
  'file:///C:/Users/USER/AppData/Roaming/npm/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
const HTML = path.join(PROJECT, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const PHOTO = path.join(HERE, 'pixel_dataset', 'images', '002_54528a3109f3.jpg');
const ONNX = path.join(PROJECT, 'pixel_runtime', 'arch_landmarks.onnx');

// ORT 오류 메시지에는 절대 경로가 그대로 박힌다(file:///C:/... 형태, 퍼센트 인코딩).
// 산출물이 containsFilePaths:false를 선언하므로 반드시 지운다.
const redact = (s) => (s == null ? s : String(s)
  .replace(/file:\/\/\/\S+?\/pixel_runtime\//g, '<로컬경로>/pixel_runtime/')
  .replace(/file:\/\/\/[A-Za-z]:\/\S*/g, '<로컬경로>')
  .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<로컬경로>'));

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));

const fileUrl = 'file:///' + HTML.replace(/\\/g, '/').replace(/ /g, '%20');
await page.goto(fileUrl, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction("document.documentElement.dataset.ezEngineReady === 'true'",
  { timeout: 120000 });

const env = await page.evaluate(() => ({
  protocol: location.protocol,
  ortLoaded: typeof ort !== 'undefined',
  pixelModuleLoaded: !!window.EzPixelLandmarks,
  wasmPaths: (typeof ort !== 'undefined' && ort.env.wasm.wasmPaths) || null,
}));

// ① 자동 로드(fetch) 경로
await page.evaluate(() => { window.TRUTH_LOOKUP = {}; });
await (await page.$('#fileInput')).uploadFile(PHOTO);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'",
  { timeout: 60000 });
await new Promise((r) => setTimeout(r, 600));
await page.click('#autoAnalyzeBtn');
await page.waitForFunction(
  "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
  { timeout: 600000, polling: 1000 });
const auto = await page.evaluate(() => ({
  applied: document.documentElement.dataset.ezPixelApplied || null,
  reason: document.documentElement.dataset.ezPixelFallbackReason || null,
}));

// ② 수동 파일 지정 경로 (패처 주석이 주장하는 우회책)
const rowVisible = await page.evaluate(() => {
  const row = document.getElementById('pixelModelRow');
  return row ? getComputedStyle(row).display !== 'none' : null;
});
await (await page.$('#pixelModelFile')).uploadFile(ONNX);
await new Promise((r) => setTimeout(r, 3000));
await page.evaluate(() => {
  window.confirm = () => true;
  document.getElementById('clearBtn')?.click();
  window.TRUTH_LOOKUP = {};
});
await new Promise((r) => setTimeout(r, 400));
await (await page.$('#fileInput')).uploadFile(PHOTO);
await page.waitForFunction("document.querySelector('#canvas').style.display !== 'none'",
  { timeout: 60000 });
await new Promise((r) => setTimeout(r, 600));
await page.click('#autoAnalyzeBtn');
await page.waitForFunction(
  "['preview','applied','error'].includes(document.documentElement.dataset.analysisState || '')",
  { timeout: 600000, polling: 1000 });
const manual = await page.evaluate(() => ({
  applied: document.documentElement.dataset.ezPixelApplied || null,
  reason: document.documentElement.dataset.ezPixelFallbackReason || null,
  confidenceMin: document.documentElement.dataset.ezPixelConfidenceMin || null,
}));

const report = {
  schemaVersion: 'pixel-file-protocol-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false },
  purpose: 'file:// 로 열었을 때 픽셀 층이 도는지, 수동 .onnx 지정이 실제 우회책인지 실측',
  environment: { ...env, wasmPaths: redact(env.wasmPaths) },
  autoFetchPath: { ...auto, reason: redact(auto.reason) },
  manualFilePickerVisible: rowVisible,
  manualFilePath: { ...manual, reason: redact(manual.reason) },
  pageErrors: errors.slice(0, 8).map(redact),
  verdict: {
    worksOnFileProtocolAuto: auto.applied === 'true',
    worksOnFileProtocolManual: manual.applied === 'true',
    conclusion: auto.applied === 'true'
      ? 'file://에서 픽셀 층이 자동으로 돈다(글루 blob import + wasmBinary/모델 바이트 주입).'
      : (manual.applied === 'true'
        ? 'file:// 자동 경로는 깨졌지만 .onnx 수동 지정으로는 돈다 — 자동 주입 회귀를 확인하라.'
        : 'file://에서 픽셀 층이 돌지 않는다 — EzPixelFileMode 주입 경로 회귀를 확인하라 '
          + '(ort_glue_src.js / ort_wasm_b64.js / model_b64.js 존재 여부).'),
  },
};
writeFileSync(path.join(HERE, 'pixel_file_protocol.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
await browser.close();
