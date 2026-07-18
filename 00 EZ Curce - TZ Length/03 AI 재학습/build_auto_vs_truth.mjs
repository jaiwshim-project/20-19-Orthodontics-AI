#!/usr/bin/env node
// 자동분석(규칙엔진) 예측 vs 전문가 정답 비교.
// - 각 사진번호마다 원본 위에 [정답=연한 노랑/빨강] + [자동분석=진한 파랑]을 겹쳐 그림
// - 번호-비교EZL.png, 번호-비교TZL.png 를 "02 사진 모음"에 저장
// - 오차 요약(EZ 평균 이탈, 치아폭 끝점 평균 이탈)을 콘솔·JSON으로 출력
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const EZ_DIR = path.join(PROJECT, '02 이퀼리브리엄 찍기');
const TZ_DIR = path.join(PROJECT, '02 치아 좌우폭 찍기');
const OUT_DIR = path.join(PROJECT, '02 사진 모음');
const PRED_PATH = path.join(PROJECT, '03 AI 재학습', 'baseline_predictions_all.json');
const MAX_DIM = 1600;
const SAMPLES = 40;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
    y: 0.5 * ((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
  };
}
function catmullPath(pts) {
  if (pts.length < 2) return '';
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0,i-1)], p1 = pts[i], p2 = pts[i+1], p3 = pts[Math.min(pts.length-1,i+2)];
    for (let j = 0; j < SAMPLES; j++) { const p = catmull(p0,p1,p2,p3,j/SAMPLES); out.push((out.length===0?'M':'L')+p.x.toFixed(1)+','+p.y.toFixed(1)); }
  }
  const last = pts[pts.length-1]; out.push('L'+last.x.toFixed(1)+','+last.y.toFixed(1));
  return out.join(' ');
}
function extractJson(text) { const m = text.match(/```json\s*([\s\S]*?)```/); return m ? JSON.parse(m[1]) : null; }
function stripDataUrl(d) { return Buffer.from(d.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64'); }
function stem(n) { return path.basename(n, path.extname(n)); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 예측 로드 + SHA 인덱스
function loadPredIndex() {
  const raw = JSON.parse(readFileSync(PRED_PATH, 'utf8'));
  const bySha = {};
  for (const p of raw.results) {
    if (p.imageRef && p.imageRef.startsWith('sha256:')) bySha[p.imageRef.slice(7)] = p;
  }
  for (const p of raw.results.filter(x => x.sourceType === 'root')) {
    const fp = path.join(PROJECT, p.imageFile);
    try { bySha[sha256(readFileSync(fp))] = p; } catch {}
  }
  return bySha;
}

function strokeFor(w, h) {
  const s = Math.max(w, h);
  return { line: Math.max(3, Math.round(s/550)), dot: Math.max(5, Math.round(s/400)), font: Math.max(16, Math.round(s/100)) };
}

// EZ 비교 SVG: 정답(노랑) + 예측(파랑)
function ezCompareSvg(truthPts, predPts, w, h) {
  const S = strokeFor(w, h);
  const t = catmullPath(truthPts), p = catmullPath(predPts);
  const td = truthPts.map(pt => `<circle cx="${pt.x}" cy="${pt.y}" r="${S.dot}" fill="#ffd400" opacity="0.9"/>`).join('');
  const pd = predPts.map(pt => `<circle cx="${pt.x}" cy="${pt.y}" r="${S.dot}" fill="#2563eb" opacity="0.9"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<path d="${t}" fill="none" stroke="#ffd400" stroke-width="${S.line}" opacity="0.85"/>`
    + `<path d="${p}" fill="none" stroke="#2563eb" stroke-width="${S.line}" stroke-dasharray="${S.line*3},${S.line*2}" opacity="0.9"/>`
    + `${td}${pd}`
    + `<text x="20" y="${S.font+16}" font-size="${S.font}" fill="#ffd400" stroke="#000" stroke-width="1" font-weight="bold">● 정답 EZ</text>`
    + `<text x="20" y="${S.font*2+24}" font-size="${S.font}" fill="#60a5fa" stroke="#000" stroke-width="1" font-weight="bold">● 자동분석 EZ</text></svg>`;
}
// 치아폭 비교 SVG: 정답(빨강) + 예측(파랑)
function tzCompareSvg(truthW, predW, w, h) {
  const S = strokeFor(w, h);
  const line = (arr, color, dash) => arr.map(wd => wd?.p1 && wd?.p2
    ? `<line x1="${wd.p1.x}" y1="${wd.p1.y}" x2="${wd.p2.x}" y2="${wd.p2.y}" stroke="${color}" stroke-width="${S.line}" ${dash?`stroke-dasharray="${S.line*3},${S.line*2}"`:''} opacity="0.9"/>`
      + `<circle cx="${wd.p1.x}" cy="${wd.p1.y}" r="${S.dot*0.7}" fill="${color}"/><circle cx="${wd.p2.x}" cy="${wd.p2.y}" r="${S.dot*0.7}" fill="${color}"/>` : '').join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + line(truthW, '#ff2d2d', false) + line(predW, '#2563eb', true)
    + `<text x="20" y="${S.font+16}" font-size="${S.font}" fill="#ff6b6b" stroke="#000" stroke-width="1" font-weight="bold">● 정답 치아폭</text>`
    + `<text x="20" y="${S.font*2+24}" font-size="${S.font}" fill="#60a5fa" stroke="#000" stroke-width="1" font-weight="bold">● 자동분석 치아폭</text></svg>`;
}

// EZ 대칭거리(양방향 최근접 평균, px)
function ezSymmetricError(a, b) {
  const dens = pts => { const out=[]; for(let i=0;i<pts.length-1;i++){const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];for(let j=0;j<SAMPLES;j++)out.push(catmull(p0,p1,p2,p3,j/SAMPLES));}out.push(pts[pts.length-1]);return out; };
  const A = dens(a), B = dens(b);
  const near = (pt, arr) => Math.min(...arr.map(q => dist(pt, q)));
  const ab = A.reduce((s,p)=>s+near(p,B),0)/A.length;
  const ba = B.reduce((s,p)=>s+near(p,A),0)/B.length;
  return (ab+ba)/2;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const bySha = loadPredIndex();
  const files = (await readdir(EZ_DIR)).filter(f => /\.md$/i.test(f)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
  const report = [];
  let ok = 0;

  for (const file of files) {
    const id = stem(file);
    try {
      const ezBuf = await readFile(path.join(EZ_DIR, file));
      const tzBuf = await readFile(path.join(TZ_DIR, file)).catch(()=>Buffer.alloc(0));
      const ezJson = ezBuf.length ? extractJson(ezBuf.toString('utf8')) : null;
      const tzJson = tzBuf.length ? extractJson(tzBuf.toString('utf8')) : null;
      if (!ezJson) continue;
      const imgBuf = stripDataUrl(ezJson.imageData);
      const imgSha = sha256(imgBuf);
      const pred = bySha[imgSha];
      if (!pred) { report.push({ id, note: '예측 없음' }); continue; }

      const meta = await sharp(imgBuf).metadata();
      const diag = Math.hypot(meta.width, meta.height);
      const scale = Math.min(1, MAX_DIM / Math.max(meta.width, meta.height));
      const w = Math.round(meta.width*scale), h = Math.round(meta.height*scale);
      const base = await sharp(imgBuf).resize(w, h).toBuffer();
      const sc = pts => pts.map(p => ({ x: p.x*scale, y: p.y*scale }));
      const scW = ws => ws.map(wd => ({ p1:{x:wd.p1.x*scale,y:wd.p1.y*scale}, p2:{x:wd.p2.x*scale,y:wd.p2.y*scale} }));

      const rec = { id };

      // EZ 비교
      const truthEz = (ezJson.ezPoints||[]).filter(p=>Number.isFinite(p.x));
      const predEz = pred.prediction.ezPoints||[];
      if (truthEz.length>=2 && predEz.length>=2) {
        const svg = Buffer.from(ezCompareSvg(sc(truthEz), sc(predEz), w, h));
        await sharp(base).composite([{input:svg,top:0,left:0}]).png({compressionLevel:9,palette:true,quality:80}).toFile(path.join(OUT_DIR, `${id}-비교EZL.png`));
        rec.ezErrorPx = ezSymmetricError(truthEz, predEz);
        rec.ezErrorPct = rec.ezErrorPx / diag * 100;
      }

      // 치아폭 비교
      const truthW = (tzJson?.toothWidths||[]).filter(x=>x?.p1&&x?.p2);
      const predW = pred.prediction.toothWidths||[];
      if (truthW.length>=1 && predW.length>=1) {
        const svg = Buffer.from(tzCompareSvg(scW(truthW), scW(predW), w, h));
        await sharp(base).composite([{input:svg,top:0,left:0}]).png({compressionLevel:9,palette:true,quality:80}).toFile(path.join(OUT_DIR, `${id}-비교TZL.png`));
        // 끝점 평균 이탈(정답 치아 i의 p1/p2 vs 예측 치아 i의 p1/p2), 12개 정렬 가정
        const n = Math.min(truthW.length, predW.length);
        let sum=0, cnt=0;
        for (let i=0;i<n;i++){ sum+=dist(truthW[i].p1,predW[i].p1)+dist(truthW[i].p2,predW[i].p2); cnt+=2; }
        rec.widthEndpointPx = sum/cnt;
        rec.widthEndpointPct = rec.widthEndpointPx / diag * 100;
      }
      report.push(rec);
      ok++;
      if (ok % 20 === 0) console.log(`  진행 ${ok}/${files.length}`);
    } catch (e) { report.push({ id, note: '오류 '+e.message }); }
  }

  // 요약
  const ezErrs = report.filter(r=>Number.isFinite(r.ezErrorPct)).map(r=>r.ezErrorPct);
  const wErrs = report.filter(r=>Number.isFinite(r.widthEndpointPct)).map(r=>r.widthEndpointPct);
  const avg = a => a.reduce((s,x)=>s+x,0)/a.length;
  const summary = {
    처리건수: ok,
    EZ평균이탈_대각선퍼센트: ezErrs.length ? +avg(ezErrs).toFixed(2) : null,
    치아폭끝점평균이탈_대각선퍼센트: wErrs.length ? +avg(wErrs).toFixed(2) : null,
  };
  await writeFile(path.join(PROJECT, '03 AI 재학습', 'auto_vs_truth_report.json'), JSON.stringify({ summary, cases: report }, null, 2), 'utf8');
  console.log('\n=== 자동분석 vs 정답 요약 ===');
  console.log(JSON.stringify(summary, null, 2));
  // 최악 케이스
  console.log('\n[치아폭 오차 최악 10]');
  report.filter(r=>Number.isFinite(r.widthEndpointPct)).sort((a,b)=>b.widthEndpointPct-a.widthEndpointPct).slice(0,10)
    .forEach(r=>console.log(`  ${r.id}: 치아폭 ${r.widthEndpointPct.toFixed(1)}% / EZ ${(r.ezErrorPct||0).toFixed(1)}%`));
}

main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
