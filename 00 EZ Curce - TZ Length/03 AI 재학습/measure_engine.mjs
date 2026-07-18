#!/usr/bin/env node
// 측정 하네스: 자동분석 예측 vs 전문가 정답 오차를 한 번에 산출(이미지 생성 없이 수치만, 빠름).
// 사용: node measure_engine.mjs [예측파일]  (기본 fixed_pred_all.json)
// 출력: 콘솔 요약 + engine_metrics.json (치아별/케이스별/EZ/치아폭/TZL/EZL)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const EZ_DIR = path.join(PROJECT, '02 이퀼리브리엄 찍기');
const TZ_DIR = path.join(PROJECT, '02 치아 좌우폭 찍기');
const HERE = path.join(PROJECT, '03 AI 재학습');
const PRED_PATH = path.join(HERE, process.argv[2] || 'fixed_pred_all.json');
const SCALE_CHORD_MM = 54, SAMPLES = 40;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function catmull(p0,p1,p2,p3,t){const t2=t*t,t3=t2*t;return{x:0.5*((2*p1.x)+(-p0.x+p2.x)*t+(2*p0.x-5*p1.x+4*p2.x-p3.x)*t2+(-p0.x+3*p1.x-3*p2.x+p3.x)*t3),y:0.5*((2*p1.y)+(-p0.y+p2.y)*t+(2*p0.y-5*p1.y+4*p2.y-p3.y)*t2+(-p0.y+3*p1.y-3*p2.y+p3.y)*t3)};}
function dens(pts){const o=[];for(let i=0;i<pts.length-1;i++){const p0=pts[Math.max(0,i-1)],p1=pts[i],p2=pts[i+1],p3=pts[Math.min(pts.length-1,i+2)];for(let j=0;j<SAMPLES;j++)o.push(catmull(p0,p1,p2,p3,j/SAMPLES));}o.push(pts[pts.length-1]);return o;}
function curveLen(pts){const d=dens(pts);let s=0;for(let i=1;i<d.length;i++)s+=dist(d[i-1],d[i]);return s;}
function ezSym(a,b){const A=dens(a),B=dens(b);const near=(p,arr)=>Math.min(...arr.map(q=>dist(p,q)));return (A.reduce((s,p)=>s+near(p,B),0)/A.length + B.reduce((s,p)=>s+near(p,A),0)/B.length)/2;}
function extractJson(t){const m=t.match(/```json\s*([\s\S]*?)```/);return m?JSON.parse(m[1]):null;}
function stripDataUrl(d){return Buffer.from(d.replace(/^data:image\/[a-zA-Z]+;base64,/,''),'base64');}
function stem(n){return path.basename(n,path.extname(n));}
function sha256(b){return crypto.createHash('sha256').update(b).digest('hex');}
function stat(arr){if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);const mean=arr.reduce((x,y)=>x+y,0)/arr.length;const q=p=>s[Math.min(s.length-1,Math.floor(s.length*p))];return{n:arr.length,mean:+mean.toFixed(3),median:+q(.5).toFixed(3),p90:+q(.9).toFixed(3),p95:+q(.95).toFixed(3),max:+s[s.length-1].toFixed(3)};}

function loadPredIndex() {
  const raw = JSON.parse(readFileSync(PRED_PATH, 'utf8'));
  const bySha = {};
  for (const p of raw.results) { if (p.status==='ok' && p.imageRef && p.imageRef.startsWith('sha256:')) bySha[p.imageRef.slice(7)] = p; }
  for (const p of raw.results.filter(x => x.status==='ok' && x.sourceType === 'root')) {
    try { bySha[sha256(readFileSync(path.join(PROJECT, p.imageFile)))] = p; } catch {}
  }
  return { bySha, total: raw.results.length, ok: raw.results.filter(r=>r.status==='ok').length };
}

function main() {
  const { bySha, total, ok } = loadPredIndex();
  const files = readdirSync(EZ_DIR).filter(f => /\.md$/i.test(f)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
  const cases = [];
  const perTooth = Array.from({length:12},()=>[]);
  const ezErrs=[], wErrs=[], tzlErr=[], ezlErr=[], diffErr=[];
  let matched=0, missing=0;

  for (const file of files) {
    const id = stem(file);
    let ezJson, tzJson, imgBuf;
    try {
      const ezBuf = readFileSync(path.join(EZ_DIR, file)); ezJson = extractJson(ezBuf.toString('utf8'));
      imgBuf = stripDataUrl(ezJson.imageData);
      try { const tb = readFileSync(path.join(TZ_DIR, file)); if (tb.length) tzJson = extractJson(tb.toString('utf8')); } catch {}
    } catch { continue; }
    const pred = bySha[sha256(imgBuf)];
    if (!pred) { missing++; continue; }
    matched++;
    const diag = Math.hypot(pred.imageWidth, pred.imageHeight);
    const rec = { id };

    const tEz = (ezJson.ezPoints||[]).filter(p=>Number.isFinite(p.x)), pEz = pred.prediction.ezPoints||[];
    if (tEz.length>=2 && pEz.length>=2) { const e=ezSym(tEz,pEz)/diag*100; rec.ezPct=+e.toFixed(2); ezErrs.push(e); }

    const tW = (tzJson?.toothWidths||[]).filter(x=>x?.p1&&x?.p2), pW = pred.prediction.toothWidths||[];
    if (tW.length>=1 && pW.length>=1) {
      const n = Math.min(tW.length, pW.length);
      let sum=0,cnt=0;
      for (let i=0;i<n;i++){ const e1=dist(tW[i].p1,pW[i].p1),e2=dist(tW[i].p2,pW[i].p2); sum+=e1+e2; cnt+=2; if(i<12)perTooth[i].push((e1+e2)/2/diag*100); }
      const e=sum/cnt/diag*100; rec.widthPct=+e.toFixed(2); wErrs.push(e);
      const chord=dist(tEz[0],tEz[tEz.length-1]); if(chord>0){ const mm=SCALE_CHORD_MM/chord;
        const tTzl=tW.reduce((s,w)=>s+dist(w.p1,w.p2),0)*mm, pTzl=pW.reduce((s,w)=>s+dist(w.p1,w.p2),0)*mm;
        const tEzl=curveLen(tEz)*mm, pEzl=curveLen(pEz)*mm;
        rec.tzlErrMm=+Math.abs(pTzl-tTzl).toFixed(2); tzlErr.push(Math.abs(pTzl-tTzl));
        rec.ezlErrMm=+Math.abs(pEzl-tEzl).toFixed(2); ezlErr.push(Math.abs(pEzl-tEzl));
        diffErr.push(Math.abs((pEzl-pTzl)-(tEzl-tTzl)));
      }
    }
    cases.push(rec);
  }

  const summary = {
    예측파일: path.basename(PRED_PATH),
    예측성공: `${ok}/${total}`,
    정답매칭: matched, 미매칭: missing,
    EZ이탈_대각선퍼센트: stat(ezErrs),
    치아폭끝점_대각선퍼센트: stat(wErrs),
    TZL오차mm: stat(tzlErr),
    EZL오차mm: stat(ezlErr),
    차이값오차mm: stat(diffErr),
    치아별끝점퍼센트: perTooth.map((a,i)=>({치아:i+1, 평균:+(a.reduce((s,x)=>s+x,0)/a.length).toFixed(2), p90:stat(a)?.p90})),
  };
  writeFileSync(path.join(HERE, 'engine_metrics.json'), JSON.stringify({ summary, cases }, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}
main();
