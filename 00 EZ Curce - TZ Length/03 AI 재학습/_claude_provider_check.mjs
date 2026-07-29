// lib/ai-provider.js 의 Claude 3단 모델 + 비전 함수 실호출 검증.
//
// ⚠️ 산출물에 키를 남기지 않는다. 실패 메시지는 safeErrorMessage 로 통과시킨다.
// ⚠️ .env.local 은 BOM + CRLF 다 — utf8 BOM 제거와 \r 제거를 모두 해야 파싱된다
//    (정규식 `$` 앞에 \r 이 남아 조용히 전부 미설정으로 흘렀다).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.APP_ROOT;
const HERE = process.env.OUT_DIR;
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const { anthropicVisionCompletion, anthropicChatCompletion,
  ANTHROPIC_MODEL_HEAVY, ANTHROPIC_MODEL_VISION, ANTHROPIC_MODEL_LIGHT,
  isAnthropicConfigured } = await import(toUrl(path.join(ROOT, 'lib', 'ai-provider.js')));
const { safeErrorMessage } = await import(toUrl(path.join(ROOT, 'lib', 'safe-error.js')));

// 64x64 단색 PNG — 환자 사진이 아니다(PHI 없음).
// ⚠️ 4x4 는 Claude 가 "Could not process image" 로 거부한다(너무 작다).
const SWATCH = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==';

const results = [];
async function probe(name, model, fn) {
  const started = process.hrtime.bigint();
  try {
    const out = await fn();
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    results.push({ name, model, ok: true, ms, replyChars: out.length,
      replyHead: out.slice(0, 60) });
    console.log(`  ✅ ${name} (${model}) ${ms}ms → "${out.slice(0, 50).replace(/\n/g, ' ')}"`);
  } catch (e) {
    const msg = safeErrorMessage(e).slice(0, 140);
    results.push({ name, model, ok: false, error: msg });
    console.log(`  ★실패 ${name} (${model}) → ${msg}`);
  }
}

console.log('키 설정:', isAnthropicConfigured());
console.log('모델 상수: HEAVY=%s VISION=%s LIGHT=%s',
  ANTHROPIC_MODEL_HEAVY, ANTHROPIC_MODEL_VISION, ANTHROPIC_MODEL_LIGHT);

await probe('vision-VISION', ANTHROPIC_MODEL_VISION, () => anthropicVisionCompletion({
  system: 'Answer with one word only.',
  prompt: 'What single color dominates this image?',
  images: [{ base64: SWATCH, contentType: 'image/png', label: 'test swatch' }],
  maxTokens: 20, timeoutMs: 40000,
}));
await probe('vision-LIGHT', ANTHROPIC_MODEL_LIGHT, () => anthropicVisionCompletion({
  system: 'Answer with one word only.',
  prompt: 'What single color dominates this image?',
  images: [{ base64: SWATCH, contentType: 'image/png' }],
  model: ANTHROPIC_MODEL_LIGHT, maxTokens: 20, timeoutMs: 40000,
}));
await probe('chat-HEAVY', ANTHROPIC_MODEL_HEAVY, () => anthropicChatCompletion({
  system: '한국어로 한 문장만 답한다.',
  messages: [{ role: 'user', content: '교정 유지장치는 왜 필요한가?' }],
  maxTokens: 90, timeoutMs: 40000,
}));
// JSON 응답 요구 — 비전 엔드포인트들이 실제로 쓰는 형태
await probe('vision-json', ANTHROPIC_MODEL_VISION, () => anthropicVisionCompletion({
  system: 'Return only valid JSON, no prose.',
  prompt: 'Return {"color":"<dominant color>"}',
  images: [{ base64: SWATCH, contentType: 'image/png' }],
  maxTokens: 60, timeoutMs: 40000,
}));

const report = {
  schemaVersion: 'claude-provider-check-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsApiKeys: false },
  purpose: 'Claude 3단 모델 ID 유효성 + lib 공용 비전 함수 실호출 검증',
  models: { heavy: ANTHROPIC_MODEL_HEAVY, vision: ANTHROPIC_MODEL_VISION,
    light: ANTHROPIC_MODEL_LIGHT },
  probes: results,
  verdict: {
    allOk: results.every((r) => r.ok),
    okCount: results.filter((r) => r.ok).length,
    total: results.length,
  },
};
writeFileSync(path.join(HERE, 'claude_provider_check.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log('\n통과', report.verdict.okCount, '/', report.verdict.total);
process.exit(report.verdict.allOk ? 0 : 1);
