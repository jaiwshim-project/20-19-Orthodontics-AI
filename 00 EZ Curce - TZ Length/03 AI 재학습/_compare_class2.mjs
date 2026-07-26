#!/usr/bin/env node
// 클래스2 신규 99건에서 구모델(width 169샘플) vs 신모델(width 268샘플) 예측을 전문가 정답과 비교.
// 구모델은 이 99건을 전혀 보지 못했고(out-of-sample), 신모델은 학습에 포함(in-sample)했다.
// 따라서 이 표는 "신규 정답을 학습해서 실제로 그 케이스를 맞추게 되었는가"의 직접 증거다.
// 일반화 성능 판단은 nested-policy-metrics.json(out-of-fold)로 별도 확인한다.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJ = 'C:/01 클로드코드/20-19 Orthodontics AI/00 EZ Curce - TZ Length';
const DIR = path.join(PROJ, '03 치아 좌우폭 찍기(김원장님-클래스2)');
const HERE = path.join(PROJ, '03 AI 재학습');
const MOLARS = new Set([1, 2, 11, 12]);
const INCISORS = new Set([6, 7]);

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const fence = t => JSON.parse(t.match(/```json([\s\S]*?)```/)[1]);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r3 = v => +Number(v).toFixed(3);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// 1) 전문가 정답 로드 (이미지 SHA-256 키. 파일번호로 매칭하지 않는다 — 절대 원칙)
const truth = new Map();
for (const f of (await readdir(DIR)).filter(x => /\.md$/i.test(x))) {
  const p = path.join(DIR, f);
  if (statSync(p).size === 0) continue;
  let j; try { j = fence(await readFile(p, 'utf8')); } catch { continue; }
  const widths = (j.toothWidths || []).filter(w => w?.p1 && w?.p2);
  if (widths.length !== 12) continue;
  truth.set(sha(Buffer.from(j.imageData.split(',').pop(), 'base64')), { widths, molarMm: j.molarMm ?? 54 });
}

// 2) 예측 로드
async function preds(file) {
  const d = JSON.parse(await readFile(path.join(HERE, file), 'utf8'));
  const map = new Map();
  for (const r of d.results || []) {
    if (r.status !== 'ok') continue;
    const s = String(r.imageRef || '');
    if (s.startsWith('sha256:')) map.set(s.slice(7), r);
  }
  return map;
}
const oldP = await preds('krr_pred_class2_old.json');
const newP = await preds('krr_pred_class2_new.json');

// 3) px→mm: 정답 치아폭 끝점 최외곽 스팬 = molarMm(54) 근사 (classify_treatment.mjs와 동일 규약)
function mmPerPx(widths, molarMm) {
  const pts = widths.flatMap(w => [w.p1, w.p2]);
  let max = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const d = dist(pts[i], pts[j]); if (d > max) max = d; }
  return molarMm / max;
}

function evaluate(predMap, label) {
  const ep = [], tzl = [], tzlSigned = [];
  const perTooth = Array.from({ length: 12 }, () => ({ ep: [], lenMm: [], rel: [] }));
  const perCase = [];
  for (const [s, t] of truth) {
    const r = predMap.get(s);
    if (!r) continue;
    const pw = r.prediction?.toothWidths;
    if (!pw || pw.length !== 12) continue;
    const diag = Math.hypot(r.imageWidth, r.imageHeight);
    const scale = mmPerPx(t.widths, t.molarMm);
    let tzlT = 0, tzlP = 0, epCase = [];
    for (let i = 0; i < 12; i++) {
      const a = t.widths[i], b = pw[i];
      // 끝점 오차: measure_engine과 동일하게 p1↔p1, p2↔p2 순서 그대로 비교
      const e = (dist(a.p1, b.p1) + dist(a.p2, b.p2)) / 2 / diag * 100;
      ep.push(e); epCase.push(e); perTooth[i].ep.push(e);
      const lt = dist(a.p1, a.p2) * scale, lp = dist(b.p1, b.p2) * scale;
      tzlT += lt; tzlP += lp;
      perTooth[i].lenMm.push(Math.abs(lp - lt));
      perTooth[i].rel.push((lp - lt) / lt * 100);
    }
    tzl.push(Math.abs(tzlP - tzlT)); tzlSigned.push(tzlP - tzlT);
    // 개인정보 규약(privacy.containsCaseIdentifiers=false): 파일명/SHA 등 케이스 식별자는 기록하지 않는다.
    perCase.push({ 끝점퍼센트: r3(mean(epCase)), TZL오차mm: r3(Math.abs(tzlP - tzlT)), TZL정답mm: r3(tzlT), TZL예측mm: r3(tzlP) });
  }
  const grp = keep => {
    const e = [], l = [];
    perTooth.forEach((t, i) => { if (keep(i + 1)) { e.push(...t.ep); l.push(...t.lenMm); } });
    return { 끝점퍼센트: r3(mean(e)), 길이오차mm: r3(mean(l)) };
  };
  return {
    label, 케이스수: perCase.length,
    끝점오차퍼센트: { mean: r3(mean(ep)), p90: r3(q(ep, 0.9)), p95: r3(q(ep, 0.95)), max: r3(Math.max(...ep)) },
    TZL오차mm: { mean: r3(mean(tzl)), p90: r3(q(tzl, 0.9)), p95: r3(q(tzl, 0.95)), max: r3(Math.max(...tzl)), 부호평균: r3(mean(tzlSigned)) },
    어금니: grp(t => MOLARS.has(t)), 앞니: grp(t => INCISORS.has(t)), 중간: grp(t => !MOLARS.has(t) && !INCISORS.has(t)),
    치아별: perTooth.map((t, i) => ({ 치아: i + 1, 끝점퍼센트: r3(mean(t.ep)), 길이오차mm: r3(mean(t.lenMm)), 상대편향퍼센트: +mean(t.rel).toFixed(2) })),
    perCase,
  };
}

const A = evaluate(oldP, '구모델(width169)'), B = evaluate(newP, '신모델(width268)');
await writeFile(path.join(HERE, 'class2_compare_metrics.json'), JSON.stringify({
  schemaVersion: 'class2-holdout-compare-v1',
  privacy: { containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false, containsImageCoordinates: false, containsModelParameters: false },
  note: '클래스2 신규 99건. 구모델=미학습(out-of-sample), 신모델=학습포함(in-sample).',
  정답파일수: truth.size, 구모델: A, 신모델: B,
}, null, 2), 'utf8');

const d = (a, b) => (a === 0 ? 'n/a' : ((a - b) / a * 100).toFixed(1) + '%');
console.log('=== 클래스2 신규 99건 · 구모델 → 신모델 ===');
console.log('정답 12치아 파일:', truth.size, '| 매칭 구/신:', A.케이스수, '/', B.케이스수);
console.log('끝점오차%  mean', A.끝점오차퍼센트.mean, '→', B.끝점오차퍼센트.mean, `(개선 ${d(A.끝점오차퍼센트.mean, B.끝점오차퍼센트.mean)})`,
  '| p95', A.끝점오차퍼센트.p95, '→', B.끝점오차퍼센트.p95, '| max', A.끝점오차퍼센트.max, '→', B.끝점오차퍼센트.max);
console.log('TZL오차mm  mean', A.TZL오차mm.mean, '→', B.TZL오차mm.mean, `(개선 ${d(A.TZL오차mm.mean, B.TZL오차mm.mean)})`,
  '| p95', A.TZL오차mm.p95, '→', B.TZL오차mm.p95, '| 부호평균', A.TZL오차mm.부호평균, '→', B.TZL오차mm.부호평균);
for (const g of ['어금니', '앞니', '중간'])
  console.log(g.padEnd(4), '끝점%', A[g].끝점퍼센트, '→', B[g].끝점퍼센트, `(${d(A[g].끝점퍼센트, B[g].끝점퍼센트)})`,
    '| 길이mm', A[g].길이오차mm, '→', B[g].길이오차mm, `(${d(A[g].길이오차mm, B[g].길이오차mm)})`);
console.log('\n치아  구분   끝점%(구→신)        길이mm(구→신)      편향%(구→신)');
A.치아별.forEach((r, i) => {
  const b = B.치아별[i], cls = MOLARS.has(r.치아) ? '어금니' : INCISORS.has(r.치아) ? '앞니 ' : '중간 ';
  console.log(String(r.치아).padStart(3), cls, String(r.끝점퍼센트).padStart(6), '→', String(b.끝점퍼센트).padStart(6),
    '  ', String(r.길이오차mm).padStart(5), '→', String(b.길이오차mm).padStart(5),
    '  ', String(r.상대편향퍼센트).padStart(7), '→', String(b.상대편향퍼센트).padStart(7));
});
console.log('\n→ class2_compare_metrics.json');
