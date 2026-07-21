#!/usr/bin/env node
/*
 * 교정후 치아폭 학습을 위한 규칙엔진 baseline 생성기.
 *
 * 배경: 「02 교정 후 치아폭 찍기(김원장님)」 정답 중 62건은 신규 재촬영 이미지라
 * 번호 root(001~119)에 없어 dataset-index에서 width_embedded_only 케이스가 된다.
 * train_residual은 이 케이스에 매칭되는 규칙 baseline이 있어야 잔차를 학습하는데,
 * run_rule_baseline.js의 embedded 소스는 EZ 폴더만 훑으므로 이 이미지는 baseline이 없다.
 *
 * 해법: 이미 생성된 corrected_after_predictions.json(교정후 114장을 규칙엔진으로 분석,
 * 전부 status ok·치아 12개 예측)을 재활용한다. 각 예측의 fileName을 「02 교정 후 사진만」
 * 사진 SHA-256으로 매핑해, dataset-index의 width_embedded_only 케이스 SHA와 정확히 일치시킨다.
 * 출력은 run_rule_baseline.js 형식(sourceType/imageRef/prediction)이라 merge_baselines에서
 * 그대로 결합된다. 원본 폴더·예측 JSON은 읽기 전용.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');

function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT, pre); if (existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, prefixes[0]);
}

const AFTER_PHOTO_DIR = resolveDir('02 교정 후 사진만');
const PRED_PATH = path.join(HERE, 'corrected_after_predictions.json');
const DATASET_PATH = path.join(HERE, 'dataset-index.json');
const OUT_JSON = path.join(HERE, 'baseline_corrected_width_predictions.json');
const OUT_CSV = path.join(HERE, 'baseline_corrected_width_predictions.csv');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// run_rule_baseline.js와 동일한 CSV 컬럼(merge_baselines의 헤더 일치 검사 통과용).
const CSV_COLUMNS = [
  'caseId', 'sourceType', 'imageFile', 'imageRef', 'status', 'runtimeMs', 'imageWidth', 'imageHeight',
  'engineVersion', 'confidenceOverall', 'imageQuality', 'templateQuality',
  'pathEvidence', 'boundaryQuality', 'widthQuality', 'toothCenterCount',
  'ezPointCount', 'toothWidthCount', 'pxPerMm', 'tzlMm', 'ezlMm',
  'differenceMm', 'warningCount', 'error',
];

function csvRow(record) {
  const confidence = record.prediction?.analysisMeta?.confidence || {};
  const metrics = record.prediction?.metrics || {};
  const warnings = record.prediction?.analysisMeta?.warnings || [];
  const row = {
    caseId: record.caseId,
    sourceType: record.sourceType,
    imageFile: record.imageFile,
    imageRef: record.imageRef,
    status: record.status,
    runtimeMs: record.runtimeMs,
    imageWidth: record.imageWidth,
    imageHeight: record.imageHeight,
    engineVersion: record.prediction?.analysisMeta?.engineVersion,
    confidenceOverall: confidence.overall,
    imageQuality: confidence.imageQuality,
    templateQuality: confidence.templateQuality,
    pathEvidence: confidence.pathEvidence,
    boundaryQuality: confidence.boundaryQuality,
    widthQuality: confidence.widthQuality,
    toothCenterCount: record.prediction?.toothCenters?.length,
    ezPointCount: record.prediction?.ezPoints?.length,
    toothWidthCount: record.prediction?.toothWidths?.length,
    pxPerMm: metrics.pxPerMm,
    tzlMm: metrics.tzl,
    ezlMm: metrics.ezl,
    differenceMm: metrics.difference,
    warningCount: warnings.length,
    error: record.error,
  };
  return CSV_COLUMNS.map((k) => csvCell(row[k])).join(',');
}

async function main() {
  const pred = JSON.parse(await readFile(PRED_PATH, 'utf8'));
  const predResults = (pred.results || []).filter((r) => r.status === 'ok');

  // 교정후 사진 파일명 -> SHA-256
  const photoSha = new Map();
  for (const name of await readdir(AFTER_PHOTO_DIR)) {
    if (!/\.(jpe?g|png)$/i.test(name)) continue;
    photoSha.set(name, sha256(await readFile(path.join(AFTER_PHOTO_DIR, name))));
  }

  // dataset-index에서 실제로 학습에 필요한 width_embedded_only 케이스 SHA 집합
  const dataset = JSON.parse(await readFile(DATASET_PATH, 'utf8'));
  const embeddedShas = new Set(
    dataset.cases.filter((c) => c.sourceKind === 'width_embedded_only').map((c) => c.image.sha256),
  );

  const records = [];
  const seen = new Set();
  let mappedToEmbedded = 0;
  for (const r of predResults) {
    const sha = photoSha.get(r.fileName);
    if (!sha) continue;                    // 사진 폴더에 없는 예측은 SHA 미상 → 제외
    if (!embeddedShas.has(sha)) continue;  // root에 이미 있는(교정후=root) 이미지는 root baseline이 처리 → 중복 방지
    if (seen.has(sha)) continue;
    seen.add(sha);
    mappedToEmbedded++;
    records.push({
      caseId: `embedded-${sha.slice(0, 16)}`,
      sourceType: 'ez-embedded-only',     // merge 키(sourceType:caseId)를 embedded 세트와 동일 규칙으로
      imageFile: null,
      imageRef: `sha256:${sha}`,
      status: 'ok',
      imageWidth: r.imageWidth,
      imageHeight: r.imageHeight,
      prediction: r.prediction,
      runtimeMs: r.runtimeMs,
    });
  }

  const payload = {
    schemaVersion: 'ez-rule-baseline-v1',
    createdAt: new Date().toISOString(),
    engineSource: 'corrected_after_predictions.json (규칙엔진, 교정후 재활용)',
    sourceSet: 'corrected-width-embedded',
    note: '교정후 치아폭 학습용 규칙 baseline. corrected_after_predictions를 교정후 사진 SHA로 dataset의 width_embedded_only 케이스에 매핑.',
    caseCount: records.length,
    results: records,
  };
  await writeFile(OUT_JSON, JSON.stringify(payload, null, 2), 'utf8');
  const csv = [CSV_COLUMNS.join(','), ...records.map(csvRow)].join('\r\n') + '\r\n';
  await writeFile(OUT_CSV, csv, 'utf8');

  console.log(JSON.stringify({
    predOk: predResults.length,
    photoShaKnown: photoSha.size,
    embeddedCasesInDataset: embeddedShas.size,
    mappedToEmbeddedBaseline: mappedToEmbedded,
    output: OUT_JSON,
  }, null, 2));
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exitCode = 1; });
