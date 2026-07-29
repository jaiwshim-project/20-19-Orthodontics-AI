// 5차 검증 — 프로덕션이 실제로 haiku VISION 으로 도는지 + 계측이 되는지 실측.
//
// ⚠️ 200 은 증거가 아니다. provider 문자열과 teeth 개수까지 본다.
// ⚠️ 앱과 동일한 payload(1200px/q85)를 보낸다. 합성 스와치로는 계측이 안 되므로
//    실제 교합면 사진을 쓰되, 응답에서 provider/개수/합만 기록한다(PHI 저장 금지).
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const HERE = process.env.OUT_DIR;
const PROJECT = path.dirname(HERE);
const PROD = process.env.PROD_URL || 'https://20-19-orthodontics-ai.vercel.app';
const REPEATS = Number(process.env.REPEATS || 6);

const pool = JSON.parse(readFileSync(path.join(HERE, '_ab_pool.json'), 'utf8'));
const probes = [];

async function probe(file, i) {
  const buf = await sharp(path.join(PROJECT, file))
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  const meta = await sharp(buf).metadata();
  const body = { base64: buf.toString('base64'), contentType: 'image/jpeg', arch: 'lower',
    imageWidth: meta.width, imageHeight: meta.height, molarDistanceMm: 54 };
  const t0 = Date.now();
  const resp = await fetch(`${PROD}/api/measure-tooth-widths`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' },
    body: Buffer.from(JSON.stringify(body), 'utf8')
  });
  const raw = await resp.text();
  let d = null; try { d = JSON.parse(raw); } catch {}
  const leak = /sk-ant-api\d\d-[A-Za-z0-9_-]{20,}|AIzaSy[A-Za-z0-9_-]{20,}/.test(raw);
  const ok = resp.status === 200
    && String(d?.provider || '') === 'anthropic:claude-haiku-4-5-20251001'
    && Array.isArray(d?.teeth) && d.teeth.length >= 10 && !leak;
  probes.push({ trial: i + 1, status: resp.status, ms: Date.now() - t0,
    provider: d?.provider || null, nTeeth: d?.teeth?.length ?? null,
    ttlMm: d?.ttlMm ?? null, error: d?.error ? String(d.error).slice(0, 80) : null,
    keyLeak: leak, ok });
  console.log(`  ${ok ? '✅' : '★실패'} #${i + 1} [${resp.status}] ${Date.now() - t0}ms `
    + `provider=${d?.provider || '(없음)'} teeth=${d?.teeth?.length ?? 'n/a'} ttl=${d?.ttlMm ?? 'n/a'}`
    + `${d?.error ? ' err=' + String(d.error).slice(0, 60) : ''}${leak ? ' ★키유출!' : ''}`);
}

console.log('대상: %s (반복 %d회 — 빈 응답 재시도가 프로덕션에서도 사는지 확인)\n', PROD, REPEATS);
for (let i = 0; i < REPEATS; i++) await probe(pool[i % pool.length].file, i);

const okN = probes.filter((p) => p.ok).length;
writeFileSync(path.join(HERE, 'remote_vision_check.json'), JSON.stringify({
  schemaVersion: 'remote-vision-check-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false,
    note: 'provider/치아개수/합계·지연만 기록. 이미지·좌표·차트번호 저장 안 함' },
  purpose: '프로덕션 measure-tooth-widths 가 haiku VISION 으로 돌고 계측이 성공하는지 반복 실측',
  target: PROD, expectedProvider: 'anthropic:claude-haiku-4-5-20251001',
  probes,
  verdict: { ok: okN, total: probes.length, keyLeaks: probes.filter((p) => p.keyLeak).length,
    failures: probes.filter((p) => !p.ok).map((p) => ({ trial: p.trial, status: p.status,
      provider: p.provider, error: p.error })) }
}, null, 2) + '\n');
console.log('\n통과 %d / %d, 키 유출 %d', okN, probes.length,
  probes.filter((p) => p.keyLeak).length);
process.exit(okN === probes.length ? 0 : 1);
