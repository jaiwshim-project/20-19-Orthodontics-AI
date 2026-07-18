#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const DIR = __dirname;
const INPUTS = [
  { json: 'baseline_predictions.json', csv: 'baseline_predictions.csv' },
  { json: 'baseline_ez_embedded_predictions.json', csv: 'baseline_ez_embedded_predictions.csv' }
];
const OUTPUT_JSON = path.join(DIR, 'baseline_predictions_all.json');
const OUTPUT_CSV = path.join(DIR, 'baseline_predictions_all.csv');

async function main() {
  const payloads = [];
  const csvParts = [];
  for (const input of INPUTS) {
    const json = JSON.parse(await fsp.readFile(path.join(DIR, input.json), 'utf8'));
    const csv = await fsp.readFile(path.join(DIR, input.csv), 'utf8');
    payloads.push(json);
    csvParts.push(csv.trimEnd().split(/\r?\n/));
  }
  const header = csvParts[0][0];
  if (!csvParts.every((lines) => lines[0] === header)) throw new Error('Input CSV headers do not match. Re-run both baselines with the same runner version.');
  const results = payloads.flatMap((payload) => payload.results || []);
  const ids = new Set();
  for (const item of results) {
    const key = `${item.sourceType}:${item.caseId}`;
    if (ids.has(key)) throw new Error(`Duplicate baseline key: ${key}`);
    ids.add(key);
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

