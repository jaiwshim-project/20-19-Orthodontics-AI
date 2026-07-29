// classify-and-upload 의 LIGHT(haiku) 경로가 provider 문자열까지 실제로 내는지 확인.
//
// ⚠️ 핸들러를 직접 부르면 Supabase 버킷에 테스트 파일을 쓴다 → 분류 호출만 같은
//    파라미터로 재현해 확인한다(운영 데이터 오염 금지).
// ⚠️ 셸 히어독으로 이 파일을 만들면 정규식의 백슬래시가 먹혀 SyntaxError 가 난다.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.APP_ROOT;
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const { anthropicVisionCompletion, ANTHROPIC_MODEL_LIGHT } =
  await import(toUrl(path.join(ROOT, 'lib', 'ai-provider.js')));

// 합성 64x64 PNG — 환자 사진이 아니다(PHI 없음).
const SWATCH = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==';

const out = await anthropicVisionCompletion({
  system: '치과 교정 이미지 분류 AI. JSON으로만 응답.',
  images: [{ base64: SWATCH, contentType: 'image/png' }],
  prompt: '{"category":"intraoral","slot":"01_front","confidence":0.95} 형식 JSON 으로만 답하라.',
  model: ANTHROPIC_MODEL_LIGHT,
  maxTokens: 200,
  temperature: 0.1,
  timeoutMs: 30000
});

// classify-and-upload 와 동일한 추출 규칙
const m = out.match(/\{[^}]+\}/);
let parsed = null;
if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
const provider = `anthropic:${ANTHROPIC_MODEL_LIGHT}`;
console.log(parsed ? '✅' : '★실패', 'LIGHT provider =', provider,
  '| 파싱 키:', parsed ? Object.keys(parsed).join(',') : '실패');
process.exit(parsed ? 0 : 1);
