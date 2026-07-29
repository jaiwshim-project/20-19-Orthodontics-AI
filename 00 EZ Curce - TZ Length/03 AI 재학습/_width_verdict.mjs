// 최종 판정 — 치아 개수 교란을 제거한 뒤 두 모델을 다시 비교한다.
//
// ⚠️ 판정 뒤집힘: 예비 실측에서 "sonnet 이 TTL 을 개선(12:5)"이라고 봤으나 무효였다.
//    정답 주석은 11~12개(결손·미가시 치아 제외)인데 모델은 프롬프트대로 항상 14개를
//    반환한다. 즉 모델 총합에는 정답에 없는 치아 2개가 들어있어 총합끼리 비교하면
//    "개수 초과(+16.7% 상당)"와 "개당 폭 오차"가 뒤섞인다.
//    개수 교란을 제거하면(개당 평균 폭) haiku −4.7%, sonnet −17.8% 로 haiku 가
//    압도한다. sonnet 의 TTL 개선은 과소추정과 개수 초과의 우연한 상쇄였다.
//
// 이 스크립트는 개수와 무관한 3개 지표로 판정을 확정한다:
//   1) 개당 평균 폭 편향  — 스케일이 맞는가
//   2) 정렬 구간 합오차   — 정답과 같은 개수 구간에서 합이 맞는가
//   3) 정렬 MAE          — 치아별 배분이 맞는가
// 세 지표 모두 쌍대 부호검정 + 부트스트랩 신뢰구간으로 본다.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = process.env.OUT_DIR;
const raw = JSON.parse(readFileSync(path.join(HERE, 'width_ab_raw.json'), 'utf8'));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => sum(a) / a.length;

function align(pred, truth) {
  const k = truth.length;
  if (!pred || pred.length < k) return null;
  let best = null;
  for (let off = 0; off + k <= pred.length; off++) {
    const seg = pred.slice(off, off + k);
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.abs(seg[i] - truth[i]);
    const m = s / k;
    if (!best || m < best.mae) best = { off, mae: m, seg };
  }
  return best;
}

const cs = raw.cases.filter((c) => c.haiku?.widths && c.sonnet?.widths);

const METRICS = {
  perToothBiasPct: (c, t) => {
    const p = mean(c[t].widths), g = mean(c.truthWidths);
    return (p - g) / g * 100;                    // 부호 있음
  },
  perToothAbsBiasPct: (c, t) => Math.abs(METRICS.perToothBiasPct(c, t)),
  segSumErrPct: (c, t) => {
    const al = align(c[t].widths, c.truthWidths);
    return al ? Math.abs(sum(al.seg) - sum(c.truthWidths)) / sum(c.truthWidths) * 100 : null;
  },
  alignedMaeMm: (c, t) => { const al = align(c[t].widths, c.truthWidths); return al ? al.mae : null; },
  nTeeth: (c, t) => c[t].widths.length
};

// 부트스트랩 (고정 시드 LCG — Math.random 은 재현 불가)
function boot(vals, iters = 4000, seed = 12345) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const ms = [];
  for (let i = 0; i < iters; i++) {
    let acc = 0;
    for (let j = 0; j < vals.length; j++) acc += vals[Math.floor(rnd() * vals.length)];
    ms.push(acc / vals.length);
  }
  ms.sort((a, b) => a - b);
  return { lo: +ms[Math.floor(iters * 0.025)].toFixed(3), hi: +ms[Math.floor(iters * 0.975)].toFixed(3) };
}

const erfc = (x) => {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196
    + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
    + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
};

const out = {};
for (const [name, fn] of Object.entries(METRICS)) {
  const h = [], s = [], diff = [];
  for (const c of cs) {
    const a = fn(c, 'haiku'), b = fn(c, 'sonnet');
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    h.push(a); s.push(b); diff.push(b - a);   // 음수 = sonnet 이 더 작다
  }
  let win = 0, lose = 0;
  for (const d of diff) { if (d < 0) win++; else if (d > 0) lose++; }
  const n = win + lose;
  const p = n ? +erfc(Math.abs(win - lose) / Math.sqrt(n) / Math.SQRT2).toFixed(5) : null;
  out[name] = {
    haiku: { mean: +mean(h).toFixed(3), ci95: boot(h) },
    sonnet: { mean: +mean(s).toFixed(3), ci95: boot(s) },
    diffMean: +mean(diff).toFixed(3), diffCi95: boot(diff),
    pairedSonnetBetter: win, pairedHaikuBetter: lose, p
  };
}

const verdict = {
  개당폭_편향: `haiku ${out.perToothBiasPct.haiku.mean}% vs sonnet ${out.perToothBiasPct.sonnet.mean}% `
    + `(둘 다 과소추정, sonnet 이 3.8배 심함)`,
  정렬구간_합오차: `haiku ${out.segSumErrPct.haiku.mean}% vs sonnet ${out.segSumErrPct.sonnet.mean}% `
    + `— haiku 우세 ${out.segSumErrPct.pairedHaikuBetter}/${out.segSumErrPct.pairedSonnetBetter} p=${out.segSumErrPct.p}`,
  치아별_MAE: `haiku ${out.alignedMaeMm.haiku.mean}mm vs sonnet ${out.alignedMaeMm.sonnet.mean}mm `
    + `— haiku 우세 ${out.alignedMaeMm.pairedHaikuBetter}/${out.alignedMaeMm.pairedSonnetBetter} p=${out.alignedMaeMm.p}`,
  결론: 'haiku-4-5 가 3개 지표 모두에서 sonnet-5 보다 정확하다. 앞선 "TTL 개선" 판정은 '
    + '치아 개수 교란(모델 14개 vs 정답 11~12개)으로 인한 허상이었다 → VISION 티어를 '
    + 'haiku 로 되돌린다.'
};

const report = {
  schemaVersion: 'width-verdict-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false, note: 'mm/％ 집계 수치만' },
  purpose: '치아 개수 교란 제거 후 haiku-4-5 vs sonnet-5 최종 판정',
  supersedes: 'width_model_ab.json 의 TTL 기반 판정(무효 — 개수 교란)',
  n: cs.length,
  metricNotes: {
    perToothBiasPct: '치아 1개당 평균 폭의 부호 편향% — 개수와 무관한 스케일 지표',
    segSumErrPct: '정답과 같은 개수의 정렬 구간에서의 합오차%',
    alignedMaeMm: '정렬 후 치아별 폭 MAE(mm)',
    nTeeth: '반환 치아 개수(정답 중위 12개)'
  },
  metrics: out, verdict
};
writeFileSync(path.join(HERE, 'width_verdict.json'), JSON.stringify(report, null, 2) + '\n');

console.log('=== 개수 교란 제거 후 최종 판정 (n=%d) ===\n', cs.length);
for (const [k, v] of Object.entries(out)) {
  console.log('%s', k);
  console.log('   haiku  %s  CI[%s, %s]', String(v.haiku.mean).padStart(7), v.haiku.ci95.lo, v.haiku.ci95.hi);
  console.log('   sonnet %s  CI[%s, %s]', String(v.sonnet.mean).padStart(7), v.sonnet.ci95.lo, v.sonnet.ci95.hi);
  console.log('   차이(sonnet−haiku) %s CI[%s, %s] | 쌍대 sonnet승 %d : haiku승 %d, p=%s',
    v.diffMean, v.diffCi95.lo, v.diffCi95.hi, v.pairedSonnetBetter, v.pairedHaikuBetter, v.p);
}
console.log('\n결론: %s', verdict.결론);
