#!/usr/bin/env node

/**
 * Generate a PHI-free, static Batch Benchmark report.
 *
 * Inputs are intentionally reduced to aggregate statistics before rendering.
 * No case identifiers, image names, hashes, coordinates, or source paths are
 * copied into the output HTML.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    dataset: path.join(HERE, 'dataset-index.json'),
    baseline: path.join(HERE, 'baseline_predictions_all.json'),
    baselineMetrics: path.join(HERE, 'baseline_metrics.json'),
    residualMetrics: path.join(HERE, 'residual-metrics.json'),
    deploymentPolicy: path.join(HERE, 'residual-deployment-policy.json'),
    nestedMetrics: path.join(HERE, 'nested-policy-metrics.json'),
    output: path.join(HERE, 'benchmark.html'),
  };

  const aliases = {
    '--dataset': 'dataset',
    '--baseline': 'baseline',
    '--baseline-metrics': 'baselineMetrics',
    '--residual-metrics': 'residualMetrics',
    '--deployment-policy': 'deploymentPolicy',
    '--nested-metrics': 'nestedMetrics',
    '--output': 'output',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }
    const key = aliases[token];
    if (!key) throw new Error(`알 수 없는 옵션: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} 뒤에 파일 경로가 필요합니다.`);
    options[key] = path.resolve(value);
    index += 1;
  }
  return options;
}

function usage() {
  return [
    '사용법: node generate_benchmark_report.mjs [options]',
    '',
    '  --dataset <file>           dataset-index.json',
    '  --baseline <file>          baseline_predictions_all.json',
    '  --baseline-metrics <file>  baseline_metrics.json (선택)',
    '  --residual-metrics <file>  residual-metrics.json (선택)',
    '  --deployment-policy <file> residual-deployment-policy.json (선택)',
    '  --nested-metrics <file>    nested-policy-metrics.json (최종 판정)',
    '  --output <file>            benchmark.html',
    '',
    '입력이 없거나 읽을 수 없어도 보고서는 생성되며 해당 영역은 “평가 대기”로 표시됩니다.',
  ].join('\n');
}

function readJsonOptional(filePath, label, notices) {
  if (!filePath || !fs.existsSync(filePath)) {
    notices.push(`${label} 파일 없음 — 평가 대기`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    notices.push(`${label} 파싱 실패 — 평가 대기 (${error.message})`);
    return null;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function finite(values) {
  return values.filter(isFiniteNumber);
}

function mean(values) {
  const numbers = finite(values);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function percentile(values, probability) {
  const numbers = finite(values).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const position = (numbers.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return numbers[lower];
  const ratio = position - lower;
  return numbers[lower] * (1 - ratio) + numbers[upper] * ratio;
}

function sum(values) {
  return finite(values).reduce((total, value) => total + value, 0);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtNumber(value, digits = 0) {
  if (!isFiniteNumber(value)) return '평가 대기';
  return new Intl.NumberFormat('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function fmtPercent(value, digits = 1) {
  if (!isFiniteNumber(value)) return '평가 대기';
  return `${fmtNumber(value * 100, digits)}%`;
}

function fmtMs(value) {
  return isFiniteNumber(value) ? `${fmtNumber(value, value >= 100 ? 0 : 1)} ms` : '평가 대기';
}

function fmtDate(iso) {
  if (!iso) return '기록 없음';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '기록 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function annotationCount(annotation, key) {
  const direct = annotation?.labelCounts?.[key];
  if (isFiniteNumber(direct)) return direct;
  const rawKey = key === 'toothWidths' ? 'toothWidthsPx' : key === 'ezPoints' ? 'ezPointsPx' : key;
  return Array.isArray(annotation?.raw?.[rawKey]) ? annotation.raw[rawKey].length : 0;
}

function summarizeDataset(dataset) {
  if (!dataset || !Array.isArray(dataset.cases)) return null;
  const cases = dataset.cases;
  let withWidth = 0;
  let widthComplete = 0;
  let widthPartial = 0;
  let withEz = 0;
  let ezExactly12 = 0;
  let ezResampleNeeded = 0;
  let both = 0;
  let widthOnly = 0;
  let ezOnly = 0;
  let neither = 0;
  let conflictCases = 0;
  let qualityFlagCases = 0;

  for (const item of cases) {
    const widths = Array.isArray(item?.expert?.widthAnnotations) ? item.expert.widthAnnotations : [];
    const ez = Array.isArray(item?.expert?.ezAnnotations) ? item.expert.ezAnnotations : [];
    const hasWidth = widths.length > 0;
    const hasEz = ez.length > 0;
    if (hasWidth) withWidth += 1;
    if (hasEz) withEz += 1;
    if (widths.some((annotation) => annotation?.completeness?.toothWidths12 === true || annotationCount(annotation, 'toothWidths') === 12)) {
      widthComplete += 1;
    } else if (hasWidth) {
      widthPartial += 1;
    }
    if (ez.some((annotation) => annotation?.completeness?.ezPoints12 === true || annotationCount(annotation, 'ezPoints') === 12)) {
      ezExactly12 += 1;
    } else if (hasEz) {
      ezResampleNeeded += 1;
    }
    if (hasWidth && hasEz) both += 1;
    else if (hasWidth) widthOnly += 1;
    else if (hasEz) ezOnly += 1;
    else neither += 1;
    if ((item?.matching?.evidence?.unresolvedConflictCount ?? 0) > 0) conflictCases += 1;
    if (Array.isArray(item?.qualityFlags) && item.qualityFlags.length) qualityFlagCases += 1;
  }

  const summary = dataset.summary ?? {};
  return {
    total: cases.length,
    rootBacked: summary.rootBackedCases ?? cases.filter((item) => item?.sourceKind === 'root_backed').length,
    embeddedOnly: summary.ezEmbeddedOnlyCases ?? cases.filter((item) => item?.sourceKind === 'ez_embedded_only').length,
    widthSources: summary.sourceWidthAnnotationFiles,
    ezSources: summary.sourceEzAnnotationFiles,
    annotationRecords: summary.canonicalAnnotationRecords,
    duplicateRows: summary.duplicateImageRowsGroupedIntoCanonicalCases,
    withWidth,
    widthComplete,
    widthPartial,
    withEz,
    ezExactly12,
    ezResampleNeeded,
    both,
    widthOnly,
    ezOnly,
    neither,
    conflictCases,
    qualityFlagCases,
    generatedAt: dataset.generatedAt,
    privacySafe: dataset?.privacy?.phiFieldsEmitted === false && dataset?.privacy?.imageNamesEmitted === false,
  };
}

function summarizeBaseline(baseline) {
  if (!baseline || !Array.isArray(baseline.results)) return null;
  const results = baseline.results;
  const successful = results.filter((item) => item?.status === 'ok' && item?.prediction);
  const runtimes = successful.map((item) => item.runtimeMs);
  const confidence = successful.map((item) => item?.prediction?.analysisMeta?.confidence?.overall);
  const widthConfidence = successful.map((item) => item?.prediction?.analysisMeta?.confidence?.widthQuality);
  const warningCounts = successful.map((item) => Array.isArray(item?.prediction?.analysisMeta?.warnings) ? item.prediction.analysisMeta.warnings.length : 0);
  const engines = new Set(successful.map((item) => item?.prediction?.analysisMeta?.engineVersion).filter(Boolean));
  return {
    total: baseline.caseCount ?? results.length,
    success: baseline.successCount ?? successful.length,
    errors: baseline.errorCount ?? results.length - successful.length,
    successRate: results.length ? successful.length / results.length : null,
    runtimeMean: mean(runtimes),
    runtimeMedian: percentile(runtimes, 0.5),
    runtimeP95: percentile(runtimes, 0.95),
    confidenceMean: mean(confidence),
    confidenceMedian: percentile(confidence, 0.5),
    confidenceP10: percentile(confidence, 0.1),
    widthConfidenceMean: mean(widthConfidence),
    warningCaseCount: warningCounts.filter((count) => count > 0).length,
    warningTotal: sum(warningCounts),
    engineVersion: engines.size === 1 ? [...engines][0] : engines.size > 1 ? '복수 버전' : '기록 없음',
    createdAt: baseline.createdAt,
  };
}

function normalizeMetric(metric) {
  if (!metric || typeof metric !== 'object') return null;
  return {
    mae: metric.mae,
    rmse: metric.rmse,
    coordinateMAE: metric.coordinateMAE ?? metric.coordinateMae ?? metric.coordinate_mae,
    p95: metric.p95,
    pck2: metric.pck?.['2pct'] ?? metric.pck2,
    pck5: metric.pck?.['5pct'] ?? metric.pck5,
    pck10: metric.pck?.['10pct'] ?? metric.pck10,
    landmarkCount: metric.landmarkCount ?? metric.landmarks,
  };
}

function baselineTaskFromOptionalMetrics(metrics, taskName) {
  if (!metrics || typeof metrics !== 'object') return null;
  const candidate = metrics?.tasks?.[taskName]?.overall
    ?? metrics?.tasks?.[taskName]?.baseline
    ?? metrics?.[taskName]?.overall
    ?? metrics?.[taskName]?.baseline
    ?? metrics?.[taskName];
  return normalizeMetric(candidate);
}

function summarizeResidual(residual, baselineMetrics) {
  const taskNames = ['width', 'ez'];
  const labels = { width: '치아 폭', ez: 'EZ 곡선' };
  const tasks = [];

  for (const name of taskNames) {
    const task = residual?.tasks?.[name];
    const overall = task?.overallOutOfFold;
    const baseline = normalizeMetric(overall?.baseline) ?? baselineTaskFromOptionalMetrics(baselineMetrics, name);
    const corrected = normalizeMetric(overall?.corrected);
    const folds = Array.isArray(task?.folds) ? task.folds.map((fold) => ({
      fold: fold.fold,
      trainSamples: fold.trainSamples,
      testSamples: fold.testSamples,
      baseline: normalizeMetric(fold.baseline),
      corrected: normalizeMetric(fold.corrected),
      improvement: fold.coordinateMaeRelativeImprovement,
      acceptedRate: fold?.distanceGate?.acceptedRate,
    })) : [];
    const gate = task?.promotionGate ?? null;
    if (task || baseline) {
      tasks.push({
        name,
        label: labels[name],
        samples: task?.samples ?? residual?.inputSummary?.taskSamples?.[name],
        groups: task?.groups ?? residual?.inputSummary?.taskGroups?.[name],
        baseline,
        corrected,
        improvement: overall?.coordinateMaeRelativeImprovement,
        p95Regression: overall?.p95Regression,
        folds,
        gate,
      });
    }
  }

  return {
    available: tasks.length > 0,
    foldCount: residual?.foldCount,
    tasks,
    overallGate: residual?.promotionGate ?? null,
    labelQuality: residual?.labelQuality ?? null,
  };
}

function summarizeDeploymentPolicy(policy) {
  if (!policy || typeof policy !== 'object') return null;
  const coordinate = policy?.validation?.coordinate ?? {};
  return {
    status: policy.status,
    posthocPass: policy?.validation?.gates?.pass === true,
    widthImprovement: coordinate?.width?.coordinateMaeRelativeImprovement,
    ezImprovement: coordinate?.ez?.coordinateMaeRelativeImprovement,
    widthFolds: coordinate?.width?.improvedFolds,
    ezFolds: coordinate?.ez?.improvedFolds,
    foldCount: coordinate?.width?.foldCount ?? coordinate?.ez?.foldCount ?? policy?.validation?.folds,
    pairedCases: policy?.validation?.pairedCompleteCases,
    productionHtmlModified: policy?.deployment?.productionHtmlModified,
    promotionAllowed: policy?.deployment?.productionPromotionAllowed,
    recommendedMode: policy?.deployment?.recommendedMode,
    selectionBiasWarning: policy?.deployment?.reason,
  };
}

function summarizeNestedPolicy(nested) {
  if (!nested || typeof nested !== 'object') return null;
  const aggregate = nested.aggregateOuterTest ?? {};
  const coordinate = aggregate.coordinate ?? {};
  const clinical = aggregate?.pairedClinical ?? {};
  const appScale = clinical?.appScale ?? {};
  const referenceScale = clinical?.referenceScale ?? {};
  const gate = nested.promotionGate ?? null;
  const outerFolds = Array.isArray(nested.outerFoldReports) ? nested.outerFoldReports.map((report) => ({
    fold: report.fold,
    mode: report?.innerSelection?.mode,
    strictCandidates: report?.innerSelection?.strictPassingCandidateCount,
    widthImprovement: report?.tasks?.width?.outerTestCoordinateMaeRelativeImprovement,
    ezImprovement: report?.tasks?.ez?.outerTestCoordinateMaeRelativeImprovement,
    pairedCases: report?.pairedOuterTestCases,
  })) : [];
  return {
    pass: gate?.pass === true,
    decision: gate?.decision,
    productionHtmlModified: gate?.productionHtmlModified,
    humanApprovalRequiredEvenIfPass: gate?.humanApprovalRequiredEvenIfPass,
    width: {
      improvement: coordinate?.width?.coordinateMaeRelativeImprovement,
      improvedFolds: coordinate?.width?.improvedFolds,
      foldCount: coordinate?.width?.foldCount,
      p95Regression: coordinate?.width?.p95Regression,
      pass: coordinate?.width?.pass,
    },
    ez: {
      improvement: coordinate?.ez?.coordinateMaeRelativeImprovement,
      improvedFolds: coordinate?.ez?.improvedFolds,
      foldCount: coordinate?.ez?.foldCount,
      p95Regression: coordinate?.ez?.p95Regression,
      pass: coordinate?.ez?.pass,
    },
    appScale: {
      ezl: appScale?.ezlMm ?? null,
      tzl: appScale?.tzlMm ?? null,
      difference: appScale?.differenceMm ?? null,
    },
    referenceScale: {
      ezl: referenceScale?.ezlMm ?? null,
      tzl: referenceScale?.tzlMm ?? null,
      difference: referenceScale?.differenceMm ?? null,
    },
    pairedCases: aggregate?.pairedCompleteCases,
    strictSelectedFolds: gate?.details?.strictInnerPolicySelectedFolds,
    strictRequiredFolds: gate?.details?.requiredStrictInnerPolicySelectedFolds,
    outerFolds,
    checks: gate?.checks ?? {},
    auditRisk: nested?.auditFinding?.priorProtocolRisk,
    auditBias: nested?.auditFinding?.bias,
    protocol: nested?.protocol?.outerValidation,
    limitations: Array.isArray(nested.limitations) ? nested.limitations : [],
  };
}

function statusBadge(status, label) {
  const normalized = ['pass', 'wait', 'warn', 'fail'].includes(status) ? status : 'wait';
  return `<span class="badge ${normalized}"><span class="dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function card(title, value, detail, status = '') {
  return `<article class="metric-card ${status}">
    <div class="metric-title">${escapeHtml(title)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
    <div class="metric-detail">${escapeHtml(detail)}</div>
  </article>`;
}

function progress(label, value, detail, tone = 'blue') {
  const pct = isFiniteNumber(value) ? clamp(value * 100, 0, 100) : 0;
  return `<div class="progress-row">
    <div class="progress-label"><span>${escapeHtml(label)}</span><strong>${escapeHtml(isFiniteNumber(value) ? fmtPercent(value) : '평가 대기')}</strong></div>
    <div class="track" role="img" aria-label="${escapeHtml(label)} ${escapeHtml(isFiniteNumber(value) ? fmtPercent(value) : '평가 대기')}"><span class="fill ${tone}" style="width:${pct.toFixed(2)}%"></span></div>
    <div class="progress-detail">${escapeHtml(detail)}</div>
  </div>`;
}

function metricBars(task) {
  const baseline = task.baseline;
  const corrected = task.corrected;
  if (!baseline || !isFiniteNumber(baseline.coordinateMAE)) {
    return `<div class="empty">기준 오차 평가 대기</div>`;
  }
  const rows = [
    ['좌표 MAE', baseline.coordinateMAE, corrected?.coordinateMAE],
    ['2D MAE', baseline.mae, corrected?.mae],
    ['P95', baseline.p95, corrected?.p95],
  ].filter((row) => isFiniteNumber(row[1]));
  const maxValue = Math.max(...rows.flatMap((row) => [row[1], row[2]]).filter(isFiniteNumber), 0.001);
  const width = 720;
  const labelWidth = 112;
  const chartWidth = 460;
  const rowHeight = 58;
  const height = 42 + rows.length * rowHeight;
  const parts = [`<svg class="bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(task.label)} 기준 엔진과 보정 모델 오차 비교">`];
  parts.push('<g class="legend"><rect x="474" y="10" width="12" height="12" rx="3" class="baseline-bar"/><text x="492" y="21">기준 엔진</text><rect x="572" y="10" width="12" height="12" rx="3" class="corrected-bar"/><text x="590" y="21">보정 모델</text></g>');
  rows.forEach(([label, base, correctedValue], index) => {
    const y = 42 + index * rowHeight;
    const baseWidth = Math.max(2, (base / maxValue) * chartWidth);
    const correctedWidth = isFiniteNumber(correctedValue) ? Math.max(2, (correctedValue / maxValue) * chartWidth) : 0;
    parts.push(`<text x="0" y="${y + 20}" class="axis-label">${escapeHtml(label)}</text>`);
    parts.push(`<rect x="${labelWidth}" y="${y}" width="${baseWidth.toFixed(2)}" height="16" rx="4" class="baseline-bar"/>`);
    parts.push(`<text x="${Math.min(labelWidth + baseWidth + 8, width - 58).toFixed(2)}" y="${y + 13}" class="bar-value">${escapeHtml(fmtPercent(base, 2))}</text>`);
    if (correctedWidth) {
      parts.push(`<rect x="${labelWidth}" y="${y + 22}" width="${correctedWidth.toFixed(2)}" height="16" rx="4" class="corrected-bar"/>`);
      parts.push(`<text x="${Math.min(labelWidth + correctedWidth + 8, width - 58).toFixed(2)}" y="${y + 35}" class="bar-value">${escapeHtml(fmtPercent(correctedValue, 2))}</text>`);
    }
  });
  parts.push('</svg>');
  return parts.join('');
}

function foldTable(task) {
  if (!task.folds.length) return `<div class="empty">fold별 평가 대기</div>`;
  const rows = task.folds.map((fold) => {
    const improved = isFiniteNumber(fold.improvement) && fold.improvement > 0;
    return `<tr>
      <td>${escapeHtml(fold.fold ?? '—')}</td>
      <td>${escapeHtml(fmtNumber(fold.testSamples))}</td>
      <td>${escapeHtml(fmtPercent(fold.baseline?.coordinateMAE, 2))}</td>
      <td>${escapeHtml(fmtPercent(fold.corrected?.coordinateMAE, 2))}</td>
      <td class="${improved ? 'positive' : 'negative'}">${escapeHtml(fmtPercent(fold.improvement, 1))}</td>
      <td>${escapeHtml(fmtPercent(fold.acceptedRate, 1))}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Fold</th><th>시험 건수</th><th>기준 좌표 MAE</th><th>보정 좌표 MAE</th><th>상대 개선</th><th>보정 적용률</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function gateList(task) {
  const gate = task.gate;
  if (!gate) return `<div class="empty">승격 기준 평가 대기</div>`;
  const checkLabels = {
    coordinateMaeRelativeImprovementAtLeast10Pct: '좌표 MAE 상대 개선 10% 이상',
    atLeast4Of5FoldsImproved: '5개 fold 중 4개 이상 개선',
    p95DidNotRegress: 'P95 오차 비퇴행',
    correctionCapIs5PctDiagonal: '보정량 이미지 대각선 5% 제한',
    unfamiliarFallbackEnabled: '낯선 증례 기준 엔진 복귀',
  };
  const items = Object.entries(gate.checks ?? {}).map(([key, passed]) => `<li>
    <span class="check ${passed ? 'yes' : 'no'}" aria-hidden="true">${passed ? '✓' : '!'}</span>
    <span>${escapeHtml(checkLabels[key] ?? key)}</span>
  </li>`).join('');
  return `<ul class="gate-list">${items || '<li>세부 기준 기록 없음</li>'}</ul>`;
}

function renderTask(task) {
  const gatePass = task.gate?.pass === true;
  const gateStatus = task.gate ? (gatePass ? statusBadge('pass', '수치 기준 통과') : statusBadge('fail', '수치 기준 미통과')) : statusBadge('wait', '평가 대기');
  const improvement = task.improvement;
  return `<article class="task-panel">
    <div class="task-head">
      <div><div class="eyebrow">OUT-OF-FOLD · ${escapeHtml(task.samples ?? '—')}건</div><h3>${escapeHtml(task.label)}</h3></div>
      ${gateStatus}
    </div>
    <div class="task-summary">
      ${card('기준 좌표 MAE', fmtPercent(task.baseline?.coordinateMAE, 2), '정규화 이미지 대각선 대비')}
      ${card('보정 좌표 MAE', fmtPercent(task.corrected?.coordinateMAE, 2), '정규화 이미지 대각선 대비', 'accent')}
      ${card('상대 개선', fmtPercent(improvement, 1), isFiniteNumber(task.p95Regression) && task.p95Regression <= 0 ? 'P95 오차도 감소' : 'P95 확인 필요', improvement > 0 ? 'good' : 'warn')}
    </div>
    ${metricBars(task)}
    <h4>Fold별 검증</h4>
    ${foldTable(task)}
    <h4>자동 승격 차단 게이트</h4>
    ${gateList(task)}
  </article>`;
}

function nestedClinicalTable(nested) {
  if (!nested) return '<div class="empty">Nested 임상 지표 평가 대기</div>';
  const labels = { ezl: 'EZL', tzl: 'TZL', difference: 'EZL−TZL 차이' };
  const rows = Object.entries(nested.appScale).map(([key, metric]) => {
    const maePass = metric?.maeDidNotRegress === true;
    const p95Pass = metric?.p95DidNotRegress === true;
    return `<tr>
      <td>${escapeHtml(labels[key] ?? key)}</td>
      <td>${escapeHtml(fmtNumber(metric?.baselineMaeMm, 2))} mm</td>
      <td>${escapeHtml(fmtNumber(metric?.candidateMaeMm, 2))} mm</td>
      <td class="${maePass ? 'positive' : 'negative'}">${escapeHtml(fmtPercent(metric?.maeRelativeImprovement, 2))}</td>
      <td>${escapeHtml(fmtNumber(metric?.baselineP95AbsoluteErrorMm, 2))} mm</td>
      <td>${escapeHtml(fmtNumber(metric?.candidateP95AbsoluteErrorMm, 2))} mm</td>
      <td class="${p95Pass ? 'positive' : 'negative'}">${escapeHtml(isFiniteNumber(metric?.p95RegressionMm) ? `${metric.p95RegressionMm > 0 ? '+' : ''}${fmtNumber(metric.p95RegressionMm, 2)} mm` : '평가 대기')}</td>
      <td>${maePass && p95Pass ? statusBadge('pass', '비퇴행') : statusBadge('fail', '실패')}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>앱 스케일</th><th>기준 MAE</th><th>후보 MAE</th><th>MAE 개선</th><th>기준 P95</th><th>후보 P95</th><th>P95 변화</th><th>판정</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function nestedFoldTable(nested) {
  if (!nested?.outerFolds?.length) return '<div class="empty">Nested fold 평가 대기</div>';
  const modeLabel = {
    strict_inner_candidate: 'Strict 후보 선택',
    baseline_only_safety_fallback: '안전 복귀',
  };
  const rows = nested.outerFolds.map((fold) => {
    const strict = fold.mode === 'strict_inner_candidate';
    return `<tr>
      <td>${escapeHtml(fold.fold ?? '—')}</td>
      <td>${strict ? statusBadge('pass', modeLabel[fold.mode]) : statusBadge('warn', modeLabel[fold.mode] ?? '기준 엔진 복귀')}</td>
      <td>${escapeHtml(fmtNumber(fold.strictCandidates))}</td>
      <td class="${(fold.widthImprovement ?? 0) > 0 ? 'positive' : ''}">${escapeHtml(fmtPercent(fold.widthImprovement, 2))}</td>
      <td class="${(fold.ezImprovement ?? 0) > 0 ? 'positive' : ''}">${escapeHtml(fmtPercent(fold.ezImprovement, 2))}</td>
      <td>${escapeHtml(fmtNumber(fold.pairedCases))}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Outer fold</th><th>내부 정책 선택</th><th>Strict 후보 수</th><th>폭 개선</th><th>EZ 개선</th><th>짝지은 시험 증례</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function validationHierarchy(policy, nested, residual) {
  const posthocStatus = policy
    ? (policy.posthocPass ? statusBadge('pass', 'PASS · 후보 탐색 결과') : statusBadge('fail', 'FAIL'))
    : statusBadge('wait', '평가 대기');
  const nestedStatus = nested
    ? (nested.pass ? statusBadge('pass', 'PASS · 권위 판정') : statusBadge('fail', 'FAIL · 권위 판정'))
    : statusBadge('wait', 'Nested 평가 대기');
  const residualStatus = residual?.overallGate
    ? (residual.overallGate.pass ? statusBadge('pass', 'PASS · 좌표만') : statusBadge('fail', 'FAIL'))
    : statusBadge('wait', '평가 대기');
  return `<div class="validation-ladder">
    <article><div class="ladder-index">A</div><div><h3>Residual v1 단순 좌표 검증</h3><p>폭·EZ 좌표의 OOF 개선만 확인한 예비 단계입니다. 임상 길이와 정책 선택 편향을 검증하지 않아 최종 PASS로 사용할 수 없습니다.</p></div>${residualStatus}</article>
    <article><div class="ladder-index">B</div><div><h3>Post-hoc fine-tuned 후보</h3><p>전체 OOF 결과에서 blend·거리 게이트를 선택하고 같은 결과로 평가한 후보 PASS입니다. 선택 후 성능이 낙관적으로 보일 수 있습니다.</p></div>${posthocStatus}</article>
    <article class="authoritative"><div class="ladder-index">C</div><div><h3>Nested outer-fold 검증</h3><p>각 outer 시험 fold를 정책 선택에서 완전히 제외한 최종 권위 평가입니다. 운영 승격 판단은 이 결과만 따릅니다.</p></div>${nestedStatus}</article>
  </div>`;
}

function renderHtml({ dataset, baseline, residual, policy, nested, notices, generatedAt }) {
  const anyData = Boolean(dataset || baseline || residual.available || policy || nested);
  const overallPass = nested?.pass === true;
  // Nested outer-fold validation is authoritative. Preliminary coordinate or
  // post-hoc policy gates must never override this top-level status.
  const overallStatus = nested
    ? (overallPass
      ? statusBadge('warn', 'Nested 통과 · 사람 승인 전 운영 보류')
      : statusBadge('fail', '운영 승격 보류 · 연구 전용'))
    : statusBadge('wait', '운영 승격 보류 · Nested 평가 대기');

  const datasetCards = dataset ? [
    card('정규화 증례', fmtNumber(dataset.total), `원본 기반 ${fmtNumber(dataset.rootBacked)} · 내장 이미지 전용 ${fmtNumber(dataset.embeddedOnly)}`),
    card('치아 폭 정답', fmtNumber(dataset.withWidth), `12치 완전 ${fmtNumber(dataset.widthComplete)} · 부분 ${fmtNumber(dataset.widthPartial)}`, dataset.widthPartial ? 'warn' : 'good'),
    card('EZ 곡선 정답', fmtNumber(dataset.withEz), `정확히 12점 ${fmtNumber(dataset.ezExactly12)} · 재표본화 ${fmtNumber(dataset.ezResampleNeeded)}`),
    card('두 정답 동시 보유', fmtNumber(dataset.both), `폭만 ${fmtNumber(dataset.widthOnly)} · EZ만 ${fmtNumber(dataset.ezOnly)} · 없음 ${fmtNumber(dataset.neither)}`),
  ].join('') : card('데이터셋', '평가 대기', 'dataset-index.json을 찾지 못했거나 읽지 못했습니다.', 'wait');

  const baselineCards = baseline ? [
    card('실행 성공', `${fmtNumber(baseline.success)} / ${fmtNumber(baseline.total)}`, `성공률 ${fmtPercent(baseline.successRate)}`, baseline.errors ? 'warn' : 'good'),
    card('평균 처리 시간', fmtMs(baseline.runtimeMean), `중앙 ${fmtMs(baseline.runtimeMedian)} · P95 ${fmtMs(baseline.runtimeP95)}`),
    card('평균 신뢰도', fmtPercent(baseline.confidenceMean), `P10 ${fmtPercent(baseline.confidenceP10)} · 폭 품질 ${fmtPercent(baseline.widthConfidenceMean)}`),
    card('경고 발생 증례', fmtNumber(baseline.warningCaseCount), `총 경고 ${fmtNumber(baseline.warningTotal)} · 실패 ${fmtNumber(baseline.errors)}`, baseline.warningCaseCount ? 'warn' : 'good'),
  ].join('') : card('기준 엔진', '평가 대기', 'baseline_predictions_all.json을 찾지 못했거나 읽지 못했습니다.', 'wait');

  const datasetProgress = dataset ? [
    progress('치아 폭 라벨 보유율', dataset.withWidth / dataset.total, `${fmtNumber(dataset.withWidth)} / ${fmtNumber(dataset.total)} 증례`, 'teal'),
    progress('완전한 12치 폭 라벨', dataset.widthComplete / Math.max(dataset.withWidth, 1), `${fmtNumber(dataset.widthComplete)} / ${fmtNumber(dataset.withWidth)} 폭 라벨 증례`, 'teal'),
    progress('EZ 라벨 보유율', dataset.withEz / dataset.total, `${fmtNumber(dataset.withEz)} / ${fmtNumber(dataset.total)} 증례`, 'violet'),
    progress('폭·EZ 동시 라벨', dataset.both / dataset.total, `${fmtNumber(dataset.both)} / ${fmtNumber(dataset.total)} 증례`, 'violet'),
  ].join('') : '<div class="empty">라벨 완전성 평가 대기</div>';

  const noticesHtml = notices.length
    ? `<div class="notice-list"><strong>입력 상태</strong><ul>${notices.map((notice) => `<li>${escapeHtml(notice)}</li>`).join('')}</ul></div>`
    : '';

  const taskPanels = residual.tasks.length
    ? residual.tasks.map(renderTask).join('')
    : `<article class="task-panel"><div class="empty large">학습/교차검증 지표가 아직 없습니다. residual-metrics.json 생성 후 다시 실행하세요.</div></article>`;

  const policyCards = policy ? [
    card('Post-hoc 후보 판정', policy.posthocPass ? 'PASS' : 'FAIL', '후보 선택과 평가에 같은 전체 OOF 결과 사용', policy.posthocPass ? 'warn' : 'wait'),
    card('Post-hoc 폭 개선', fmtPercent(policy.widthImprovement, 2), `${fmtNumber(policy.widthFolds)} / ${fmtNumber(policy.foldCount)} fold 개선`),
    card('Post-hoc EZ 개선', fmtPercent(policy.ezImprovement, 2), `${fmtNumber(policy.ezFolds)} / ${fmtNumber(policy.foldCount)} fold 개선`),
    card('당시 운영 허용', policy.promotionAllowed ? '허용' : '금지', policy.productionHtmlModified === false ? '운영 HTML 미수정' : 'HTML 상태 확인 필요', policy.promotionAllowed ? 'warn' : 'good'),
  ].join('') : card('Post-hoc 정책', '평가 대기', 'residual-deployment-policy.json이 없습니다.', 'wait');

  const nestedCards = nested ? [
    card('Nested 폭 좌표 개선', fmtPercent(nested.width.improvement, 2), `${fmtNumber(nested.width.improvedFolds)} / ${fmtNumber(nested.width.foldCount)} fold 개선 · 10% 기준 미달`, nested.width.pass ? 'good' : 'warn'),
    card('Nested EZ 좌표 개선', fmtPercent(nested.ez.improvement, 2), `${fmtNumber(nested.ez.improvedFolds)} / ${fmtNumber(nested.ez.foldCount)} fold 개선 · strict fold 기준 미달`, nested.ez.pass ? 'good' : 'warn'),
    card('앱 스케일 TZL MAE', fmtPercent(nested.appScale.tzl?.maeRelativeImprovement, 2), `${fmtNumber(nested.appScale.tzl?.maeRegressionMm, 2)} mm 퇴행`, nested.appScale.tzl?.maeDidNotRegress ? 'good' : 'warn'),
    card('Strict 정책 선택', `${fmtNumber(nested.strictSelectedFolds)} / ${fmtNumber(nested.strictRequiredFolds)}`, '나머지 fold는 기준 엔진으로 안전 복귀', nested.strictSelectedFolds === nested.strictRequiredFolds ? 'good' : 'warn'),
  ].join('') : card('Nested 정책', '평가 대기', 'nested-policy-metrics.json이 없습니다.', 'wait');

  const privacyStatus = dataset?.privacySafe === false ? statusBadge('warn', '입력 개인정보 설정 확인') : statusBadge('pass', '집계 보고서 · PHI 비포함');
  const datasetTimestamp = dataset ? fmtDate(dataset.generatedAt) : '평가 대기';
  const baselineTimestamp = baseline ? fmtDate(baseline.createdAt) : '평가 대기';
  const decisionBanner = nested
    ? (nested.pass
      ? '<aside class="decision-banner"><h3>최종 상태: 운영 승격 보류 · 사람 승인 대기</h3><p>Nested outer-fold 정량 검증을 통과했더라도 독립 외부 검증과 치과의사의 명시적 승인이 끝나기 전에는 운영 HTML에 통합하지 않습니다.</p></aside>'
      : '<aside class="decision-banner"><h3>최종 상태: 운영 승격 보류 · 연구 전용</h3><p>Residual v1의 단순 좌표 PASS와 post-hoc fine-tuned 후보 PASS는 최종 운영 PASS가 아닙니다. 정책 선택에서 완전히 분리된 Nested outer-fold 검증이 FAIL이므로 현재 운영 HTML은 수정하지 않고 연구·오류 분석만 계속합니다.</p></aside>')
    : '<aside class="decision-banner"><h3>최종 상태: 운영 승격 보류 · 연구 전용 (Nested 평가 대기)</h3><p>Nested outer-fold 최종 판정 전에는 예비 좌표 PASS나 post-hoc 후보 PASS를 운영 승격 근거로 사용할 수 없습니다.</p></aside>';

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>EZ/TZL Batch Benchmark</title>
  <style>
    :root{--bg:#071019;--panel:#0e1a25;--panel2:#122333;--line:#263849;--text:#f3f7fb;--muted:#9eb0bf;--blue:#5eb7ff;--teal:#43d5bd;--violet:#a78bfa;--amber:#f6c453;--red:#ff7785;--green:#66dda2;--shadow:0 18px 60px rgba(0,0,0,.22)}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 18% 0%,#123149 0,transparent 35%),var(--bg);color:var(--text);font-family:Inter,"Pretendard Variable","Noto Sans KR",system-ui,-apple-system,sans-serif;line-height:1.55}
    .shell{max-width:1320px;margin:0 auto;padding:34px 24px 80px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:26px}.brand{font-size:13px;letter-spacing:.16em;text-transform:uppercase;color:var(--blue);font-weight:800}.meta{font-size:12px;color:var(--muted);text-align:right}
    .hero{background:linear-gradient(135deg,rgba(20,54,76,.94),rgba(14,27,39,.96));border:1px solid #31526b;border-radius:24px;padding:30px;box-shadow:var(--shadow);display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end}.hero h1{font-size:clamp(30px,5vw,55px);line-height:1.05;margin:8px 0 14px;letter-spacing:-.045em}.hero p{max-width:760px;color:#bfd0dd;margin:0;font-size:15px}.eyebrow{font-size:11px;letter-spacing:.14em;color:var(--blue);font-weight:800}.hero-status{display:flex;flex-direction:column;align-items:flex-end;gap:10px}.hero-status small{color:var(--muted);max-width:280px;text-align:right}
    .safety{margin:18px 0 34px;padding:17px 20px;border:1px solid #765e25;border-left:4px solid var(--amber);background:rgba(80,59,12,.2);border-radius:12px;color:#f7e5b5}.safety strong{color:#ffe395}.safety span{color:#d8c79b}
    section{margin-top:42px}.section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:16px}.section-head h2{font-size:24px;margin:0;letter-spacing:-.02em}.section-head p{margin:0;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.metric-card{background:linear-gradient(180deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:18px;min-height:135px}.metric-card.accent{border-color:#426fc0}.metric-card.good{border-color:#285e4e}.metric-card.warn{border-color:#64512a}.metric-title{color:var(--muted);font-size:12px;font-weight:700}.metric-value{font-size:27px;font-weight:830;letter-spacing:-.03em;margin:9px 0 4px}.metric-detail{font-size:12px;color:#9eb0bf}
    .two-col{display:grid;grid-template-columns:1.05fr .95fr;gap:16px}.panel,.task-panel{background:rgba(14,26,37,.92);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:var(--shadow)}.panel h3,.task-panel h3{margin:4px 0 0;font-size:22px}.panel h4,.task-panel h4{font-size:14px;margin:27px 0 10px;color:#c8d7e3}
    .progress-row+.progress-row{margin-top:18px}.progress-label{display:flex;justify-content:space-between;gap:12px;font-size:13px}.track{height:8px;border-radius:99px;background:#1d2d3a;overflow:hidden;margin:7px 0}.fill{height:100%;display:block;border-radius:inherit;background:var(--blue)}.fill.teal{background:var(--teal)}.fill.violet{background:var(--violet)}.fill.amber{background:var(--amber)}.progress-detail{font-size:11px;color:var(--muted)}
    .facts{display:grid;grid-template-columns:1fr 1fr;gap:12px}.fact{background:#0a1620;border:1px solid #203340;border-radius:12px;padding:13px}.fact span{display:block;color:var(--muted);font-size:11px}.fact strong{font-size:14px}.notice-list{margin-top:16px;padding:14px;border:1px solid #5c4d28;border-radius:10px;background:#231f14;color:#ead9a9;font-size:12px}.notice-list ul{margin:5px 0 0;padding-left:18px}
    .badge{display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:1px solid;padding:7px 11px;font-size:11px;font-weight:800;white-space:nowrap}.badge .dot{width:7px;height:7px;border-radius:50%;background:currentColor}.badge.pass{color:var(--green);border-color:#2c6852;background:#102a22}.badge.wait{color:#aebbc5;border-color:#455866;background:#15212b}.badge.warn{color:var(--amber);border-color:#6b572a;background:#282211}.badge.fail{color:var(--red);border-color:#713846;background:#2c151b}
    .task-panel+.task-panel{margin-top:18px}.task-head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px}.task-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:20px 0}.task-summary .metric-card{min-height:117px;padding:15px}.task-summary .metric-value{font-size:23px}.bar-chart{display:block;width:100%;height:auto;max-height:260px;background:#09141d;border:1px solid #1c2e3b;border-radius:13px;padding:12px}.bar-chart text{fill:#aebdca;font:12px system-ui,sans-serif}.bar-chart .axis-label{fill:#dce7ef;font-weight:700}.bar-chart .bar-value{fill:#c5d3dd;font-size:11px}.baseline-bar{fill:#55778f}.corrected-bar{fill:var(--teal)}
    .table-wrap{overflow-x:auto;border:1px solid #203440;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:660px;font-size:12px}th,td{text-align:right;padding:11px 13px;border-bottom:1px solid #1e303c}th:first-child,td:first-child{text-align:left}th{color:#9eb0bf;background:#0a1620;font-weight:700}tbody tr:last-child td{border-bottom:0}.positive{color:var(--green);font-weight:800}.negative{color:var(--red);font-weight:800}
    .gate-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;list-style:none;padding:0;margin:0}.gate-list li{display:flex;align-items:center;gap:9px;background:#0a1620;border:1px solid #20333f;border-radius:10px;padding:10px;font-size:12px}.check{width:20px;height:20px;border-radius:50%;display:inline-grid;place-items:center;font-weight:900;flex:0 0 auto}.check.yes{background:#123a2b;color:var(--green)}.check.no{background:#401c24;color:var(--red)}
    .validation-ladder{display:grid;gap:12px}.validation-ladder article{display:grid;grid-template-columns:42px minmax(0,1fr) auto;align-items:center;gap:15px;background:#0a1620;border:1px solid #263a48;border-radius:14px;padding:16px}.validation-ladder article.authoritative{border-color:#75404a;background:linear-gradient(90deg,rgba(94,31,43,.24),#0a1620)}.validation-ladder h3{font-size:15px;margin:0 0 4px}.validation-ladder p{margin:0;color:var(--muted);font-size:12px}.ladder-index{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#183247;color:var(--blue);font-weight:900}.authoritative .ladder-index{background:#4a1d27;color:#ff9dab}.decision-banner{border:1px solid #763d49;background:linear-gradient(135deg,#38141c,#19151c);border-radius:18px;padding:22px;color:#ffd9de}.decision-banner h3{margin:0 0 8px;font-size:24px}.decision-banner p{margin:0;color:#dab7bd}
    .empty{border:1px dashed #3c5060;border-radius:12px;padding:18px;text-align:center;color:var(--muted);background:#0a151e}.empty.large{padding:46px 18px}.footer{margin-top:45px;border-top:1px solid var(--line);padding-top:20px;display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:11px}.footer strong{color:#c8d5df}
    @media(max-width:980px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.two-col{grid-template-columns:1fr}.hero{grid-template-columns:1fr}.hero-status{align-items:flex-start}.hero-status small{text-align:left}}
    @media(max-width:620px){.shell{padding:22px 14px 60px}.topbar,.section-head,.footer{align-items:flex-start;flex-direction:column}.meta{text-align:left}.hero{padding:22px;border-radius:18px}.grid,.task-summary,.facts,.gate-list{grid-template-columns:1fr}.metric-card{min-height:auto}.task-head{flex-direction:column}.bar-chart{padding:4px}.safety{font-size:13px}.validation-ladder article{grid-template-columns:38px 1fr}.validation-ladder article .badge{grid-column:1/-1;justify-self:start}}
    @media print{body{background:#fff;color:#111}.shell{max-width:none;padding:10px}.hero,.panel,.task-panel,.metric-card{box-shadow:none;background:#fff;color:#111;border-color:#bbb}.hero p,.meta,.metric-detail,.section-head p,.progress-detail,.footer{color:#555}.safety{background:#fff8df;color:#222}.bar-chart{background:#fff}.bar-chart text,.bar-chart .axis-label,.bar-chart .bar-value{fill:#111}.fact,.gate-list li,th{background:#fff}.task-panel{break-inside:avoid}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="topbar">
      <div class="brand">EZ CURVE · TZ LENGTH</div>
      <div class="meta">보고서 생성 ${escapeHtml(fmtDate(generatedAt))}</div>
    </div>

    <header class="hero">
      <div>
        <div class="eyebrow">BATCH BENCHMARK · ROUND 01</div>
        <h1>자동 분석 품질<br>집계 보고서</h1>
        <p>전문가 정답과 규칙 기반 분석, 잔차 보정 모델을 증례 단위가 아닌 집계 수준에서 비교합니다. 이 보고서에는 환자 식별정보, 파일명, 이미지, 해시, 개별 좌표가 포함되지 않습니다.</p>
      </div>
      <div class="hero-status">${overallStatus}${privacyStatus}<small>${nested ? '최상위 판정은 untouched outer fold 기반 Nested 검증을 따릅니다.' : anyData ? '최종 Nested 검증 전까지 모든 결과는 연구 전용입니다.' : '입력 산출물이 준비되면 자동으로 집계됩니다.'}</small></div>
    </header>

    <aside class="safety"><strong>의료 보조 도구 경고:</strong> <span>이 결과는 진단, 발치, 치간 삭제 또는 치료 결정을 자동 확정하지 않습니다. 수치 게이트를 통과해도 치과의사의 증례별 검토와 명시적 사람 승인 전에는 운영 모델로 승격하거나 배포하지 마십시오.</span></aside>

    ${decisionBanner}

    <section aria-labelledby="data-title">
      <div class="section-head"><div><div class="eyebrow">01 · DATA CURATION</div><h2 id="data-title">데이터·매칭·라벨 완전성</h2></div><p>개인정보를 제거한 집계만 표시</p></div>
      <div class="grid">${datasetCards}</div>
      <div class="two-col" style="margin-top:16px">
        <article class="panel"><h3>라벨 커버리지</h3><div style="margin-top:20px">${datasetProgress}</div></article>
        <article class="panel"><h3>데이터 품질 상태</h3><div class="facts" style="margin-top:20px">
          <div class="fact"><span>전문가 주석 원본</span><strong>${escapeHtml(dataset ? `${fmtNumber(dataset.widthSources)} 폭 · ${fmtNumber(dataset.ezSources)} EZ` : '평가 대기')}</strong></div>
          <div class="fact"><span>정규화 주석 레코드</span><strong>${escapeHtml(dataset ? fmtNumber(dataset.annotationRecords) : '평가 대기')}</strong></div>
          <div class="fact"><span>미해결 매칭 충돌</span><strong>${escapeHtml(dataset ? fmtNumber(dataset.conflictCases) : '평가 대기')}</strong></div>
          <div class="fact"><span>중복 이미지 행 병합</span><strong>${escapeHtml(dataset ? fmtNumber(dataset.duplicateRows) : '평가 대기')}</strong></div>
          <div class="fact"><span>데이터 인덱스 생성</span><strong>${escapeHtml(datasetTimestamp)}</strong></div>
          <div class="fact"><span>개인정보 출력 설정</span><strong>${escapeHtml(dataset ? (dataset.privacySafe ? '비활성화 확인' : '확인 필요') : '평가 대기')}</strong></div>
        </div>${noticesHtml}</article>
      </div>
    </section>

    <section aria-labelledby="baseline-title">
      <div class="section-head"><div><div class="eyebrow">02 · RULE ENGINE BASELINE</div><h2 id="baseline-title">기준 엔진 실행 상태</h2></div><p>${escapeHtml(baseline ? `엔진 ${baseline.engineVersion} · ${baselineTimestamp}` : '평가 대기')}</p></div>
      <div class="grid">${baselineCards}</div>
      <div class="panel" style="margin-top:16px">
        <h3>실행 품질</h3>
        <div style="margin-top:20px">${baseline ? [
          progress('배치 실행 성공률', baseline.successRate, `${fmtNumber(baseline.success)}건 성공 · ${fmtNumber(baseline.errors)}건 실패`, baseline.errors ? 'amber' : 'teal'),
          progress('평균 전체 신뢰도', baseline.confidenceMean, `중앙 ${fmtPercent(baseline.confidenceMedian)} · 하위 10% 경계 ${fmtPercent(baseline.confidenceP10)}`, 'blue'),
          progress('평균 폭 경계 품질', baseline.widthConfidenceMean, '규칙 기반 엔진의 내부 신뢰도이며 실제 오차를 대체하지 않음', 'violet'),
        ].join('') : '<div class="empty">기준 엔진 실행 평가 대기</div>'}</div>
      </div>
    </section>

    <section aria-labelledby="model-title">
      <div class="section-head"><div><div class="eyebrow">03 · PRELIMINARY COORDINATE MODEL</div><h2 id="model-title">Residual v1 단순 좌표 검증</h2></div><p>${escapeHtml(residual.foldCount ? `${residual.foldCount}-fold OOF · 비최종 지표` : '평가 대기')}</p></div>
      <aside class="safety" style="margin-top:0"><strong>해석 주의:</strong> <span>아래 PASS는 좌표 오차만 대상으로 한 초기 residual v1 게이트입니다. 임상 길이, 정책 선택 편향, untouched outer fold를 포함하지 않으므로 최종 승격 PASS로 해석하면 안 됩니다.</span></aside>
      ${taskPanels}
    </section>

    <section aria-labelledby="hierarchy-title">
      <div class="section-head"><div><div class="eyebrow">04 · VALIDATION HIERARCHY</div><h2 id="hierarchy-title">PASS의 단계와 최종 권위</h2></div><p>Nested outer-fold 판정이 최우선</p></div>
      ${validationHierarchy(policy, nested, residual)}
      <div class="grid" style="margin-top:16px">${policyCards}</div>
    </section>

    <section aria-labelledby="nested-title">
      <div class="section-head"><div><div class="eyebrow">05 · AUTHORITATIVE NESTED VALIDATION</div><h2 id="nested-title">Untouched outer-fold 최종 검증</h2></div>${nested ? (nested.pass ? statusBadge('pass', 'PASS') : statusBadge('fail', 'FAIL · 운영 승격 금지')) : statusBadge('wait', '평가 대기')}</div>
      <div class="grid">${nestedCards}</div>
      <article class="task-panel" style="margin-top:16px">
        <div class="task-head"><div><div class="eyebrow">CLINICAL OUTPUT · APP SCALE</div><h3>길이 오차 및 P95 퇴행</h3></div>${nested?.appScale?.ezl?.p95DidNotRegress === false || nested?.appScale?.difference?.p95DidNotRegress === false ? statusBadge('fail', 'EZL / 차이 P95 퇴행') : statusBadge('wait', '평가 확인')}</div>
        <p style="color:var(--muted);font-size:13px">앱과 동일한 후보 EZ endpoint chord 스케일입니다. 음수 MAE 개선은 오차 증가를 뜻하며, 양수 P95 변화는 꼬리 오차 악화를 뜻합니다.</p>
        ${nestedClinicalTable(nested)}
        <h4>Outer fold별 정책 선택</h4>
        ${nestedFoldTable(nested)}
      </article>
      <article class="panel" style="margin-top:16px"><div class="facts">
        <div class="fact"><span>Nested 최종 판정</span><strong>${escapeHtml(nested ? (nested.pass ? 'PASS' : 'FAIL') : '평가 대기')}</strong></div>
        <div class="fact"><span>짝지은 임상 증례</span><strong>${escapeHtml(nested ? fmtNumber(nested.pairedCases) : '평가 대기')}</strong></div>
        <div class="fact"><span>Strict 정책 선택 fold</span><strong>${escapeHtml(nested ? `${fmtNumber(nested.strictSelectedFolds)} / ${fmtNumber(nested.strictRequiredFolds)}` : '평가 대기')}</strong></div>
        <div class="fact"><span>운영 HTML</span><strong>${escapeHtml(nested?.productionHtmlModified === false ? '미수정 확인' : '상태 확인 필요')}</strong></div>
      </div></article>
    </section>

    <section aria-labelledby="promotion-title">
      <div class="section-head"><div><div class="eyebrow">06 · FINAL PROMOTION CONTROL</div><h2 id="promotion-title">최종 승격 판정</h2></div>${overallStatus}</div>
      <article class="panel">
        <div class="two-col">
          <div><h3>${overallPass ? 'Nested 정량 기준 통과 · 사람 승인 대기' : nested ? '운영 승격 보류 · 연구 전용' : 'Nested 최종 평가 대기'}</h3><p style="color:var(--muted);max-width:660px">${overallPass ? 'Nested 검증을 통과해도 독립 외부 검증, 시각적 오버레이 검토와 치과의사의 명시적 승인이 필요합니다.' : nested ? '폭 좌표 개선은 10% 기준에 미달했고, EZ는 개선 fold 수가 부족했습니다. 앱 스케일 TZL MAE 및 EZL·차이 P95가 퇴행하여 운영 모델로 승격하지 않습니다.' : '정책 선택에서 분리된 Nested outer-fold 지표를 먼저 생성해야 합니다.'}</p></div>
          <div class="facts">
            <div class="fact"><span>허용 모드</span><strong>Research / offline only</strong></div>
            <div class="fact"><span>자동 운영 승격</span><strong>차단</strong></div>
            <div class="fact"><span>필수 승인자</span><strong>치과의사 / 책임자</strong></div>
            <div class="fact"><span>운영 HTML 변경</span><strong>${escapeHtml(nested?.productionHtmlModified === false ? '없음' : '확인 필요')}</strong></div>
          </div>
        </div>
      </article>
    </section>

    <footer class="footer"><div><strong>개인정보 보호:</strong> 원본 환자명, 이미지명, 경로, 해시, 개별 좌표 미포함</div><div><strong>용도:</strong> 연구·품질검증·사람 승인 지원</div></footer>
  </main>
</body>
</html>`;
}

function validateRenderedHtml(html, { nested } = {}) {
  const required = [
    '<!doctype html>',
    'EZ/TZL Batch Benchmark',
    '의료 보조 도구 경고',
    '사람 승인',
    '개별 좌표 미포함',
    '운영 승격 보류 · 연구 전용',
    'Residual v1',
    'Post-hoc fine-tuned 후보',
    'Nested outer-fold 검증',
  ];
  const forbidden = [
    { pattern: /<script[^>]+src=/i, reason: '외부 스크립트 참조' },
    { pattern: /https?:\/\//i, reason: '외부 네트워크 URL' },
    { pattern: /\b[a-f0-9]{64}\b/i, reason: '원본 해시' },
    { pattern: /\.jpe?g\b/i, reason: '원본 이미지 파일명' },
    { pattern: /["']caseId["']/i, reason: '개별 증례 식별자 필드' },
    { pattern: /["'](?:x|y)["']\s*:/i, reason: '개별 좌표 JSON' },
  ];
  for (const text of required) {
    if (!html.includes(text)) throw new Error(`보고서 필수 문구 누락: ${text}`);
  }
  if (nested) {
    const nestedRequired = [
      fmtPercent(nested.width.improvement, 2),
      fmtPercent(nested.ez.improvement, 2),
      fmtPercent(nested.appScale.tzl?.maeRelativeImprovement, 2),
      `${fmtNumber(nested.strictSelectedFolds)} / ${fmtNumber(nested.strictRequiredFolds)}`,
      '운영 HTML',
      nested.productionHtmlModified === false ? '미수정 확인' : '상태 확인 필요',
    ];
    for (const text of nestedRequired) {
      if (!html.includes(text)) throw new Error(`Nested 핵심 지표 누락: ${text}`);
    }
  }
  for (const rule of forbidden) {
    if (rule.pattern.test(html)) throw new Error(`보고서 개인정보/독립성 검증 실패: ${rule.reason}`);
  }
  // The all-pending report is intentionally shorter than a populated report,
  // but should still contain the complete static layout and safety controls.
  if (html.length < 10_000) throw new Error('보고서가 비정상적으로 짧습니다.');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const notices = [];
  const datasetJson = readJsonOptional(options.dataset, '데이터 인덱스', notices);
  const baselineJson = readJsonOptional(options.baseline, '기준 엔진 예측', notices);
  const baselineMetricsJson = readJsonOptional(options.baselineMetrics, '기준 오차 지표(선택)', notices);
  const residualMetricsJson = readJsonOptional(options.residualMetrics, '잔차 보정 지표(선택)', notices);
  const deploymentPolicyJson = readJsonOptional(options.deploymentPolicy, 'Post-hoc 배포 정책(선택)', notices);
  const nestedMetricsJson = readJsonOptional(options.nestedMetrics, 'Nested 정책 지표(최종)', notices);

  // A missing optional baseline metric file is not an error when residual metrics
  // already include baseline OOF statistics.
  if (residualMetricsJson?.tasks && !baselineMetricsJson) {
    const index = notices.findIndex((notice) => notice.startsWith('기준 오차 지표(선택) 파일 없음'));
    if (index >= 0) notices.splice(index, 1);
  }

  const dataset = summarizeDataset(datasetJson);
  const baseline = summarizeBaseline(baselineJson);
  const residual = summarizeResidual(residualMetricsJson, baselineMetricsJson);
  const policy = summarizeDeploymentPolicy(deploymentPolicyJson);
  const nested = summarizeNestedPolicy(nestedMetricsJson);
  const generatedAt = new Date().toISOString();
  const html = renderHtml({ dataset, baseline, residual, policy, nested, notices, generatedAt });

  validateRenderedHtml(html, { nested });

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, html, 'utf8');
  process.stdout.write(`Batch Benchmark 생성 완료: ${options.output}\n`);
  process.stdout.write(`집계 상태: 데이터 ${dataset ? '완료' : '대기'} · 기준 엔진 ${baseline ? '완료' : '대기'} · 모델 ${residual.available ? '완료' : '대기'} · Nested ${nested ? (nested.pass ? 'PASS' : 'FAIL') : '대기'}\n`);
  process.stdout.write('HTML 기본 검증: 통과 (외부 URL·해시·이미지명·개별 좌표 없음)\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`보고서 생성 실패: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
