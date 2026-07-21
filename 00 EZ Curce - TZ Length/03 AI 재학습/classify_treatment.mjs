#!/usr/bin/env node
/*
 * 트랙B: 교정 전/후 비교 → 교정 치료방법 3분류 학습.
 *
 * 김용을 원장 이론(EZL/TZL) 기반. 교정 전 치아폭 정답과 교정 후 치아폭 정답을
 * 파일번호(환자)로 페어링해, 치아 개수와 TZL(치아 좌우폭 합, mm) 변화로
 * 세 가지 치료방법을 판정한다:
 *   ① 발치 후 교정틀 부착   : 치아 개수 감소 (교정후 < 교정전)
 *   ② IPR(치간삭제) 후 교정틀: 개수 동일 + TZL 유의 감소 (치아를 갈아 폭을 줄임)
 *   ③ 치아유지 + 교정틀만    : 개수·TZL 거의 동일 (배열만 교정)
 *
 * 스케일: 두 사진 모두 molarMm=54(양쪽 어금니 간 거리 54mm)를 기준으로 하므로,
 * 각 사진의 px→mm 스케일 = 54 / (해당 사진의 양끝 치아폭 끝점 간 픽셀 거리).
 * 다만 정답 라벨에는 어금니간 픽셀거리가 별도 저장돼 있지 않으므로,
 * 치아폭 선분들의 픽셀 합(TZL_px)을 그대로 두 사진 각각의 최외곽 스팬으로 정규화한다.
 * 개수 변화는 스케일 무관하게 신뢰할 수 있는 1차 신호다.
 *
 * 원본 폴더는 읽기 전용. 출력: treatment_classification.json
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');

function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT, pre); if (existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, prefixes[0]);
}

const PRE_WIDTH_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');
const POST_WIDTH_DIR = resolveDir('02 교정 후 치아폭 찍기(김원장님)', '02 교정 후 치아폭 찍기');
const OUT = path.join(HERE, 'treatment_classification.json');

function numPrefix(name) { const m = /^\s*(\d+)/.exec(name); return m ? m[1] : null; }

function extractJson(text) {
  const marker = text.indexOf('```json');
  if (marker < 0) return null;
  const start = text.indexOf('{', marker);
  const end = text.indexOf('\n```', start);
  if (start < 0 || end < 0) return null;
  try { return JSON.parse(text.slice(start, end)); } catch { return null; }
}

function dist(p1, p2) { return Math.hypot(p2.x - p1.x, p2.y - p1.y); }

// 치아폭 선분 길이 합(px)과 최외곽 스팬(px)으로 스케일 불변 지표 산출.
function widthStats(toothWidths) {
  const segs = (toothWidths || []).filter((w) => w?.p1 && w?.p2);
  const n = segs.length;
  if (!n) return null;
  const lengths = segs.map((w) => dist(w.p1, w.p2));
  const sumPx = lengths.reduce((a, b) => a + b, 0);
  // 최외곽 스팬: 모든 끝점 중 서로 가장 먼 두 점 간 거리(어금니~어금니 근사).
  const pts = segs.flatMap((w) => [w.p1, w.p2]);
  let span = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = dist(pts[i], pts[j]); if (d > span) span = d;
  }
  return { n, sumPx, spanPx: span, lengths };
}

// molarMm=54 기준: 아치 최외곽 스팬을 어금니 간 거리로 근사해 px→mm 스케일 추정.
function toMm(stats, molarMm = 54) {
  if (!stats || stats.spanPx <= 0) return null;
  const pxPerMm = stats.spanPx / molarMm;
  return { tzlMm: stats.sumPx / pxPerMm, pxPerMm, n: stats.n };
}

async function loadWidthByNum(dir) {
  const map = new Map();
  for (const name of (await readdir(dir)).filter((n) => /\.md$/i.test(n))) {
    const buf = await readFile(path.join(dir, name));
    if (!buf.length) continue;
    const j = extractJson(buf.toString('utf8'));
    if (!j) continue;
    const stats = widthStats(j.toothWidths);
    if (!stats) continue;
    const num = numPrefix(name);
    if (num) map.set(num, { fileName: name, molarMm: j.molarMm || 54, ...toMm(stats, j.molarMm || 54), rawN: stats.n });
  }
  return map;
}

// 뒷자리 1 차이(3166000↔3166001)까지 허용해 동일 환자 매칭.
function matchNum(num, map) {
  if (map.has(num)) return num;
  for (const c of [num.replace(/0$/, '1'), num.replace(/1$/, '0')]) if (map.has(c)) return c;
  return null;
}

function classify(pre, post) {
  const dN = post.n - pre.n;                 // 치아 개수 변화
  const tzlRatio = post.tzlMm / pre.tzlMm;    // TZL 비율(1보다 작으면 감소)
  const IPR_THRESH = 0.95;                    // TZL 5%+ 감소 시 IPR로 판정
  if (dN <= -1) {
    return { method: 'extraction', label: '① 발치 후 교정틀 부착', reason: `치아 개수 ${pre.n}→${post.n} (감소 ${-dN}개)` };
  }
  if (tzlRatio <= IPR_THRESH) {
    return { method: 'ipr', label: '② IPR(치간삭제) 후 교정틀 부착', reason: `개수 유지(${pre.n}) + TZL ${(100 * (1 - tzlRatio)).toFixed(1)}% 감소` };
  }
  return { method: 'retain', label: '③ 치아유지 + 교정틀만', reason: `개수 유지(${pre.n}) + TZL 변화 ${((tzlRatio - 1) * 100).toFixed(1)}%` };
}

async function main() {
  const preMap = await loadWidthByNum(PRE_WIDTH_DIR);
  const postMap = await loadWidthByNum(POST_WIDTH_DIR);

  const cases = [];
  for (const [num, post] of postMap) {
    const preNum = matchNum(num, preMap);
    if (!preNum) { cases.push({ num, status: 'no_pre_pair', post }); continue; }
    const pre = preMap.get(preNum);
    const cls = classify(pre, post);
    cases.push({
      num, preNum, status: 'ok',
      pre: { n: pre.n, tzlMm: Math.round(pre.tzlMm * 10) / 10 },
      post: { n: post.n, tzlMm: Math.round(post.tzlMm * 10) / 10 },
      deltaTeeth: post.n - pre.n,
      tzlRatio: Math.round((post.tzlMm / pre.tzlMm) * 1000) / 1000,
      ...cls,
    });
  }

  const ok = cases.filter((c) => c.status === 'ok');
  const byMethod = { extraction: 0, ipr: 0, retain: 0 };
  for (const c of ok) byMethod[c.method]++;

  const payload = {
    schemaVersion: 'treatment-classification-v1',
    createdAt: new Date().toISOString(),
    note: '교정 전/후 치아폭 정답을 파일번호로 페어링해 치료방법 3분류. 개수 변화=발치, TZL 5%+감소=IPR, 그 외=치아유지+교정틀.',
    scaleNote: 'px→mm는 각 사진의 최외곽 치아폭 끝점 스팬을 molarMm(54)로 근사 정규화. 개수 변화는 스케일 불변 1차 신호.',
    thresholds: { iprTzlRatioMax: 0.95, extractionTeethDelta: -1 },
    pairedCases: ok.length,
    unpaired: cases.filter((c) => c.status !== 'ok').length,
    distribution: byMethod,
    cases: cases.sort((a, b) => String(a.num).localeCompare(String(b.num), 'en', { numeric: true })),
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2), 'utf8');

  console.log('=== 교정 치료방법 3분류 결과 ===');
  console.log('페어링 성공:', ok.length, '/ 미페어링:', payload.unpaired);
  console.log('① 발치 후 교정틀:', byMethod.extraction, '건');
  console.log('② IPR 후 교정틀 :', byMethod.ipr, '건');
  console.log('③ 치아유지+교정틀:', byMethod.retain, '건');
  console.log('→', OUT);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exitCode = 1; });
