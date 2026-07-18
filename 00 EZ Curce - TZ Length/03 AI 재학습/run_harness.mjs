#!/usr/bin/env node

/**
 * Six-stage, fail-fast medical-ML research harness for the EZ/TZL project.
 *
 * Safety boundary:
 * - this program never writes the production HTML;
 * - a model can only finish in research or shadow mode;
 * - human approval is always required;
 * - harness-run.json contains aggregate data only (no case IDs, image hashes,
 *   source paths, patient names, or image coordinates).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = {
  config: path.join(HERE, 'pipeline_config.json'),
  dataset: path.join(HERE, 'dataset-index.json'),
  rootBaseline: path.join(HERE, 'baseline_predictions.json'),
  rootBaselineCsv: path.join(HERE, 'baseline_predictions.csv'),
  embeddedBaseline: path.join(HERE, 'baseline_ez_embedded_predictions.json'),
  embeddedBaselineCsv: path.join(HERE, 'baseline_ez_embedded_predictions.csv'),
  baseline: path.join(HERE, 'baseline_predictions_all.json'),
  baselineCsv: path.join(HERE, 'baseline_predictions_all.csv'),
  baselineMetrics: path.join(HERE, 'baseline_metrics.json'),
  baselineReport: path.join(HERE, 'BASELINE_METRICS.md'),
  model: path.join(HERE, 'residual-model.json'),
  residualMetrics: path.join(HERE, 'residual-metrics.json'),
  clinicalMetrics: path.join(HERE, 'residual-clinical-metrics.json'),
  gateTuning: path.join(HERE, 'residual-gate-tuning.json'),
  fineGateTuning: path.join(HERE, 'residual-gate-fine-tuning.json'),
  deploymentPolicy: path.join(HERE, 'residual-deployment-policy.json'),
  nestedPolicyMetrics: path.join(HERE, 'nested-policy-metrics.json'),
  parityFixture: path.join(HERE, 'residual-parity-fixture.json'),
  benchmark: path.join(HERE, 'benchmark.html'),
  manifest: path.join(HERE, 'harness-run.json'),
};

const SCRIPTS = {
  curator: path.join(HERE, 'build_dataset_index.mjs'),
  baseline: path.join(HERE, 'run_rule_baseline.js'),
  merge: path.join(HERE, 'merge_baselines.js'),
  evaluateBaseline: path.join(HERE, 'evaluate_baseline.mjs'),
  train: path.join(HERE, 'train_residual.py'),
  clinical: path.join(HERE, 'evaluate_residual_clinical.py'),
  tuneGate: path.join(HERE, 'tune_residual_gate.py'),
  validateNestedPolicy: path.join(HERE, 'validate_deployment_policy_nested.py'),
  verify: path.join(HERE, 'verify_pipeline.mjs'),
  parityFixture: path.join(HERE, 'generate_residual_parity_fixture.py'),
  parityTest: path.join(HERE, 'test_residual_inference.js'),
  report: path.join(HERE, 'generate_benchmark_report.mjs'),
};

const STAGE_NAMES = ['Curator', 'Miner', 'Architect', 'Trainer', 'Critic', 'Promoter'];
const startedAt = new Date();
const stages = [];
let activeStage = null;
let productionPath = null;
let productionDigestBefore = null;

function usage() {
  return [
    'Usage: node run_harness.mjs [options]',
    '',
    '  --round <1..5>          record the controlled learning round (default: 1)',
    '  --refresh-baseline      rerun root + embedded-only rule baselines and merge',
    '  --skip-training         reuse current model/metrics; missing artifacts block promotion',
    '  --dry-run               alias for --skip-training (verification still runs)',
    '  --python <executable>   Python 3.12+ executable (bundled runtime is auto-detected)',
    '  --config <file>         pipeline config (default: pipeline_config.json)',
    '  -h, --help              show this help',
    '',
    'The production HTML is never edited. Even a fully passing run remains shadow-only',
    'until an authorized clinician/responsible owner explicitly approves a separate release.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    round: 1,
    refreshBaseline: false,
    skipTraining: false,
    dryRun: false,
    python: null,
    config: FILES.config,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const nextValue = (flag) => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--refresh-baseline') options.refreshBaseline = true;
    else if (token === '--skip-training') options.skipTraining = true;
    else if (token === '--dry-run') {
      options.dryRun = true;
      options.skipTraining = true;
    } else if (token === '--round') options.round = Number(nextValue(token));
    else if (token.startsWith('--round=')) options.round = Number(token.slice('--round='.length));
    else if (token === '--python') options.python = nextValue(token);
    else if (token.startsWith('--python=')) options.python = token.slice('--python='.length);
    else if (token === '--config') options.config = path.resolve(nextValue(token));
    else if (token.startsWith('--config=')) options.config = path.resolve(token.slice('--config='.length));
    else throw new Error(`Unknown option: ${token}`);
  }
  if (!Number.isInteger(options.round) || options.round < 1 || options.round > 5) {
    throw new Error('--round must be an integer from 1 through 5');
  }
  if (options.refreshBaseline && options.dryRun) {
    throw new Error('--dry-run cannot be combined with --refresh-baseline');
  }
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await readFile(filePath));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${error.message}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'generatedAt' || key === 'createdAt') continue;
    result[key] = canonicalize(value[key]);
  }
  return result;
}

function semanticDigest(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function countAnnotations(dataset, kind) {
  const key = kind === 'width' ? 'widthAnnotations' : 'ezAnnotations';
  return dataset.cases.reduce((total, item) => total + (item.expert?.[key]?.length ?? 0), 0);
}

function countCompleteCases(dataset, kind) {
  const key = kind === 'width' ? 'widthAnnotations' : 'ezAnnotations';
  const completenessKey = kind === 'width' ? 'toothWidths12' : 'ezPoints12';
  return dataset.cases.filter((item) =>
    (item.expert?.[key] ?? []).some((annotation) => annotation.completeness?.[completenessKey] === true)).length;
}

function inspectPolicy(config, round) {
  const checks = {
    schemaVersion: config?.schema_version === 'ez-training-config-v1',
    fiveGroupedFolds: config?.folds === 5,
    requestedRoundWithinConfiguredMaximum: Number.isInteger(config?.rounds?.maximum)
      && config.rounds.maximum >= round && config.rounds.maximum <= 5,
    imageDigestSplitUnit: config?.validation?.split_unit === 'patient_group_if_available_else_image_sha256',
    humanApprovalRequired: config?.validation?.promotion_requires_human_approval === true,
    coordinateImprovementGatePresent: Number.isFinite(config?.validation?.minimum_coordinate_mae_relative_improvement),
    improvedFoldGatePresent: Number.isInteger(config?.validation?.minimum_improved_fold_count),
    p95NonRegressionGatePresent: Number.isFinite(config?.validation?.maximum_p95_relative_regression),
    correctionCapPresent: Number.isFinite(config?.validation?.maximum_correction_fraction_of_image_diagonal),
    unfamiliarFallbackRequired: config?.validation?.unfamiliar_case_policy === 'fall_back_to_rule_engine',
    shadowDefault: config?.deployment?.default_mode === 'shadow',
    gatedPromotionPolicy: config?.deployment?.production_promotion === 'only_after_all_validation_gates_pass',
  };
  return { checks, complete: Object.values(checks).every(Boolean) };
}

async function preferredGateTuningPath() {
  if (await exists(FILES.fineGateTuning)) return FILES.fineGateTuning;
  return FILES.gateTuning;
}

async function verifyDeploymentPolicyIdentity(policy, model) {
  if (!policy || !model || !(await exists(FILES.model))) return false;
  const modelFileDigest = await sha256File(FILES.model);
  return policy.schemaVersion === 'ez-tzl-residual-deployment-policy/v1'
    && policy.modelSchemaVersion === model.schemaVersion
    && typeof model.trainingDataDigestSha256 === 'string'
    && policy.modelTrainingDataDigestSha256 === model.trainingDataDigestSha256
    && policy.modelFileSha256 === modelFileDigest;
}

async function verifyNestedPolicyIdentity(policy, nestedMetrics) {
  const binding = policy?.nestedValidation;
  if (!binding || !nestedMetrics || !(await exists(FILES.nestedPolicyMetrics))) return false;
  const nestedFileDigest = await sha256File(FILES.nestedPolicyMetrics);
  return binding.schemaVersion === nestedMetrics.schemaVersion
    && binding.metricsFileSha256 === nestedFileDigest
    && binding.pass === (nestedMetrics.promotionGate?.pass === true)
    && binding.decision === nestedMetrics.promotionGate?.decision;
}

function nestedValidationPassed(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  return metrics.pass === true
    || metrics.promotionGate?.pass === true
    || metrics.validation?.gates?.pass === true
    || metrics.nestedValidation?.pass === true;
}

async function resolvePython(explicit) {
  const candidates = [
    explicit,
    process.env.EZ_TRAINING_PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || await exists(candidate)) return candidate;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runProcess(stage, label, executable, args) {
  const commandLog = { label, status: 'RUNNING', exitCode: null, durationMs: null };
  stage.commands.push(commandLog);
  const commandStarted = Date.now();
  process.stdout.write(`[${stage.id}/6 ${stage.name}] ${label}...\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: HERE,
      stdio: 'inherit',
      windowsHide: true,
      env: process.env,
    });
    child.once('error', (error) => {
      commandLog.status = 'FAILED';
      commandLog.durationMs = Date.now() - commandStarted;
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      commandLog.exitCode = code;
      commandLog.durationMs = Date.now() - commandStarted;
      if (code === 0) {
        commandLog.status = 'PASS';
        resolve();
      } else {
        commandLog.status = 'FAILED';
        reject(new Error(`${label} failed with exit ${code ?? 'null'}${signal ? ` (${signal})` : ''}`));
      }
    });
  });
}

async function runStage(id, task) {
  const record = {
    id,
    name: STAGE_NAMES[id - 1],
    status: 'RUNNING',
    durationMs: null,
    commands: [],
    aggregate: {},
  };
  stages.push(record);
  activeStage = record;
  const stageStarted = Date.now();
  process.stdout.write(`\n=== ${id}/6 ${record.name} ===\n`);
  try {
    record.aggregate = await task(record) ?? {};
    record.status = 'PASS';
    return record;
  } catch (error) {
    record.status = 'FAILED';
    throw error;
  } finally {
    record.durationMs = Date.now() - stageStarted;
  }
}

function assertManifestAggregateOnly(manifest) {
  const serialized = JSON.stringify(manifest);
  const forbidden = [
    /"caseId"\s*:/iu,
    /"patientName"\s*:/iu,
    /"imageName"\s*:/iu,
    /"sourcePath"\s*:/iu,
    /"sourceFile(?:Name|Path)?"\s*:/iu,
    /[A-Za-z]:\\/u,
    /data:image\//iu,
    /"(?:x|y)"\s*:/u,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(serialized)) throw new Error(`harness-run privacy audit failed: ${pattern}`);
  }
}

async function writeManifest(manifest) {
  assertManifestAggregateOnly(manifest);
  await mkdir(path.dirname(FILES.manifest), { recursive: true });
  await writeFile(FILES.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function makeManifest(options, final) {
  return {
    schemaVersion: 'ez-medical-ml-harness-run/v1',
    privacy: {
      aggregateOnly: true,
      containsPhi: false,
      containsCaseIdentifiers: false,
      containsImageHashes: false,
      containsSourcePaths: false,
      containsImageCoordinates: false,
    },
    round: options.round,
    executionMode: options.refreshBaseline
      ? 'refresh_baseline'
      : (options.skipTraining ? 'reuse_current_artifacts' : 'train_current_round'),
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    pipelineStatus: final.pipelineStatus,
    promotionStatus: final.promotionStatus,
    deploymentMode: final.deploymentMode,
    humanApprovalRequired: true,
    productionPromotionAllowed: false,
    productionHtml: {
      editedByHarness: false,
      unchangedDigestVerified: final.productionUnchanged === true,
    },
    stages,
    automatedGates: final.automatedGates ?? null,
    blockedReasons: final.blockedReasons ?? [],
    outputArtifacts: {
      aggregateManifest: 'harness-run.json',
      benchmarkReport: 'benchmark.html',
      baselineMetrics: 'baseline_metrics.json',
      residualMetrics: (final.artifacts?.residualMetrics === true) ? 'residual-metrics.json' : null,
      clinicalMetrics: (final.artifacts?.clinicalMetrics === true) ? 'residual-clinical-metrics.json' : null,
      gateTuning: final.artifacts?.gateTuningFile ?? null,
      deploymentPolicy: (final.artifacts?.deploymentPolicy === true) ? 'residual-deployment-policy.json' : null,
      nestedPolicyMetrics: (final.artifacts?.nestedPolicyMetrics === true) ? 'nested-policy-metrics.json' : null,
    },
    fatalFailure: final.fatalFailure ?? null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const config = await readJson(options.config, 'pipeline config');
  const productionRoot = config.project_root;
  const productionFile = config.production_html;
  if (typeof productionRoot !== 'string' || typeof productionFile !== 'string') {
    throw new Error('pipeline config must identify the read-only production HTML');
  }
  productionPath = path.join(productionRoot, productionFile);
  productionDigestBefore = await sha256File(productionPath);
  const python = await resolvePython(options.python);
  let architectPolicy = { complete: false, checks: {} };
  let criticDecision = null;

  await runStage(1, async (stage) => {
    await runProcess(stage, 'build_dataset_index', process.execPath, [
      SCRIPTS.curator,
      '--output', FILES.dataset,
    ]);
    const dataset = await readJson(FILES.dataset, 'canonical dataset');
    if (dataset.schemaVersion !== 'ez-canonical-dataset-index/v1') throw new Error('canonical dataset schema mismatch');
    if (dataset.privacy?.phiFieldsEmitted !== false) throw new Error('canonical dataset PHI audit did not pass');
    if (!Array.isArray(dataset.cases) || dataset.cases.length === 0) throw new Error('canonical dataset contains no cases');
    const reviewCases = dataset.cases.filter((item) => item.qualityFlags?.includes('requires_mapping_review')).length;
    return {
      mappingAudit: 'PASS',
      phiAudit: 'PASS',
      canonicalCases: dataset.cases.length,
      rootBackedCases: dataset.summary?.rootBackedCases ?? null,
      embeddedOnlyCases: dataset.summary?.ezEmbeddedOnlyCases ?? null,
      widthAnnotations: countAnnotations(dataset, 'width'),
      ezAnnotations: countAnnotations(dataset, 'ez'),
      exact12WidthCases: countCompleteCases(dataset, 'width'),
      exact12EzCases: countCompleteCases(dataset, 'ez'),
      casesRequiringMappingReview: reviewCases,
      duplicateImageRowsGrouped: dataset.summary?.duplicateImageRowsGroupedIntoCanonicalCases ?? null,
    };
  });

  await runStage(2, async (stage) => {
    if (options.refreshBaseline) {
      await runProcess(stage, 'run_root_rule_baseline', process.execPath, [
        SCRIPTS.baseline,
        '--source=root',
        `--output=${FILES.rootBaseline}`,
        `--csv=${FILES.rootBaselineCsv}`,
      ]);
      await runProcess(stage, 'run_embedded_rule_baseline', process.execPath, [
        SCRIPTS.baseline,
        '--source=ez-embedded-only',
        `--output=${FILES.embeddedBaseline}`,
        `--csv=${FILES.embeddedBaselineCsv}`,
      ]);
      await runProcess(stage, 'merge_rule_baselines', process.execPath, [SCRIPTS.merge]);
    } else if (!(await exists(FILES.baseline))) {
      throw new Error('merged baseline is missing; rerun with --refresh-baseline');
    }
    await runProcess(stage, 'evaluate_rule_baseline', process.execPath, [
      SCRIPTS.evaluateBaseline,
      '--dataset', FILES.dataset,
      '--predictions', FILES.baseline,
      '--output', FILES.baselineMetrics,
      '--report', FILES.baselineReport,
    ]);
    const baseline = await readJson(FILES.baseline, 'merged baseline');
    const metrics = await readJson(FILES.baselineMetrics, 'baseline metrics');
    if (baseline.errorCount !== 0 || baseline.successCount !== baseline.caseCount) {
      throw new Error('baseline contains failed cases');
    }
    if (metrics.sanityChecks?.pass !== true) throw new Error('baseline metric sanity checks failed');
    return {
      baselineMode: options.refreshBaseline ? 'refreshed' : 'reused',
      totalCases: baseline.caseCount,
      successfulCases: baseline.successCount,
      failedCases: baseline.errorCount,
      evaluatedWidthCases: metrics.summary?.evaluatedWidthCaseCount ?? null,
      evaluatedEzCases: metrics.summary?.evaluatedEzCaseCount ?? null,
      pairedClinicalCases: metrics.summary?.completeWidthAndEzClinicalCaseCount ?? null,
      sanityChecksPassed: metrics.sanityChecks?.checks?.filter((item) => item.pass).length ?? null,
      sanityChecksTotal: metrics.sanityChecks?.checks?.length ?? null,
    };
  });

  await runStage(3, async () => {
    const [dataset, baseline] = await Promise.all([
      readJson(FILES.dataset, 'canonical dataset'),
      readJson(FILES.baseline, 'merged baseline'),
    ]);
    architectPolicy = inspectPolicy(config, options.round);
    const groups = dataset.cases
      .map((item) => item.splitGrouping?.minimumGroupId)
      .filter((value) => typeof value === 'string' && value.length > 0)
      .sort();
    if (new Set(groups).size !== dataset.cases.length) throw new Error('split groups are missing or duplicated');
    const splitDigest = semanticDigest({ seed: config.seed, folds: config.folds, groups });
    const architectureDigest = semanticDigest({
      round: options.round,
      config: canonicalize(config),
      dataset: semanticDigest(dataset),
      baseline: semanticDigest(baseline),
      split: splitDigest,
    });
    return {
      configSchemaValid: architectPolicy.checks.schemaVersion === true,
      policyComplete: architectPolicy.complete,
      policyChecksPassed: Object.values(architectPolicy.checks).filter(Boolean).length,
      policyChecksTotal: Object.values(architectPolicy.checks).length,
      splitUnit: 'exact_image_digest_or_private_patient_group',
      groupedFolds: config.folds ?? null,
      uniqueSplitGroups: new Set(groups).size,
      seed: Number.isInteger(config.seed) ? config.seed : null,
      splitDigest,
      architectureDigest,
    };
  });

  await runStage(4, async (stage) => {
    if (!options.skipTraining) {
      const maximumCorrection = String(config.validation?.maximum_correction_fraction_of_image_diagonal ?? 0.05);
      const seed = String(config.seed ?? 20260711);
      const folds = String(config.folds ?? 5);
      await runProcess(stage, 'train_residual_model', python, [
        SCRIPTS.train,
        '--dataset-index', FILES.dataset,
        '--baseline-predictions', FILES.baseline,
        '--output-dir', HERE,
        '--folds', folds,
        '--seed', seed,
        '--max-correction', maximumCorrection,
      ]);
      await runProcess(stage, 'evaluate_clinical_lengths', python, [
        SCRIPTS.clinical,
        '--dataset-index', FILES.dataset,
        '--baseline-predictions', FILES.baseline,
        '--output', FILES.clinicalMetrics,
        '--seed', seed,
        '--maximum-correction', maximumCorrection,
      ]);
      await runProcess(stage, 'tune_fine_clinical_and_safety_policy', python, [
        SCRIPTS.tuneGate,
        '--dataset-index', FILES.dataset,
        '--baseline-predictions', FILES.baseline,
        '--model', FILES.model,
        '--output', FILES.fineGateTuning,
        '--policy-output', FILES.deploymentPolicy,
        '--seed', seed,
        '--legacy-maximum-correction', maximumCorrection,
        '--fine-grid',
      ]);
      await runProcess(stage, 'validate_policy_with_nested_outer_folds', python, [
        SCRIPTS.validateNestedPolicy,
        '--dataset-index', FILES.dataset,
        '--baseline-predictions', FILES.baseline,
        '--output', FILES.nestedPolicyMetrics,
        '--seed', seed,
      ]);
    }
    const gateTuningPath = await preferredGateTuningPath();
    const required = [
      FILES.model,
      FILES.residualMetrics,
      FILES.clinicalMetrics,
      gateTuningPath,
      FILES.deploymentPolicy,
      FILES.nestedPolicyMetrics,
    ];
    const availability = await Promise.all(required.map(exists));
    const [
      modelPresent,
      residualPresent,
      clinicalPresent,
      tunerPresent,
      policyPresent,
      nestedMetricsPresent,
    ] = availability;
    let residualSummary = null;
    let clinicalSummary = null;
    let tunerSummary = null;
    let policySummary = null;
    let nestedSummary = null;
    if (residualPresent) {
      const metrics = await readJson(FILES.residualMetrics, 'residual metrics');
      residualSummary = {
        samplesWidth: metrics.inputSummary?.taskSamples?.width ?? null,
        samplesEz: metrics.inputSummary?.taskSamples?.ez ?? null,
        statisticalGatePass: metrics.promotionGate?.pass === true,
      };
    }
    if (clinicalPresent) {
      const metrics = await readJson(FILES.clinicalMetrics, 'clinical metrics');
      clinicalSummary = {
        pairedCases: metrics.pairedCompleteCases ?? null,
        pairedFallbackCases: metrics.pairedAnyFallback ?? null,
      };
    }
    if (tunerPresent) {
      const tuning = await readJson(gateTuningPath, 'gate tuning');
      tunerSummary = {
        candidates: tuning.protocol?.candidateCount ?? null,
        passingCandidates: tuning.selection?.passingCandidateCount ?? null,
        candidateSelected: tuning.selection?.candidateSelected === true,
        actualPixelDiagonalCapVerified: tuning.actualPixelDiagonalCapAudit?.bothTasksVerified === true,
      };
    }
    if (policyPresent) {
      const policy = await readJson(FILES.deploymentPolicy, 'deployment policy');
      policySummary = {
        schemaValid: policy.schemaVersion === 'ez-tzl-residual-deployment-policy/v1',
        status: typeof policy.status === 'string' ? policy.status : 'missing',
        validationGatePass: policy.validation?.gates?.pass === true,
        modelIdentityFieldsPresent: [
          policy.modelSchemaVersion,
          policy.modelTrainingDataDigestSha256,
          policy.modelFileSha256,
        ].every((value) => typeof value === 'string' && value.length > 0),
      };
    }
    if (nestedMetricsPresent) {
      const nested = await readJson(FILES.nestedPolicyMetrics, 'nested policy metrics');
      nestedSummary = {
        outerFolds: nested.protocol?.outerValidation ? 5 : null,
        promotionGatePass: nested.promotionGate?.pass === true,
        strictInnerPolicySelectedFolds:
          nested.promotionGate?.details?.strictInnerPolicySelectedFolds ?? null,
        requiredStrictInnerPolicySelectedFolds:
          nested.promotionGate?.details?.requiredStrictInnerPolicySelectedFolds ?? null,
      };
    }
    return {
      trainingMode: options.skipTraining ? 'reused' : 'trained',
      modelPresent,
      residualMetricsPresent: residualPresent,
      clinicalMetricsPresent: clinicalPresent,
      gateTuningPresent: tunerPresent,
      fineGateTuningPreferred: gateTuningPath === FILES.fineGateTuning,
      deploymentPolicyPresent: policyPresent,
      nestedPolicyMetricsPresent: nestedMetricsPresent,
      missingArtifactCount: availability.filter((value) => !value).length,
      residual: residualSummary,
      clinical: clinicalSummary,
      tuning: tunerSummary,
      deploymentPolicy: policySummary,
      nestedValidation: nestedSummary,
    };
  });

  await runStage(5, async (stage) => {
    await runProcess(stage, 'verify_dataset_baseline_pipeline', process.execPath, [
      SCRIPTS.verify,
      '--dataset', FILES.dataset,
      '--baseline', FILES.baseline,
      '--config', options.config,
    ]);
    const modelPresent = await exists(FILES.model);
    let parityPass = false;
    if (modelPresent) {
      await runProcess(stage, 'generate_python_parity_fixture', python, [
        SCRIPTS.parityFixture,
        '--model', FILES.model,
        '--baseline', FILES.baseline,
        '--output', FILES.parityFixture,
        '--cases', '12',
      ]);
      await runProcess(stage, 'test_javascript_python_parity', process.execPath, [SCRIPTS.parityTest]);
      parityPass = true;
    }

    const residualPresent = await exists(FILES.residualMetrics);
    const clinicalPresent = await exists(FILES.clinicalMetrics);
    const gateTuningPath = await preferredGateTuningPath();
    const tunerPresent = await exists(gateTuningPath);
    const deploymentPolicyPresent = await exists(FILES.deploymentPolicy);
    const nestedMetricsPresent = await exists(FILES.nestedPolicyMetrics);
    const residual = residualPresent ? await readJson(FILES.residualMetrics, 'residual metrics') : null;
    const clinical = clinicalPresent ? await readJson(FILES.clinicalMetrics, 'clinical metrics') : null;
    const tuning = tunerPresent ? await readJson(gateTuningPath, 'gate tuning') : null;
    const deploymentPolicy = deploymentPolicyPresent
      ? await readJson(FILES.deploymentPolicy, 'deployment policy')
      : null;
    const nestedMetrics = nestedMetricsPresent
      ? await readJson(FILES.nestedPolicyMetrics, 'nested policy metrics')
      : null;
    const datasetForGrouping = await readJson(FILES.dataset, 'canonical dataset');
    const model = modelPresent ? await readJson(FILES.model, 'residual model') : null;
    const deploymentPolicyIdentityMatch = await verifyDeploymentPolicyIdentity(deploymentPolicy, model);
    const nestedPolicyIdentityMatch = await verifyNestedPolicyIdentity(deploymentPolicy, nestedMetrics);
    const policyStatus = typeof deploymentPolicy?.status === 'string' ? deploymentPolicy.status : '';
    const policyPendingNested = /pending.*nested|nested.*pending/iu.test(policyStatus);
    const policyRejected = /rejected|failed|blocked|research[_-]?only/iu.test(policyStatus);
    const policyReady = !policyPendingNested && !policyRejected
      && /validated|eligible|approved|shadow/iu.test(policyStatus);
    const nestedPass = nestedValidationPassed(nestedMetrics);
    const gates = {
      pipelineVerification: true,
      inferenceParity: parityPass,
      policyComplete: architectPolicy.complete,
      residualStatisticalGate: residual?.promotionGate?.pass === true,
      clinicalMetricsPresent: clinical?.schemaVersion === 'ez-tzl-residual-clinical-metrics/v1',
      gateTunerPresent: tuning?.schemaVersion === 'ez-tzl-residual-gate-tuning/v1',
      tunedCandidateSelected: tuning?.selection?.candidateSelected === true,
      deploymentPolicyPresent:
        deploymentPolicy?.schemaVersion === 'ez-tzl-residual-deployment-policy/v1',
      deploymentPolicyModelIdentityMatch: deploymentPolicyIdentityMatch,
      deploymentPolicyNestedMetricsIdentityMatch: nestedPolicyIdentityMatch,
      tunedRequiredGate: deploymentPolicy?.validation?.gates?.pass === true,
      actualPixelDiagonalCapIssueResolved:
        tuning?.actualPixelDiagonalCapAudit?.bothTasksVerified === true
        && deploymentPolicy?.capPolicy?.verification?.bothTasksVerified === true,
      nestedPolicyMetricsPresent: nestedMetricsPresent,
      nestedPolicyValidationPass: nestedPass,
      nestedClinicalTailNonRegression:
        nestedMetrics?.promotionGate?.checks?.allAppScaleMaeAndP95DidNotRegress === true
        && nestedMetrics?.promotionGate?.checks?.allReferenceScaleP95DidNotRegress === true,
      allOuterFoldsSelectedStrictInnerPolicy:
        nestedMetrics?.promotionGate?.checks?.allFiveOuterFoldsSelectedStrictInnerPolicy === true,
      patientLevelGroupingAvailable:
        Number(datasetForGrouping.summary?.patientGroupIdsGenerated ?? 0) > 0,
      deploymentPolicyStatusReady: policyReady,
      deploymentPolicyIntegrationAuthorized:
        deploymentPolicy?.deployment?.productionIntegrationAuthorized === true,
      deploymentPolicyPromotionAllowed:
        deploymentPolicy?.deployment?.productionPromotionAllowed === true,
    };
    const blockedReasons = [];
    if (!gates.policyComplete) blockedReasons.push('promotion_policy_missing_or_incomplete');
    if (!gates.inferenceParity) blockedReasons.push('inference_parity_not_verified');
    if (!gates.residualStatisticalGate) blockedReasons.push('statistical_gate_failed_or_missing');
    if (!gates.clinicalMetricsPresent) blockedReasons.push('clinical_metrics_missing');
    if (!gates.gateTunerPresent) blockedReasons.push('gate_tuner_output_missing');
    if (gates.gateTunerPresent && !gates.tunedCandidateSelected) blockedReasons.push('no_tuned_candidate_passed');
    if (!gates.deploymentPolicyPresent) blockedReasons.push('deployment_policy_missing_or_invalid');
    if (gates.deploymentPolicyPresent && !gates.deploymentPolicyModelIdentityMatch) {
      blockedReasons.push('deployment_policy_model_identity_mismatch');
    }
    if (gates.deploymentPolicyPresent && !gates.deploymentPolicyNestedMetricsIdentityMatch) {
      blockedReasons.push('deployment_policy_nested_metrics_identity_mismatch');
    }
    if (gates.gateTunerPresent && !gates.tunedRequiredGate) blockedReasons.push('tuned_required_gate_failed');
    if (gates.gateTunerPresent && !gates.actualPixelDiagonalCapIssueResolved) {
      blockedReasons.push('pixel_diagonal_correction_cap_issue_unresolved');
    }
    if (policyPendingNested) blockedReasons.push('pending_nested_validation');
    if (policyRejected) blockedReasons.push('candidate_rejected_nested_validation');
    if (!policyPendingNested && !policyRejected && !gates.deploymentPolicyStatusReady) {
      blockedReasons.push('deployment_policy_status_not_ready');
    }
    if (!gates.nestedPolicyMetricsPresent) blockedReasons.push('nested_policy_metrics_missing');
    else if (!gates.nestedPolicyValidationPass) blockedReasons.push('nested_policy_failed');
    if (gates.nestedPolicyMetricsPresent && !gates.nestedClinicalTailNonRegression) {
      blockedReasons.push('clinical_tail_regression');
    }
    if (!gates.patientLevelGroupingAvailable) blockedReasons.push('patient_level_grouping_unavailable');
    if (!gates.deploymentPolicyIntegrationAuthorized || !gates.deploymentPolicyPromotionAllowed) {
      blockedReasons.push('deployment_policy_not_authorized');
    }
    const allAutomatedGatesPass = Object.values(gates).every(Boolean);
    criticDecision = {
      gates,
      allAutomatedGatesPass,
      blockedReasons,
      promotionStatus: allAutomatedGatesPass ? 'AWAITING_HUMAN_APPROVAL' : 'BLOCKED',
      deploymentMode: allAutomatedGatesPass ? 'shadow' : 'research_only',
    };
    return {
      structuralValidation: 'PASS',
      parityValidation: parityPass ? 'PASS' : 'NOT_AVAILABLE',
      automatedGateChecksPassed: Object.values(gates).filter(Boolean).length,
      automatedGateChecksTotal: Object.values(gates).length,
      allAutomatedGatesPass,
      promotionStatus: criticDecision.promotionStatus,
      deploymentMode: criticDecision.deploymentMode,
      humanApprovalRequired: true,
      productionPromotionAllowed: false,
      blockedReasonCount: blockedReasons.length,
    };
  });

  await runStage(6, async (stage) => {
    await runProcess(stage, 'generate_aggregate_benchmark_report', process.execPath, [
      SCRIPTS.report,
      '--dataset', FILES.dataset,
      '--baseline', FILES.baseline,
      '--baseline-metrics', FILES.baselineMetrics,
      '--residual-metrics', FILES.residualMetrics,
      '--output', FILES.benchmark,
    ]);
    const productionDigestAfter = await sha256File(productionPath);
    if (productionDigestAfter !== productionDigestBefore) {
      throw new Error('production HTML changed during the harness run');
    }
    return {
      benchmarkGenerated: await exists(FILES.benchmark),
      manifestFinalWriteScheduled: true,
      productionHtmlEdited: false,
      productionDigestUnchanged: true,
      releaseMode: criticDecision?.deploymentMode ?? 'research_only',
      humanApprovalRequired: true,
    };
  });

  const finalGateTuningPath = await preferredGateTuningPath();
  const finalGateTuningPresent = await exists(finalGateTuningPath);
  const artifactFlags = {
    residualMetrics: await exists(FILES.residualMetrics),
    clinicalMetrics: await exists(FILES.clinicalMetrics),
    gateTuning: finalGateTuningPresent,
    gateTuningFile: finalGateTuningPresent ? path.basename(finalGateTuningPath) : null,
    deploymentPolicy: await exists(FILES.deploymentPolicy),
    nestedPolicyMetrics: await exists(FILES.nestedPolicyMetrics),
  };
  stages.at(-1).aggregate.manifestFinalized = true;
  const final = {
    pipelineStatus: 'PASS',
    promotionStatus: criticDecision.promotionStatus,
    deploymentMode: criticDecision.deploymentMode,
    productionUnchanged: true,
    automatedGates: criticDecision.gates,
    blockedReasons: criticDecision.blockedReasons,
    artifacts: artifactFlags,
  };
  await writeManifest(makeManifest(options, final));
  process.stdout.write(`\n${JSON.stringify({
    pipelineStatus: final.pipelineStatus,
    promotionStatus: final.promotionStatus,
    deploymentMode: final.deploymentMode,
    humanApprovalRequired: true,
    productionPromotionAllowed: false,
    productionHtmlEdited: false,
    manifest: 'harness-run.json',
  }, null, 2)}\n`);
}

let optionsForFailure = null;
try {
  optionsForFailure = parseArgs(process.argv.slice(2));
  if (optionsForFailure.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    await main();
  }
} catch (error) {
  let productionUnchanged = false;
  if (productionPath && productionDigestBefore) {
    try {
      productionUnchanged = (await sha256File(productionPath)) === productionDigestBefore;
    } catch {
      productionUnchanged = false;
    }
  }
  const safeFailureCode = activeStage
    ? `STAGE_${activeStage.id}_${activeStage.name.toUpperCase()}_FAILED`
    : 'HARNESS_INITIALIZATION_FAILED';
  const fallbackOptions = optionsForFailure ?? {
    round: 1,
    refreshBaseline: false,
    skipTraining: false,
  };
  try {
    await writeManifest(makeManifest(fallbackOptions, {
      pipelineStatus: 'FAILED',
      promotionStatus: 'BLOCKED',
      deploymentMode: 'research_only',
      productionUnchanged,
      automatedGates: null,
      blockedReasons: ['fail_fast_pipeline_error'],
      artifacts: {},
      fatalFailure: { code: safeFailureCode },
    }));
  } catch (manifestError) {
    process.stderr.write(`Could not write safe failure manifest: ${manifestError.message}\n`);
  }
  process.stderr.write(`HARNESS_FAILED: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
