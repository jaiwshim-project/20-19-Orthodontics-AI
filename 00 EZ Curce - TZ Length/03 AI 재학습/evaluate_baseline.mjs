#!/usr/bin/env node

/**
 * Quantitative audit for the rule-based TZL/EZL baseline.
 *
 * Privacy invariant: generated artifacts contain numeric measurements and the
 * canonical caseId only. They never copy source paths, filenames, image names,
 * label hashes, image hashes, or raw coordinates.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATASET = path.join(SCRIPT_DIR, 'dataset-index.json');
const DEFAULT_PREDICTIONS = path.join(SCRIPT_DIR, 'baseline_predictions_all.json');
const DEFAULT_JSON = path.join(SCRIPT_DIR, 'baseline_metrics.json');
const DEFAULT_REPORT = path.join(SCRIPT_DIR, 'BASELINE_METRICS.md');

const CURVE_DENSE_SAMPLES_PER_SEGMENT = 50;
const CURVE_COMPARE_POINTS = 200;
const CURVE_LANDMARK_POINTS = 12;
const SCALE_CHORD_MM = 54;
const EPS = 1e-12;

function parseArgs(argv) {
  const out = {
    dataset: DEFAULT_DATASET,
    predictions: DEFAULT_PREDICTIONS,
    output: DEFAULT_JSON,
    report: DEFAULT_REPORT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dataset') out.dataset = path.resolve(argv[++i]);
    else if (arg === '--predictions') out.predictions = path.resolve(argv[++i]);
    else if (arg === '--output') out.output = path.resolve(argv[++i]);
    else if (arg === '--report') out.report = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node evaluate_baseline.mjs [--dataset FILE] [--predictions FILE] [--output FILE] [--report FILE]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function point(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
  return { x: Number(value.x), y: Number(value.y) };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function curveLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
  return total;
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
      + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
      + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function generateCatmullRom(points, samplesPerSegment = CURVE_DENSE_SAMPLES_PER_SEGMENT) {
  if (points.length < 2) return [];
  if (points.length === 2) return points.slice();
  const result = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < samplesPerSegment; j += 1) {
      result.push(catmullRom(p0, p1, p2, p3, j / samplesPerSegment));
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

function resampleByArcLength(points, count) {
  if (!Array.isArray(points) || points.length === 0 || count <= 0) return [];
  if (count === 1) return [{ ...points[0] }];
  if (points.length === 1) return Array.from({ length: count }, () => ({ ...points[0] }));
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= EPS) return Array.from({ length: count }, () => ({ ...points[0] }));
  const out = [];
  let cursor = 1;
  for (let k = 0; k < count; k += 1) {
    const target = total * k / (count - 1);
    while (cursor < cumulative.length - 1 && cumulative[cursor] < target) cursor += 1;
    const lo = Math.max(0, cursor - 1);
    const hi = cursor;
    const span = cumulative[hi] - cumulative[lo];
    const t = span <= EPS ? 0 : (target - cumulative[lo]) / span;
    out.push({
      x: points[lo].x + (points[hi].x - points[lo].x) * t,
      y: points[lo].y + (points[hi].y - points[lo].y) * t,
    });
  }
  return out;
}

function buildCurve(controlPoints) {
  const valid = (controlPoints || []).map(point).filter(Boolean);
  if (valid.length < 2) return null;
  const generated = generateCatmullRom(valid);
  const dense200 = resampleByArcLength(generated, CURVE_COMPARE_POINTS);
  const landmarks12 = resampleByArcLength(dense200, CURVE_LANDMARK_POINTS);
  return {
    originalPointCount: valid.length,
    dense200,
    landmarks12,
    lengthPx: curveLength(dense200),
    chordPx: distance(dense200[0], dense200[dense200.length - 1]),
  };
}

function percentile(values, q) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];
  const position = (clean.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  const t = position - lo;
  return clean[lo] * (1 - t) + clean[hi] * t;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function summarize(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) {
    return { n: 0, min: null, mean: null, median: null, p75: null, p90: null, p95: null, max: null, sd: null, rmse: null };
  }
  const avg = mean(clean);
  const variance = clean.reduce((sum, value) => sum + (value - avg) ** 2, 0) / clean.length;
  return {
    n: clean.length,
    min: Math.min(...clean),
    mean: avg,
    median: percentile(clean, 0.5),
    p75: percentile(clean, 0.75),
    p90: percentile(clean, 0.9),
    p95: percentile(clean, 0.95),
    max: Math.max(...clean),
    sd: Math.sqrt(variance),
    rmse: Math.sqrt(clean.reduce((sum, value) => sum + value ** 2, 0) / clean.length),
  };
}

function scaleStats(stats, factor) {
  const out = {};
  for (const [key, value] of Object.entries(stats)) {
    out[key] = key === 'n' || value === null ? value : value * factor;
  }
  return out;
}

function errorStats(pxValues, normValues) {
  const normalized = summarize(normValues);
  return {
    pixels: summarize(pxValues),
    fractionOfImageDiagonal: normalized,
    percentOfImageDiagonal: scaleStats(normalized, 100),
  };
}

function axialAngleErrorDegrees(a1, a2, b1, b2) {
  let diff = Math.abs(Math.atan2(a2.y - a1.y, a2.x - a1.x) - Math.atan2(b2.y - b1.y, b2.x - b1.x));
  diff %= Math.PI;
  diff = Math.min(diff, Math.PI - diff);
  return diff * 180 / Math.PI;
}

function alignSegment(predicted, expert) {
  const direct = distance(predicted.p1, expert.p1) + distance(predicted.p2, expert.p2);
  const swapped = distance(predicted.p1, expert.p2) + distance(predicted.p2, expert.p1);
  if (swapped < direct) {
    return { p1: predicted.p2, p2: predicted.p1, swapped: true, endpointSumPx: swapped };
  }
  return { p1: predicted.p1, p2: predicted.p2, swapped: false, endpointSumPx: direct };
}

function alignCurveToReference(candidate, reference) {
  const last = candidate.length - 1;
  const refLast = reference.length - 1;
  const direct = distance(candidate[0], reference[0]) + distance(candidate[last], reference[refLast]);
  const reversed = distance(candidate[last], reference[0]) + distance(candidate[0], reference[refLast]);
  return reversed < direct ? candidate.slice().reverse() : candidate.slice();
}

function nearestDistances(from, to) {
  return from.map((p) => {
    let best = Infinity;
    for (const q of to) best = Math.min(best, distance(p, q));
    return best;
  });
}

function curveDistanceMetrics(a, b) {
  const aToB = nearestDistances(a, b);
  const bToA = nearestDistances(b, a);
  const combined = aToB.concat(bToA);
  const alignedA = alignCurveToReference(a, b);
  const pointDistances = alignedA.map((p, index) => distance(p, b[index]));
  return {
    symmetricMeanPx: (mean(aToB) + mean(bToA)) / 2,
    symmetricP95Px: percentile(combined, 0.95),
    hd95Px: Math.max(percentile(aToB, 0.95), percentile(bToA, 0.95)),
    pointwiseMeanPx: mean(pointDistances),
    pointwiseP95Px: percentile(pointDistances, 0.95),
  };
}

function buildEzConsensus(annotations) {
  const curves = (annotations || [])
    .map((annotation) => buildCurve(annotation?.raw?.ezPointsPx))
    .filter(Boolean);
  if (!curves.length) return null;
  const reference = curves[0].dense200;
  const aligned = curves.map((curve, index) => (index === 0 ? reference : alignCurveToReference(curve.dense200, reference)));
  const averaged = Array.from({ length: CURVE_COMPARE_POINTS }, (_, index) => ({
    x: mean(aligned.map((curve) => curve[index].x)),
    y: mean(aligned.map((curve) => curve[index].y)),
  }));
  const dense200 = resampleByArcLength(averaged, CURVE_COMPARE_POINTS);
  const landmarks12 = resampleByArcLength(dense200, CURVE_LANDMARK_POINTS);
  const pairwise = [];
  for (let i = 0; i < aligned.length; i += 1) {
    for (let j = i + 1; j < aligned.length; j += 1) {
      const curveMetrics = curveDistanceMetrics(aligned[i], aligned[j]);
      const a = aligned[i];
      const b = aligned[j];
      pairwise.push({
        ...curveMetrics,
        endpointMeanPx: (distance(a[0], b[0]) + distance(a[a.length - 1], b[b.length - 1])) / 2,
        curveLengthDifferencePx: Math.abs(curveLength(a) - curveLength(b)),
      });
    }
  }
  return {
    annotationCount: curves.length,
    originalPointCounts: curves.map((curve) => curve.originalPointCount),
    dense200,
    landmarks12,
    lengthPx: curveLength(dense200),
    chordPx: distance(dense200[0], dense200[dense200.length - 1]),
    pairwise,
  };
}

function buildWidthConsensus(annotations) {
  const byTooth = new Map();
  for (const annotation of annotations || []) {
    for (const rawLine of annotation?.raw?.toothWidthsPx || []) {
      const toothNo = Number(rawLine.toothNo);
      const p1 = point(rawLine.p1);
      const p2 = point(rawLine.p2);
      if (!Number.isInteger(toothNo) || toothNo < 1 || toothNo > 12 || !p1 || !p2) continue;
      if (!byTooth.has(toothNo)) byTooth.set(toothNo, []);
      byTooth.get(toothNo).push({ p1, p2 });
    }
  }
  const lines = [];
  for (const [toothNo, variants] of [...byTooth.entries()].sort((a, b) => a[0] - b[0])) {
    const reference = variants[0];
    const aligned = variants.map((variant, index) => {
      if (index === 0) return variant;
      const match = alignSegment(variant, reference);
      return { p1: match.p1, p2: match.p2 };
    });
    lines.push({
      toothNo,
      p1: { x: mean(aligned.map((line) => line.p1.x)), y: mean(aligned.map((line) => line.p1.y)) },
      p2: { x: mean(aligned.map((line) => line.p2.x)), y: mean(aligned.map((line) => line.p2.y)) },
      annotationCount: variants.length,
    });
  }
  return lines;
}

function rankWithTies(values) {
  const indexed = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = Array(values.length);
  let start = 0;
  while (start < indexed.length) {
    let end = start + 1;
    while (end < indexed.length && indexed[end].value === indexed[start].value) end += 1;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i += 1) ranks[indexed[i].index] = rank;
    start = end;
  }
  return ranks;
}

function spearman(pairs) {
  const clean = pairs.filter((pair) => Number.isFinite(pair.confidence) && Number.isFinite(pair.error));
  if (clean.length < 3) return { n: clean.length, rho: null };
  const x = rankWithTies(clean.map((pair) => pair.confidence));
  const y = rankWithTies(clean.map((pair) => pair.error));
  const mx = mean(x);
  const my = mean(y);
  let numerator = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < x.length; i += 1) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    numerator += dx * dy;
    dx2 += dx ** 2;
    dy2 += dy ** 2;
  }
  const denominator = Math.sqrt(dx2 * dy2);
  return { n: clean.length, rho: denominator <= EPS ? null : numerator / denominator };
}

function confidenceQuartiles(pairs) {
  const clean = pairs
    .filter((pair) => Number.isFinite(pair.confidence) && Number.isFinite(pair.error))
    .sort((a, b) => a.confidence - b.confidence);
  const quartiles = [];
  for (let q = 0; q < 4; q += 1) {
    const start = Math.floor(q * clean.length / 4);
    const end = Math.floor((q + 1) * clean.length / 4);
    const rows = clean.slice(start, end);
    quartiles.push({
      quartile: q + 1,
      label: q === 0 ? 'lowest_confidence' : q === 3 ? 'highest_confidence' : 'middle_confidence',
      n: rows.length,
      confidence: summarize(rows.map((row) => row.confidence)),
      errorFractionOfImageDiagonal: summarize(rows.map((row) => row.error)),
      caseIds: rows.map((row) => row.caseId),
    });
  }
  return quartiles;
}

function confidenceAudit(pairs) {
  const correlation = spearman(pairs);
  const quartiles = confidenceQuartiles(pairs);
  const low = quartiles[0]?.errorFractionOfImageDiagonal?.mean;
  const high = quartiles[3]?.errorFractionOfImageDiagonal?.mean;
  return {
    spearman: correlation,
    quartiles,
    highestToLowestConfidenceMeanErrorRatio: Number.isFinite(low) && low > EPS && Number.isFinite(high) ? high / low : null,
  };
}

function getConfidence(prediction, name) {
  return finiteNumber(prediction?.analysisMeta?.confidence?.[name]);
}

function signedAndAbsolute(values) {
  return {
    signed: summarize(values),
    absolute: summarize(values.map(Math.abs)),
  };
}

function safeRelative(numerator, denominator) {
  return Math.abs(denominator) > EPS ? numerator / denominator : null;
}

function compactNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function evaluate(dataset, predictions) {
  if (!Array.isArray(dataset?.cases)) throw new Error('dataset-index.json does not contain cases[]');
  if (!Array.isArray(predictions?.results)) throw new Error('baseline_predictions_all.json does not contain results[]');

  const predictionByCaseId = new Map();
  const duplicatePredictionCaseIds = [];
  for (const row of predictions.results) {
    if (predictionByCaseId.has(row.caseId)) duplicatePredictionCaseIds.push(row.caseId);
    predictionByCaseId.set(row.caseId, row);
  }

  const widthRows = [];
  const widthCaseRows = [];
  const ezCaseRows = [];
  const interAnnotatorRows = [];
  const clinicalRows = [];
  const unmatchedDatasetCaseIds = [];
  const invalidPredictionCaseIds = [];

  for (const caseRow of dataset.cases) {
    const caseId = String(caseRow.caseId);
    const predictionRow = predictionByCaseId.get(caseId);
    if (!predictionRow) {
      unmatchedDatasetCaseIds.push(caseId);
      continue;
    }
    if (predictionRow.status !== 'ok' || !predictionRow.prediction) {
      invalidPredictionCaseIds.push(caseId);
      continue;
    }
    const prediction = predictionRow.prediction;
    const width = Number(caseRow?.image?.widthPx || predictionRow.imageWidth);
    const height = Number(caseRow?.image?.heightPx || predictionRow.imageHeight);
    const diagonal = Math.hypot(width, height);
    if (!(diagonal > 0)) {
      invalidPredictionCaseIds.push(caseId);
      continue;
    }

    const expertWidths = buildWidthConsensus(caseRow?.expert?.widthAnnotations);
    const predictedWidths = (prediction.toothWidths || []).map((line) => ({ p1: point(line.p1), p2: point(line.p2) }));
    const currentWidthRows = [];
    for (const expertLine of expertWidths) {
      const predictedLine = predictedWidths[expertLine.toothNo - 1];
      if (!predictedLine?.p1 || !predictedLine?.p2) continue;
      const aligned = alignSegment(predictedLine, expertLine);
      const predictedCenter = midpoint(aligned.p1, aligned.p2);
      const expertCenter = midpoint(expertLine.p1, expertLine.p2);
      const predictedLengthPx = distance(aligned.p1, aligned.p2);
      const expertLengthPx = distance(expertLine.p1, expertLine.p2);
      const endpointMeanPx = aligned.endpointSumPx / 2;
      const centerErrorPx = distance(predictedCenter, expertCenter);
      const lengthAbsoluteErrorPx = Math.abs(predictedLengthPx - expertLengthPx);
      const row = {
        caseId,
        toothNo: expertLine.toothNo,
        endpointOrderSwapped: aligned.swapped,
        endpointMeanPx,
        endpointMeanNorm: endpointMeanPx / diagonal,
        centerErrorPx,
        centerErrorNorm: centerErrorPx / diagonal,
        lengthAbsoluteErrorPx,
        lengthAbsoluteErrorNorm: lengthAbsoluteErrorPx / diagonal,
        lengthRelativeAbsoluteError: safeRelative(lengthAbsoluteErrorPx, expertLengthPx),
        orientationErrorDegrees: axialAngleErrorDegrees(aligned.p1, aligned.p2, expertLine.p1, expertLine.p2),
        expertLengthPx,
        predictedLengthPx,
        overallConfidence: getConfidence(prediction, 'overall'),
        widthQuality: getConfidence(prediction, 'widthQuality'),
        toothWidthConfidence: finiteNumber(prediction?.analysisMeta?.confidence?.widths?.[expertLine.toothNo - 1]),
      };
      widthRows.push(row);
      currentWidthRows.push(row);
    }
    if (currentWidthRows.length) {
      widthCaseRows.push({
        caseId,
        annotatedToothCount: currentWidthRows.length,
        complete12: currentWidthRows.length === 12 && new Set(currentWidthRows.map((row) => row.toothNo)).size === 12,
        endpointMeanNorm: mean(currentWidthRows.map((row) => row.endpointMeanNorm)),
        centerErrorMeanNorm: mean(currentWidthRows.map((row) => row.centerErrorNorm)),
        lengthErrorMeanNorm: mean(currentWidthRows.map((row) => row.lengthAbsoluteErrorNorm)),
        orientationErrorMeanDegrees: mean(currentWidthRows.map((row) => row.orientationErrorDegrees)),
        swappedLineCount: currentWidthRows.filter((row) => row.endpointOrderSwapped).length,
        overallConfidence: getConfidence(prediction, 'overall'),
        widthQuality: getConfidence(prediction, 'widthQuality'),
      });
    }

    const expertEz = buildEzConsensus(caseRow?.expert?.ezAnnotations);
    const predictedEz = buildCurve(prediction.ezPoints);
    let ezCaseMetric = null;
    if (expertEz && predictedEz) {
      const predDenseAligned = alignCurveToReference(predictedEz.dense200, expertEz.dense200);
      const predLandmarksAligned = alignCurveToReference(predictedEz.landmarks12, expertEz.landmarks12);
      const symmetric = curveDistanceMetrics(predDenseAligned, expertEz.dense200);
      const landmarkDistances = predLandmarksAligned.map((p, index) => distance(p, expertEz.landmarks12[index]));
      const endpointMeanPx = (
        distance(predDenseAligned[0], expertEz.dense200[0])
        + distance(predDenseAligned[predDenseAligned.length - 1], expertEz.dense200[expertEz.dense200.length - 1])
      ) / 2;
      const curveLengthAbsoluteErrorPx = Math.abs(predictedEz.lengthPx - expertEz.lengthPx);
      ezCaseMetric = {
        caseId,
        expertAnnotationCount: expertEz.annotationCount,
        expertOriginalPointCounts: expertEz.originalPointCounts,
        symmetricMeanPx: symmetric.symmetricMeanPx,
        symmetricMeanNorm: symmetric.symmetricMeanPx / diagonal,
        symmetricP95Px: symmetric.symmetricP95Px,
        symmetricP95Norm: symmetric.symmetricP95Px / diagonal,
        hd95Px: symmetric.hd95Px,
        hd95Norm: symmetric.hd95Px / diagonal,
        endpointMeanPx,
        endpointMeanNorm: endpointMeanPx / diagonal,
        landmark12MeanPx: mean(landmarkDistances),
        landmark12MeanNorm: mean(landmarkDistances) / diagonal,
        landmark12P95Px: percentile(landmarkDistances, 0.95),
        landmark12P95Norm: percentile(landmarkDistances, 0.95) / diagonal,
        curveLengthAbsoluteErrorPx,
        curveLengthAbsoluteErrorNorm: curveLengthAbsoluteErrorPx / diagonal,
        curveLengthRelativeAbsoluteError: safeRelative(curveLengthAbsoluteErrorPx, expertEz.lengthPx),
        expertCurveLengthPx: expertEz.lengthPx,
        predictedCurveLengthPx: predictedEz.lengthPx,
        expertChordPx: expertEz.chordPx,
        predictedChordPx: predictedEz.chordPx,
        overallConfidence: getConfidence(prediction, 'overall'),
        templateQuality: getConfidence(prediction, 'templateQuality'),
        pathEvidence: getConfidence(prediction, 'pathEvidence'),
      };
      ezCaseRows.push(ezCaseMetric);

      if (expertEz.annotationCount > 1) {
        for (const pair of expertEz.pairwise) {
          interAnnotatorRows.push({
            caseId,
            expertAnnotationCount: expertEz.annotationCount,
            symmetricMeanNorm: pair.symmetricMeanPx / diagonal,
            symmetricP95Norm: pair.symmetricP95Px / diagonal,
            hd95Norm: pair.hd95Px / diagonal,
            endpointMeanNorm: pair.endpointMeanPx / diagonal,
            curveLengthDifferenceNorm: pair.curveLengthDifferencePx / diagonal,
          });
        }
      }
    }

    const widthCase = widthCaseRows[widthCaseRows.length - 1];
    const sameCurrentWidthCase = widthCase?.caseId === caseId ? widthCase : null;
    if (sameCurrentWidthCase?.complete12 && expertEz && predictedEz && currentWidthRows.length === 12) {
      const expertPxPerMm = expertEz.chordPx / SCALE_CHORD_MM;
      if (expertPxPerMm > EPS) {
        const expertTzlPx = currentWidthRows.reduce((sum, row) => sum + row.expertLengthPx, 0);
        const predictedTzlPx = currentWidthRows.reduce((sum, row) => sum + row.predictedLengthPx, 0);
        const expertEzlMm = expertEz.lengthPx / expertPxPerMm;
        const expertTzlMm = expertTzlPx / expertPxPerMm;
        const expertDifferenceMm = expertEzlMm - expertTzlMm;
        const predictedEzlCommonMm = predictedEz.lengthPx / expertPxPerMm;
        const predictedTzlCommonMm = predictedTzlPx / expertPxPerMm;
        const predictedDifferenceCommonMm = predictedEzlCommonMm - predictedTzlCommonMm;
        const appPxPerMm = finiteNumber(prediction?.metrics?.pxPerMm);
        const appEzlMm = finiteNumber(prediction?.metrics?.ezl);
        const appTzlMm = finiteNumber(prediction?.metrics?.tzl);
        const appDifferenceMm = finiteNumber(prediction?.metrics?.difference);
        const reconstructedAppPxPerMm = predictedEz.chordPx / SCALE_CHORD_MM;
        clinicalRows.push({
          caseId,
          expertAnnotationCount: expertEz.annotationCount,
          expertScalePxPerMm: expertPxPerMm,
          appScalePxPerMm: appPxPerMm,
          reconstructedAppScalePxPerMm: reconstructedAppPxPerMm,
          appScaleSignedErrorPxPerMm: appPxPerMm === null ? null : appPxPerMm - expertPxPerMm,
          appScaleRelativeError: appPxPerMm === null ? null : (appPxPerMm - expertPxPerMm) / expertPxPerMm,
          appScaleInternalRelativeDisagreement: appPxPerMm === null ? null : safeRelative(appPxPerMm - reconstructedAppPxPerMm, reconstructedAppPxPerMm),
          expert: { ezlMm: expertEzlMm, tzlMm: expertTzlMm, differenceMm: expertDifferenceMm },
          predictedUsingExpertScale: {
            ezlMm: predictedEzlCommonMm,
            tzlMm: predictedTzlCommonMm,
            differenceMm: predictedDifferenceCommonMm,
            ezlErrorMm: predictedEzlCommonMm - expertEzlMm,
            tzlErrorMm: predictedTzlCommonMm - expertTzlMm,
            differenceErrorMm: predictedDifferenceCommonMm - expertDifferenceMm,
          },
          applicationReported: {
            ezlMm: appEzlMm,
            tzlMm: appTzlMm,
            differenceMm: appDifferenceMm,
            ezlErrorMm: appEzlMm === null ? null : appEzlMm - expertEzlMm,
            tzlErrorMm: appTzlMm === null ? null : appTzlMm - expertTzlMm,
            differenceErrorMm: appDifferenceMm === null ? null : appDifferenceMm - expertDifferenceMm,
            scaleInducedEzlDeltaMm: appEzlMm === null ? null : appEzlMm - predictedEzlCommonMm,
            scaleInducedTzlDeltaMm: appTzlMm === null ? null : appTzlMm - predictedTzlCommonMm,
            scaleInducedDifferenceDeltaMm: appDifferenceMm === null ? null : appDifferenceMm - predictedDifferenceCommonMm,
          },
          overallConfidence: getConfidence(prediction, 'overall'),
          combinedGeometricErrorNorm: mean([sameCurrentWidthCase.endpointMeanNorm, ezCaseMetric?.symmetricMeanNorm].filter(Number.isFinite)),
        });
      }
    }
  }

  const perTooth = {};
  for (let toothNo = 1; toothNo <= 12; toothNo += 1) {
    const rows = widthRows.filter((row) => row.toothNo === toothNo);
    perTooth[String(toothNo)] = {
      lineCount: rows.length,
      caseCount: new Set(rows.map((row) => row.caseId)).size,
      endpointMeanError: errorStats(rows.map((row) => row.endpointMeanPx), rows.map((row) => row.endpointMeanNorm)),
      centerError: errorStats(rows.map((row) => row.centerErrorPx), rows.map((row) => row.centerErrorNorm)),
      lengthAbsoluteError: errorStats(rows.map((row) => row.lengthAbsoluteErrorPx), rows.map((row) => row.lengthAbsoluteErrorNorm)),
      lengthRelativeAbsoluteError: summarize(rows.map((row) => row.lengthRelativeAbsoluteError)),
      orientationAbsoluteErrorDegrees: summarize(rows.map((row) => row.orientationErrorDegrees)),
      endpointOrderSwappedCount: rows.filter((row) => row.endpointOrderSwapped).length,
    };
  }

  const commonScaleErrors = {
    ezlMm: signedAndAbsolute(clinicalRows.map((row) => row.predictedUsingExpertScale.ezlErrorMm)),
    tzlMm: signedAndAbsolute(clinicalRows.map((row) => row.predictedUsingExpertScale.tzlErrorMm)),
    differenceMm: signedAndAbsolute(clinicalRows.map((row) => row.predictedUsingExpertScale.differenceErrorMm)),
  };
  const appErrors = {
    ezlMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.ezlErrorMm).filter(Number.isFinite)),
    tzlMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.tzlErrorMm).filter(Number.isFinite)),
    differenceMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.differenceErrorMm).filter(Number.isFinite)),
  };

  const confidenceComponents = ['overall', 'imageQuality', 'templateQuality', 'pathEvidence', 'boundaryQuality', 'widthQuality'];
  const confidence = {};
  for (const component of confidenceComponents) {
    confidence[component] = {
      widthEndpointError: confidenceAudit(widthCaseRows.map((row) => ({
        caseId: row.caseId,
        confidence: component === 'overall' ? row.overallConfidence : (
          component === 'widthQuality' ? row.widthQuality : getConfidence(predictionByCaseId.get(row.caseId)?.prediction, component)
        ),
        error: row.endpointMeanNorm,
      }))),
      ezSymmetricMeanError: confidenceAudit(ezCaseRows.map((row) => ({
        caseId: row.caseId,
        confidence: component === 'overall' ? row.overallConfidence : (
          component === 'templateQuality' ? row.templateQuality : component === 'pathEvidence' ? row.pathEvidence
            : getConfidence(predictionByCaseId.get(row.caseId)?.prediction, component)
        ),
        error: row.symmetricMeanNorm,
      }))),
    };
  }
  confidence.overall.combinedCompleteCaseError = confidenceAudit(clinicalRows.map((row) => ({
    caseId: row.caseId,
    confidence: row.overallConfidence,
    error: row.combinedGeometricErrorNorm,
  })));
  confidence.perToothWidthConfidence = confidenceAudit(widthRows.map((row) => ({
    caseId: row.caseId,
    confidence: row.toothWidthConfidence,
    error: row.endpointMeanNorm,
  })));

  const datasetCaseIds = new Set(dataset.cases.map((row) => String(row.caseId)));
  const predictionOnlyCaseIds = [...predictionByCaseId.keys()].filter((caseId) => !datasetCaseIds.has(String(caseId))).map(String);

  return {
    summary: {
      datasetCaseCount: dataset.cases.length,
      predictionCaseCount: predictions.results.length,
      evaluatedWidthCaseCount: widthCaseRows.length,
      evaluatedWidthLineCount: widthRows.length,
      completeWidthCaseCount: widthCaseRows.filter((row) => row.complete12).length,
      evaluatedEzCaseCount: ezCaseRows.length,
      multiExpertEzCaseCount: new Set(interAnnotatorRows.map((row) => row.caseId)).size,
      completeWidthAndEzClinicalCaseCount: clinicalRows.length,
      unmatchedDatasetPredictionCount: unmatchedDatasetCaseIds.length,
      invalidPredictionCount: invalidPredictionCaseIds.length,
    },
    matchingAndQuality: {
      duplicatePredictionCaseIds: [...new Set(duplicatePredictionCaseIds)].sort(),
      unmatchedDatasetCaseIds: unmatchedDatasetCaseIds.sort(),
      invalidPredictionCaseIds: invalidPredictionCaseIds.sort(),
      predictionOnlyCaseIds: predictionOnlyCaseIds.sort(),
    },
    width: {
      definitions: {
        endpointMatching: 'minimum total Euclidean cost of direct versus swapped endpoint assignment, per tooth',
        center: 'Euclidean distance between predicted and expert segment midpoints',
        length: 'absolute segment-length difference',
        orientation: 'absolute axial angle difference modulo 180 degrees',
        aggregation: 'each annotated tooth line contributes once; case summaries average annotated teeth',
      },
      overall: {
        endpointMeanError: errorStats(widthRows.map((row) => row.endpointMeanPx), widthRows.map((row) => row.endpointMeanNorm)),
        centerError: errorStats(widthRows.map((row) => row.centerErrorPx), widthRows.map((row) => row.centerErrorNorm)),
        lengthAbsoluteError: errorStats(widthRows.map((row) => row.lengthAbsoluteErrorPx), widthRows.map((row) => row.lengthAbsoluteErrorNorm)),
        lengthRelativeAbsoluteError: summarize(widthRows.map((row) => row.lengthRelativeAbsoluteError)),
        orientationAbsoluteErrorDegrees: summarize(widthRows.map((row) => row.orientationErrorDegrees)),
        endpointOrderSwappedCount: widthRows.filter((row) => row.endpointOrderSwapped).length,
        endpointOrderSwappedFraction: widthRows.length ? widthRows.filter((row) => row.endpointOrderSwapped).length / widthRows.length : null,
      },
      perTooth,
      cases: widthCaseRows.map((row) => ({
        caseId: row.caseId,
        annotatedToothCount: row.annotatedToothCount,
        complete12: row.complete12,
        endpointMeanFractionOfImageDiagonal: row.endpointMeanNorm,
        centerMeanFractionOfImageDiagonal: row.centerErrorMeanNorm,
        lengthErrorMeanFractionOfImageDiagonal: row.lengthErrorMeanNorm,
        orientationErrorMeanDegrees: row.orientationErrorMeanDegrees,
        swappedLineCount: row.swappedLineCount,
        overallConfidence: row.overallConfidence,
      })),
    },
    ezCurve: {
      definitions: {
        expertCurve: `uniform Catmull-Rom (${CURVE_DENSE_SAMPLES_PER_SEGMENT} samples/segment), then arc-length resampled to ${CURVE_COMPARE_POINTS} points`,
        landmarkComparison: `${CURVE_COMPARE_POINTS}-point curve arc-length resampled again to ${CURVE_LANDMARK_POINTS} points`,
        symmetricMean: 'mean of the two directional mean nearest-curve distances',
        symmetricP95: '95th percentile of all bidirectional nearest-curve distances',
        hd95: 'maximum of the two directional 95th-percentile nearest-curve distances',
        multiExpertConsensus: 'direction-aligned, pointwise mean of equal arc-length curves, then re-resampled; one case weight regardless of annotation count',
      },
      overall: {
        symmetricMeanError: errorStats(ezCaseRows.map((row) => row.symmetricMeanPx), ezCaseRows.map((row) => row.symmetricMeanNorm)),
        symmetricP95Error: errorStats(ezCaseRows.map((row) => row.symmetricP95Px), ezCaseRows.map((row) => row.symmetricP95Norm)),
        hd95Error: errorStats(ezCaseRows.map((row) => row.hd95Px), ezCaseRows.map((row) => row.hd95Norm)),
        endpointMeanError: errorStats(ezCaseRows.map((row) => row.endpointMeanPx), ezCaseRows.map((row) => row.endpointMeanNorm)),
        landmark12MeanError: errorStats(ezCaseRows.map((row) => row.landmark12MeanPx), ezCaseRows.map((row) => row.landmark12MeanNorm)),
        landmark12P95Error: errorStats(ezCaseRows.map((row) => row.landmark12P95Px), ezCaseRows.map((row) => row.landmark12P95Norm)),
        curveLengthAbsoluteError: errorStats(ezCaseRows.map((row) => row.curveLengthAbsoluteErrorPx), ezCaseRows.map((row) => row.curveLengthAbsoluteErrorNorm)),
        curveLengthRelativeAbsoluteError: summarize(ezCaseRows.map((row) => row.curveLengthRelativeAbsoluteError)),
      },
      cases: ezCaseRows.map((row) => ({
        caseId: row.caseId,
        expertAnnotationCount: row.expertAnnotationCount,
        expertOriginalPointCounts: row.expertOriginalPointCounts,
        symmetricMeanFractionOfImageDiagonal: row.symmetricMeanNorm,
        symmetricP95FractionOfImageDiagonal: row.symmetricP95Norm,
        hd95FractionOfImageDiagonal: row.hd95Norm,
        endpointMeanFractionOfImageDiagonal: row.endpointMeanNorm,
        landmark12MeanFractionOfImageDiagonal: row.landmark12MeanNorm,
        landmark12P95FractionOfImageDiagonal: row.landmark12P95Norm,
        curveLengthAbsoluteErrorFractionOfImageDiagonal: row.curveLengthAbsoluteErrorNorm,
        curveLengthRelativeAbsoluteError: row.curveLengthRelativeAbsoluteError,
        overallConfidence: row.overallConfidence,
      })),
    },
    expertVariability: {
      definitions: {
        caseWeighting: 'duplicate expert annotations form one consensus and do not duplicate the case in model-error aggregates',
        pairwiseRows: 'one row per unique expert-annotation pair, numeric metrics only',
      },
      pairCount: interAnnotatorRows.length,
      caseCount: new Set(interAnnotatorRows.map((row) => row.caseId)).size,
      aggregate: {
        symmetricMeanFractionOfImageDiagonal: summarize(interAnnotatorRows.map((row) => row.symmetricMeanNorm)),
        symmetricP95FractionOfImageDiagonal: summarize(interAnnotatorRows.map((row) => row.symmetricP95Norm)),
        hd95FractionOfImageDiagonal: summarize(interAnnotatorRows.map((row) => row.hd95Norm)),
        endpointMeanFractionOfImageDiagonal: summarize(interAnnotatorRows.map((row) => row.endpointMeanNorm)),
        curveLengthDifferenceFractionOfImageDiagonal: summarize(interAnnotatorRows.map((row) => row.curveLengthDifferenceNorm)),
      },
      cases: interAnnotatorRows,
    },
    clinicalScale: {
      definitions: {
        inclusion: 'case has all 12 expert tooth-width lines, at least one valid expert EZ curve, and a successful prediction',
        commonScale: `expert EZ endpoint chord is fixed to ${SCALE_CHORD_MM} mm; the same expert px/mm scale is applied to expert and predicted lengths`,
        difference: 'EZL - TZL',
        applicationScale: `application-reported px/mm and measurements; current application derives scale from its predicted EZ endpoint chord set to ${SCALE_CHORD_MM} mm`,
      },
      caseCount: clinicalRows.length,
      predictedUsingCommonExpertScaleErrors: commonScaleErrors,
      applicationReportedErrors: appErrors,
      applicationScaleError: {
        signedPxPerMm: summarize(clinicalRows.map((row) => row.appScaleSignedErrorPxPerMm).filter(Number.isFinite)),
        absolutePxPerMm: summarize(clinicalRows.map((row) => Math.abs(row.appScaleSignedErrorPxPerMm)).filter(Number.isFinite)),
        signedRelative: summarize(clinicalRows.map((row) => row.appScaleRelativeError).filter(Number.isFinite)),
        absoluteRelative: summarize(clinicalRows.map((row) => Math.abs(row.appScaleRelativeError)).filter(Number.isFinite)),
        internalReconstructionRelativeDisagreement: summarize(clinicalRows.map((row) => Math.abs(row.appScaleInternalRelativeDisagreement)).filter(Number.isFinite)),
      },
      scaleInducedMeasurementDelta: {
        ezlMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.scaleInducedEzlDeltaMm).filter(Number.isFinite)),
        tzlMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.scaleInducedTzlDeltaMm).filter(Number.isFinite)),
        differenceMm: signedAndAbsolute(clinicalRows.map((row) => row.applicationReported.scaleInducedDifferenceDeltaMm).filter(Number.isFinite)),
      },
      cases: clinicalRows,
    },
    confidenceCalibration: {
      interpretation: 'A useful confidence score should have negative Spearman rho with error and lower error in the highest-confidence quartile. Quartiles are case-disjoint and ordered low to high confidence.',
      ...confidence,
    },
  };
}

function formatPercent(fraction, digits = 2) {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : 'n/a';
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function reportMarkdown(result) {
  const w = result.width.overall;
  const ez = result.ezCurve.overall;
  const clinical = result.clinicalScale;
  const confW = result.confidenceCalibration.overall.widthEndpointError;
  const confEz = result.confidenceCalibration.overall.ezSymmetricMeanError;
  const variability = result.expertVariability;
  const lines = [
    '# Rule Baseline 정량 평가',
    '',
    `생성 시각: ${result.generatedAt}`,
    '',
    '## 평가 범위',
    '',
    `- 전체 정규 사례: ${result.summary.datasetCaseCount}`,
    `- 폭 정답 비교: ${result.summary.evaluatedWidthCaseCount}건 / ${result.summary.evaluatedWidthLineCount}개 치아`,
    `- EZ 곡선 정답 비교: ${result.summary.evaluatedEzCaseCount}건`,
    `- 12개 폭 + EZ 공통 스케일 임상 수치 비교: ${result.summary.completeWidthAndEzClinicalCaseCount}건`,
    `- 누락/실패 예측: ${result.summary.unmatchedDatasetPredictionCount + result.summary.invalidPredictionCount}건`,
    '',
    '모든 위치 오차는 이미지 대각선으로 정규화했습니다. 보고서와 JSON에는 PHI, 원본 파일명, 원본 좌표를 넣지 않았습니다.',
    '',
    '## 기준 성능',
    '',
    '| 항목 | 평균 | 중앙값 | P95 |',
    '|---|---:|---:|---:|',
    `| 치아 폭 끝점 평균 오차 | ${formatPercent(w.endpointMeanError.fractionOfImageDiagonal.mean)} | ${formatPercent(w.endpointMeanError.fractionOfImageDiagonal.median)} | ${formatPercent(w.endpointMeanError.fractionOfImageDiagonal.p95)} |`,
    `| 치아 폭 중심 오차 | ${formatPercent(w.centerError.fractionOfImageDiagonal.mean)} | ${formatPercent(w.centerError.fractionOfImageDiagonal.median)} | ${formatPercent(w.centerError.fractionOfImageDiagonal.p95)} |`,
    `| 치아 폭 길이 절대오차 | ${formatPercent(w.lengthAbsoluteError.fractionOfImageDiagonal.mean)} | ${formatPercent(w.lengthAbsoluteError.fractionOfImageDiagonal.median)} | ${formatPercent(w.lengthAbsoluteError.fractionOfImageDiagonal.p95)} |`,
    `| 치아 폭 방향 오차 | ${formatNumber(w.orientationAbsoluteErrorDegrees.mean)}° | ${formatNumber(w.orientationAbsoluteErrorDegrees.median)}° | ${formatNumber(w.orientationAbsoluteErrorDegrees.p95)}° |`,
    `| EZ 대칭 평균 곡선 오차 | ${formatPercent(ez.symmetricMeanError.fractionOfImageDiagonal.mean)} | ${formatPercent(ez.symmetricMeanError.fractionOfImageDiagonal.median)} | ${formatPercent(ez.symmetricMeanError.fractionOfImageDiagonal.p95)} |`,
    `| EZ 대칭 P95 오차 | ${formatPercent(ez.symmetricP95Error.fractionOfImageDiagonal.mean)} | ${formatPercent(ez.symmetricP95Error.fractionOfImageDiagonal.median)} | ${formatPercent(ez.symmetricP95Error.fractionOfImageDiagonal.p95)} |`,
    `| EZ HD95 | ${formatPercent(ez.hd95Error.fractionOfImageDiagonal.mean)} | ${formatPercent(ez.hd95Error.fractionOfImageDiagonal.median)} | ${formatPercent(ez.hd95Error.fractionOfImageDiagonal.p95)} |`,
    `| EZ 12점 대응 평균 오차 | ${formatPercent(ez.landmark12MeanError.fractionOfImageDiagonal.mean)} | ${formatPercent(ez.landmark12MeanError.fractionOfImageDiagonal.median)} | ${formatPercent(ez.landmark12MeanError.fractionOfImageDiagonal.p95)} |`,
    '',
    `폭 선분 ${result.summary.evaluatedWidthLineCount}개 중 ${w.endpointOrderSwappedCount}개(${formatPercent(w.endpointOrderSwappedFraction)})는 끝점 순서를 바꿨을 때 최소 대응 비용이 되었습니다. 방향각은 180° 축 방향으로 평가했으므로 끝점 순서에 영향을 받지 않습니다.`,
    '',
    '## 공통 전문가 스케일 임상 수치',
    '',
    `전문가 EZ 양끝 chord를 ${SCALE_CHORD_MM} mm로 놓은 동일 px/mm 스케일을 전문가와 예측 양쪽에 적용했습니다.`,
    '',
    '| 오차 항목 | 공통 스케일 MAE | 앱 보고값 MAE |',
    '|---|---:|---:|',
    `| EZL | ${formatNumber(clinical.predictedUsingCommonExpertScaleErrors.ezlMm.absolute.mean)} mm | ${formatNumber(clinical.applicationReportedErrors.ezlMm.absolute.mean)} mm |`,
    `| TZL | ${formatNumber(clinical.predictedUsingCommonExpertScaleErrors.tzlMm.absolute.mean)} mm | ${formatNumber(clinical.applicationReportedErrors.tzlMm.absolute.mean)} mm |`,
    `| EZL - TZL | ${formatNumber(clinical.predictedUsingCommonExpertScaleErrors.differenceMm.absolute.mean)} mm | ${formatNumber(clinical.applicationReportedErrors.differenceMm.absolute.mean)} mm |`,
    '',
    `앱 자체 px/mm 스케일의 전문가 스케일 대비 평균 절대 상대오차는 ${formatPercent(clinical.applicationScaleError.absoluteRelative.mean)}입니다. 앱 내부 저장값과 예측 chord로 재계산한 스케일의 불일치 평균은 ${formatPercent(clinical.applicationScaleError.internalReconstructionRelativeDisagreement.mean, 4)}입니다.`,
    '',
    '## 전문가 중복 정답 처리',
    '',
    `다중 EZ 정답 사례는 ${variability.caseCount}건이며, 한 사례당 가중치 1로 consensus를 만들었습니다. 쌍별 전문가 EZ 대칭 평균 차이는 이미지 대각선 대비 ${formatPercent(variability.aggregate.symmetricMeanFractionOfImageDiagonal.mean)}입니다.`,
    '',
    '## 신뢰도 점검',
    '',
    `- 전체 confidence ↔ 폭 끝점 오차 Spearman ρ: ${formatNumber(confW.spearman.rho, 3)} (n=${confW.spearman.n})`,
    `- 전체 confidence ↔ EZ 대칭 평균 오차 Spearman ρ: ${formatNumber(confEz.spearman.rho, 3)} (n=${confEz.spearman.n})`,
    `- 최고 신뢰도 사분위/최저 신뢰도 사분위 평균오차 비: 폭 ${formatNumber(confW.highestToLowestConfidenceMeanErrorRatio, 3)}, EZ ${formatNumber(confEz.highestToLowestConfidenceMeanErrorRatio, 3)}`,
    '',
    'ρ가 음수이고 최고 신뢰도 구간의 오차가 더 작아야 신뢰도 점수가 실질적인 오류 선별에 도움이 됩니다.',
    '',
    '## 판정',
    '',
    '이 결과는 현재 rule 엔진의 고정 기준선입니다. 재학습 모델은 동일 사례 분할의 검증 예측으로 이 지표를 낮춰야 하며, 학습 표본에 대한 적합값으로 비교하면 안 됩니다. 의료적 의사결정에 사용하기 전 독립 검증과 전문가 승인이 필요합니다.',
    '',
  ];
  return lines.join('\n');
}

function deepRound(value) {
  if (Array.isArray(value)) return value.map(deepRound);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deepRound(child)]));
  }
  if (typeof value === 'number') return compactNumber(value, 10);
  return value;
}

function runSanityChecks(metrics) {
  const widthCaseIds = metrics.width.cases.map((row) => row.caseId);
  const ezCaseIds = metrics.ezCurve.cases.map((row) => row.caseId);
  const clinicalCaseIds = metrics.clinicalScale.cases.map((row) => row.caseId);
  const checks = [
    {
      name: 'all_dataset_cases_have_successful_prediction',
      pass: metrics.summary.unmatchedDatasetPredictionCount === 0 && metrics.summary.invalidPredictionCount === 0,
      observed: metrics.summary.unmatchedDatasetPredictionCount + metrics.summary.invalidPredictionCount,
    },
    {
      name: 'width_case_weight_is_unique',
      pass: new Set(widthCaseIds).size === widthCaseIds.length,
      observed: widthCaseIds.length - new Set(widthCaseIds).size,
    },
    {
      name: 'ez_case_weight_is_unique',
      pass: new Set(ezCaseIds).size === ezCaseIds.length,
      observed: ezCaseIds.length - new Set(ezCaseIds).size,
    },
    {
      name: 'clinical_case_weight_is_unique',
      pass: new Set(clinicalCaseIds).size === clinicalCaseIds.length,
      observed: clinicalCaseIds.length - new Set(clinicalCaseIds).size,
    },
    {
      name: 'width_line_count_matches_per_tooth_sum',
      pass: metrics.summary.evaluatedWidthLineCount === Object.values(metrics.width.perTooth).reduce((sum, row) => sum + row.lineCount, 0),
      observed: Object.values(metrics.width.perTooth).reduce((sum, row) => sum + row.lineCount, 0),
    },
    {
      name: 'clinical_count_matches_case_rows',
      pass: metrics.summary.completeWidthAndEzClinicalCaseCount === metrics.clinicalScale.cases.length,
      observed: metrics.clinicalScale.cases.length,
    },
    {
      name: 'application_scale_reconstructs_from_predicted_chord',
      pass: (metrics.clinicalScale.applicationScaleError.internalReconstructionRelativeDisagreement.max ?? 0) < 1e-6,
      observed: metrics.clinicalScale.applicationScaleError.internalReconstructionRelativeDisagreement.max,
    },
    {
      name: 'normalized_errors_are_nonnegative',
      pass: metrics.width.overall.endpointMeanError.fractionOfImageDiagonal.min >= 0
        && metrics.ezCurve.overall.symmetricMeanError.fractionOfImageDiagonal.min >= 0,
      observed: {
        widthMin: metrics.width.overall.endpointMeanError.fractionOfImageDiagonal.min,
        ezMin: metrics.ezCurve.overall.symmetricMeanError.fractionOfImageDiagonal.min,
      },
    },
  ];
  const multiExpertCases = metrics.ezCurve.cases.filter((row) => row.expertAnnotationCount > 1);
  if (multiExpertCases.some((row) => row.caseId === '106')) {
    checks.push({
      name: 'case_106_multi_expert_is_consensus_weighted_once',
      pass: multiExpertCases.filter((row) => row.caseId === '106').length === 1
        && metrics.clinicalScale.cases.filter((row) => row.caseId === '106').length <= 1
        && metrics.expertVariability.cases.filter((row) => row.caseId === '106').length >= 1,
      observed: {
        ezAggregateRows: multiExpertCases.filter((row) => row.caseId === '106').length,
        clinicalRows: metrics.clinicalScale.cases.filter((row) => row.caseId === '106').length,
        variabilityRows: metrics.expertVariability.cases.filter((row) => row.caseId === '106').length,
      },
    });
  }
  return {
    pass: checks.every((check) => check.pass),
    checks,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataset = readJson(args.dataset);
  const predictions = readJson(args.predictions);
  const metrics = evaluate(dataset, predictions);
  const sanityChecks = runSanityChecks(metrics);
  if (!sanityChecks.pass) {
    throw new Error(`Sanity checks failed: ${JSON.stringify(sanityChecks.checks.filter((check) => !check.pass))}`);
  }
  const result = deepRound({
    schemaVersion: 'ez-baseline-metrics/v1',
    generatedAt: new Date().toISOString(),
    privacy: {
      phiFieldsEmitted: false,
      sourcePathsEmitted: false,
      sourceFileNamesEmitted: false,
      rawCoordinatesEmitted: false,
      perCaseIdentifier: 'canonical caseId only',
    },
    inputs: {
      datasetSchemaVersion: dataset.schemaVersion || null,
      predictionSchemaVersion: predictions.schemaVersion || null,
      datasetSha256: sha256File(args.dataset),
      predictionsSha256: sha256File(args.predictions),
      baselineEngineVersion: predictions.results.find((row) => row?.prediction?.analysisMeta?.engineVersion)?.prediction?.analysisMeta?.engineVersion || null,
    },
    curveProtocol: {
      interpolation: 'uniform Catmull-Rom',
      denseSamplesPerSegment: CURVE_DENSE_SAMPLES_PER_SEGMENT,
      comparisonArcLengthSamples: CURVE_COMPARE_POINTS,
      landmarkArcLengthSamples: CURVE_LANDMARK_POINTS,
      scaleChordMm: SCALE_CHORD_MM,
    },
    sanityChecks,
    ...metrics,
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(args.report, reportMarkdown(result), 'utf8');
  console.log(JSON.stringify({
    output: args.output,
    report: args.report,
    summary: result.summary,
    widthEndpointMeanPercentDiagonal: result.width.overall.endpointMeanError.percentOfImageDiagonal.mean,
    ezSymmetricMeanPercentDiagonal: result.ezCurve.overall.symmetricMeanError.percentOfImageDiagonal.mean,
    clinicalCommonScaleDifferenceMaeMm: result.clinicalScale.predictedUsingCommonExpertScaleErrors.differenceMm.absolute.mean,
    appScaleAbsoluteRelativeError: result.clinicalScale.applicationScaleError.absoluteRelative.mean,
  }, null, 2));
}

main();
