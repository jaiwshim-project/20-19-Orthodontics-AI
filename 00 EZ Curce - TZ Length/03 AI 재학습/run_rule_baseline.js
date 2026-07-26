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
// 파일명 접미어(담당자/버전)가 세션마다 달라지므로 후보들을 순서대로 탐지한다. 원본은 읽기 전용.
function resolveFile(...cands) { for (const c of cands) { const p = path.join(PROJECT_DIR, c); if (fs.existsSync(p)) return p; } return path.join(PROJECT_DIR, cands[0]); }
function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT_DIR, pre); if (fs.existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = fs.readdirSync(PROJECT_DIR).find((n) => n.startsWith(base) && fs.statSync(path.join(PROJECT_DIR, n)).isDirectory()); if (hit) return path.join(PROJECT_DIR, hit); } catch (_) { /* */ }
  return path.join(PROJECT_DIR, prefixes[0]);
}
// 운영 규칙엔진 HTML(SHA 6ee35113…712197). 사용자가 "보정 전 알고리즘 적용"으로 이름 변경함.
const APP_PATH = resolveFile('EZ Curve - TZ Length.html', 'EZ Curve - TZ Length - 보정 전 알고리즘 적용.html');
const EZ_ANNOTATION_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
// 클래스2 치아폭 정답(2026-07-26 신규). 임베디드 이미지가 root/EZ 어디에도 없는 완전 신규 SHA라
// dataset에서 width_embedded_only 케이스가 된다. train_residual이 잔차를 학습하려면
// 이 이미지에 대한 규칙엔진 baseline이 필요하므로 --source=class2-width-embedded로 생성한다.
const CLASS2_WIDTH_DIR = resolveDir('03 치아 좌우폭 찍기(김원장님-클래스2)', '03 치아 좌우폭 찍기');
// --source=embedded-missing 전용: 모든 라벨 폴더의 임베디드 이미지 중
// baseline_predictions_all.json에 아직 없는 SHA만 골라 규칙엔진을 돌린다.
// dataset 케이스 수와 baseline 케이스 수가 어긋나 evaluate_baseline의
// all_dataset_cases_have_successful_prediction 검사가 깨지는 것을 막는 보충 경로.
const ALL_LABEL_DIRS = [
  CLASS2_WIDTH_DIR,
  resolveDir('02 교정 후 치아폭 찍기(김원장님)', '02 교정 후 치아폭 찍기'),
  resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기'),
  resolveDir('01 치아 좌우폭 찍기 (유라쌤)', '01 치아 좌우폭 찍기'),
  resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기'),
];
const SCRATCH_DIR = __dirname;
const DEFAULT_JSON = path.join(SCRATCH_DIR, 'baseline_predictions.json');
const DEFAULT_CSV = path.join(SCRATCH_DIR, 'baseline_predictions.csv');

function parseArgs(argv) {
  const out = { from: 1, limit: null, source: 'root', output: DEFAULT_JSON, csv: DEFAULT_CSV, headed: false };
  for (const arg of argv) {
    if (arg === '--headed') out.headed = true;
    else if (arg.startsWith('--from=')) out.from = Number(arg.slice(7));
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice(8));
    else if (arg.startsWith('--source=')) out.source = arg.slice(9);
    else if (arg.startsWith('--output=')) out.output = path.resolve(arg.slice(9));
    else if (arg.startsWith('--csv=')) out.csv = path.resolve(arg.slice(6));
  }
  if (!Number.isInteger(out.from) || out.from < 1) throw new Error('--from must be a positive integer');
  if (out.limit != null && (!Number.isInteger(out.limit) || out.limit < 1)) throw new Error('--limit must be a positive integer');
  if (!['root', 'ez-embedded-only', 'class2-width-embedded', 'embedded-missing'].includes(out.source)) throw new Error('--source must be root, ez-embedded-only, class2-width-embedded, or embedded-missing');
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
    // Embedded-only means an annotation image whose exact SHA-256 is absent
    // from the numbered root set. Duplicate embedded images are analyzed once.
    const rootHashes = new Set();
    for (let n = 1; n <= 119; n++) {
      const filePath = path.join(PROJECT_DIR, `${String(n).padStart(3, '0')}.jpg`);
      if (fs.existsSync(filePath)) rootHashes.add(sha256(await fsp.readFile(filePath)));
    }
    // 클래스2 소스는 치아폭 정답 폴더의 임베디드 이미지를 사용한다. 형식(JSON fence + imageData)이
    // EZ 폴더와 동일하므로 동일 추출 경로를 재사용하며, 0 byte/손상 파일은 건너뛴다.
    let annotationDirs;
    if (options.source === 'class2-width-embedded') annotationDirs = [CLASS2_WIDTH_DIR];
    else if (options.source === 'embedded-missing') annotationDirs = ALL_LABEL_DIRS;
    else annotationDirs = [EZ_ANNOTATION_DIR];

    // embedded-missing은 이미 baseline이 있는 SHA를 제외한다.
    const alreadyCovered = new Set();
    if (options.source === 'embedded-missing') {
      const existing = path.join(SCRATCH_DIR, 'baseline_predictions_all.json');
      if (fs.existsSync(existing)) {
        const document = JSON.parse(await fsp.readFile(existing, 'utf8'));
        for (const item of document.results || []) {
          const ref = String(item.imageRef || '');
          if (ref.startsWith('sha256:')) alreadyCovered.add(ref.slice(7));
        }
      }
    }

    const byHash = new Map();
    const skipped = [];
    for (const annotationDir of annotationDirs) {
      if (!fs.existsSync(annotationDir)) continue;
      const mdNames = (await fsp.readdir(annotationDir)).filter((name) => /\.md$/i.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      for (const name of mdNames) {
        const mdPath = path.join(annotationDir, name);
        if ((await fsp.stat(mdPath)).size === 0) { skipped.push(`${name}: empty file`); continue; }
        let embedded;
        try { embedded = extractEmbeddedImage(await fsp.readFile(mdPath, 'utf8'), mdPath); }
        catch (error) { skipped.push(`${name}: ${error.message}`); continue; }
        const hash = sha256(embedded.buffer);
        if (rootHashes.has(hash) || byHash.has(hash) || alreadyCovered.has(hash)) continue;
        byHash.set(hash, { mdPath, mime: embedded.mime, hash });
      }
    }
    if (skipped.length) console.log(`Skipped ${skipped.length} annotation file(s):\n  ${skipped.join('\n  ')}`);
    all = [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash)).map((item) => {
      const caseId = `embedded-${item.hash.slice(0, 16)}`;
      // sourceType은 merge_baselines의 중복키 규칙(sourceType:caseId)과 dataset 매칭(imageRef SHA)에
      // 맞춰 embedded 계열과 동일하게 유지한다.
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

function runnerHtml() {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>EZ rule baseline batch</title>
<style>body{font:14px system-ui;margin:20px}progress{width:min(720px,90vw)}pre{white-space:pre-wrap}.app-frame{position:fixed;left:-10000px;top:0;width:800px;height:800px;border:0}</style>
</head><body>
<h1>EZ rule baseline batch</h1><progress id="bar" max="1" value="0"></progress><pre id="status">Loading engine…</pre>
<iframe id="app" class="app-frame" src="/app"></iframe>
<script>
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
  const payload={schemaVersion:'ez-rule-baseline-v1',createdAt:new Date().toISOString(),engineSource:'EZ Curve - TZ Length.html',sourceSet:manifest[0]?.sourceType||'empty',caseCount:results.length,results};
  await post('/api/results',payload);
  statusEl.textContent='Complete: '+results.length+' cases';
}
main().catch(async error=>{statusEl.textContent='FATAL: '+String(error&&error.stack||error);try{await post('/api/fatal',{error:String(error&&error.stack||error)})}catch(_){}});
</script></body></html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
        res.end(runnerHtml());
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
        res.writeHead(200, { 'content-type': contentType(APP_PATH), 'cache-control': 'no-store' });
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
