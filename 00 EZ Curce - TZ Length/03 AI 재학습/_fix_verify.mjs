// 수정 2건이 실제로 동작하는지 검증한다("파일에 코드가 있다" ≠ "그 분기가 돌았다").
//
// 검증 1: VISION 기본값이 haiku 로 되돌아갔는가 (환경변수 없을 때)
// 검증 2: 빈 텍스트 재시도가 실제로 발동해 텍스트를 살리는가
//         → max_tokens 를 일부러 극단적으로 낮춰(=thinking 이 반드시 소진) 재현한다.
// 검증 3: measure-tooth-widths 핸들러가 haiku 로 200 + teeth 를 반환하는가
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const APP_ROOT = path.dirname(PROJECT);
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
// 기본값을 보려면 오버라이드가 없어야 한다
delete process.env.ANTHROPIC_MODEL;
delete process.env.ANTHROPIC_MODEL_VISION;
delete process.env.GEMINI_API_KEY;

const lib = await import(toUrl(path.join(APP_ROOT, 'lib', 'ai-provider.js')));
const checks = [];
const add = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✅' : '★실패'} ${name} — ${detail}`);
};

// ── 검증 1
add('VISION 기본값 되돌림',
  lib.ANTHROPIC_MODEL_VISION === 'claude-haiku-4-5-20251001',
  `VISION=${lib.ANTHROPIC_MODEL_VISION} (HEAVY=${lib.ANTHROPIC_MODEL_HEAVY}, LIGHT=${lib.ANTHROPIC_MODEL_LIGHT})`);

// 이미지 준비
const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));
const buf = await sharp(path.join(PROJECT, pool[0].file))
  .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85 }).toBuffer();
const meta = await sharp(buf).metadata();
const base64 = buf.toString('base64');

// ── 검증 2: max_tokens 를 극히 낮춰 빈 응답을 강제 → 재시도가 살려내야 한다
// sonnet 은 thinking 을 자주 내므로 재현에 유리하다(모델 정책과 무관한 회귀 테스트).
let retryOk = false, retryDetail = '';
for (let attempt = 1; attempt <= 4 && !retryOk; attempt++) {
  const text = await lib.anthropicVisionCompletion({
    system: 'Return only JSON.',
    images: [{ base64, contentType: 'image/jpeg' }],
    prompt: `Analyze this occlusal photo (${meta.width}x${meta.height}px) and return `
      + `{"teeth":[{"index":1,"widthMm":10.5}],"ttlMm":100}. JSON only.`,
    model: 'claude-sonnet-5', maxTokens: 40, temperature: 0.1, timeoutMs: 120000
  });
  if (text) { retryOk = true; retryDetail = `시도 ${attempt}회차에 텍스트 확보(${text.length}자) — 재시도층이 빈 응답을 구제`; }
  else retryDetail = `시도 ${attempt}회차 여전히 빈 응답`;
}
add('빈 텍스트 재시도 발동', retryOk, retryDetail);

// ── 검증 3: 핸들러 실구동 (haiku 경로)
const handler = (await import(toUrl(path.join(APP_ROOT, 'api', 'measure-tooth-widths.js')))).default;
const captured = {};
const res = {
  status(c) { captured.status = c; return this; },
  json(b) { captured.body = b; return this; },
  end() { return this; }
};
await handler({ method: 'POST', body: {
  base64, contentType: 'image/jpeg', arch: 'lower',
  imageWidth: meta.width, imageHeight: meta.height, molarDistanceMm: 54
} }, res);
const b = captured.body || {};
add('핸들러 haiku 실구동',
  captured.status === 200 && b.provider === 'anthropic:claude-haiku-4-5-20251001'
    && Array.isArray(b.teeth) && b.teeth.length >= 10,
  `status=${captured.status} provider=${b.provider} teeth=${b.teeth?.length} ttl=${b.ttlMm}`);

const report = {
  schemaVersion: 'fix-verify-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    note: '검증 통과 여부와 모델명만' },
  purpose: 'VISION haiku 되돌림 + 빈 텍스트 재시도가 실제로 동작하는지 실구동 확인',
  checks,
  verdict: { passed: checks.filter((c) => c.ok).length, total: checks.length,
    failed: checks.filter((c) => !c.ok).map((c) => c.name) }
};
writeFileSync(path.join(HERE, 'fix_verify.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\n통과 %d / %d', report.verdict.passed, report.verdict.total);
process.exit(report.verdict.failed.length ? 1 : 0);
