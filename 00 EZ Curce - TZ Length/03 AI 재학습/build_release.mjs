#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = path.join(path.dirname(HERE), 'ez_training_release_20260711');

const GROUPS = {
  docs: [
    'README.md',
    'README_재학습.md',
    'BASELINE_AUDIT.md',
    'BASELINE_METRICS.md',
    'RESIDUAL_INFERENCE_AUDIT.md',
    'NESTED_POLICY_AUDIT.md',
    'HARNESS.md',
  ],
  scripts: [
    'package.json',
    'build_dataset_index.mjs',
    'run_rule_baseline.js',
    'merge_baselines.js',
    'evaluate_baseline.mjs',
    'train_residual.py',
    'evaluate_residual_clinical.py',
    'tune_residual_blend.py',
    'tune_residual_gate.py',
    'validate_deployment_policy_nested.py',
    'generate_residual_parity_fixture.py',
    'residual_inference.js',
    'test_residual_inference.js',
    'verify_pipeline.mjs',
    'generate_benchmark_report.mjs',
    'run_harness.mjs',
    'build_release.mjs',
  ],
  data: [
    'pipeline_config.json',
    'dataset-index.json',
    'baseline_predictions_all.json',
    'baseline_predictions_all.csv',
    'residual-parity-fixture.json',
  ],
  model: [
    'residual-model.json',
    'residual-deployment-policy.json',
  ],
  reports: [
    'baseline_metrics.json',
    'residual-metrics.json',
    'residual-clinical-metrics.json',
    'residual-blend-tuning.json',
    'residual-gate-tuning.json',
    'residual-gate-fine-tuning.json',
    'nested-policy-metrics.json',
    'harness-run.json',
    'benchmark.html',
  ],
};

function argument(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(HERE, fileName), 'utf8'));
}

async function main() {
  const outputRoot = path.resolve(argument('--output', DEFAULT_OUTPUT));
  const nested = await readJson('nested-policy-metrics.json');
  const policy = await readJson('residual-deployment-policy.json');
  const config = await readJson('pipeline_config.json');
  if (nested.promotionGate?.pass === true) {
    throw new Error('This research release builder is only for a non-promoted model; review the release protocol.');
  }
  if (policy.deployment?.productionPromotionAllowed === true) {
    throw new Error('Deployment policy conflicts with the failed nested validation.');
  }

  const records = [];
  for (const [group, names] of Object.entries(GROUPS)) {
    await mkdir(outputRoot, { recursive: true });
    for (const name of names) {
      const source = path.join(HERE, name);
      // Keep the release flat: the harness and Python modules deliberately use
      // same-directory relative imports and artifact paths.
      const destination = path.join(outputRoot, name);
      const bytes = await readFile(source);
      await copyFile(source, destination);
      const copied = await readFile(destination);
      const sourceHash = sha256(bytes);
      const copiedHash = sha256(copied);
      if (sourceHash !== copiedHash) throw new Error(`Release copy hash mismatch: ${name}`);
      records.push({
        group,
        file: name,
        bytes: copied.length,
        sha256: copiedHash,
      });
    }
  }

  const manifest = {
    schemaVersion: 'ez-tzl-training-release/v1',
    createdAt: new Date().toISOString(),
    releaseMode: 'research_only',
    productionHtmlModified: false,
    productionHtmlSha256: sha256(await readFile(path.join(config.project_root, config.production_html))),
    promotionPass: false,
    decision: nested.promotionGate?.decision || 'do_not_promote_research_only',
    policyStatus: policy.status,
    humanApprovalRequired: true,
    privacy: {
      containsOriginalImages: false,
      containsMdImageData: false,
      generatedReportsContainPhi: false,
    },
    files: records.sort((a, b) => a.file.localeCompare(b.file, 'en')),
    totals: {
      files: records.length,
      bytes: records.reduce((sum, item) => sum + item.bytes, 0),
    },
  };
  const manifestPath = path.join(outputRoot, 'release-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: 'PASS',
    outputRoot,
    releaseMode: manifest.releaseMode,
    decision: manifest.decision,
    files: manifest.totals.files,
    bytes: manifest.totals.bytes,
    manifest: manifestPath,
  }, null, 2));
}

main().catch(error => {
  console.error(`BUILD_RELEASE_FAILED: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
