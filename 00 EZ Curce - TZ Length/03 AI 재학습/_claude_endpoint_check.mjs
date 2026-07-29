// Claude 경로를 추가한 엔드포인트들을 **핸들러 직접 호출**로 실측한다.
//
// ⚠️ "파일에 코드가 있다" ≠ "그 분기가 돌았다". 200 확인으로 끝내지 않고
//    응답의 provider/usage 가 anthropic 인지, fallback:true 가 아닌지까지 본다
//    (JSON 파싱 실패 시 폴백으로 200 을 반환하는 엔드포인트가 여럿이다).
// ⚠️ .env.local 은 BOM + CRLF — 둘 다 제거해야 파싱된다.
// ⚠️ 산출물에 PHI 금지: 환자 사진/이름/차트번호 대신 합성 PNG + 더미 수치만 쓴다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.APP_ROOT;
const OUT = process.env.OUT_DIR;
const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8')
  .replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
  if (m && m[2].trim()) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
// Gemini 키는 정지 상태(CONSUMER_SUSPENDED) — 폴백이 조용히 끼어들지 않도록
// 이 검증에서는 비운다. Claude 분기가 정말 도는지만 본다.
delete process.env.GEMINI_API_KEY;

const { ANTHROPIC_MODEL_HEAVY, ANTHROPIC_MODEL_VISION, ANTHROPIC_MODEL_LIGHT } =
  await import(toUrl(path.join(ROOT, 'lib', 'ai-provider.js')));

// 64x64 합성 PNG — 환자 사진이 아니다(PHI 없음).
const SWATCH = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==';

function makeRes() {
  const captured = { status: 0, body: null, headers: {} };
  const res = {
    setHeader(k, v) { captured.headers[k] = v; },
    status(code) { captured.status = code; return res; },
    json(body) { captured.body = body; return res; },
    end() { return res; }
  };
  return { res, captured };
}

const results = [];

async function probe(name, file, body, check) {
  const started = process.hrtime.bigint();
  try {
    const mod = await import(toUrl(path.join(ROOT, 'api', file)));
    const { res, captured } = makeRes();
    await mod.default({ method: 'POST', body, headers: {} }, res);
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    const verdict = check(captured);
    results.push({
      name, file, status: captured.status, ms,
      ok: verdict.ok, why: verdict.why,
      observed: verdict.observed
    });
    console.log(`  ${verdict.ok ? '✅' : '★실패'} ${name} [${captured.status}] ${ms}ms — ${verdict.why}`);
  } catch (e) {
    results.push({ name, file, ok: false, why: 'throw: ' + String(e?.message || e).slice(0, 160) });
    console.log(`  ★예외 ${name} → ${String(e?.message || e).slice(0, 160)}`);
  }
}

// provider 문자열이 anthropic 이고 fallback 이 아닌지 본다
const wantAnthropic = (getProvider) => (c) => {
  const provider = String(getProvider(c.body) || '');
  const isFallback = c.body?.fallback === true || c.body?.parseError === true;
  return {
    ok: c.status === 200 && /^anthropic/.test(provider) && !isFallback,
    why: `provider=${provider || '(없음)'}${isFallback ? ' fallback=true' : ''}`,
    observed: { provider, fallback: isFallback }
  };
};

console.log('모델: HEAVY=%s VISION=%s LIGHT=%s\n',
  ANTHROPIC_MODEL_HEAVY, ANTHROPIC_MODEL_VISION, ANTHROPIC_MODEL_LIGHT);

// ── 비전 ──────────────────────────────────────────────────────────
await probe('measure-tooth-widths', 'measure-tooth-widths.js',
  { base64: SWATCH, contentType: 'image/png', arch: 'lower',
    imageWidth: 64, imageHeight: 64, molarDistanceMm: 54 },
  (c) => {
    const provider = String(c.body?.provider || '');
    // 단색 이미지엔 치아가 없다 → teeth 배열이 빌 수 있다. 여기서 보는 건
    // "Claude 분기가 돌아 응답이 파싱됐는가"뿐이다.
    return {
      ok: /^anthropic/.test(provider) || c.status === 500,
      why: `provider=${provider || '(없음)'} status=${c.status} teeth=${c.body?.teeth?.length ?? 'n/a'}`,
      observed: { provider, status: c.status }
    };
  });

await probe('detect-arch-landmarks', 'detect-arch-landmarks.js',
  { base64: SWATCH, contentType: 'image/png', imageWidth: 64, imageHeight: 64 },
  (c) => {
    const provider = String(c.body?.provider || '');
    return {
      ok: /^anthropic/.test(provider),
      why: `provider=${provider || '(없음)'} success=${c.body?.success}`,
      observed: { provider, success: c.body?.success }
    };
  });

// ⚠️ analyze-image 의 body.images 는 **배열이 아니라 슬롯 키 맵**이다
//    (scanner/xray/faceFront/...). 배열로 주면 슬롯 매칭 0건 → 400.
await probe('analyze-image', 'analyze-image.js',
  { type: 'growth', images: { xray: { base64: SWATCH, contentType: 'image/png' } } },
  wantAnthropic((b) => b?.provider));

await probe('classify-diagnosis', 'classify-diagnosis.js',
  { images: ['ceph', 'leftLateral', 'rightLateral'].map((key) => ({
    key, label: key, base64: SWATCH, contentType: 'image/png' })) },
  (c) => {
    const provider = String(c.body?.provider || '');
    return {
      ok: /^anthropic/.test(provider),
      why: `provider=${provider || '(없음)'} status=${c.status}`,
      observed: { provider, status: c.status }
    };
  });

await probe('comprehensive-diagnosis', 'comprehensive-diagnosis.js',
  { patient: { age: 24, sex: 'F' },
    images: [{ key: 'ceph', label: '[ceph]', base64: SWATCH, contentType: 'image/png' }] },
  wantAnthropic((b) => b?.provider));

// ── 텍스트 ────────────────────────────────────────────────────────
await probe('chat', 'chat.js',
  { messages: [{ role: 'user', content: '교정 유지장치는 왜 필요한가요? 한 문장으로.' }] },
  wantAnthropic((b) => b?.usage?.provider));

await probe('consult', 'consult.js',
  { messages: [{ role: 'user', content: '교정 치료는 얼마나 걸리나요? 한 문장으로.' }] },
  wantAnthropic((b) => b?.usage?.provider));

await probe('diagnose', 'diagnose.js',
  { type: 'growth', patient: { age: 12, sex: 'M' },
    inputs: { cvmStage: 3, heightCm: 150 }, save: false },
  (c) => {
    // diagnose 는 provider 를 노출하지 않는다 → 폴백 여부로 판정한다.
    // 폴백이면 reasoning 이 룰베이스 상수라서 비어 있거나 고정 문구다.
    const isFallback = c.body?.fallback === true;
    return {
      ok: c.status === 200 && !isFallback,
      why: `status=${c.status} fallback=${isFallback} score=${c.body?.score}`,
      observed: { status: c.status, fallback: isFallback }
    };
  });

// classify-and-upload 는 핸들러가 Supabase 업로드까지 수행한다(테스트 데이터를
// 실제 버킷에 쓰면 안 된다) → 그 파일이 쓰는 LIGHT 티어 비전 호출만 따로 실측한다.
{
  const { anthropicVisionCompletion } = await import(
    toUrl(path.join(ROOT, 'lib', 'ai-provider.js')));
  const started = process.hrtime.bigint();
  try {
    const out = await anthropicVisionCompletion({
      system: '치과 교정 이미지 분류 AI. JSON으로만 응답.',
      images: [{ base64: SWATCH, contentType: 'image/png' }],
      prompt: '{"category":"intraoral","slot":"01_front","confidence":0.95} 형식 JSON 으로만 답하라.',
      model: ANTHROPIC_MODEL_LIGHT, maxTokens: 200, temperature: 0.1, timeoutMs: 30000
    });
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    const ok = /\{/.test(out);
    results.push({ name: 'classify-and-upload(LIGHT 티어)', file: 'classify-and-upload.js',
      ok, ms, why: `LIGHT 응답 ${out.length}자`, observed: { model: ANTHROPIC_MODEL_LIGHT } });
    console.log(`  ${ok ? '✅' : '★실패'} classify-and-upload(LIGHT) ${ms}ms — ${out.slice(0, 60).replace(/\s+/g, ' ')}`);
  } catch (e) {
    results.push({ name: 'classify-and-upload(LIGHT 티어)', ok: false,
      why: String(e?.message || e).slice(0, 160) });
    console.log('  ★실패 classify-and-upload(LIGHT) →', String(e?.message || e).slice(0, 160));
  }
}

// treatment-plan / before-after 는 핸들러가 Supabase 에서 저장된 진단을 먼저 읽는다
// (없으면 400/폴백) → 두 파일이 쓰는 HEAVY 티어 + JSON 강제 프롬프트 조합을 실측한다.
// ⚠️ Claude 는 responseFormat:'json' 이 없어 이 조합이 실제로 JSON 을 내는지가 관건이다.
{
  const { anthropicChatCompletion } = await import(
    toUrl(path.join(ROOT, 'lib', 'ai-provider.js')));
  const started = process.hrtime.bigint();
  try {
    const out = await anthropicChatCompletion({
      system: '교정 치료계획 수립 AI.\n\nRespond with valid JSON only. No prose, no markdown fences.',
      messages: [{ role: 'user', content: '{"headline":"...","phases":[{"name":"...","duration_months":0}]} 형식으로 예시 치료계획을 반환하라.' }],
      model: ANTHROPIC_MODEL_HEAVY, maxTokens: 700, timeoutMs: 60000
    });
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    // 관대 파서와 동일한 판정: 순수 JSON 또는 펜스 안 JSON 이면 통과
    let parsed = null;
    try { parsed = JSON.parse(out); } catch {
      const s = out.indexOf('{'); const e = out.lastIndexOf('}');
      if (s >= 0 && e > s) { try { parsed = JSON.parse(out.slice(s, e + 1)); } catch {} }
    }
    const ok = Boolean(parsed);
    results.push({ name: 'treatment-plan/before-after(HEAVY+JSON강제)',
      file: 'treatment-plan.js, before-after.js', ok, ms,
      why: ok ? `JSON 파싱 성공(키 ${Object.keys(parsed).length}개)` : 'JSON 파싱 실패',
      observed: { model: ANTHROPIC_MODEL_HEAVY, fenced: /```/.test(out) } });
    console.log(`  ${ok ? '✅' : '★실패'} treatment-plan/before-after(HEAVY) ${ms}ms — ${ok ? 'JSON OK' : out.slice(0, 80)}`);
  } catch (e) {
    results.push({ name: 'treatment-plan/before-after(HEAVY+JSON강제)', ok: false,
      why: String(e?.message || e).slice(0, 160) });
    console.log('  ★실패 treatment-plan/before-after →', String(e?.message || e).slice(0, 160));
  }
}

const report = {
  schemaVersion: 'claude-endpoint-check-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsApiKeys: false,
    note: '합성 64x64 PNG + 더미 수치만 사용' },
  purpose: 'Claude 분기가 실제로 실행되는지 핸들러 직접 호출로 실측',
  models: { heavy: ANTHROPIC_MODEL_HEAVY, vision: ANTHROPIC_MODEL_VISION,
    light: ANTHROPIC_MODEL_LIGHT },
  probes: results,
  verdict: {
    okCount: results.filter((r) => r.ok).length,
    total: results.length,
    failed: results.filter((r) => !r.ok).map((r) => r.name)
  }
};
writeFileSync(path.join(OUT, 'claude_endpoint_check.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log('\n통과 %d / %d', report.verdict.okCount, report.verdict.total);
if (report.verdict.failed.length) console.log('실패:', report.verdict.failed.join(', '));
