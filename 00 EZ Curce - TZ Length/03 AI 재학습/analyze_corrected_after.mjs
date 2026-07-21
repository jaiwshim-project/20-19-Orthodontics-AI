#!/usr/bin/env node
// 「02 교정 후」 종합 분석 리포트 생성기.
// 입력: corrected_after_predictions.json (규칙엔진 예측), corrected_pairing_index.json (교정전↔후 페어링)
//       + 교정 전 EZ/치아폭 정답 폴더 (동일 환자 TZL 교차검증용)
// 출력: corrected_after_report.json + 콘솔 요약
//   작업1) 이상적 EZ 곡선 타깃 통계 (교정후 배열 = 목표 곡선)
//   작업2) 교정전↔후 TZL 교차검증 (치아폭 불변 가정)
//   작업3) 규칙엔진 성능/형태 지표
// 원본 정답 폴더는 읽기 전용.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
const SCALE_CHORD_MM = 54, SAMPLES = 40;

function resolveDir(...cands) {
  for (const c of cands) { const p = path.join(PROJECT, c); if (existsSync(p)) return p; }
  const base = cands[0].replace(/\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, cands[0]);
}
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
const WIDTH_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function catmull(p0, p1, p2, p3, t) { const t2 = t * t, t3 = t2 * t; return { x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3), y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3) }; }
function dens(pts) { const o = []; for (let i = 0; i < pts.length - 1; i++) { const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]; for (let j = 0; j < SAMPLES; j++) o.push(catmull(p0, p1, p2, p3, j / SAMPLES)); } o.push(pts[pts.length - 1]); return o; }
function curveLen(pts) { const d = dens(pts); let s = 0; for (let i = 1; i < d.length; i++) s += dist(d[i - 1], d[i]); return s; }
function extractJson(t) { const m = t.match(/```json\s*([\s\S]*?)```/); return m ? JSON.parse(m[1]) : null; }
function stat(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const mean = arr.reduce((x, y) => x + y, 0) / arr.length; const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]; return { n: arr.length, mean: +mean.toFixed(3), median: +q(.5).toFixed(3), p90: +q(.9).toFixed(3), p95: +q(.95).toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) }; }

// 정답 md에서 mm 스케일(molarMm/현) 대비 TZL을 계산. 치아폭 p1,p2 픽셀거리 합 × mm/px.
function truthTzlMm(widthJson) {
  const tw = (widthJson.toothWidths || []).filter((w) => w && w.p1 && w.p2 && Number.isFinite(w.p1.x) && Number.isFinite(w.p2.x));
  if (!tw.length) return null;
  // 스케일: EZ 정답의 molarMm 기준 현(첫점~끝점) 사용이 정석이나, 여기선 치아폭 파일 자체 스케일이 없으므로 픽셀 합만 반환.
  const px = tw.reduce((s, w) => s + dist(w.p1, w.p2), 0);
  return { pxSum: px, count: tw.length };
}

function main() {
  const pred = JSON.parse(readFileSync(path.join(HERE, 'corrected_after_predictions.json'), 'utf8'));
  const pairing = JSON.parse(readFileSync(path.join(HERE, 'corrected_pairing_index.json'), 'utf8'));
  const okResults = pred.results.filter((r) => r.status === 'ok');

  // ── 작업3: 규칙엔진 성능/형태 지표 (교정 후 사진 기준) ──────────────
  const ezlArr = [], tzlArr = [], diffArr = [], confArr = [], archWidthRatioArr = [], archDepthRatioArr = [];
  const perCase = [];
  for (const r of okResults) {
    const m = r.prediction.metrics || {};
    const ez = r.prediction.ezPoints || [];
    const diag = Math.hypot(r.imageWidth, r.imageHeight);
    if (Number.isFinite(m.ezl)) ezlArr.push(m.ezl);
    if (Number.isFinite(m.tzl)) tzlArr.push(m.tzl);
    if (Number.isFinite(m.difference)) diffArr.push(m.difference);
    const conf = r.prediction.analysisMeta?.confidence?.overall;
    if (Number.isFinite(conf)) confArr.push(conf);
    // 아치 형태: 폭(첫~끝 EZ점 직선거리) / 깊이(현 중점~가장 먼 EZ점). 정규화 위해 대각선으로 나눔.
    let archWidthRatio = null, archDepthRatio = null;
    if (ez.length >= 3) {
      const a = ez[0], b = ez[ez.length - 1];
      const chord = dist(a, b);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const depth = Math.max(...ez.map((p) => dist(p, mid)));
      archWidthRatio = chord / diag; archDepthRatio = depth / diag;
      archWidthRatioArr.push(archWidthRatio); archDepthRatioArr.push(archDepthRatio);
    }
    perCase.push({ num: r.num, fileName: r.fileName, ezlMm: m.ezl, tzlMm: m.tzl, diffMm: m.difference, conf, archWidthRatio, archDepthRatio, ezPointCount: ez.length, imageWidth: r.imageWidth, imageHeight: r.imageHeight });
  }

  // ── 작업2: 교정전↔후 TZL 교차검증 (치아폭 불변) ────────────────────
  // 교정 후 규칙엔진 TZL(mm) vs 교정 전 정답 치아폭 픽셀합(스케일 상이 주의) — 상대 비교 위주.
  const crossCheck = [];
  for (const p of pairing.pairs) {
    const rec = { num: p.num, afterFile: p.afterFile, beforeWidthLabel: p.beforeWidthLabel };
    const predRow = okResults.find((r) => r.num === p.num);
    rec.afterTzlMm = predRow?.prediction?.metrics?.tzl ?? null;
    rec.afterEzlMm = predRow?.prediction?.metrics?.ezl ?? null;
    if (p.beforeWidthLabel && existsSync(path.join(WIDTH_DIR, p.beforeWidthLabel))) {
      try {
        const wj = extractJson(readFileSync(path.join(WIDTH_DIR, p.beforeWidthLabel), 'utf8'));
        const t = wj ? truthTzlMm(wj) : null;
        rec.beforeToothWidthCount = t?.count ?? null;
        rec.beforeToothWidthPxSum = t ? +t.pxSum.toFixed(1) : null;
      } catch { rec.beforeError = true; }
    }
    crossCheck.push(rec);
  }

  const report = {
    schemaVersion: 'corrected-after-report-v1',
    createdAt: new Date().toISOString(),
    engine: pred.engineSource,
    engineNote: '규칙엔진(tzl-ezl-rule-v1.0, 운영/보정전 HTML). 교정 후 하악 교합면 사진 기준.',
    caseCount: okResults.length,

    task1_idealEzTarget: {
      note: '교정 후 배열은 이상적 EZ 곡선 상태. 아래는 규칙엔진이 교정후 사진에서 자동추출한 EZ 곡선의 형태 분포. 향후 아치 템플릿 개선의 검증 기준으로 사용.',
      ezlMm: stat(ezlArr),
      archWidthRatio: stat(archWidthRatioArr),   // EZ 첫~끝 직선 / 이미지 대각선
      archDepthRatio: stat(archDepthRatioArr),   // 아치 깊이 / 이미지 대각선
      ezPointCount: stat(okResults.map((r) => (r.prediction.ezPoints || []).length)),
    },

    task2_beforeAfterTzlCrossCheck: {
      note: '동일 환자 교정전(치아폭 정답)↔후(규칙엔진 TZL) 매칭. 치아 크기는 교정으로 불변이므로 TZL은 보존되어야 함. 단 교정전/후 사진 스케일(pxPerMm)이 달라 픽셀합 직접 비교 불가 — 환자단위 존재 검증 및 향후 스케일 정규화 후 비교용.',
      matchedPairs: crossCheck.filter((c) => c.beforeWidthLabel && c.afterTzlMm != null).length,
      afterTzlMm: stat(tzlArr),
      samples: crossCheck.slice(0, 5),
    },

    task3_rulePerformance: {
      note: '규칙엔진의 교정후 사진 자동분석 지표. 교정전 정답이 없어 절대 오차는 산출 불가 — 분포/신뢰도/형태 이상치 위주.',
      ezlMm: stat(ezlArr),
      tzlMm: stat(tzlArr),
      differenceMm: stat(diffArr),   // EZL - TZL
      confidenceOverall: stat(confArr),
      lowConfidenceCases: perCase.filter((c) => Number.isFinite(c.conf) && c.conf < 0.5).map((c) => ({ num: c.num, conf: +c.conf.toFixed(3) })),
      negativeDifferenceCases: perCase.filter((c) => Number.isFinite(c.diffMm) && c.diffMm < 0).length, // EZL<TZL (공간부족 시사)
    },

    perCase,
    crossCheck,
  };

  writeFileSync(path.join(HERE, 'corrected_after_report.json'), JSON.stringify(report, null, 2), 'utf8');

  // ── 콘솔 요약 ──
  const t1 = report.task1_idealEzTarget, t3 = report.task3_rulePerformance;
  console.log('\n════════ 「02 교정 후」 종합 분석 (규칙엔진 tzl-ezl-rule-v1.0) ════════');
  console.log(`분석 성공: ${okResults.length}/${pred.results.length}장\n`);
  console.log('── 작업2: 교정전↔후 페어링 ──');
  console.log(`  치아폭 정답 매칭: ${report.task2_beforeAfterTzlCrossCheck.matchedPairs}쌍`);
  console.log(`  ⚠️ 교정전/후 사진 스케일 상이 → 픽셀합 직접 비교 불가(스케일 정규화 필요)\n`);
  console.log('── 작업1: 이상적 EZ 곡선 타깃 형태 분포 ──');
  console.log(`  EZL(mm)         : mean ${t1.ezlMm.mean}  median ${t1.ezlMm.median}  p95 ${t1.ezlMm.p95}  [${t1.ezlMm.min}~${t1.ezlMm.max}]`);
  console.log(`  아치폭/대각선   : mean ${t1.archWidthRatio.mean}  [${t1.archWidthRatio.min}~${t1.archWidthRatio.max}]`);
  console.log(`  아치깊이/대각선 : mean ${t1.archDepthRatio.mean}  [${t1.archDepthRatio.min}~${t1.archDepthRatio.max}]\n`);
  console.log('── 작업3: 규칙엔진 성능 지표 ──');
  console.log(`  EZL(mm)     : mean ${t3.ezlMm.mean}  p95 ${t3.ezlMm.p95}`);
  console.log(`  TZL(mm)     : mean ${t3.tzlMm.mean}  p95 ${t3.tzlMm.p95}`);
  console.log(`  EZL-TZL(mm) : mean ${t3.differenceMm.mean}  median ${t3.differenceMm.median}  [${t3.differenceMm.min}~${t3.differenceMm.max}]`);
  console.log(`  신뢰도(overall): mean ${t3.confidenceOverall.mean}  [${t3.confidenceOverall.min}~${t3.confidenceOverall.max}]`);
  console.log(`  저신뢰(<0.5) 케이스: ${t3.lowConfidenceCases.length}건`);
  console.log(`  EZL<TZL(공간부족 시사) 케이스: ${t3.negativeDifferenceCases}건`);
  console.log(`\n리포트 저장: ${path.join(HERE, 'corrected_after_report.json')}`);
}

main();
