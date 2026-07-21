#!/usr/bin/env node
// 어금니(치아 1·2·11·12번) 끝점 오차가 큰 케이스를 순위화해 수동보정 대상 목록을 만든다.
// 입력: krr_pred_all.json (KRR 적용 예측) + EZ/치아폭 정답 폴더
// 출력: molar_correction_targets.json + 콘솔 표
// measure_engine.mjs의 오차 계산법을 그대로 재사용(끝점 거리 / 이미지 대각선 %).
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT, pre); if (existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, prefixes[0]);
}
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
const TZ_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');
const AFTER_DIR = resolveDir('02 교정 후');
const PRED_PATH = path.join(HERE, process.argv[2] || 'krr_pred_all.json');

const MOLARS = [0, 1, 10, 11]; // 0-index: 1·2·11·12번
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const extractJson = (t) => { const m = t.match(/```json\s*([\s\S]*?)```/); return m ? JSON.parse(m[1]) : null; };
const stripDataUrl = (d) => Buffer.from(String(d).replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');
const stem = (n) => path.basename(n, path.extname(n));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 파일번호 -> 환자명(교정후 폴더 파일명에서). 예: "3001000 김지윤.jpg"
const nameByNum = {};
try {
  for (const f of readdirSync(AFTER_DIR)) {
    const m = /^\s*(\d+)\s+(.+?)\.(jpe?g)$/i.exec(f);
    if (m) nameByNum[m[1]] = m[2];
  }
} catch { /* */ }

function loadPredIndex() {
  const raw = JSON.parse(readFileSync(PRED_PATH, 'utf8'));
  const bySha = {};
  for (const p of raw.results) { if (p.status === 'ok' && p.imageRef && p.imageRef.startsWith('sha256:')) bySha[p.imageRef.slice(7)] = p; }
  for (const p of raw.results.filter((x) => x.status === 'ok' && x.sourceType === 'root')) {
    try { bySha[sha256(readFileSync(path.join(PROJECT, p.imageFile)))] = p; } catch { /* */ }
  }
  return bySha;
}

function main() {
  const bySha = loadPredIndex();
  const files = readdirSync(EZ_DIR).filter((f) => /\.md$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const rows = [];
  for (const file of files) {
    const id = stem(file);
    let ezJson, tzJson, imgBuf;
    try {
      const ezBuf = readFileSync(path.join(EZ_DIR, file)); ezJson = extractJson(ezBuf.toString('utf8'));
      imgBuf = stripDataUrl(ezJson.imageData);
      const tb = readFileSync(path.join(TZ_DIR, file)); if (tb.length) tzJson = extractJson(tb.toString('utf8'));
    } catch { continue; }
    if (!tzJson) continue;
    const pred = bySha[sha256(imgBuf)];
    if (!pred) continue;
    const diag = Math.hypot(pred.imageWidth, pred.imageHeight);
    const tW = (tzJson.toothWidths || []).filter((x) => x?.p1 && x?.p2);
    const pW = pred.prediction.toothWidths || [];
    if (tW.length < 12 || pW.length < 12) continue; // 어금니 12번까지 정답 필요

    // 치아별 끝점 오차(%)
    const perTooth = [];
    for (let i = 0; i < 12; i++) {
      if (!tW[i] || !pW[i]) { perTooth.push(null); continue; }
      const e = (dist(tW[i].p1, pW[i].p1) + dist(tW[i].p2, pW[i].p2)) / 2 / diag * 100;
      perTooth.push(+e.toFixed(2));
    }
    const molarVals = MOLARS.map((i) => perTooth[i]).filter((v) => v != null);
    if (!molarVals.length) continue;
    const molarMean = molarVals.reduce((s, x) => s + x, 0) / molarVals.length;
    const molarMax = Math.max(...molarVals);
    rows.push({
      num: id,
      name: nameByNum[id] || nameByNum[id.replace(/1$/, '0')] || nameByNum[id.replace(/0$/, '1')] || '(미상)',
      molarMeanPct: +molarMean.toFixed(2),
      molarMaxPct: +molarMax.toFixed(2),
      tooth1: perTooth[0], tooth2: perTooth[1], tooth11: perTooth[10], tooth12: perTooth[11],
      allTeethMeanPct: +(perTooth.filter((v) => v != null).reduce((s, x) => s + x, 0) / perTooth.filter((v) => v != null).length).toFixed(2),
    });
  }

  rows.sort((a, b) => b.molarMeanPct - a.molarMeanPct);
  const TOP = 20;
  const targets = rows.slice(0, TOP);

  const out = {
    schemaVersion: 'molar-correction-targets-v1',
    createdAt: new Date().toISOString(),
    predictionSource: path.basename(PRED_PATH),
    note: '어금니(치아 1·2·11·12번) 끝점 오차 = 각 치아 p1/p2 예측↔정답 거리 평균 / 이미지 대각선 %. molarMeanPct 내림차순. 상위 케이스를 보정후 HTML에서 열어 어금니 좌우폭선을 드래그 보정 → 04 수정본 수집 → retrain_loop.',
    evaluatedCases: rows.length,
    molarMeanAcrossAll: +(rows.reduce((s, r) => s + r.molarMeanPct, 0) / rows.length).toFixed(2),
    topTargets: targets,
  };
  writeFileSync(path.join(HERE, 'molar_correction_targets.json'), JSON.stringify(out, null, 2), 'utf8');

  console.log(`\n어금니 오차 순위 (평가 ${rows.length}건, KRR 적용, 전체 어금니 평균 ${out.molarMeanAcrossAll}%)`);
  console.log('순위 파일번호  환자명        어금니평균  최악   1번   2번   11번  12번  (전체평균)');
  console.log('─'.repeat(84));
  targets.forEach((r, i) => {
    const p = (v) => (v == null ? ' - ' : String(v).padStart(4));
    console.log(`${String(i + 1).padStart(2)}  ${r.num.padEnd(9)} ${r.name.padEnd(10)}  ${String(r.molarMeanPct).padStart(5)}%   ${String(r.molarMaxPct).padStart(4)}  ${p(r.tooth1)}  ${p(r.tooth2)}  ${p(r.tooth11)}  ${p(r.tooth12)}   (${r.allTeethMeanPct})`);
  });
  console.log(`\n저장: ${path.join(HERE, 'molar_correction_targets.json')}`);
}
main();
