// 5차 검증 — 프로덕션에서 각 엔드포인트가 정말 Claude 로 도는지 실측한다.
//
// ⚠️ 200 은 증거가 아니다. 여러 엔드포인트가 실패 시에도 폴백으로 200 을 낸다 →
//    응답의 provider/usage 와 fallback 플래그까지 본다.
// ⚠️ 한글은 셸 인라인 -d 로 보내면 깨진다(실측) → fetch 로 UTF-8 바이트를 직접 보낸다.
// ⚠️ PHI 금지: 합성 64x64 PNG + 더미 수치만 쓴다. 응답 본문은 저장하지 않고
//    provider/길이만 기록한다.
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const PROD = process.env.PROD_URL || 'https://20-19-orthodontics-ai.vercel.app';
const OUT = process.env.OUT_DIR;

const SWATCH = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItz/fMYxgi+hcEKLNO+FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywLzk8EPlvGqjQAAAABJRU5ErkJggg==';

const results = [];

async function call(name, route, body, judge, timeoutMs = 120000) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${PROD}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache' },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: controller.signal
    });
    clearTimeout(timer);
    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}
    const ms = Date.now() - started;
    const v = judge(resp.status, data, raw);
    // 키 유출 재확인 — 응답 어디에도 실제 키가 없어야 한다
    const leak = /sk-ant-api\d\d-[A-Za-z0-9_-]{20,}|AIzaSy[A-Za-z0-9_-]{20,}/.test(raw);
    results.push({ name, route, status: resp.status, ms,
      ok: v.ok && !leak, why: v.why + (leak ? ' ★키유출!' : ''), keyLeak: leak });
    console.log(`  ${v.ok && !leak ? '✅' : '★실패'} ${name} [${resp.status}] ${ms}ms — ${v.why}${leak ? ' ★키유출!' : ''}`);
  } catch (e) {
    results.push({ name, route, ok: false, why: String(e?.message || e).slice(0, 150) });
    console.log(`  ★예외 ${name} → ${String(e?.message || e).slice(0, 150)}`);
  }
}

const providerIs = (get) => (status, data) => {
  const p = String(get(data) || '');
  const fb = data?.fallback === true || data?.parseError === true;
  return { ok: status === 200 && /^anthropic/.test(p) && !fb,
    why: `provider=${p || '(없음)'}${fb ? ' fallback=true' : ''}` };
};

console.log('대상:', PROD, '\n');

await call('consult (HEAVY)', '/api/consult',
  { messages: [{ role: 'user', content: '교정 치료 기간은 얼마나 되나요? 한 문장으로.' }] },
  providerIs((d) => d?.usage?.provider));

await call('chat (HEAVY)', '/api/chat',
  { messages: [{ role: 'user', content: '유지장치는 왜 필요한가요? 한 문장으로.' }] },
  providerIs((d) => d?.usage?.provider));

await call('measure-tooth-widths (VISION)', '/api/measure-tooth-widths',
  { base64: SWATCH, contentType: 'image/png', arch: 'lower',
    imageWidth: 64, imageHeight: 64, molarDistanceMm: 54 },
  (s, d) => ({ ok: /^anthropic/.test(String(d?.provider || '')),
    why: `provider=${d?.provider || '(없음)'} teeth=${d?.teeth?.length ?? 'n/a'}` }));

await call('detect-arch-landmarks (VISION)', '/api/detect-arch-landmarks',
  { base64: SWATCH, contentType: 'image/png', imageWidth: 64, imageHeight: 64 },
  (s, d) => ({ ok: /^anthropic/.test(String(d?.provider || '')),
    why: `provider=${d?.provider || '(없음)'} success=${d?.success}` }));

await call('analyze-image (VISION)', '/api/analyze-image',
  { type: 'growth', images: { xray: { base64: SWATCH, contentType: 'image/png' } } },
  providerIs((d) => d?.provider));

await call('classify-diagnosis (VISION)', '/api/classify-diagnosis',
  { images: ['ceph', 'leftLateral', 'rightLateral'].map((key) => ({
    key, label: key, base64: SWATCH, contentType: 'image/png' })) },
  (s, d) => ({ ok: /^anthropic/.test(String(d?.provider || '')),
    why: `provider=${d?.provider || '(없음)'} status=${s}` }));

await call('comprehensive-diagnosis (HEAVY)', '/api/comprehensive-diagnosis',
  { patient: { age: 24, sex: 'F' },
    images: [{ key: 'ceph', label: '[ceph]', base64: SWATCH, contentType: 'image/png' }] },
  providerIs((d) => d?.provider));

await call('diagnose (HEAVY)', '/api/diagnose',
  { type: 'growth', patient: { age: 12, sex: 'M' },
    inputs: { cvmStage: 3, heightCm: 150 }, save: false },
  (s, d) => ({ ok: s === 200 && d?.fallback !== true,
    why: `fallback=${d?.fallback} score=${d?.score}` }));

const report = {
  schemaVersion: 'remote-claude-check-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsApiKeys: false,
    note: '합성 PNG + 더미 수치. 응답 본문은 저장하지 않고 provider 만 기록' },
  purpose: '프로덕션에서 Claude 분기가 실제로 실행되는지 + 키 유출 0 재확인',
  target: PROD,
  probes: results,
  verdict: {
    okCount: results.filter((r) => r.ok).length,
    total: results.length,
    keyLeaks: results.filter((r) => r.keyLeak).length,
    failed: results.filter((r) => !r.ok).map((r) => r.name)
  }
};
writeFileSync(path.join(OUT, 'remote_claude_check.json'),
  JSON.stringify(report, null, 2) + '\n');
console.log('\n통과 %d / %d, 키 유출 %d',
  report.verdict.okCount, report.verdict.total, report.verdict.keyLeaks);
if (report.verdict.failed.length) console.log('실패:', report.verdict.failed.join(', '));
