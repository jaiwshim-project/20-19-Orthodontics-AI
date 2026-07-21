#!/usr/bin/env node
/*
 * 어금니 길이(치아 좌우폭 mm) 분석.
 *
 * measure_engine과 동일한 스케일(EZ 현 SCALE_CHORD_MM=54)·SHA매칭을 쓰되,
 * 치아별로 (1) 폭 길이 mm 오차, (2) 상대 오차%, (3) 끝점 위치 오차%를 각각 산출한다.
 * 규칙엔진(baseline_predictions_all.json)과 KRR(krr_pred_all.json) 두 예측을
 * 같은 정답에 대해 비교해 어금니 개선폭을 보여준다.
 *
 * 어금니 = 치아 인덱스 1,2(좌측 최후방) / 11,12(우측 최후방). 앞니=6,7.
 * 원본 폴더 읽기 전용. 출력: molar_length_metrics.json
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT, pre); if (existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, prefixes[0]);
}
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
const TZ_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');
const HERE = path.join(PROJECT, '03 AI 재학습');
const SCALE_CHORD_MM = 54;
const MOLAR = new Set([1, 2, 11, 12]);   // 최후방 어금니(양측)
const INCISOR = new Set([6, 7]);          // 앞니(중앙)

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function extractJson(t) { const m = t.match(/```json\s*([\s\S]*?)```/); return m ? JSON.parse(m[1]) : null; }
function stripDataUrl(d) { return Buffer.from(d.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64'); }
function stemName(n) { return path.basename(n, path.extname(n)); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function stat(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((x, y) => x + y, 0) / arr.length;
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: arr.length, mean: +mean.toFixed(3), median: +q(.5).toFixed(3), p90: +q(.9).toFixed(3), p95: +q(.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
}

function loadPred(file) {
  const raw = JSON.parse(readFileSync(path.join(HERE, file), 'utf8'));
  const bySha = {};
  for (const p of raw.results) {
    if (p.status !== 'ok') continue;
    if (p.imageRef && p.imageRef.startsWith('sha256:')) bySha[p.imageRef.slice(7)] = p;
    if (p.sourceType === 'root' && p.imageFile) { try { bySha[sha256(readFileSync(path.join(PROJECT, p.imageFile)))] = p; } catch { /* */ } }
  }
  return bySha;
}

function analyze(bySha, label) {
  const files = readdirSync(EZ_DIR).filter((f) => /\.md$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  // 치아별: 길이 mm 절대오차, 상대오차%, 끝점 위치오차%
  const lenErrMm = Array.from({ length: 12 }, () => []);
  const lenRelPct = Array.from({ length: 12 }, () => []);   // (pred-truth)/truth (부호 유지: 편향 확인용)
  const endptPct = Array.from({ length: 12 }, () => []);
  let matched = 0;

  for (const file of files) {
    let ezJson, tzJson, imgBuf;
    try {
      ezJson = extractJson(readFileSync(path.join(EZ_DIR, file)).toString('utf8'));
      imgBuf = stripDataUrl(ezJson.imageData);
      const tb = readFileSync(path.join(TZ_DIR, file)); if (tb.length) tzJson = extractJson(tb.toString('utf8'));
    } catch { continue; }
    const pred = bySha[sha256(imgBuf)];
    if (!pred) continue;
    const tW = (tzJson?.toothWidths || []).filter((x) => x?.p1 && x?.p2);
    const pW = pred.prediction.toothWidths || [];
    const tEz = (ezJson.ezPoints || []).filter((p) => Number.isFinite(p.x));
    if (tW.length < 12 || pW.length < 12 || tEz.length < 2) continue;   // 12개 완전 라벨만
    const chord = dist(tEz[0], tEz[tEz.length - 1]); if (chord <= 0) continue;
    const mm = SCALE_CHORD_MM / chord;
    const diag = Math.hypot(pred.imageWidth, pred.imageHeight);
    matched++;
    for (let i = 0; i < 12; i++) {
      const tLen = dist(tW[i].p1, tW[i].p2) * mm;
      const pLen = dist(pW[i].p1, pW[i].p2) * mm;
      lenErrMm[i].push(Math.abs(pLen - tLen));
      if (tLen > 0) lenRelPct[i].push((pLen - tLen) / tLen * 100);
      const e = (dist(tW[i].p1, pW[i].p1) + dist(tW[i].p2, pW[i].p2)) / 2 / diag * 100;
      endptPct[i].push(e);
    }
  }

  const perTooth = [];
  for (let i = 0; i < 12; i++) {
    const grp = MOLAR.has(i + 1) ? '어금니' : INCISOR.has(i + 1) ? '앞니' : '중간';
    perTooth.push({
      치아: i + 1, 분류: grp,
      길이오차mm_평균: stat(lenErrMm[i])?.mean,
      길이오차mm_p90: stat(lenErrMm[i])?.p90,
      상대오차퍼센트_평균: +(lenRelPct[i].reduce((s, x) => s + x, 0) / lenRelPct[i].length).toFixed(2),
      상대오차퍼센트_절대평균: +(lenRelPct[i].reduce((s, x) => s + Math.abs(x), 0) / lenRelPct[i].length).toFixed(2),
      끝점위치오차퍼센트_평균: stat(endptPct[i])?.mean,
    });
  }
  const groupStat = (grpName) => {
    const idxs = [...Array(12).keys()].filter((i) => (MOLAR.has(i + 1) ? '어금니' : INCISOR.has(i + 1) ? '앞니' : '중간') === grpName);
    const lens = idxs.flatMap((i) => lenErrMm[i]);
    const rels = idxs.flatMap((i) => lenRelPct[i].map(Math.abs));
    const ends = idxs.flatMap((i) => endptPct[i]);
    return { 길이오차mm: stat(lens), 상대오차퍼센트절대: stat(rels), 끝점위치오차퍼센트: stat(ends) };
  };
  return { label, matched, perTooth, 그룹: { 어금니: groupStat('어금니'), 앞니: groupStat('앞니'), 중간: groupStat('중간') } };
}

function main() {
  const out = { schemaVersion: 'molar-length-metrics-v1', createdAt: new Date().toISOString(), scaleChordMm: SCALE_CHORD_MM, note: '교정전 정답 기준. 어금니=치아1·2·11·12, 앞니=6·7. 길이=치아 좌우폭 mm.' };
  const results = {};
  if (existsSync(path.join(HERE, 'baseline_predictions_all.json'))) results.규칙엔진 = analyze(loadPred('baseline_predictions_all.json'), '규칙엔진');
  if (existsSync(path.join(HERE, 'krr_pred_all.json'))) results.KRR = analyze(loadPred('krr_pred_all.json'), 'KRR(신모델)');
  out.results = results;

  // 개선폭(규칙→KRR) 요약
  if (results.규칙엔진 && results.KRR) {
    const cmp = ['어금니', '앞니', '중간'].map((g) => {
      const r = results.규칙엔진.그룹[g].길이오차mm.mean, k = results.KRR.그룹[g].길이오차mm.mean;
      return { 그룹: g, 규칙_길이오차mm: r, KRR_길이오차mm: k, 개선퍼센트: +((r - k) / r * 100).toFixed(1) };
    });
    out.어금니길이_개선요약 = cmp;
  }
  writeFileSync(path.join(HERE, 'molar_length_metrics.json'), JSON.stringify(out, null, 2), 'utf8');

  // 콘솔 출력
  console.log('=== 어금니 길이(치아 좌우폭 mm) 정확도 분석 ===');
  for (const key of Object.keys(results)) {
    const r = results[key];
    console.log(`\n[${r.label}] 매칭 ${r.matched}건`);
    console.log(' 그룹별 길이오차:');
    for (const g of ['앞니', '중간', '어금니']) {
      const s = r.그룹[g];
      console.log(`   ${g}: 길이 ${s.길이오차mm.mean}mm (p90 ${s.길이오차mm.p90}) | 상대 ${s.상대오차퍼센트절대.mean}% | 끝점위치 ${s.끝점위치오차퍼센트.mean}%`);
    }
    console.log(' 어금니 치아별 길이오차(mm) / 상대편향(%):');
    for (const t of r.perTooth.filter((x) => x.분류 === '어금니')) {
      console.log(`   치아${t.치아}: ${t.길이오차mm_평균}mm (p90 ${t.길이오차mm_p90}) | 편향 ${t.상대오차퍼센트_평균>0?'+':''}${t.상대오차퍼센트_평균}%`);
    }
  }
  if (out.어금니길이_개선요약) {
    console.log('\n=== 규칙 → KRR 길이오차 개선 ===');
    for (const c of out.어금니길이_개선요약) console.log(`   ${c.그룹}: ${c.규칙_길이오차mm} → ${c.KRR_길이오차mm}mm (${c.개선퍼센트>0?'':''}${c.개선퍼센트}%↓)`);
  }
  console.log('\n→ molar_length_metrics.json');
}
main();
