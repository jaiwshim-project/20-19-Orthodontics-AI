// 대조군 검사 — 재시도층을 끈 사본에서는 정말 빈 응답이 나오는가.
//
// ⚠️ 이게 없으면 "재시도가 통했다"는 위양성일 수 있다: max_tokens=40 에서 애초에
//    빈 응답이 안 났을 뿐인데 재시도 덕이라고 오해할 수 있다
//    (feedback_verify_layer_actually_runs — 대조군 무결성까지 검사한다).
// 같은 이미지·같은 파라미터로 N회씩 돌려 빈 응답률을 비교한다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const APP_ROOT = path.dirname(PROJECT);
const N = Number(process.env.N || 8);
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(APP_ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const withRetry = await import(toUrl(path.join(APP_ROOT, 'lib', 'ai-provider.js')));
const noRetry = await import(toUrl(path.join(APP_ROOT, 'lib', '_ai_provider_noretry.js')));

const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));
const buf = await sharp(path.join(PROJECT, pool[0].file))
  .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 85 }).toBuffer();
const meta = await sharp(buf).metadata();
const base64 = buf.toString('base64');

const call = (mod) => mod.anthropicVisionCompletion({
  system: 'Return only JSON.',
  images: [{ base64, contentType: 'image/jpeg' }],
  prompt: `Analyze this occlusal photo (${meta.width}x${meta.height}px) and return `
    + `{"teeth":[{"index":1,"widthMm":10.5}],"ttlMm":100}. JSON only.`,
  model: 'claude-sonnet-5', maxTokens: 40, temperature: 0.1, timeoutMs: 120000
});

async function rate(mod, label) {
  let empty = 0;
  for (let i = 0; i < N; i++) {
    try { if (!(await call(mod))) empty++; }
    catch (e) { console.log(`   (${label} 예외: ${String(e?.message || e).slice(0, 60)})`); empty++; }
  }
  console.log(`  ${label}: 빈 응답 ${empty}/${N} (${Math.round(empty / N * 100)}%)`);
  return empty;
}

console.log('max_tokens=40 강제 조건에서 빈 응답률 비교 (N=%d)\n', N);
const ctrl = await rate(noRetry, '대조군(재시도 OFF)');
const test = await rate(withRetry, '수정본(재시도 ON) ');

const ok = ctrl > 0 && test < ctrl;
console.log('\n%s 대조군에서 빈 응답 %d건 발생 → 재시도층이 %d건으로 감소',
  ok ? '✅' : '★판정보류', ctrl, test);
if (!ctrl) console.log('   ⚠️ 대조군에서 빈 응답이 0건이면 이 조건은 재현력이 없다 → 검증 무효');

writeFileSync(path.join(HERE, 'retry_control.json'), JSON.stringify({
  schemaVersion: 'retry-control-v1',
  privacy: { containsPhi: false, containsFilePaths: false, note: '빈 응답 건수만' },
  purpose: '빈 텍스트 재시도층의 효과를 대조군(층 OFF)과 비교해 위양성 배제',
  config: { model: 'claude-sonnet-5', maxTokens: 40, trials: N },
  result: { 대조군_빈응답: ctrl, 수정본_빈응답: test, 재현력있음: ctrl > 0, 개선: ok }
}, null, 2) + '\n');
process.exit(ok ? 0 : 1);
