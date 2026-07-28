#!/usr/bin/env node
'use strict';

// Exact batch harness for the rule engine embedded in the production HTML.
// It serves the untouched app and source JPGs from one local origin, then asks
// headless Chrome to call window.runAutoEngine(image) for every selected case.

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const PROJECT_DIR = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const DEFAULT_APP_PATH = path.join(PROJECT_DIR, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
// --app=<경로>로 다른 HTML 사본(예: 임베드 직전 .bak)을 지정할 수 있다. 같은 이미지
// 집합을 두 사본에 통과시켜 짝지어진 실측 before/after를 얻기 위한 용도.
let APP_PATH = DEFAULT_APP_PATH;
// EZ 라벨 폴더 담당자 접미어("(김원장님)") 자동 탐지. 원본은 읽기 전용.
function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT_DIR, pre); if (fs.existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = fs.readdirSync(PROJECT_DIR).find((n) => n.startsWith(base) && fs.statSync(path.join(PROJECT_DIR, n)).isDirectory()); if (hit) return path.join(PROJECT_DIR, hit); } catch (_) { /* */ }
  return path.join(PROJECT_DIR, prefixes[0]);
}
const EZ_ANNOTATION_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
// 클래스2 치아폭 정답 폴더(2026-07-26 신규). --source=class2-width-embedded로 이 이미지에
// KRR 적용 엔진 예측을 생성해 신규 데이터에서의 개선 여부를 측정한다.
const CLASS2_WIDTH_DIR = resolveDir('03 치아 좌우폭 찍기(김원장님-클래스2)', '03 치아 좌우폭 찍기');
const SCRATCH_DIR = __dirname;
// ⚠️ 기본 출력을 `baseline_predictions.json`으로 두면 안 된다. 그 파일명은
// `run_rule_baseline.js`(규칙엔진 = 학습의 **입력 baseline**)의 기본 출력이고
// `merge_baselines.js`가 그대로 읽어 간다. 이 러너는 **KRR 적용 엔진**의 예측을 내므로,
// 같은 파일명을 쓰면 학습 입력이 조용히 "모델 출력"으로 바뀌어 잔차가 0에 가까워지고
// 승격 게이트가 무관하게 깨진다(2026-07-27에 실제로 발생 — root 119건이 오염돼
// EZ 게이트까지 흔들렸다). 그래서 기본값을 KRR 전용 이름으로 분리한다.
const DEFAULT_JSON = path.join(SCRATCH_DIR, 'krr_pred_root.json');
const DEFAULT_CSV = path.join(SCRATCH_DIR, 'krr_pred_root.csv');
const RULE_BASELINE_NAMES = new Set([
  'baseline_predictions.json', 'baseline_predictions.csv',
  'baseline_predictions_all.json', 'baseline_predictions_all.csv',
  'baseline_ez_embedded_predictions.json', 'baseline_ez_embedded_predictions.csv',
  'baseline_corrected_width_predictions.json', 'baseline_corrected_width_predictions.csv',
  'baseline_class2_width_predictions.json', 'baseline_class2_width_predictions.csv',
  'baseline_class2b_width_predictions.json', 'baseline_class2b_width_predictions.csv',
  'baseline_missing_predictions.json', 'baseline_missing_predictions.csv',
]);

function parseArgs(argv) {
  const out = { from: 1, limit: null, source: 'root', output: DEFAULT_JSON, csv: DEFAULT_CSV, headed: false };
  for (const arg of argv) {
    if (arg === '--headed') out.headed = true;
    else if (arg.startsWith('--from=')) out.from = Number(arg.slice(7));
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice(8));
    else if (arg.startsWith('--source=')) out.source = arg.slice(9);
    else if (arg.startsWith('--output=')) out.output = path.resolve(arg.slice(9));
    else if (arg.startsWith('--csv=')) out.csv = path.resolve(arg.slice(6));
    else if (arg.startsWith('--app=')) out.app = path.resolve(arg.slice(6));
  }
  if (!Number.isInteger(out.from) || out.from < 1) throw new Error('--from must be a positive integer');
  if (out.limit != null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error('--limit must be a positive integer');
  if (!['root', 'ez-embedded-only', 'class2-width-embedded'].includes(out.source)) throw new Error('--source must be root, ez-embedded-only, or class2-width-embedded');
  // KRR 예측을 규칙 baseline 파일명으로 덮어쓰는 것을 막는다(위 주석의 오염 사고 재발 방지).
  for (const target of [out.output, out.csv]) {
    if (RULE_BASELINE_NAMES.has(path.basename(target))) {
      throw new Error(`Refusing to write KRR-engine predictions to a rule-baseline file name: ${path.basename(target)}. `
        + 'Those files are the training input and must come from run_rule_baseline.js (production rule engine).');
    }
  }
  return out;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extractEmbeddedImage(mdText, sourcePath) {
  const match = /"imageData"\s*:\s*"data:([^;,]+);base64,([A-Za-z0-9+/=]+)"/.exec(mdText);
  if (!match) throw new Error(`Embedded imageData not found: ${sourcePath}`);
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

async function buildManifest(options) {
  let all;
  if (options.source === 'root') {
    all = [];
    for (let n = 1; n <= 119; n++) {
      const imageFile = `${String(n).padStart(3, '0')}.jpg`;
      if (fs.existsSync(path.join(PROJECT_DIR, imageFile))) {
        all.push({ caseId: String(n).padStart(3, '0'), sourceType: 'root', imageFile, imageRef: null, imageUrl: `/images/${imageFile}` });
      }
    }
  } else {
    // Embedded-only means an EZ annotation image whose exact SHA-256 is absent
    // from the numbered root set. Duplicate embedded images are analyzed once.
    const rootHashes = new Set();
    for (let n = 1; n <= 119; n++) {
      const filePath = path.join(PROJECT_DIR, `${String(n).padStart(3, '0')}.jpg`);
      if (fs.existsSync(filePath)) rootHashes.add(sha256(await fsp.readFile(filePath)));
    }
    const annotationDir = options.source === 'class2-width-embedded' ? CLASS2_WIDTH_DIR : EZ_ANNOTATION_DIR;
    const mdNames = (await fsp.readdir(annotationDir)).filter((name) => /\.md$/i.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const byHash = new Map();
    for (const name of mdNames) {
      const mdPath = path.join(annotationDir, name);
      if ((await fsp.stat(mdPath)).size === 0) continue; // 0 byte 라벨 파일 skip
      let embedded;
      try { embedded = extractEmbeddedImage(await fsp.readFile(mdPath, 'utf8'), mdPath); } catch (_) { continue; }
      const hash = sha256(embedded.buffer);
      if (!rootHashes.has(hash) && !byHash.has(hash)) byHash.set(hash, { mdPath, mime: embedded.mime, hash });
    }
    all = [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash)).map((item) => {
      const caseId = `embedded-${item.hash.slice(0, 16)}`;
      return { caseId, sourceType: 'ez-embedded-only', imageFile: null, imageRef: `sha256:${item.hash}`, imageUrl: `/embedded/${caseId}`, mdPath: item.mdPath, mime: item.mime };
    });
  }
  const start = options.from - 1;
  const end = options.limit == null ? all.length : start + options.limit;
  return all.slice(start, end);
}

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  return candidates.find((item) => fs.existsSync(item));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeSummaryCsv(payload) {
  const columns = [
    'caseId', 'sourceType', 'imageFile', 'imageRef', 'status', 'runtimeMs', 'imageWidth', 'imageHeight',
    'engineVersion', 'confidenceOverall', 'imageQuality', 'templateQuality',
    'pathEvidence', 'boundaryQuality', 'widthQuality', 'toothCenterCount',
    'ezPointCount', 'toothWidthCount', 'pxPerMm', 'tzlMm', 'ezlMm',
    'differenceMm', 'warningCount', 'error'
  ];
  const rows = payload.results.map((record) => {
    const confidence = record.prediction?.analysisMeta?.confidence || {};
    const metrics = record.prediction?.metrics || {};
    const warnings = record.prediction?.analysisMeta?.warnings || [];
    return {
      caseId: record.caseId,
      sourceType: record.sourceType,
      imageFile: record.imageFile,
      imageRef: record.imageRef,
      status: record.status,
      runtimeMs: record.runtimeMs,
      imageWidth: record.imageWidth,
      imageHeight: record.imageHeight,
      engineVersion: record.prediction?.analysisMeta?.engineVersion,
      confidenceOverall: confidence.overall,
      imageQuality: confidence.imageQuality,
      templateQuality: confidence.templateQuality,
      pathEvidence: confidence.pathEvidence,
      boundaryQuality: confidence.boundaryQuality,
      widthQuality: confidence.widthQuality,
      toothCenterCount: record.prediction?.toothCenters?.length,
      ezPointCount: record.prediction?.ezPoints?.length,
      toothWidthCount: record.prediction?.toothWidths?.length,
      pxPerMm: metrics.pxPerMm,
      tzlMm: metrics.tzl,
      ezlMm: metrics.ezl,
      differenceMm: metrics.difference,
      warningCount: warnings.length,
      error: record.error
    };
  });
  return [columns.join(','), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}

function runnerHtml(engineSource) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>EZ rule baseline batch</title>
<style>body{font:14px system-ui;margin:20px}progress{width:min(720px,90vw)}pre{white-space:pre-wrap}.app-frame{position:fixed;left:-10000px;top:0;width:800px;height:800px;border:0}</style>
</head><body>
<h1>EZ rule baseline batch</h1><progress id="bar" max="1" value="0"></progress><pre id="status">Loading engine…</pre>
<iframe id="app" class="app-frame" src="/app"></iframe>
<script>
const ENGINE_SOURCE=${JSON.stringify(engineSource)};
const statusEl=document.getElementById('status'),bar=document.getElementById('bar'),frame=document.getElementById('app');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loadImage=src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Image load failed: '+src));img.src=src;});
async function post(url,value){const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});if(!res.ok)throw new Error(url+' returned '+res.status);}
async function main(){
  const manifest=await fetch('/api/manifest').then(r=>r.json());
  bar.max=manifest.length;
  await new Promise((resolve,reject)=>{frame.addEventListener('load',resolve,{once:true});frame.addEventListener('error',()=>reject(new Error('Production HTML failed to load')),{once:true});});
  const engine=frame.contentWindow.__ezBatchRunAutoEngine;
  if(typeof engine!=='function')throw new Error('Batch hook for runAutoEngine was not exposed');
  const results=[];
  for(let i=0;i<manifest.length;i++){
    const item=manifest[i],record={caseId:item.caseId,sourceType:item.sourceType,imageFile:item.imageFile||null,imageRef:item.imageRef||null,status:'error'};
    statusEl.textContent='Running '+(i+1)+'/'+manifest.length+': '+item.caseId;
    const started=performance.now();
    try{
      const img=await loadImage(item.imageUrl);
      record.imageWidth=img.naturalWidth;record.imageHeight=img.naturalHeight;
      record.prediction=engine.call(frame.contentWindow,img);
      record.status='ok';
    }catch(error){record.error=String(error&&error.stack||error);}
    record.runtimeMs=Math.round((performance.now()-started)*100)/100;
    results.push(record);bar.value=i+1;
    await post('/api/progress',{index:i+1,total:manifest.length,caseId:item.caseId,status:record.status,runtimeMs:record.runtimeMs});
    await wait(0);
  }
  const payload={schemaVersion:'ez-rule-baseline-v1',createdAt:new Date().toISOString(),engineSource:ENGINE_SOURCE,sourceSet:manifest[0]?.sourceType||'empty',caseCount:results.length,results};
  await post('/api/results',payload);
  statusEl.textContent='Complete: '+results.length+' cases';
}
main().catch(async error=>{statusEl.textContent='FATAL: '+String(error&&error.stack||error);try{await post('/api/fatal',{error:String(error&&error.stack||error)})}catch(_){}});
</script></body></html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.app) APP_PATH = options.app;
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('Chrome or Edge executable was not found.');
  if (!fs.existsSync(APP_PATH)) throw new Error(`Production HTML not found: ${APP_PATH}`);

  const manifest = await buildManifest(options);
  if (!manifest.length) throw new Error('No source images were found for the requested range.');
  const embeddedById = new Map(manifest.filter((item) => item.mdPath).map((item) => [item.caseId, item]));
  const publicManifest = manifest.map(({ mdPath, mime, ...item }) => item);

  let resolveResult, rejectResult;
  const finished = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/runner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(runnerHtml(path.basename(APP_PATH)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/app') {
        // The production script is wrapped in an IIFE. Expose only the engine
        // function on this in-memory served copy; the source HTML is untouched.
        const source = await fsp.readFile(APP_PATH, 'utf8');
        const marker = "document.documentElement.dataset.ezEngineReady='true';";
        if (!source.includes(marker)) throw new Error('Could not locate the batch hook marker in production HTML.');
        const instrumented = source.replace(
          marker,
          "window.__ezBatchRunAutoEngine=runAutoEngine;window.__ezBatchEngineVersion=AUTO_ENGINE_VERSION;" + marker
        );
        // --app으로 .bak 사본을 지정하면 확장자가 .html이 아니므로 확장자 추론에
        // 맡기면 브라우저가 렌더 대신 다운로드한다. 이 경로는 항상 HTML로 낸다.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(instrumented);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/manifest') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(publicManifest));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
        const name = decodeURIComponent(url.pathname.slice('/images/'.length));
        if (!/^\d{3}\.jpg$/i.test(name)) throw new Error('Invalid image name');
        const filePath = path.join(PROJECT_DIR, name);
        res.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' });
        fs.createReadStream(filePath).on('error', rejectResult).pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/embedded/')) {
        const caseId = decodeURIComponent(url.pathname.slice('/embedded/'.length));
        const item = embeddedById.get(caseId);
        if (!item) { res.writeHead(404); res.end('Unknown embedded case'); return; }
        const embedded = extractEmbeddedImage(await fsp.readFile(item.mdPath, 'utf8'), item.mdPath);
        res.writeHead(200, { 'content-type': embedded.mime || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(embedded.buffer);
        return;
      }
      if (req.method === 'POST' && ['/api/progress', '/api/results', '/api/fatal'].includes(url.pathname)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        res.writeHead(204); res.end();
        if (url.pathname === '/api/progress') {
          process.stdout.write(`[${value.index}/${value.total}] ${value.caseId} ${value.status} ${value.runtimeMs} ms\n`);
        } else if (url.pathname === '/api/results') {
          await fsp.writeFile(options.output, JSON.stringify(value, null, 2), 'utf8');
          await fsp.writeFile(options.csv, makeSummaryCsv(value), 'utf8');
          resolveResult(value);
        } else {
          rejectResult(new Error(value.error || 'Unknown browser runner failure'));
        }
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (error) {
      res.writeHead(500); res.end(String(error));
      rejectResult(error);
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const profileDir = path.join(SCRATCH_DIR, `.chrome-profile-${Date.now()}`);
  const browserArgs = [
    ...(options.headed ? [] : ['--headless=new']), '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profileDir}`, `http://127.0.0.1:${port}/runner`
  ];
  const child = spawn(browserPath, browserArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErrors = '';
  child.stderr.on('data', (chunk) => { browserErrors = (browserErrors + chunk.toString()).slice(-12000); });
  child.once('error', rejectResult);
  child.once('exit', (code) => {
    if (code && code !== 0) rejectResult(new Error(`Browser exited with code ${code}\n${browserErrors}`));
  });

  const timeout = setTimeout(() => rejectResult(new Error('Batch timed out after 30 minutes.')), 30 * 60 * 1000);
  try {
    const payload = await finished;
    const ok = payload.results.filter((item) => item.status === 'ok').length;
    console.log(`Complete: ${ok}/${payload.results.length} successful`);
    console.log(`JSON: ${options.output}`);
    console.log(`CSV:  ${options.csv}`);
  } finally {
    clearTimeout(timeout);
    if (!child.killed) child.kill();
    await new Promise((resolve) => server.close(resolve));
    const resolvedProfile = path.resolve(profileDir);
    const resolvedScratch = path.resolve(SCRATCH_DIR) + path.sep;
    if (resolvedProfile.startsWith(resolvedScratch) && path.basename(resolvedProfile).startsWith('.chrome-profile-')) {
      try { await fsp.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.warn(`Temporary browser profile could not be removed: ${error.message}`); }
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
