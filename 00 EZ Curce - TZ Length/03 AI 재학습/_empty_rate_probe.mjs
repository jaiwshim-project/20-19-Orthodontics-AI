// 빈 응답의 발생률과 원인 확정.
//
// 진단 1차 결과: 실패 2건을 재실행하니 둘 다 성공 → 간헐적. 한 건은 응답에
// `thinking` 블록이 있었다. 가설: sonnet-5 가 때때로 thinking 을 내보내고,
// thinking 이 max_tokens 를 소진하면 text 블록이 0개가 되어 lib 추출기가 ''를 준다
// (stop_reason=max_tokens). → 같은 케이스를 반복 호출해 발생률과 stop_reason 을 본다.
//
// ⚠️ 이 가설이 맞으면 대책은 "maxTokens 상향"이 아니라 "빈 텍스트 재시도"다.
//    상향은 확률만 낮추고 0 으로 만들지 못한다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const APP_ROOT = path.dirname(PROJECT);
const REPEATS = Number(process.env.REPEATS || 6);
const MAX_TOKENS = Number(process.env.MT || 3000);

for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const truth = JSON.parse(readFileSync(path.join(HERE, 'truth_lookup.json'), 'utf8'));
const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));

const SYS = `You are an orthodontic measurement AI. Given a lower or upper occlusal photo, identify each tooth from left molar to right molar (14 teeth total) and measure the mesiodistal width of each tooth in millimeters.

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

const Anthropic = (await import('@anthropic-ai/sdk')).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 앞 4건을 반복 호출 (특정 이미지 특성이 아니라 확률 현상인지 확인)
const targets = pool.slice(0, 4);
const trials = [];

for (const p of targets) {
  const buf = await sharp(path.join(PROJECT, p.file))
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(buf).metadata();
  const base64 = buf.toString('base64');
  const chart = String(truth[p.sha].id).slice(-4);

  for (let i = 0; i < REPEATS; i++) {
    try {
      const resp = await client.messages.create({
        model: 'claude-sonnet-5', max_tokens: MAX_TOKENS, system: SYS,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: `Analyze this lower occlusal photo (${meta.width}x${meta.height}px).
Identify all visible teeth from left to right (up to 14).
SCALE: The distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar) is 54mm.
Measure each tooth's mesiodistal width in mm using this scale.
Return ONLY the JSON object with widthMm for each tooth and ttlMm as the sum.` }
        ] }]
      }, { timeout: 120000 });
      const types = (resp.content || []).map((b) => b.type);
      const textLen = (resp.content || []).filter((b) => b.type === 'text')
        .map((b) => b.text).join('').length;
      trials.push({ chart, trial: i + 1, stop: resp.stop_reason, types,
        hasThinking: types.includes('thinking'), textLen,
        outTok: resp.usage?.output_tokens ?? null });
    } catch (e) {
      trials.push({ chart, trial: i + 1, error: String(e?.message || e).slice(0, 80) });
    }
  }
  const mine = trials.filter((t) => t.chart === chart);
  console.log(`  ${chart}: 빈응답 ${mine.filter((t) => t.textLen === 0).length}/${mine.length}, `
    + `thinking ${mine.filter((t) => t.hasThinking).length}/${mine.length}, `
    + `stop=${[...new Set(mine.map((t) => t.stop))].join(',')}`);
}

const empty = trials.filter((t) => t.textLen === 0);
const thinking = trials.filter((t) => t.hasThinking);
const report = {
  schemaVersion: 'empty-rate-probe-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    note: '4자리 차트번호 + 응답 메타데이터만' },
  purpose: 'sonnet-5 빈 텍스트 응답의 발생률·원인(thinking 블록/stop_reason) 확정',
  config: { model: 'claude-sonnet-5', maxTokens: MAX_TOKENS, repeats: REPEATS,
    cases: targets.length },
  verdict: {
    총시행: trials.length,
    빈응답: empty.length,
    빈응답률: Math.round(empty.length / trials.length * 1000) / 10,
    thinking블록출현: thinking.length,
    빈응답의stopReason: [...new Set(empty.map((t) => t.stop))],
    빈응답중thinking보유: empty.filter((t) => t.hasThinking).length,
    stopReason분포: Object.fromEntries(
      [...new Set(trials.map((t) => t.stop))].map((s) => [String(s),
        trials.filter((t) => t.stop === s).length]))
  },
  trials
};
writeFileSync(path.join(HERE, 'empty_rate_probe.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\n=== 판정 ===');
console.log(JSON.stringify(report.verdict, null, 1));
