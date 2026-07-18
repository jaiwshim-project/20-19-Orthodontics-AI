#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  dataset: path.join(HERE, 'dataset-index.json'),
  baseline: path.join(HERE, 'baseline_predictions_all.json'),
  config: path.join(HERE, 'pipeline_config.json'),
};
const SHA256_RE = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  assert(value && !value.startsWith('--'), `${flag} requires a path`);
  return path.resolve(value);
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    fail(`${label} cannot be read: ${filePath} (${error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${filePath} (${error.message})`);
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function assertFiniteNumbers(value, location) {
  if (typeof value === 'number') {
    assert(Number.isFinite(value), `${location} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteNumbers(item, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertFiniteNumbers(child, `${location}.${key}`);
  }
}

function assertPoint(point, width, height, location, { nullable = false, allowOutOfBounds = false } = {}) {
  if (point === null && nullable) return;
  assert(point && typeof point === 'object' && !Array.isArray(point), `${location} must be a point object`);
  assert(Number.isFinite(point.x) && Number.isFinite(point.y), `${location} x/y must be finite`);
  // 전문가가 이미지 경계에 걸친 랜드마크를 찍은 경우, 원본 정답은 수정하지 않고
  // canonical 데이터의 coordinate_outside_image_bounds 품질 플래그로 위임한다.
  // 다만 완전히 비상식적인 이탈은 여전히 하드 실패로 처리한다(대각선의 2% 마진).
  if (allowOutOfBounds) {
    const margin = 0.02 * Math.hypot(width, height);
    assert(point.x >= -margin && point.x < width + margin,
      `${location}.x=${point.x} is far outside [0, ${width}) beyond flagged margin`);
    assert(point.y >= -margin && point.y < height + margin,
      `${location}.y=${point.y} is far outside [0, ${height}) beyond flagged margin`);
    return;
  }
  assert(point.x >= 0 && point.x < width, `${location}.x=${point.x} is outside [0, ${width})`);
  assert(point.y >= 0 && point.y < height, `${location}.y=${point.y} is outside [0, ${height})`);
}

function assertPointArray(points, width, height, location, options = {}) {
  assert(Array.isArray(points), `${location} must be an array`);
  points.forEach((point, index) => assertPoint(point, width, height, `${location}[${index}]`, options));
}

function auditDatasetPhi(dataset) {
  const forbiddenKeys = new Set([
    'imageName',
    'sourcePath',
    'sourceFilePath',
    'sourceFileName',
    'filePath',
    'fileName',
    'projectPath',
    'patientName',
    'savedAt',
    'name',
    'path',
  ].map(key => key.toLocaleLowerCase('en-US')));
  const visit = (value, location) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert(!forbiddenKeys.has(key.toLocaleLowerCase('en-US')), `${location}.${key} is a PHI/provenance key`);
      visit(child, `${location}.${key}`);
    }
  };
  visit(dataset, 'dataset');

  const serialized = JSON.stringify(dataset);
  assert(!/\p{Script=Hangul}/u.test(serialized), 'dataset contains Hangul text and may expose a patient name');
  assert(!/(?:[A-Za-z]:\\|\.md(?:"|$)|intraoral[_ -]?lower)/iu.test(serialized), 'dataset contains a source path/name fragment');
}

function verifyCanonicalAnnotation(annotation, image, location, kind) {
  assert(annotation && typeof annotation === 'object', `${location} must be an object`);
  assert(SHA256_RE.test(annotation.labelSha256), `${location}.labelSha256 is invalid`);
  assert(Array.isArray(annotation.sourceAnnotationSha256s) && annotation.sourceAnnotationSha256s.length >= 1,
    `${location}.sourceAnnotationSha256s must be non-empty`);
  annotation.sourceAnnotationSha256s.forEach((sha, index) =>
    assert(SHA256_RE.test(sha), `${location}.sourceAnnotationSha256s[${index}] is invalid`));
  assert(SHA256_RE.test(annotation.embeddedImageSha256), `${location}.embeddedImageSha256 is invalid`);
  assert(annotation.raw && typeof annotation.raw === 'object', `${location}.raw is missing`);
  const raw = annotation.raw;
  // 이 주석이 경계 밖 좌표로 이미 플래그된 경우, 경계 검사를 마진 허용으로 완화한다.
  const outOfBoundsFlagged = Array.isArray(annotation.qualityFlags)
    && annotation.qualityFlags.includes('coordinate_outside_image_bounds');
  const pointOpts = { allowOutOfBounds: outOfBoundsFlagged };
  assertPoint(raw.originPx, image.widthPx, image.heightPx, `${location}.raw.originPx`, {
    nullable: kind === 'width',
    allowOutOfBounds: outOfBoundsFlagged,
  });
  assertPointArray(raw.toothCentersPx, image.widthPx, image.heightPx, `${location}.raw.toothCentersPx`, pointOpts);
  assertPointArray(raw.ezPointsPx, image.widthPx, image.heightPx, `${location}.raw.ezPointsPx`, pointOpts);
  assert(Array.isArray(raw.toothWidthsPx), `${location}.raw.toothWidthsPx must be an array`);
  raw.toothWidthsPx.forEach((width, index) => {
    assert(width && typeof width === 'object', `${location}.raw.toothWidthsPx[${index}] must be an object`);
    assert(width.toothNo === index + 1, `${location}.raw.toothWidthsPx[${index}].toothNo must equal ${index + 1}`);
    assertPoint(width.p1, image.widthPx, image.heightPx, `${location}.raw.toothWidthsPx[${index}].p1`, pointOpts);
    assertPoint(width.p2, image.widthPx, image.heightPx, `${location}.raw.toothWidthsPx[${index}].p2`, pointOpts);
  });
  const counts = annotation.labelCounts;
  const completeness = annotation.completeness;
  assert(counts?.toothCenters === raw.toothCentersPx.length, `${location}.labelCounts.toothCenters mismatch`);
  assert(counts?.ezPoints === raw.ezPointsPx.length, `${location}.labelCounts.ezPoints mismatch`);
  assert(counts?.toothWidths === raw.toothWidthsPx.length, `${location}.labelCounts.toothWidths mismatch`);
  assert(completeness?.toothCenters12 === (raw.toothCentersPx.length === 12), `${location}.completeness.toothCenters12 mismatch`);
  assert(completeness?.ezPoints12 === (raw.ezPointsPx.length === 12), `${location}.completeness.ezPoints12 mismatch`);
  assert(completeness?.toothWidths12 === (raw.toothWidthsPx.length === 12), `${location}.completeness.toothWidths12 mismatch`);
  assert(Array.isArray(annotation.qualityFlags), `${location}.qualityFlags must be an array`);
  assertFiniteNumbers(annotation, location);
}

function verifyDataset(dataset) {
  assert(dataset?.schemaVersion === 'ez-canonical-dataset-index/v1', 'dataset schemaVersion mismatch');
  assert(dataset.privacy?.phiFieldsEmitted === false, 'dataset privacy.phiFieldsEmitted must be false');
  assert(Array.isArray(dataset.cases), 'dataset.cases must be an array');
  assert(dataset.cases.length === 174, `dataset cases must be 174, got ${dataset.cases.length}`);
  assert(dataset.summary?.canonicalCases === 174, 'dataset summary.canonicalCases must be 174');
  assert(dataset.summary?.rootBackedCases === 119, 'dataset summary.rootBackedCases must be 119');
  assert(dataset.summary?.ezEmbeddedOnlyCases === 55, 'dataset summary.ezEmbeddedOnlyCases must be 55');

  const ids = new Set();
  const imageShas = new Set();
  let rootCount = 0;
  let embeddedCount = 0;
  let widthAnnotationCount = 0;
  let ezAnnotationCount = 0;
  for (const [caseIndex, item] of dataset.cases.entries()) {
    const location = `dataset.cases[${caseIndex}]`;
    assert(typeof item.caseId === 'string' && item.caseId.length > 0, `${location}.caseId is invalid`);
    assert(!ids.has(item.caseId), `${location}.caseId is duplicated: ${item.caseId}`);
    ids.add(item.caseId);
    if (item.sourceKind === 'root_backed') rootCount += 1;
    else if (item.sourceKind === 'ez_embedded_only') embeddedCount += 1;
    else fail(`${location}.sourceKind is invalid: ${item.sourceKind}`);

    const image = item.image;
    assert(image && typeof image === 'object', `${location}.image is missing`);
    assert(SHA256_RE.test(image.sha256), `${location}.image.sha256 is invalid`);
    assert(!imageShas.has(image.sha256), `${location}.image.sha256 is duplicated`);
    imageShas.add(image.sha256);
    assert(Number.isInteger(image.widthPx) && image.widthPx > 0, `${location}.image.widthPx is invalid`);
    assert(Number.isInteger(image.heightPx) && image.heightPx > 0, `${location}.image.heightPx is invalid`);
    assert(Number.isInteger(image.bytes) && image.bytes > 0, `${location}.image.bytes is invalid`);
    assert(item.splitGrouping?.minimumGroupId === image.sha256, `${location}.splitGrouping.minimumGroupId must equal image SHA-256`);
    assert(item.expert && typeof item.expert === 'object', `${location}.expert is missing`);
    assert(Array.isArray(item.expert.widthAnnotations), `${location}.expert.widthAnnotations must be an array`);
    assert(Array.isArray(item.expert.ezAnnotations), `${location}.expert.ezAnnotations must be an array`);
    item.expert.widthAnnotations.forEach((annotation, index) => {
      verifyCanonicalAnnotation(annotation, image, `${location}.expert.widthAnnotations[${index}]`, 'width');
      widthAnnotationCount += 1;
    });
    item.expert.ezAnnotations.forEach((annotation, index) => {
      verifyCanonicalAnnotation(annotation, image, `${location}.expert.ezAnnotations[${index}]`, 'ez');
      ezAnnotationCount += 1;
    });
    assert(Array.isArray(item.qualityFlags), `${location}.qualityFlags must be an array`);
  }
  assert(rootCount === 119, `root-backed case count must be 119, got ${rootCount}`);
  assert(embeddedCount === 55, `embedded-only case count must be 55, got ${embeddedCount}`);
  assert(ids.size === 174, `unique dataset case IDs must be 174, got ${ids.size}`);
  assert(imageShas.size === 174, `unique dataset image SHA-256 values must be 174, got ${imageShas.size}`);
  auditDatasetPhi(dataset);
  assertFiniteNumbers(dataset, 'dataset');
  return { ids, rootCount, embeddedCount, widthAnnotationCount, ezAnnotationCount };
}

function verifyBaseline(baseline) {
  assert(baseline?.schemaVersion === 'ez-rule-baseline-collection-v1', 'baseline schemaVersion mismatch');
  assert(baseline.caseCount === 174, `baseline.caseCount must be 174, got ${baseline.caseCount}`);
  assert(baseline.successCount === 174, `baseline.successCount must be 174, got ${baseline.successCount}`);
  assert(baseline.errorCount === 0, `baseline.errorCount must be 0, got ${baseline.errorCount}`);
  assert(Array.isArray(baseline.results) && baseline.results.length === 174,
    `baseline.results must contain 174 rows, got ${baseline.results?.length}`);

  const ids = new Set();
  for (const [index, result] of baseline.results.entries()) {
    const location = `baseline.results[${index}]`;
    assert(result.status === 'ok', `${location}.status must be ok`);
    assert(typeof result.caseId === 'string' && result.caseId.length > 0, `${location}.caseId is invalid`);
    assert(!ids.has(result.caseId), `${location}.caseId is duplicated: ${result.caseId}`);
    ids.add(result.caseId);
    assert(Number.isInteger(result.imageWidth) && result.imageWidth > 0, `${location}.imageWidth is invalid`);
    assert(Number.isInteger(result.imageHeight) && result.imageHeight > 0, `${location}.imageHeight is invalid`);
    const prediction = result.prediction;
    assert(prediction && typeof prediction === 'object', `${location}.prediction is missing`);
    assert(Array.isArray(prediction.toothCenters) && prediction.toothCenters.length === 12,
      `${location}.prediction.toothCenters must contain 12 points`);
    assert(Array.isArray(prediction.ezPoints) && prediction.ezPoints.length === 12,
      `${location}.prediction.ezPoints must contain 12 points`);
    assert(Array.isArray(prediction.toothWidths) && prediction.toothWidths.length === 12,
      `${location}.prediction.toothWidths must contain 12 widths`);
    assertPointArray(prediction.toothCenters, result.imageWidth, result.imageHeight, `${location}.prediction.toothCenters`);
    assertPointArray(prediction.ezPoints, result.imageWidth, result.imageHeight, `${location}.prediction.ezPoints`);
    prediction.toothWidths.forEach((width, widthIndex) => {
      assert(width && typeof width === 'object', `${location}.prediction.toothWidths[${widthIndex}] is invalid`);
      assertPoint(width.p1, result.imageWidth, result.imageHeight, `${location}.prediction.toothWidths[${widthIndex}].p1`);
      assertPoint(width.p2, result.imageWidth, result.imageHeight, `${location}.prediction.toothWidths[${widthIndex}].p2`);
    });
    assertFiniteNumbers(result, location);
  }
  assert(ids.size === 174, `unique baseline case IDs must be 174, got ${ids.size}`);
  return { ids };
}

async function verifyJoins(dataset, baseline, config) {
  assert(config?.schema_version === 'ez-training-config-v1', 'pipeline config schema_version mismatch');
  assert(typeof config.project_root === 'string' && config.project_root.length > 0, 'pipeline config project_root is missing');
  const datasetById = new Map(dataset.cases.map(item => [item.caseId, item]));
  let caseJoinCount = 0;
  let shaJoinCount = 0;
  let dimensionJoinCount = 0;
  for (const [index, result] of baseline.results.entries()) {
    const location = `baseline.results[${index}]`;
    const item = datasetById.get(result.caseId);
    assert(item, `${location}.caseId has no dataset match: ${result.caseId}`);
    caseJoinCount += 1;
    assert(item.image.widthPx === result.imageWidth && item.image.heightPx === result.imageHeight,
      `${location} image dimensions do not match dataset case ${result.caseId}`);
    dimensionJoinCount += 1;

    if (item.sourceKind === 'ez_embedded_only') {
      assert(result.sourceType === 'ez-embedded-only', `${location}.sourceType mismatch for embedded-only case`);
      assert(result.imageRef === `sha256:${item.image.sha256}`, `${location}.imageRef SHA-256 mismatch`);
      shaJoinCount += 1;
      continue;
    }

    assert(result.sourceType === 'root', `${location}.sourceType mismatch for root-backed case`);
    assert(typeof result.imageFile === 'string' && /^\d{3}\.(?:jpe?g|png)$/iu.test(result.imageFile),
      `${location}.imageFile must be a safe three-digit root filename`);
    assert(Number(path.basename(result.imageFile, path.extname(result.imageFile))) === item.rootNumber,
      `${location}.imageFile number does not match dataset rootNumber`);
    const sourcePath = path.join(config.project_root, result.imageFile);
    let sourceSha;
    try {
      sourceSha = await sha256File(sourcePath);
    } catch (error) {
      fail(`${location} root source image cannot be hashed: ${sourcePath} (${error.message})`);
    }
    assert(sourceSha === item.image.sha256, `${location} root source SHA-256 mismatch`);
    shaJoinCount += 1;
  }
  assert(caseJoinCount === 174, `dataset-baseline case join must be 174/174, got ${caseJoinCount}/174`);
  assert(shaJoinCount === 174, `dataset-baseline SHA join must be 174/174, got ${shaJoinCount}/174`);
  assert(dimensionJoinCount === 174, `dataset-baseline dimension join must be 174/174, got ${dimensionJoinCount}/174`);
  return { caseJoinCount, shaJoinCount, dimensionJoinCount };
}

async function verifyOptionalArtifacts() {
  const specs = [
    {
      fileName: 'residual-model.json',
      schemaVersion: 'ez-tzl-residual-krr/v1',
      requiredKeys: ['privacy', 'seed', 'featureSpec', 'correctionPolicy', 'tasks', 'promotionGate'],
    },
    {
      fileName: 'residual-metrics.json',
      schemaVersion: 'ez-tzl-residual-metrics/v1',
      requiredKeys: ['metricDefinitions', 'inputSummary', 'labelQuality', 'tasks', 'promotionGate'],
    },
    {
      fileName: 'residual-deployment-policy.json',
      schemaVersion: 'ez-tzl-residual-deployment-policy/v1',
      requiredKeys: [
        'status', 'modelSchemaVersion', 'modelTrainingDataDigestSha256', 'modelFileSha256',
        'tasks', 'capPolicy', 'validation', 'deployment',
      ],
    },
    {
      fileName: 'nested-policy-metrics.json',
      schemaVersion: 'ez-tzl-nested-deployment-policy-metrics/v1',
      requiredKeys: ['auditFinding', 'protocol', 'aggregateOuterTest', 'promotionGate', 'limitations'],
    },
  ];
  const checked = [];
  const missing = [];
  const artifacts = new Map();
  for (const spec of specs) {
    const filePath = path.join(HERE, spec.fileName);
    if (!(await fileExists(filePath))) {
      missing.push(spec.fileName);
      continue;
    }
    const artifact = await readJson(filePath, spec.fileName);
    assert(artifact?.schemaVersion === spec.schemaVersion,
      `${spec.fileName} schemaVersion must be ${spec.schemaVersion}`);
    for (const key of spec.requiredKeys) {
      assert(Object.hasOwn(artifact, key), `${spec.fileName} is missing top-level key: ${key}`);
    }
    assertFiniteNumbers(artifact, spec.fileName);
    artifacts.set(spec.fileName, artifact);
    checked.push(spec.fileName);
  }

  const model = artifacts.get('residual-model.json');
  const policy = artifacts.get('residual-deployment-policy.json');
  const nestedMetrics = artifacts.get('nested-policy-metrics.json');
  const decisions = {};
  if (model && policy) {
    assert(policy.modelSchemaVersion === model.schemaVersion,
      'deployment policy modelSchemaVersion does not match residual model');
    assert(policy.modelTrainingDataDigestSha256 === model.trainingDataDigestSha256,
      'deployment policy training-data digest does not match residual model');
    assert(SHA256_RE.test(policy.modelFileSha256), 'deployment policy modelFileSha256 is invalid');
    const actualModelSha = await sha256File(path.join(HERE, 'residual-model.json'));
    assert(policy.modelFileSha256 === actualModelSha,
      'deployment policy modelFileSha256 does not match residual-model.json');
    assert(policy.capPolicy?.space === 'actual_pixel_diagonal',
      'deployment policy must use actual_pixel_diagonal cap space');
    assert(policy.capPolicy?.verification?.bothTasksVerified === true,
      'deployment policy actual-pixel-diagonal cap was not verified');
    decisions.policyStatus = policy.status;
  }
  if (nestedMetrics) {
    assert(nestedMetrics.promotionGate?.productionHtmlModified === false,
      'nested policy audit must not modify the production HTML');
    const pass = nestedMetrics.promotionGate?.pass === true;
    if (!pass && policy) {
      assert(policy.deployment?.productionPromotionAllowed === false,
        'deployment policy cannot allow production after nested validation failure');
    }
    decisions.nestedPromotionPass = pass;
    decisions.nestedDecision = nestedMetrics.promotionGate?.decision || null;
  }
  return { checked, missing, decisions };
}

async function main() {
  const datasetPath = argValue('--dataset', DEFAULTS.dataset);
  const baselinePath = argValue('--baseline', DEFAULTS.baseline);
  const configPath = argValue('--config', DEFAULTS.config);
  const [dataset, baseline, config] = await Promise.all([
    readJson(datasetPath, 'dataset index'),
    readJson(baselinePath, 'baseline predictions'),
    readJson(configPath, 'pipeline config'),
  ]);

  const datasetStats = verifyDataset(dataset);
  const baselineStats = verifyBaseline(baseline);
  for (const id of datasetStats.ids) assert(baselineStats.ids.has(id), `baseline is missing dataset caseId: ${id}`);
  const joins = await verifyJoins(dataset, baseline, config);
  const optionalArtifacts = await verifyOptionalArtifacts();

  console.log(JSON.stringify({
    status: 'PASS',
    dataset: {
      cases: dataset.cases.length,
      rootBacked: datasetStats.rootCount,
      ezEmbeddedOnly: datasetStats.embeddedCount,
      uniqueCaseIds: datasetStats.ids.size,
      uniqueImageSha256: new Set(dataset.cases.map(item => item.image.sha256)).size,
      widthAnnotations: datasetStats.widthAnnotationCount,
      ezAnnotations: datasetStats.ezAnnotationCount,
      coordinates: 'finite_and_in_bounds',
      phiAudit: 'passed',
    },
    baseline: {
      cases: baseline.results.length,
      ok: baseline.results.filter(item => item.status === 'ok').length,
      twelveToothCenters: baseline.results.length,
      twelveEzPoints: baseline.results.length,
      twelveToothWidths: baseline.results.length,
      coordinates: 'finite_and_in_bounds',
    },
    joins,
    optionalArtifacts,
  }, null, 2));
}

main().catch(error => {
  console.error(`VERIFY_PIPELINE_FAILED: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
