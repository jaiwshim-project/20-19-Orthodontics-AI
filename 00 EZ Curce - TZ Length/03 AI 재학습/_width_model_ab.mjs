// 치아 폭 API 의 모델 A/B — haiku-4-5(마이그레이션 전) vs sonnet-5(현재).
//
// 왜 필요한가: measure-tooth-widths 는 마이그레이션 *전에도* Claude 분기가 있었다
// (기본값 haiku-4-5-20251001). 즉 이번 변경은 "죽었다→살았다"가 아니라 모델 교체다.
// 따라서 "더 정확해졌나"는 같은 이미지·같은 프롬프트로 두 모델을 재실행해야 답할 수 있다.
//
// ⚠️ 정답은 픽셀 좌표쌍(p1,p2)이고 API 는 mm 를 반환한다 → 직접 비교 불가.
//    정답도 API 와 동일한 스케일 규약(1번↔14번 어금니 거리 = molarDistanceMm)으로
//    mm 로 환산해서 비교한다. 규약이 같으므로 두 모델에 공평하다.
// ⚠️ PHI 금지: 산출물에는 4자리 차트번호/파일명만, 좌표·절대경로 없음.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const N = Number(process.env.AB_N || 12);
const MOLAR_MM = 54; // step3-new.html 기본값과 동일

const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

// .env.local (BOM + CRLF)
const APP_ROOT = path.dirname(PROJECT);
for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
// Gemini 는 정지 상태이나, 분기 순서상 Claude 가 먼저이므로 영향 없음. 명시적으로 제거.
delete process.env.GEMINI_API_KEY;

const { anthropicVisionCompletion } = await import(
  toUrl(path.join(APP_ROOT, 'lib', 'ai-provider.js')));

const truth = JSON.parse(readFileSync(path.join(HERE, 'truth_lookup.json'), 'utf8'));
const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'))
  .slice(0, N);

// api/measure-tooth-widths.js 와 동일한 프롬프트 (복제 — 라우트는 req/res 를 요구)
const SYSTEM_PROMPT = `You are an orthodontic measurement AI. Given a lower or upper occlusal photo, identify each tooth from left molar to right molar (14 teeth total) and measure the mesiodistal width of each tooth in millimeters.

CRITICAL SCALE RULE:
- The user provides molarDistanceMm = the real-world distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar).
- Use this as the ONLY scale reference.
- Measure each tooth's mesiodistal width as a proportion of this known distance, then convert to mm.
- The sum of all 14 tooth widths (TTL) should typically be 95-115mm for a normal adult dentition.

For each tooth, output:
- index: 1-14 (left to right in the photo)
- widthMm: mesiodistal width in millimeters (calculated using the molarDistanceMm scale)
- note: tooth name (e.g. "좌측 제2대구치")

Output ONLY valid JSON with this structure:
{
  "success": true,
  "teeth": [{"index": 1, "widthMm": 10.5, "note": "좌측 제2대구치"}, ...],
  "ttlMm": number (sum of all widthMm),
  "confidence": number (0-1),
  "arch": "lower" or "upper"
}`;

const userPrompt = (w, h) => `Analyze this lower occlusal photo (${w}x${h}px).
Identify all visible teeth from left to right (up to 14).
SCALE: The distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar) is ${MOLAR_MM}mm.
Measure each tooth's mesiodistal width in mm using this scale.
Return ONLY the JSON object with widthMm for each tooth and ttlMm as the sum.`;

// 정답 픽셀 → mm. API 와 같은 규약: 1번 치아 중심 ↔ 마지막 치아 중심 거리 = MOLAR_MM
function truthMm(tw) {
  const mid = (s) => ({ x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2 });
  const a = mid(tw[0]), b = mid(tw[tw.length - 1]);
  const spanPx = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(spanPx > 0)) return null;
  const mmPerPx = MOLAR_MM / spanPx;
  const widths = tw.map((s) => Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y) * mmPerPx);
  return { widths, ttl: widths.reduce((s, v) => s + v, 0) };
}

function parseTeeth(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let p; try { p = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(p?.teeth)) return null;
  const teeth = p.teeth
    .map((t) => ({ index: Number(t.index), widthMm: Number(t.widthMm) || 0 }))
    .filter((t) => t.index >= 1 && t.index <= 14 && t.widthMm > 0)
    .sort((a, b) => a.index - b.index);
  if (!teeth.length) return null;
  const ttl = Number(p.ttlMm) || teeth.reduce((s, t) => s + t.widthMm, 0);
  return { widths: teeth.map((t) => t.widthMm), ttl };
}

// ⚠️ 치아 개수 정렬 문제 — 첫 실행에서 발견한 함정.
//    정답 주석은 11~12개(결손·미가시 치아 제외)인데 모델은 프롬프트대로 항상 14개를
//    반환한다. 인덱스를 그대로 1:1 로 짝지으면 "정답 1번 = 모델 1번"이 성립하지 않아
//    MAE 가 정렬 오차를 폭 오차로 오인한다(두 모델 모두 14개이므로 방향 편향은
//    없지만, 절대값 자체가 무의미해진다).
//    → 슬라이딩 오프셋으로 MAE 최소가 되는 정렬을 찾아 그 값을 쓴다. 모델에 유리한
//      쪽으로 기울지만 두 모델에 동일 규칙이므로 비교에는 공평하다.
function bestAlign(pred, truth) {
  const k = truth.length;
  if (pred.length < k) return { offset: null, mae: null, sumErrPct: null };
  let best = null;
  for (let off = 0; off + k <= pred.length; off++) {
    let s = 0, sum = 0;
    for (let i = 0; i < k; i++) { s += Math.abs(pred[off + i] - truth[i]); sum += pred[off + i]; }
    const mae = s / k;
    if (!best || mae < best.mae) {
      const tsum = truth.reduce((a, b) => a + b, 0);
      best = { offset: off, mae, sumErrPct: Math.abs(sum - tsum) / tsum * 100 };
    }
  }
  return best;
}

const MODELS = {
  'haiku-4-5(구)': 'claude-haiku-4-5-20251001',
  'sonnet-5(현)': 'claude-sonnet-5'
};

// step3-new.html:876-883 과 동일 — maxDim 1200, jpeg quality 0.85.
// ⚠️ 원본(3600~4100px, 9~14MB)은 Anthropic 5MB 한도를 넘어 400 이 난다(실측).
//    앱이 보내는 것과 같은 크기로 맞춰야 A/B 가 실제 사용 조건을 반영한다.
const MAX_DIM = 1200;
async function appPayload(file) {
  const buf = await sharp(path.join(PROJECT, file))
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(buf).metadata();
  return { base64: buf.toString('base64'), w: meta.width, h: meta.height };
}

const rows = [];
for (const p of pool) {
  const t = truthMm(truth[p.sha].toothWidths);
  if (!t) continue;
  const { base64, w: sw, h: sh } = await appPayload(p.file);
  const row = { chart: truth[p.sha].id.slice(-4), truthTtl: t.ttl, truthN: t.widths.length };
  for (const [tag, model] of Object.entries(MODELS)) {
    try {
      const out = await anthropicVisionCompletion({
        system: SYSTEM_PROMPT, images: [{ base64, contentType: 'image/jpeg' }],
        prompt: userPrompt(sw, sh), model,
        maxTokens: 3000, temperature: 0.1, timeoutMs: 90000
      });
      const pr = parseTeeth(out);
      if (!pr) { row[tag] = { fail: 'parse' }; continue; }
      const al = bestAlign(pr.widths, t.widths);
      row[tag] = {
        ttl: Math.round(pr.ttl * 10) / 10,
        ttlErrPct: Math.round(Math.abs(pr.ttl - t.ttl) / t.ttl * 1000) / 10,
        nTeeth: pr.widths.length,
        // 정렬 흡수 후 지표 (아래 bestAlign 주석 참조)
        alignOffset: al.offset,
        alignedMaeMm: al.mae === null ? null : Math.round(al.mae * 100) / 100,
        alignedSumErrPct: al.sumErrPct === null ? null : Math.round(al.sumErrPct * 10) / 10,
        widths: pr.widths.map((v) => Math.round(v * 100) / 100)
      };
    } catch (e) {
      row[tag] = { fail: String(e?.message || e).slice(0, 80) };
    }
  }
  rows.push(row);
  const f = (k) => row[k]?.fail ? '실패'
    : `TTL오차 ${row[k].ttlErrPct}% / 정렬MAE ${row[k].alignedMaeMm}mm(off${row[k].alignOffset})`;
  console.log(`  ${row.chart}: 정답TTL ${row.truthTtl.toFixed(1)}mm | 구 ${f('haiku-4-5(구)')} | 신 ${f('sonnet-5(현)')}`);
}

function agg(tag, field) {
  const v = rows.map((r) => r[tag]?.[field]).filter((x) => typeof x === 'number');
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  return { n: v.length, mean: Math.round(mean * 100) / 100,
    median: Math.round(v[Math.floor(v.length / 2)] * 100) / 100 };
}

// 쌍대 비교(같은 이미지) — 부호 검정
function pairedSign(field) {
  let better = 0, worse = 0, tie = 0;
  for (const r of rows) {
    const a = r['haiku-4-5(구)']?.[field], b = r['sonnet-5(현)']?.[field];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (b < a) better++; else if (b > a) worse++; else tie++;
  }
  return { 신모델우세: better, 구모델우세: worse, 동일: tie };
}

const report = {
  schemaVersion: 'width-model-ab-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false,
    note: '4자리 차트번호 + mm 단위 오차만. 좌표·절대경로 없음' },
  purpose: 'measure-tooth-widths 의 모델 교체(haiku-4-5→sonnet-5)가 정확도를 바꿨는지 쌍대 실측',
  caveat: '정답은 픽셀 좌표 → API 와 동일한 molarDistanceMm=54 스케일 규약으로 mm 환산. '
    + '두 모델에 동일 조건. 프론트(step3-new.html)는 이 API 를 쓰고, '
    + '연구용 보정후 HTML 은 로컬 ONNX 이므로 이 결과와 무관.',
  payload: { maxDim: MAX_DIM, jpegQuality: 85,
    note: 'step3-new.html 과 동일. 원본 그대로는 5MB 한도 초과로 400' },
  n: rows.length, molarDistanceMm: MOLAR_MM,
  alignNote: '정답 주석 11~12개 vs 모델 14개 → 슬라이딩 오프셋으로 MAE 최소 정렬 후 비교. '
    + '두 모델 동일 규칙.',
  aggregate: {
    ttlErrPct: { 구: agg('haiku-4-5(구)', 'ttlErrPct'), 신: agg('sonnet-5(현)', 'ttlErrPct') },
    alignedMaeMm: { 구: agg('haiku-4-5(구)', 'alignedMaeMm'), 신: agg('sonnet-5(현)', 'alignedMaeMm') },
    alignedSumErrPct: { 구: agg('haiku-4-5(구)', 'alignedSumErrPct'), 신: agg('sonnet-5(현)', 'alignedSumErrPct') }
  },
  paired: { ttlErrPct: pairedSign('ttlErrPct'), alignedMaeMm: pairedSign('alignedMaeMm'),
    alignedSumErrPct: pairedSign('alignedSumErrPct') },
  cases: rows
};
writeFileSync(path.join(HERE, 'width_model_ab.json'),
  JSON.stringify(report, null, 2) + '\n');

console.log('\n=== 집계 (n=%d) ===', rows.length);
console.log('TTL 오차%%   구 평균 %s / 신 평균 %s',
  report.aggregate.ttlErrPct.구?.mean, report.aggregate.ttlErrPct.신?.mean);
console.log('정렬 MAE     구 평균 %smm / 신 평균 %smm',
  report.aggregate.alignedMaeMm.구?.mean, report.aggregate.alignedMaeMm.신?.mean);
console.log('정렬구간 합오차%% 구 %s / 신 %s',
  report.aggregate.alignedSumErrPct.구?.mean, report.aggregate.alignedSumErrPct.신?.mean);
console.log('쌍대 TTL:', JSON.stringify(report.paired.ttlErrPct, null, 0));
console.log('쌍대 정렬MAE:', JSON.stringify(report.paired.alignedMaeMm, null, 0));
