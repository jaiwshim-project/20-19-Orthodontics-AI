// 전략 비교 — width_ab_raw.json(57건) 오프라인 평가. API 재호출 없음.
//
// 예비 실측이 남긴 문제: sonnet 은 TTL(총합)이 좋고 haiku 는 치아별 배분이 좋다.
// 둘 다 만족하는 방법이 있는지 본다.
//
// 전략:
//   A_haiku        : 구 모델 그대로
//   B_sonnet       : 현재 모델 그대로
//   C_hybrid_shape : sonnet 의 총합 + haiku 의 배분 비율 (2회 호출)
//   D_haiku_scaled : haiku 배분 × 학습된 전역 배율 (1회 호출, 학습 필요)
//   E_sonnet_scaled: sonnet 배분 × 학습된 전역 배율 (1회 호출, 학습 필요)
//
// ⚠️ D·E 의 배율은 데이터에서 학습하는 파라미터다 → 같은 데이터로 평가하면
//    in-sample 낙관이 된다. 케이스 그룹 단위 5-fold out-of-fold 로만 보고한다
//    (feedback_report_oof_not_insample 규칙).
// ⚠️ 정답 n(11~12)과 모델 n(14)이 달라 슬라이딩 오프셋 정렬로 흡수한다. 모든 전략
//    동일 규칙.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HERE = process.env.OUT_DIR;
const raw = JSON.parse(readFileSync(path.join(HERE, 'width_ab_raw.json'), 'utf8'));

const sum = (a) => a.reduce((x, y) => x + y, 0);

// 정답 k개에 대해 예측 배열에서 MAE 최소 연속 구간을 찾는다
function align(pred, truth) {
  const k = truth.length;
  if (!pred || pred.length < k) return null;
  let best = null;
  for (let off = 0; off + k <= pred.length; off++) {
    const seg = pred.slice(off, off + k);
    let s = 0;
    for (let i = 0; i < k; i++) s += Math.abs(seg[i] - truth[i]);
    const mae = s / k;
    if (!best || mae < best.mae) best = { off, mae, seg };
  }
  return best;
}

// 배분 비율만 남기고 총합을 target 으로 맞춘다
const rescale = (w, target) => { const s = sum(w); return s > 0 ? w.map((v) => v / s * target) : w; };

const usable = raw.cases.filter((c) => c.haiku?.widths && c.sonnet?.widths);
console.log('양 모델 모두 성공한 케이스: %d / %d', usable.length, raw.cases.length);

// ── 전역 배율 학습: 학습셋에서 (정답합 / 예측합) 의 중위수
function learnScale(train, tag) {
  const r = train.map((c) => sum(c.truthWidths) / sum(c[tag].widths)).sort((a, b) => a - b);
  return r.length ? r[Math.floor(r.length / 2)] : 1;
}

function predict(strategy, c, scales) {
  const h = c.haiku.widths, s = c.sonnet.widths;
  switch (strategy) {
    case 'A_haiku': return h;
    case 'B_sonnet': return s;
    // sonnet 총합을 haiku 배분에 입힌다. 길이가 다를 수 있어 haiku 기준 재스케일.
    case 'C_hybrid_shape': return rescale(h, sum(s));
    case 'D_haiku_scaled': return h.map((v) => v * scales.haiku);
    case 'E_sonnet_scaled': return s.map((v) => v * scales.sonnet);
    default: throw new Error('unknown strategy ' + strategy);
  }
}

const STRATEGIES = ['A_haiku', 'B_sonnet', 'C_hybrid_shape', 'D_haiku_scaled', 'E_sonnet_scaled'];

// ── 그룹 단위 5-fold (같은 group 은 한 fold 에만)
const groups = [...new Set(usable.map((c) => c.group))].sort();
const K = 5;
const foldOf = new Map(groups.map((g, i) => [g, i % K]));

const perCase = [];
for (let f = 0; f < K; f++) {
  const train = usable.filter((c) => foldOf.get(c.group) !== f);
  const test = usable.filter((c) => foldOf.get(c.group) === f);
  const scales = { haiku: learnScale(train, 'haiku'), sonnet: learnScale(train, 'sonnet') };
  for (const c of test) {
    const row = { chart: c.chart, fold: f, truthTtl: sum(c.truthWidths), scales };
    for (const st of STRATEGIES) {
      const p = predict(st, c, scales);
      const al = align(p, c.truthWidths);
      row[st] = al ? {
        ttlErrPct: Math.abs(sum(p) - sum(c.truthWidths)) / sum(c.truthWidths) * 100,
        maeMm: al.mae,
        // 정렬 구간의 합오차 — 배분과 스케일을 동시에 보는 지표
        segErrPct: Math.abs(sum(al.seg) - sum(c.truthWidths)) / sum(c.truthWidths) * 100,
        signedTtlPct: (sum(p) - sum(c.truthWidths)) / sum(c.truthWidths) * 100
      } : null;
    }
    perCase.push(row);
  }
}

function stats(st, field) {
  const v = perCase.map((r) => r[st]?.[field]).filter((x) => typeof x === 'number')
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const mean = sum(v) / v.length;
  const sd = Math.sqrt(sum(v.map((x) => (x - mean) ** 2)) / Math.max(1, v.length - 1));
  return { n: v.length, mean: +mean.toFixed(3), median: +v[Math.floor(v.length / 2)].toFixed(3),
    p90: +v[Math.min(v.length - 1, Math.floor(v.length * 0.9))].toFixed(3),
    se: +(sd / Math.sqrt(v.length)).toFixed(3) };
}

// 쌍대 부호검정 (기준 = A_haiku) + 정규근사 양측 p
function paired(st, field, base = 'A_haiku') {
  let win = 0, lose = 0;
  for (const r of perCase) {
    const a = r[base]?.[field], b = r[st]?.[field];
    if (typeof a !== 'number' || typeof b !== 'number') continue;
    if (b < a) win++; else if (b > a) lose++;
  }
  const n = win + lose;
  if (!n) return { win, lose, p: null };
  const z = Math.abs(win - lose) / Math.sqrt(n);
  // 양측 p 정규근사 (erfc)
  const erfc = (x) => {
    const t = 1 / (1 + 0.5 * Math.abs(x));
    const y = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196
      + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398
      + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? y : 2 - y;
  };
  return { win, lose, p: +erfc(z / Math.SQRT2).toFixed(4) };
}

const table = {};
for (const st of STRATEGIES) {
  table[st] = {
    ttlErrPct: stats(st, 'ttlErrPct'),
    maeMm: stats(st, 'maeMm'),
    segErrPct: stats(st, 'segErrPct'),
    signedTtlPct: stats(st, 'signedTtlPct'),
    vsHaiku: { ttlErrPct: paired(st, 'ttlErrPct'), maeMm: paired(st, 'maeMm'),
      segErrPct: paired(st, 'segErrPct') }
  };
}

const report = {
  schemaVersion: 'width-strategy-eval-v1',
  privacy: { containsPhi: false, containsPatientNames: false, containsFilePaths: false,
    containsImageCoordinates: false, note: '4자리 차트번호 + mm/％ 오차만' },
  purpose: '치아 폭 전략 5종을 그룹 5-fold out-of-fold 로 비교 — TTL 과 치아별 배분을 동시 평가',
  method: {
    n: usable.length, groups: groups.length, folds: K,
    alignment: '정답 11~12개 vs 모델 14개 → MAE 최소 슬라이딩 오프셋 정렬(전 전략 동일)',
    oof: 'D·E 의 전역 배율은 학습 파라미터 → 그룹 단위 out-of-fold 만 보고(in-sample 금지)',
    metrics: {
      ttlErrPct: '총합 절대오차% — EZL/TZL 판정에 직접 쓰이는 값',
      maeMm: '치아별 폭 평균절대오차(mm) — 개별 치아 표시 정확도',
      segErrPct: '정렬 구간 합오차% ',
      signedTtlPct: '부호 편향(+ 과대추정)'
    }
  },
  strategies: table,
  cases: perCase.map((r) => ({ chart: r.chart, fold: r.fold,
    truthTtl: +r.truthTtl.toFixed(1),
    ...Object.fromEntries(STRATEGIES.map((st) => [st, r[st] ? {
      ttlErrPct: +r[st].ttlErrPct.toFixed(2), maeMm: +r[st].maeMm.toFixed(3) } : null])) }))
};
writeFileSync(path.join(HERE, 'width_strategy_eval.json'), JSON.stringify(report, null, 2) + '\n');

console.log('\n=== 그룹 5-fold out-of-fold (n=%d) ===', usable.length);
console.log('전략              TTL오차%  치아MAE   부호편향   vs구모델(TTL승/패,p)  vs구모델(MAE승/패,p)');
for (const st of STRATEGIES) {
  const t = table[st];
  console.log('%s  %s     %s    %s     %s/%s p=%s        %s/%s p=%s',
    st.padEnd(16), String(t.ttlErrPct.mean).padStart(6),
    String(t.maeMm.mean).padStart(5), String(t.signedTtlPct.mean).padStart(6),
    t.vsHaiku.ttlErrPct.win, t.vsHaiku.ttlErrPct.lose, t.vsHaiku.ttlErrPct.p,
    t.vsHaiku.maeMm.win, t.vsHaiku.maeMm.lose, t.vsHaiku.maeMm.p);
}
