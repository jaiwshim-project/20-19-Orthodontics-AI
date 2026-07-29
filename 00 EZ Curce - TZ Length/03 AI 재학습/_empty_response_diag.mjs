// sonnet-5 가 텍스트 0바이트를 반환한 2건의 원인 진단.
//
// lib 의 추출기는 content 중 type==='text' 만 모은다 → rawLen 0 은
// ① 텍스트 블록이 아예 없다(다른 블록 타입만 왔다) 또는
// ② stop_reason 이 max_tokens/refusal 이라 본문이 안 나왔다는 뜻이다.
// 어느 쪽인지 원시 응답으로 확정한다(추측 금지).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const APP_ROOT = path.dirname(PROJECT);

for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const truth = JSON.parse(readFileSync(path.join(HERE, 'truth_lookup.json'), 'utf8'));
const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));
const raw = JSON.parse(readFileSync(path.join(HERE, 'width_ab_raw.json'), 'utf8'));

// 실패 케이스의 group(정답 id) → pool 항목 역추적
const failGroups = new Set(raw.cases.filter((c) => c.sonnet?.fail).map((c) => c.group));
const targets = pool.filter((p) => failGroups.has(String(truth[p.sha].id)));
console.log('실패 케이스 재현 대상:', targets.length);

const Anthropic = (await import('@anthropic-ai/sdk')).default;
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = raw.config ? null : null; // 아래에서 동일 프롬프트 재구성
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

const findings = [];
for (const p of targets) {
  const buf = await sharp(path.join(PROJECT, p.file))
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(buf).metadata();
  const resp = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4000,
    system: SYS,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } },
      { type: 'text', text: `Analyze this lower occlusal photo (${meta.width}x${meta.height}px).
Identify all visible teeth from left to right (up to 14).
SCALE: The distance between tooth #1 (leftmost molar) and tooth #14 (rightmost molar) is 54mm.
Measure each tooth's mesiodistal width in mm using this scale.
Return ONLY the JSON object with widthMm for each tooth and ttlMm as the sum.` }
    ] }]
  }, { timeout: 120000 });

  const blocks = (resp.content || []).map((b) => ({ type: b.type,
    len: typeof b.text === 'string' ? b.text.length : null }));
  const textAll = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const f = {
    chart: String(truth[p.sha].id).slice(-4),
    stopReason: resp.stop_reason,
    stopSequence: resp.stop_sequence || null,
    blockTypes: blocks,
    outputTokens: resp.usage?.output_tokens ?? null,
    textLen: textAll.length,
    // 원문 앞부분만 — 진단에 필요한 최소량
    head: textAll.slice(0, 200)
  };
  findings.push(f);
  console.log(`  ${f.chart}: stop=${f.stopReason} blocks=${JSON.stringify(blocks)} outTok=${f.outputTokens} textLen=${f.textLen}`);
  if (f.head) console.log(`    head: ${f.head.replace(/\n/g, ' ').slice(0, 160)}`);
}

writeFileSync(path.join(HERE, 'empty_response_diag.json'), JSON.stringify({
  schemaVersion: 'empty-response-diag-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    note: '4자리 차트번호 + 응답 메타데이터만' },
  purpose: 'sonnet-5 텍스트 0바이트 응답의 stop_reason/블록 타입 확정',
  findings
}, null, 2) + '\n');
