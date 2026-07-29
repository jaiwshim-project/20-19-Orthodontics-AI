// 치아 폭 모델 A/B 확대판 — 정답 매칭 전량(57건) × 2모델, 치아별 폭 원자료를 남긴다.
//
// 목적: n=20 예비 실측에서 "TTL 은 sonnet 우세(12:5), 치아별 MAE 는 haiku 우세(17:0)"
//       라는 상반된 신호가 나왔다. 표본을 늘리고, 이후 전략 비교를 API 재호출 없이
//       오프라인으로 반복할 수 있도록 widths 배열을 그대로 저장한다.
//
// ⚠️ maxTokens 3000 에서 sonnet 파싱 실패 3/20 → 두 모델 모두 4000 으로 통일(공평).
// ⚠️ 원본(9~14MB)은 Anthropic 5MB 한도 초과 → step3-new.html 과 동일하게 1200px/q85.
// ⚠️ PHI 금지: 4자리 차트번호 + mm 수치만. 좌표·파일명·절대경로 없음.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const APP_ROOT = path.dirname(PROJECT);
const CONCURRENCY = Number(process.env.AB_CONC || 4);
const MOLAR_MM = 54;
const MAX_DIM = 1200;
const MAX_TOKENS = 4000;

const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
delete process.env.GEMINI_API_KEY;

const { anthropicVisionCompletion } = await import(
  toUrl(path.join(APP_ROOT, 'lib', 'ai-provider.js')));

const truth = JSON.parse(readFileSync(path.join(HERE, 'truth_lookup.json'), 'utf8'));
const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));

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

function truthMm(tw) {
  const mid = (s) => ({ x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2 });
  const a = mid(tw[0]), b = mid(tw[tw.length - 1]);
  const spanPx = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(spanPx > 0)) return null;
  const mmPerPx = MOLAR_MM / spanPx;
  return tw.map((s) => Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y) * mmPerPx);
}

function parseTeeth(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { err: 'no-json-object' };
  let p; try { p = JSON.parse(m[0]); } catch (e) { return { err: 'json-parse:' + e.message.slice(0, 40) }; }
  if (!Array.isArray(p?.teeth)) return { err: 'no-teeth-array' };
  const teeth = p.teeth
    .map((t) => ({ index: Number(t.index), widthMm: Number(t.widthMm) || 0 }))
    .filter((t) => t.index >= 1 && t.index <= 14 && t.widthMm > 0)
    .sort((a, b) => a.index - b.index);
  if (!teeth.length) return { err: 'empty-after-filter' };
  return { widths: teeth.map((t) => t.widthMm), reportedTtl: Number(p.ttlMm) || null };
}

async function appPayload(file) {
  const buf = await sharp(path.join(PROJECT, file))
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(buf).metadata();
  return { base64: buf.toString('base64'), w: meta.width, h: meta.height };
}

const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5' };

async function runCase(p) {
  const t = truthMm(truth[p.sha].toothWidths);
  if (!t) return null;
  const { base64, w, h } = await appPayload(p.file);
  const row = {
    chart: String(truth[p.sha].id).slice(-4),
    // 그룹 키 = 정답 id 전체(같은 케이스가 코호트별로 중복될 수 있다 → 분할 시 분리)
    group: String(truth[p.sha].id),
    truthWidths: t.map((v) => Math.round(v * 100) / 100)
  };
  for (const [tag, model] of Object.entries(MODELS)) {
    try {
      const out = await anthropicVisionCompletion({
        system: SYSTEM_PROMPT, images: [{ base64, contentType: 'image/jpeg' }],
        prompt: userPrompt(w, h), model,
        maxTokens: MAX_TOKENS, temperature: 0.1, timeoutMs: 120000
      });
      const pr = parseTeeth(out);
      row[tag] = pr.err
        ? { fail: pr.err, rawLen: String(out || '').length, rawTail: String(out || '').slice(-80) }
        : { widths: pr.widths.map((v) => Math.round(v * 100) / 100) };
    } catch (e) {
      row[tag] = { fail: 'api:' + String(e?.message || e).slice(0, 70) };
    }
  }
  const s = (k) => row[k]?.fail ? `실패(${row[k].fail.slice(0, 24)})`
    : `n=${row[k].widths.length} TTL=${row[k].widths.reduce((a, b) => a + b, 0).toFixed(1)}`;
  console.log(`  ${row.chart}: 정답 n=${t.length} TTL=${t.reduce((a, b) => a + b, 0).toFixed(1)} | haiku ${s('haiku')} | sonnet ${s('sonnet')}`);
  return row;
}

// 동시성 제한 워커 풀
const rows = [];
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < pool.length) {
    const p = pool[cursor++];
    try { const r = await runCase(p); if (r) rows.push(r); }
    catch (e) { console.log('  ★케이스 예외:', String(e?.message || e).slice(0, 80)); }
  }
}));

const report = {
  schemaVersion: 'width-ab-raw-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false,
    note: '4자리 차트번호 + mm 폭 수치만. 정답 좌표는 mm 로 환산되어 좌표성 없음' },
  purpose: '치아 폭 모델 A/B 원자료 — 전략 비교를 API 재호출 없이 오프라인 반복하기 위함',
  config: { molarDistanceMm: MOLAR_MM, maxDim: MAX_DIM, jpegQuality: 85,
    maxTokens: MAX_TOKENS, models: MODELS },
  n: rows.length,
  failures: {
    haiku: rows.filter((r) => r.haiku?.fail).length,
    sonnet: rows.filter((r) => r.sonnet?.fail).length
  },
  cases: rows
};
writeFileSync(path.join(HERE, 'width_ab_raw.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\n케이스 %d, 실패 haiku %d / sonnet %d → width_ab_raw.json',
  rows.length, report.failures.haiku, report.failures.sonnet);
