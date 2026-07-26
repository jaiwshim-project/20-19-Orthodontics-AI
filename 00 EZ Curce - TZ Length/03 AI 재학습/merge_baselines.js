#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DIR = __dirname;
const INPUTS = [
  { json: 'baseline_predictions.json', csv: 'baseline_predictions.csv' },
  { json: 'baseline_ez_embedded_predictions.json', csv: 'baseline_ez_embedded_predictions.csv' },
  // 교정후 치아폭 학습용 규칙 baseline(width_embedded_only 케이스). 파일이 있을 때만 포함.
  { json: 'baseline_corrected_width_predictions.json', csv: 'baseline_corrected_width_predictions.csv', optional: true },
  // 클래스2 치아폭(2026-07-26 신규 99건) 규칙 baseline. 완전 신규 SHA라 중복 없음. 있을 때만 포함.
  { json: 'baseline_class2_width_predictions.json', csv: 'baseline_class2_width_predictions.csv', optional: true },
  // 위 소스들이 훑지 못한 임베디드 이미지 보충분(--source=embedded-missing). dataset ↔ baseline
  // 케이스 수 일치를 보장해 evaluate_baseline의 전수 예측 검사를 통과시킨다.
  { json: 'baseline_missing_predictions.json', csv: 'baseline_missing_predictions.csv', optional: true }
];
const OUTPUT_JSON = path.join(DIR, 'baseline_predictions_all.json');
const OUTPUT_CSV = path.join(DIR, 'baseline_predictions_all.csv');

async function main() {
  const payloads = [];
  const csvParts = [];
  for (const input of INPUTS) {
    const jsonPath = path.join(DIR, input.json);
    if (input.optional && !fs.existsSync(jsonPath)) continue; // 선택 소스는 없으면 건너뜀
    const json = JSON.parse(await fsp.readFile(jsonPath, 'utf8'));
    const csv = await fsp.readFile(path.join(DIR, input.csv), 'utf8');
    payloads.push(json);
    csvParts.push(csv.trimEnd().split(/\r?\n/));
  }
  const header = csvParts[0][0];
  if (!csvParts.every((lines) => lines[0] === header)) throw new Error('Input CSV headers do not match. Re-run both baselines with the same runner version.');
  const results = [];
  const ids = new Set();
  for (const payload of payloads) {
    for (const item of payload.results || []) {
      const key = `${item.sourceType}:${item.caseId}`;
      // 교정후 이미지 중 root와 SHA가 같은 47건은 root baseline이 이미 담당하고,
      // EZ embedded 세트와 교정후 embedded 세트가 동일 SHA를 낼 일은 없다(EZ 폴더 미포함).
      // 그래도 방어적으로 중복 키는 먼저 등록된 것을 유지하고 스킵한다.
      if (ids.has(key)) continue;
      ids.add(key);
      results.push(item);
    }
  }
  const combined = {
    schemaVersion: 'ez-rule-baseline-collection-v1',
    createdAt: new Date().toISOString(),
    engineSource: 'EZ Curve - TZ Length.html',
    sourceSets: payloads.map((payload) => ({ sourceSet: payload.sourceSet, caseCount: payload.results?.length || 0 })),
    caseCount: results.length,
    successCount: results.filter((item) => item.status === 'ok').length,
    errorCount: results.filter((item) => item.status !== 'ok').length,
    results
  };
  await fsp.writeFile(OUTPUT_JSON, JSON.stringify(combined, null, 2), 'utf8');
  const mergedCsv = [header, ...csvParts.flatMap((lines) => lines.slice(1))].join('\r\n') + '\r\n';
  await fsp.writeFile(OUTPUT_CSV, mergedCsv, 'utf8');
  console.log(JSON.stringify({ outputJson: OUTPUT_JSON, outputCsv: OUTPUT_CSV, cases: combined.caseCount, successes: combined.successCount, errors: combined.errorCount }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });

