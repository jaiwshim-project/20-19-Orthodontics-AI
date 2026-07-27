#!/usr/bin/env node
'use strict';

// 「02 교정 후」 폴더 전용 배치 러너.
// 교정 후 하악 교합면 사진 114장을 운영 HTML의 window.runAutoEngine(image)로 분석해
// (1) 이상적 EZ 곡선 타깃 후보, (2) 교정전↔후 파일번호 페어링, (3) 규칙엔진 성능/형태 지표를 산출한다.
// 원본 사진 폴더·운영 HTML·기존 정답 폴더는 모두 읽기 전용으로만 사용한다.
//
// 사용:
//   node run_corrected_after.js               # 전체 114장
//   node run_corrected_after.js --limit=5      # 앞 5장만(스모크 테스트)
//   node run_corrected_after.js --headed        # 브라우저 창 표시(디버그)

const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

const PROJECT_DIR = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
// 운영 규칙엔진 HTML. 사용자가 운영본을 "보정 전 알고리즘 적용"으로 이름만 변경(SHA 6ee35113…712197 동일).
// --engine=after 로 KRR+편향보정 HTML을 대신 사용할 수 있다.
const APP_RULE = path.join(PROJECT_DIR, 'EZ Curve - TZ Length - 보정 전 알고리즘 적용.html');
const APP_KRR = path.join(PROJECT_DIR, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
// 교정 후 사진 폴더는 세션마다 이름이 바뀌어 왔다('02 교정 후' → '02 교정 후 사진만').
// resolveDir 선언보다 위에 두면 TDZ에 걸리므로 아래로 옮겼다.
let AFTER_DIR = null;
// 라벨 폴더는 "(김원장님)" 접미어 유무가 세션마다 달라 실제 존재하는 폴더를 자동 탐지한다.
function resolveDir(...candidates) {
  for (const c of candidates) { const p = path.join(PROJECT_DIR, c); if (fs.existsSync(p)) return p; }
  // 접두어로 시작하는 폴더를 마지막 수단으로 탐색.
  const prefix = candidates[0];
  try {
    const hit = fs.readdirSync(PROJECT_DIR).find((n) => n.startsWith(prefix.replace(/\(.*$/, '').trim()) && fs.statSync(path.join(PROJECT_DIR, n)).isDirectory());
    if (hit) return path.join(PROJECT_DIR, hit);
  } catch { /* ignore */ }
  return path.join(PROJECT_DIR, candidates[0]);
}
AFTER_DIR = resolveDir('02 교정 후 사진만', '02 교정 후');
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
const WIDTH_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');
const SCRATCH_DIR = __dirname;
// 규칙엔진(--engine=rule) 산출물과 연구용 엔진(--engine=after) 산출물은 파일을 분리한다.
// 같은 파일에 쓰면 --engine=after 스모크 테스트 한 번으로 커밋된 114장 규칙엔진 기준값이
// 덮여 사라진다(실제로 한 번 그랬다).
const OUT_PRED_RULE = path.join(SCRATCH_DIR, 'corrected_after_predictions.json');
const OUT_PRED_KRR = path.join(SCRATCH_DIR, 'corrected_after_predictions_krr.json');
let OUT_PRED = OUT_PRED_RULE;
const OUT_PAIR = path.join(SCRATCH_DIR, 'corrected_pairing_index.json');

function parseArgs(argv) {
  const out = { limit: null, headed: false, engine: 'rule' };
  for (const arg of argv) {
    if (arg === '--headed') out.headed = true;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice(8));
    else if (arg.startsWith('--engine=')) out.engine = arg.slice(9); // rule | after
  }
  return out;
}

function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

// 파일명 앞부분의 숫자 접두어 = 파일번호(환자 ID). 예: "3001000 김지윤.jpg" -> "3001000"
function numPrefix(name) { const m = /^\s*(\d+)/.exec(name); return m ? m[1] : null; }

function extractEmbeddedImage(mdText) {
  const match = /"imageData"\s*:\s*"data:([^;,]+);base64,([A-Za-z0-9+/=]+)"/.exec(mdText);
  if (!match) return null;
  return { mime: match[1], buffer: Buffer.from(match[2], 'base64') };
}

// 교정 후 JPG 목록(파일번호 오름차순).
async function listAfterImages() {
  const names = (await fsp.readdir(AFTER_DIR)).filter((n) => /\.(jpe?g)$/i.test(n));
  return names
    .map((name) => ({ name, num: numPrefix(name), abs: path.join(AFTER_DIR, name) }))
    .sort((a, b) => String(a.num).localeCompare(String(b.num), 'en', { numeric: true }));
}

// 기존 정답 폴더의 파일번호 -> md 파일명 매핑(번호 접두어 기준).
async function listLabelNums(dir) {
  const map = new Map();
  try {
    for (const name of (await fsp.readdir(dir)).filter((n) => /\.md$/i.test(n))) {
      const num = numPrefix(name);
      if (num) map.set(num, name);
    }
  } catch { /* 폴더 없으면 빈 맵 */ }
  return map;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function runnerHtml(engineSourceName) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>corrected-after batch</title>
<style>body{font:14px system-ui;margin:20px}progress{width:min(720px,90vw)}pre{white-space:pre-wrap}.app-frame{position:fixed;left:-10000px;top:0;width:800px;height:800px;border:0}</style>
</head><body>
<h1>corrected-after batch</h1><progress id="bar" max="1" value="0"></progress><pre id="status">Loading engine…</pre>
<iframe id="app" class="app-frame" src="/app"></iframe>
<script>
const statusEl=document.getElementById('status'),bar=document.getElementById('bar'),frame=document.getElementById('app');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
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
    const item=manifest[i],record={caseId:item.caseId,num:item.num,fileName:item.fileName,status:'error'};
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
    await post('/api/progress',{index:i+1,total:manifest.length,caseId:item.caseId,status:record.status});
    await wait(0);
  }
  const payload={schemaVersion:'ez-corrected-after-v1',createdAt:new Date().toISOString(),engineSource:${JSON.stringify(engineSourceName)},caseCount:results.length,results};
  await post('/api/results',payload);
  statusEl.textContent='Complete: '+results.length+' cases';
}
main().catch(async error=>{statusEl.textContent='FATAL: '+String(error&&error.stack||error);try{await post('/api/fatal',{error:String(error&&error.stack||error)})}catch(_){}});
</script></body></html>`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browserPath = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find((p) => fs.existsSync(p));
  if (!browserPath) throw new Error('Chrome or Edge executable was not found.');
  const APP_PATH = options.engine === 'after' ? APP_KRR : APP_RULE;
  OUT_PRED = options.engine === 'after' ? OUT_PRED_KRR : OUT_PRED_RULE;
  if (!fs.existsSync(APP_PATH)) throw new Error(`Engine HTML not found: ${APP_PATH}`);
  console.log(`[엔진] ${options.engine === 'after' ? 'KRR+편향보정(보정후)' : '규칙엔진(운영/보정전)'} <- ${path.basename(APP_PATH)}`);

  // ── 작업2: 교정전↔후 파일번호 페어링 인덱스 ─────────────────────────
  const afterImages = await listAfterImages();
  const ezNums = await listLabelNums(EZ_DIR);
  const widthNums = await listLabelNums(WIDTH_DIR);
  const pairing = [];
  for (const img of afterImages) {
    const buf = await fsp.readFile(img.abs);
    const num = img.num;
    // 뒷자리 1 차이(예: 3166000 <-> 3166001)까지 허용해 동일 환자 매칭 시도.
    const candidates = num ? [num, num.replace(/0$/, '1'), num.replace(/1$/, '0')] : [];
    let ezName = null, widthName = null;
    for (const c of candidates) { if (!ezName && ezNums.has(c)) ezName = ezNums.get(c); if (!widthName && widthNums.has(c)) widthName = widthNums.get(c); }
    pairing.push({
      caseId: `after-${num || sha256(buf).slice(0, 8)}`,
      num,
      afterFile: img.name,
      afterSha256: sha256(buf),
      beforeEzLabel: ezName,        // 교정 전 EZ 정답 파일(없으면 null)
      beforeWidthLabel: widthName,  // 교정 전 치아폭 정답 파일(없으면 null)
      hasBeforePair: Boolean(ezName || widthName)
    });
  }
  const pairSummary = {
    schemaVersion: 'corrected-pairing-v1',
    createdAt: new Date().toISOString(),
    note: '교정 후 사진과 교정 전 라벨(EZ/치아폭)을 파일번호로 매핑. 이미지 SHA는 교정 전과 다르므로 좌표 직접 결합 금지, 환자 단위 검증용.',
    afterCount: pairing.length,
    withBeforeEz: pairing.filter((p) => p.beforeEzLabel).length,
    withBeforeWidth: pairing.filter((p) => p.beforeWidthLabel).length,
    withoutPair: pairing.filter((p) => !p.hasBeforePair).map((p) => ({ num: p.num, afterFile: p.afterFile })),
    pairs: pairing
  };
  await fsp.writeFile(OUT_PAIR, JSON.stringify(pairSummary, null, 2), 'utf8');
  console.log(`[페어링] ${pairing.length}장 / EZ매칭 ${pairSummary.withBeforeEz} / 폭매칭 ${pairSummary.withBeforeWidth} / 미매칭 ${pairSummary.withoutPair.length}`);
  console.log(`         -> ${OUT_PAIR}`);

  // ── 작업1·3: 규칙엔진 EZ 예측 + 성능/형태 지표 (헤드리스 Chrome) ────
  const selected = options.limit == null ? afterImages : afterImages.slice(0, options.limit);
  const byId = new Map();
  const manifest = selected.map((img) => {
    const caseId = `after-${img.num || 'x'}`;
    byId.set(caseId, img.abs);
    return { caseId, num: img.num, fileName: img.name, imageUrl: `/after/${encodeURIComponent(caseId)}` };
  });

  let resolveResult, rejectResult;
  const finished = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/runner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(runnerHtml(path.basename(APP_PATH))); return;
      }
      if (req.method === 'GET' && url.pathname === '/app') {
        const source = await fsp.readFile(APP_PATH, 'utf8');
        const marker = "document.documentElement.dataset.ezEngineReady='true';";
        if (!source.includes(marker)) throw new Error('Could not locate the batch hook marker in engine HTML.');
        const instrumented = source.replace(marker,
          "window.__ezBatchRunAutoEngine=runAutoEngine;window.__ezBatchEngineVersion=AUTO_ENGINE_VERSION;" + marker);
        res.writeHead(200, { 'content-type': contentType(APP_PATH), 'cache-control': 'no-store' });
        res.end(instrumented); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/manifest') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(manifest)); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/after/')) {
        const caseId = decodeURIComponent(url.pathname.slice('/after/'.length));
        const abs = byId.get(caseId);
        if (!abs) { res.writeHead(404); res.end('Unknown case'); return; }
        res.writeHead(200, { 'content-type': contentType(abs), 'cache-control': 'no-store' });
        fs.createReadStream(abs).on('error', rejectResult).pipe(res); return;
      }
      if (req.method === 'POST' && ['/api/progress', '/api/results', '/api/fatal'].includes(url.pathname)) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        res.writeHead(204); res.end();
        if (url.pathname === '/api/progress') process.stdout.write(`[${value.index}/${value.total}] ${value.caseId} ${value.status}\n`);
        else if (url.pathname === '/api/results') { await fsp.writeFile(OUT_PRED, JSON.stringify(value, null, 2), 'utf8'); resolveResult(value); }
        else rejectResult(new Error(value.error || 'Unknown browser runner failure'));
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (error) { res.writeHead(500); res.end(String(error)); rejectResult(error); }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const profileDir = path.join(SCRATCH_DIR, `.chrome-profile-after-${Date.now()}`);
  const browserArgs = [
    ...(options.headed ? [] : ['--headless=new']), '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${profileDir}`, `http://127.0.0.1:${port}/runner`
  ];
  const child = spawn(browserPath, browserArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErrors = '';
  child.stderr.on('data', (chunk) => { browserErrors = (browserErrors + chunk.toString()).slice(-12000); });
  child.once('error', rejectResult);
  child.once('exit', (code) => { if (code && code !== 0) rejectResult(new Error(`Browser exited with code ${code}\n${browserErrors}`)); });

  const timeout = setTimeout(() => rejectResult(new Error('Batch timed out after 30 minutes.')), 30 * 60 * 1000);
  try {
    const payload = await finished;
    const ok = payload.results.filter((r) => r.status === 'ok').length;
    console.log(`[예측] ${ok}/${payload.results.length} 성공 -> ${OUT_PRED}`);
  } finally {
    clearTimeout(timeout);
    if (!child.killed) child.kill();
    await new Promise((resolve) => server.close(resolve));
    const resolvedProfile = path.resolve(profileDir);
    if (resolvedProfile.startsWith(path.resolve(SCRATCH_DIR) + path.sep) && path.basename(resolvedProfile).startsWith('.chrome-profile-after-')) {
      try { await fsp.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    }
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
