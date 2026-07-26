/*
 * Browser/Node inference for ez-tzl-residual-krr/v1.
 *
 * This module deliberately has no DOM, Canvas, filesystem, or third-party
 * dependency.  It reproduces train_residual.py's baseline preprocessing,
 * 169-value feature vector, standardisation, RBF-KRR prediction, distance
 * gate, legacy correction cap, baseline fallback, and unit-square clamp.
 */
(function universalModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EzResidualInference = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createModule() {
  'use strict';

  const EPS = 1e-12;
  const SQRT2 = Math.sqrt(2);
  const FEATURE_SIZE = 169;
  const DEPLOYMENT_POLICY_SCHEMA = 'ez-tzl-residual-deployment-policy/v1';
  const DEPLOYMENT_POLICY_STATUSES = new Set([
    'candidate_pending_nested_validation',
    'candidate_rejected_nested_validation',
    'candidate_nested_validation_passed',
    'approved_for_shadow',
    'approved_for_production',
    'production_approved',
  ]);
  const TASK_POINT_COUNTS = Object.freeze({ width: 24, ez: 12 });
  const CAP_POLICIES = Object.freeze({
    LEGACY_AXIS_NORMALIZED: 'legacy-axis-normalized',
    PIXEL_DIAGONAL: 'pixel-diagonal',
  });

  function fail(message) {
    throw new Error(`EZ residual inference: ${message}`);
  }

  function number(value, label) {
    const result = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(result)) fail(`${label} must be finite`);
    return result;
  }

  function positiveNumber(value, label) {
    const result = number(value, label);
    if (!(result > 0)) fail(`${label} must be positive`);
    return result;
  }

  function point(value, label) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [number(value.x, `${label}.x`), number(value.y, `${label}.y`)];
    }
    if (Array.isArray(value) && value.length >= 2) {
      return [number(value[0], `${label}[0]`), number(value[1], `${label}[1]`)];
    }
    fail(`${label} must be an {x,y} object or [x,y] array`);
  }

  function pointObject(value) {
    return { x: value[0], y: value[1] };
  }

  function lexicographicallyBefore(a, b) {
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  }

  function widthPair(value, label) {
    let p1;
    let p2;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const left = value.p1 || value.left || value.start;
      const right = value.p2 || value.right || value.end;
      if (left != null && right != null) {
        p1 = point(left, `${label}.p1`);
        p2 = point(right, `${label}.p2`);
      } else if ([value.x1, value.y1, value.x2, value.y2].every((item) => item != null)) {
        p1 = [number(value.x1, `${label}.x1`), number(value.y1, `${label}.y1`)];
        p2 = [number(value.x2, `${label}.x2`), number(value.y2, `${label}.y2`)];
      }
    } else if (Array.isArray(value)) {
      if (value.length === 2) {
        p1 = point(value[0], `${label}[0]`);
        p2 = point(value[1], `${label}[1]`);
      } else if (value.length >= 4) {
        p1 = [number(value[0], `${label}[0]`), number(value[1], `${label}[1]`)];
        p2 = [number(value[2], `${label}[2]`), number(value[3], `${label}[3]`)];
      }
    }
    if (!p1 || !p2) fail(`${label} is not a valid width line`);
    // Exact equivalent of Python tuple comparison: (p2.x,p2.y) < (p1.x,p1.y).
    return lexicographicallyBefore(p2, p1) ? [p2, p1] : [p1, p2];
  }

  function getFirst(container, keys) {
    if (!container || typeof container !== 'object') return undefined;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(container, key)) return container[key];
    }
    return undefined;
  }

  function predictionContainer(draft) {
    if (!draft || typeof draft !== 'object') fail('draft must be an object');
    for (const key of ['prediction', 'baseline', 'result', 'autoDraft', 'analysis', 'outputs']) {
      if (draft[key] && typeof draft[key] === 'object' && !Array.isArray(draft[key])) return draft[key];
    }
    return draft;
  }

  function dimensionsFrom(container) {
    if (!container || typeof container !== 'object') return null;
    const candidates = [container];
    for (const key of ['image', 'sourceImage', 'embeddedImage']) {
      if (container[key] && typeof container[key] === 'object') candidates.push(container[key]);
    }
    for (const candidate of candidates) {
      const widthValue = getFirst(candidate, ['widthPx', 'imageWidth', 'width']);
      const heightValue = getFirst(candidate, ['heightPx', 'imageHeight', 'height']);
      if (widthValue == null || heightValue == null) continue;
      const width = Number(widthValue);
      const height = Number(heightValue);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) return [width, height];
    }
    return null;
  }

  function parseWidths(value) {
    if (!Array.isArray(value)) fail('draft must contain a tooth-width array');
    const items = value.slice();
    if (items.length > 0 && items.every((item) => item && typeof item === 'object' && Number.isFinite(Number(item.toothNo)))) {
      items.sort((a, b) => Number(a.toothNo) - Number(b.toothNo));
    }
    const result = items.map((item, index) => widthPair(item, `toothWidths[${index}]`));
    if (result.length !== 12) fail(`exactly 12 tooth-width lines are required; received ${result.length}`);
    return result;
  }

  function parsePointList(value, label) {
    if (!Array.isArray(value)) fail(`${label} must be an array`);
    return value.map((item, index) => point(item, `${label}[${index}]`));
  }

  function distance(a, b) {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  function orientCurve(points) {
    if (points.length >= 2 && points[points.length - 1][0] < points[0][0]) return points.slice().reverse();
    return points.slice();
  }

  function resampleCurve(inputPoints, count) {
    if (!Array.isArray(inputPoints) || inputPoints.length < 2) fail('EZ curve needs at least two finite 2D points');
    const points = [inputPoints[0]];
    for (let index = 1; index < inputPoints.length; index += 1) {
      // Mirrors train_residual.py's keep mask, which compares adjacent points
      // in the original input rather than against the last retained point.
      if (distance(inputPoints[index - 1], inputPoints[index]) > EPS) points.push(inputPoints[index]);
    }
    if (points.length < 2) fail('EZ curve has zero arc length');
    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      cumulative.push(cumulative[index - 1] + distance(points[index - 1], points[index]));
    }
    const total = cumulative[cumulative.length - 1];
    if (!(total > EPS)) fail('EZ curve has zero arc length');
    const result = [];
    let segment = 0;
    for (let sampleIndex = 0; sampleIndex < count; sampleIndex += 1) {
      const target = total * sampleIndex / (count - 1);
      while (segment + 1 < cumulative.length - 1 && cumulative[segment + 1] < target) segment += 1;
      const startDistance = cumulative[segment];
      const endDistance = cumulative[segment + 1];
      const ratio = (target - startDistance) / (endDistance - startDistance);
      result.push([
        points[segment][0] + ratio * (points[segment + 1][0] - points[segment][0]),
        points[segment][1] + ratio * (points[segment + 1][1] - points[segment][1]),
      ]);
    }
    return result;
  }

  function normalizePoints(points, width, height) {
    return points.map((item) => [item[0] / width, item[1] / height]);
  }

  function flattenPoints(points) {
    const result = [];
    for (const item of points) result.push(item[0], item[1]);
    return result;
  }

  function canonicalBaseline(draft) {
    const prediction = predictionContainer(draft);
    const dims = dimensionsFrom(draft) || dimensionsFrom(prediction);
    if (!dims) fail('positive image dimensions are required');
    const [width, height] = dims;
    const rawWidths = getFirst(prediction, ['toothWidths', 'toothWidthsPx', 'tooth_widths', 'widths']);
    const rawEz = getFirst(prediction, ['ezPoints', 'ezPointsPx', 'ez_points']);
    const rawCenters = getFirst(prediction, ['toothCenters', 'toothCentersPx', 'tooth_centers']);
    const widths = parseWidths(rawWidths);
    const widthPixels = widths.flatMap((pairValue) => pairValue);
    const ezPixels = resampleCurve(orientCurve(parsePointList(rawEz, 'ezPoints')), 12);
    const widthPoints = normalizePoints(widthPixels, width, height);
    const ezPoints = normalizePoints(ezPixels, width, height);
    let centers;
    if (Array.isArray(rawCenters) && rawCenters.length === 12) {
      centers = normalizePoints(parsePointList(rawCenters, 'toothCenters'), width, height);
    } else {
      centers = [];
      for (let index = 0; index < 24; index += 2) {
        centers.push([
          (widthPoints[index][0] + widthPoints[index + 1][0]) * 0.5,
          (widthPoints[index][1] + widthPoints[index + 1][1]) * 0.5,
        ]);
      }
    }
    return { width, height, widthPoints, ezPoints, centers };
  }

  function featureVectorFromCanonical(canonical) {
    const { widthPoints, ezPoints, centers, width, height } = canonical;
    if (widthPoints.length !== 24 || ezPoints.length !== 12 || centers.length !== 12) fail('canonical landmark shapes are invalid');
    const widthLengths = [];
    const widthDirections = [];
    for (let index = 0; index < 24; index += 2) {
      const dx = widthPoints[index + 1][0] - widthPoints[index][0];
      const dy = widthPoints[index + 1][1] - widthPoints[index][1];
      const length = Math.hypot(dx, dy);
      widthLengths.push(length);
      const divisor = Math.max(length, EPS);
      widthDirections.push(dx / divisor, dy / divisor);
    }
    const ezLengths = [];
    const ezDirections = [];
    for (let index = 0; index < 11; index += 1) {
      const dx = ezPoints[index + 1][0] - ezPoints[index][0];
      const dy = ezPoints[index + 1][1] - ezPoints[index][1];
      const length = Math.hypot(dx, dy);
      ezLengths.push(length);
      const divisor = Math.max(length, EPS);
      ezDirections.push(dx / divisor, dy / divisor);
    }
    const chordX = ezPoints[11][0] - ezPoints[0][0];
    const chordY = ezPoints[11][1] - ezPoints[0][1];
    const chordLength = Math.hypot(chordX, chordY);
    let archDepth = 0;
    if (chordLength > EPS) {
      for (const item of ezPoints) {
        const cross = Math.abs(chordX * (item[1] - ezPoints[0][1]) - chordY * (item[0] - ezPoints[0][0]));
        archDepth = Math.max(archDepth, cross / chordLength);
      }
    }
    const meanWidthLength = widthLengths.reduce((sum, item) => sum + item, 0) / widthLengths.length;
    const result = [
      ...flattenPoints(widthPoints),
      ...flattenPoints(ezPoints),
      ...flattenPoints(centers),
      ...widthLengths.map((item) => item / SQRT2),
      ...widthDirections,
      ...ezLengths.map((item) => item / SQRT2),
      ...ezDirections,
      Math.log(Math.max(width / height, EPS)),
      chordLength / SQRT2,
      archDepth / SQRT2,
      meanWidthLength / SQRT2,
    ];
    if (result.length !== FEATURE_SIZE || result.some((item) => !Number.isFinite(item))) fail('invalid 169-value feature vector');
    return result;
  }

  function buildFeatureVector(draft) {
    return featureVectorFromCanonical(canonicalBaseline(draft));
  }

  function numericArray(value, expectedLength, label) {
    if (!Array.isArray(value) || value.length !== expectedLength) fail(`${label} must contain ${expectedLength} values`);
    return value.map((item, index) => number(item, `${label}[${index}]`));
  }

  function taskModel(modelDocument, taskName) {
    if (!modelDocument || typeof modelDocument !== 'object') fail('model document must be an object');
    const task = modelDocument.tasks && modelDocument.tasks[taskName];
    if (!task || typeof task !== 'object') fail(`model has no ${taskName} task`);
    const mean = numericArray(task.featureMean, FEATURE_SIZE, `${taskName}.featureMean`);
    const scale = numericArray(task.featureScale, FEATURE_SIZE, `${taskName}.featureScale`);
    if (scale.some((item) => item === 0)) fail(`${taskName}.featureScale cannot contain zero`);
    if (!Array.isArray(task.prototypes) || task.prototypes.length < 1) fail(`${taskName}.prototypes must not be empty`);
    const prototypes = task.prototypes.map((row, index) => numericArray(row, FEATURE_SIZE, `${taskName}.prototypes[${index}]`));
    const outputSize = TASK_POINT_COUNTS[taskName] * 2;
    if (!Array.isArray(task.alpha) || task.alpha.length !== prototypes.length) fail(`${taskName}.alpha row count must match prototypes`);
    const alpha = task.alpha.map((row, index) => numericArray(row, outputSize, `${taskName}.alpha[${index}]`));
    const gamma = positiveNumber(task.hyperparameters && task.hyperparameters.gamma, `${taskName}.gamma`);
    // 다단(반복) 보정 모델은 프로토타입·표준화·거리게이트를 모든 스테이지가 공유하고
    // alpha/gamma만 스테이지별로 다르다. stages가 없으면 1단계 모델로 취급한다.
    let stages;
    if (task.stages == null) {
      stages = [{ gamma, alpha }];
    } else {
      if (!Array.isArray(task.stages) || task.stages.length < 1) fail(`${taskName}.stages must be a non-empty array`);
      if (task.stageCount != null && task.stageCount !== task.stages.length) {
        fail(`${taskName}.stageCount does not match stages length`);
      }
      stages = task.stages.map((item, index) => {
        if (!item || typeof item !== 'object') fail(`${taskName}.stages[${index}] must be an object`);
        if (!Array.isArray(item.alpha) || item.alpha.length !== prototypes.length) {
          fail(`${taskName}.stages[${index}].alpha row count must match prototypes`);
        }
        return {
          gamma: positiveNumber(item.gamma, `${taskName}.stages[${index}].gamma`),
          alpha: item.alpha.map((row, rowIndex) => numericArray(row, outputSize, `${taskName}.stages[${index}].alpha[${rowIndex}]`)),
        };
      });
      // 하위호환 계약: 최상위 alpha/gamma는 1단계와 동일해야 한다.
      if (stages[0].gamma !== gamma) fail(`${taskName}.stages[0].gamma must equal hyperparameters.gamma`);
      for (let row = 0; row < alpha.length; row += 1) {
        for (let column = 0; column < outputSize; column += 1) {
          if (stages[0].alpha[row][column] !== alpha[row][column]) {
            fail(`${taskName}.stages[0].alpha must equal the top-level alpha`);
          }
        }
      }
    }
    return {
      mean,
      scale,
      prototypes,
      alpha,
      stages,
      gamma,
      gateDistance: positiveNumber(task.distanceGate && task.distanceGate.threshold, `${taskName}.gateDistance`),
    };
  }

  function squaredDistancePythonStyle(z, prototype, zNorm) {
    let prototypeNorm = 0;
    let dot = 0;
    for (let index = 0; index < FEATURE_SIZE; index += 1) {
      prototypeNorm += prototype[index] * prototype[index];
      dot += z[index] * prototype[index];
    }
    return Math.max(zNorm + prototypeNorm - 2 * dot, 0);
  }

  function correctionCap(modelDocument) {
    const value = modelDocument && modelDocument.correctionPolicy &&
      modelDocument.correctionPolicy.maximumPerLandmarkCorrectionDiagonalFraction;
    return positiveNumber(value, 'maximumPerLandmarkCorrectionDiagonalFraction');
  }

  function cumulativeCorrectionCap(modelDocument, perStageCap, stageCount) {
    // 누적 캡은 스테이지를 모두 적용한 뒤 규칙엔진 초안 기준 최대 이동량이다.
    // 모델이 선언하지 않으면 perStageCap x stageCount로 두어 학습 기본값과 일치시킨다.
    const declared = modelDocument && modelDocument.correctionPolicy &&
      modelDocument.correctionPolicy.maximumCumulativeCorrectionDiagonalFraction;
    if (declared == null) return perStageCap * stageCount;
    const value = positiveNumber(declared, 'maximumCumulativeCorrectionDiagonalFraction');
    if (value < perStageCap - EPS) fail('cumulative correction cap must be at least the per-stage cap');
    if (value > 0.25) fail('cumulative correction cap must not exceed 0.25');
    return value;
  }

  function sha256String(value, label) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) fail(`${label} must be a SHA-256 hex digest`);
    return value.toLowerCase();
  }

  function validateDeploymentPolicy(modelDocument, options) {
    const policy = options && options.deploymentPolicy;
    if (policy == null) return null;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('deploymentPolicy must be an object');
    if (policy.schemaVersion !== DEPLOYMENT_POLICY_SCHEMA) {
      fail(`unsupported deployment policy schema: ${String(policy.schemaVersion)}`);
    }
    if (typeof policy.status !== 'string' || !policy.status.trim()) fail('deployment policy status is missing');
    const status = policy.status.trim();
    if (!DEPLOYMENT_POLICY_STATUSES.has(status)) fail(`unsupported deployment policy status: ${status}`);
    if (/pending/i.test(status) && !(options && options.allowPendingPolicy === true)) {
      fail(`deployment policy status ${status} requires allowPendingPolicy=true`);
    }
    if (/rejected/i.test(status) && !(options && options.allowResearchPolicy === true)) {
      fail(`deployment policy status ${status} requires allowResearchPolicy=true`);
    }
    if (policy.modelSchemaVersion !== modelDocument.schemaVersion) fail('deployment policy model schema does not match the supplied model');
    const policyTrainingDigest = sha256String(
      policy.modelTrainingDataDigestSha256,
      'deploymentPolicy.modelTrainingDataDigestSha256',
    );
    const modelTrainingDigest = sha256String(
      modelDocument.trainingDataDigestSha256,
      'model.trainingDataDigestSha256',
    );
    if (policyTrainingDigest !== modelTrainingDigest) fail('deployment policy training-data digest does not match the supplied model');
    const policyFileSha256 = sha256String(policy.modelFileSha256, 'deploymentPolicy.modelFileSha256');
    let modelFileSha256Verified = false;
    if (options && options.modelFileSha256 != null) {
      const suppliedFileSha256 = sha256String(options.modelFileSha256, 'options.modelFileSha256');
      if (suppliedFileSha256 !== policyFileSha256) fail('deployment policy file SHA-256 does not match options.modelFileSha256');
      modelFileSha256Verified = true;
    }
    if (!policy.validation || !policy.validation.gates || policy.validation.gates.pass !== true) {
      fail('deployment policy validation gate is not passing');
    }
    let nestedValidation = null;
    if (/nested_validation/.test(status)) {
      const nested = policy.nestedValidation;
      if (!nested || typeof nested !== 'object') fail('deployment policy nestedValidation is missing');
      if (nested.schemaVersion !== 'ez-tzl-nested-deployment-policy-metrics/v1') {
        fail(`unsupported nested validation schema: ${String(nested.schemaVersion)}`);
      }
      const metricsFileSha256 = sha256String(
        nested.metricsFileSha256,
        'deploymentPolicy.nestedValidation.metricsFileSha256',
      );
      if (typeof nested.pass !== 'boolean') fail('deployment policy nestedValidation.pass must be boolean');
      if (typeof nested.decision !== 'string' || !nested.decision) {
        fail('deployment policy nestedValidation.decision is missing');
      }
      if (status === 'candidate_rejected_nested_validation' &&
          (nested.pass !== false || nested.decision !== 'do_not_promote_research_only')) {
        fail('rejected deployment policy has inconsistent nested validation result');
      }
      if (status === 'candidate_nested_validation_passed' && nested.pass !== true) {
        fail('passed deployment policy has a failing nested validation result');
      }
      let metricsFileSha256Verified = false;
      if (options && options.nestedMetricsFileSha256 != null) {
        const suppliedMetricsSha256 = sha256String(
          options.nestedMetricsFileSha256,
          'options.nestedMetricsFileSha256',
        );
        if (suppliedMetricsSha256 !== metricsFileSha256) {
          fail('deployment policy nested metrics SHA-256 does not match options.nestedMetricsFileSha256');
        }
        metricsFileSha256Verified = true;
      }
      nestedValidation = {
        schemaVersion: nested.schemaVersion,
        metricsFileSha256,
        metricsFileSha256Verified,
        pass: nested.pass,
        decision: nested.decision,
      };
    }
    const cap = policy.capPolicy;
    if (!cap || typeof cap !== 'object') fail('deployment policy capPolicy is missing');
    if (cap.space !== 'actual_pixel_diagonal') fail(`unsupported deployment cap space: ${String(cap.space)}`);
    if (cap.appliedBeforeBlend !== true) fail('deployment cap must be applied before blend');
    if (!cap.verification || cap.verification.bothTasksVerified !== true) fail('deployment cap verification is not passing');
    const maximumFraction = positiveNumber(cap.maximumFraction, 'deploymentPolicy.capPolicy.maximumFraction');
    if (maximumFraction > 0.25) fail('deployment cap maximumFraction must not exceed 0.25');
    const tasks = {};
    for (const taskName of ['width', 'ez']) {
      const task = policy.tasks && policy.tasks[taskName];
      if (!task || typeof task !== 'object') fail(`deployment policy ${taskName} task is missing`);
      const blend = number(task.blend, `deploymentPolicy.tasks.${taskName}.blend`);
      const distanceGateMultiplier = positiveNumber(
        task.distanceGateMultiplier,
        `deploymentPolicy.tasks.${taskName}.distanceGateMultiplier`,
      );
      if (blend < 0 || blend > 1) fail(`deployment policy ${taskName} blend must be in [0,1]`);
      if (distanceGateMultiplier > 1) fail(`deployment policy ${taskName} distanceGateMultiplier must not exceed 1`);
      tasks[taskName] = { blend, distanceGateMultiplier };
    }
    return {
      schemaVersion: policy.schemaVersion,
      status,
      modelSchemaVersion: policy.modelSchemaVersion,
      modelTrainingDataDigestSha256: policyTrainingDigest,
      modelFileSha256: policyFileSha256,
      modelFileSha256Verified,
      nestedValidation,
      maximumFraction,
      tasks,
      productionIntegrationAuthorized: Boolean(
        policy.deployment && policy.deployment.productionIntegrationAuthorized === true
      ),
    };
  }

  function clipCorrectionPairs(correction, maximumFraction, aspect, policy) {
    const result = correction.slice();
    for (let index = 0; index < result.length; index += 2) {
      const dx = result[index];
      const dy = result[index + 1];
      let magnitude;
      let maximum;
      if (policy === CAP_POLICIES.LEGACY_AXIS_NORMALIZED) {
        // Exact train_residual.py v1 behaviour.  Despite the historical JSON
        // name, this is 0.05*sqrt(2) in axis-normalised coordinate space.
        magnitude = Math.hypot(dx, dy);
        maximum = maximumFraction * SQRT2;
      } else if (policy === CAP_POLICIES.PIXEL_DIAGONAL) {
        // Pixel distance divided by image height.  This makes the cap exactly
        // maximumFraction of sqrt(width^2+height^2) for every aspect ratio.
        magnitude = Math.hypot(dx * aspect, dy);
        maximum = maximumFraction * Math.hypot(aspect, 1);
      } else {
        fail(`unknown correctionCapPolicy: ${policy}`);
      }
      const factor = Math.min(1, maximum / Math.max(magnitude, EPS));
      result[index] *= factor;
      result[index + 1] *= factor;
    }
    return result;
  }

  function unflattenPoints(values) {
    const result = [];
    for (let index = 0; index < values.length; index += 2) result.push([values[index], values[index + 1]]);
    return result;
  }

  function pixelsFromNormalized(points, width, height) {
    return points.map((item) => [item[0] * width, item[1] * height]);
  }

  function predictCanonicalTask(modelDocument, taskName, canonical, featureVector, options, deploymentRuntime) {
    if (!Object.prototype.hasOwnProperty.call(TASK_POINT_COUNTS, taskName)) fail(`unsupported task: ${taskName}`);
    if (deploymentRuntime && options && options.correctionCapPolicy &&
        options.correctionCapPolicy !== CAP_POLICIES.PIXEL_DIAGONAL) {
      fail('deploymentPolicy requires the pixel-diagonal correction cap');
    }
    const policy = deploymentRuntime
      ? CAP_POLICIES.PIXEL_DIAGONAL
      : options && options.correctionCapPolicy
        ? options.correctionCapPolicy
        : CAP_POLICIES.LEGACY_AXIS_NORMALIZED;
    const taskPolicy = deploymentRuntime
      ? deploymentRuntime.tasks[taskName]
      : { blend: 1, distanceGateMultiplier: 1 };
    const model = taskModel(modelDocument, taskName);
    const z = featureVector.map((value, index) => (value - model.mean[index]) / model.scale[index]);
    let zNorm = 0;
    for (const value of z) zNorm += value * value;
    const distances = model.prototypes.map((prototype) => squaredDistancePythonStyle(z, prototype, zNorm));
    let nearestSquared = Infinity;
    for (const value of distances) nearestSquared = Math.min(nearestSquared, value);
    const nearestDistance = Math.sqrt(nearestSquared);
    const effectiveGateThreshold = model.gateDistance * taskPolicy.distanceGateMultiplier;
    const accepted = nearestDistance <= effectiveGateThreshold;
    const outputSize = TASK_POINT_COUNTS[taskName] * 2;
    const perStageCap = deploymentRuntime ? deploymentRuntime.maximumFraction : correctionCap(modelDocument);
    const aspect = canonical.width / canonical.height;
    const cumulativeCap = cumulativeCorrectionCap(modelDocument, perStageCap, model.stages.length);
    const baseline = taskName === 'width' ? flattenPoints(canonical.widthPoints) : flattenPoints(canonical.ezPoints);

    // 스테이지 k는 k-1까지 적용된 예측을 baseline으로 삼아 다시 잔차를 더한다.
    // train_residual.py의 fit_stages/predict_stages와 같은 순서를 지킨다:
    //   per-stage clip → 단위정사각 클램프 → 누적 clip → 클램프.
    //
    // 배포정책의 blend는 스테이지 안이 아니라 '누적 보정량'에 곱한다. 학습(fit_stages)은
    // blend 개념 없이 스테이지를 쌓으므로, blend를 스테이지마다 곱하면 2단계 이후의
    // baseline이 학습 때와 달라져 모델이 가정한 잔차 분포를 벗어난다. 누적 보정에
    // 곱하면 blend=1에서 학습과 정확히 일치하고, blend<1은 그 보정을 축소만 하므로
    // 누적 캡도 그대로 성립한다.
    let staged = baseline.slice();
    for (let stageIndex = 0; stageIndex < model.stages.length; stageIndex += 1) {
      const stage = model.stages[stageIndex];
      const correction = new Array(outputSize).fill(0);
      for (let row = 0; row < distances.length; row += 1) {
        const kernel = Math.exp(-stage.gamma * distances[row]);
        for (let column = 0; column < outputSize; column += 1) correction[column] += kernel * stage.alpha[row][column];
      }
      const stageCorrection = clipCorrectionPairs(correction, perStageCap, aspect, policy);
      const stepped = staged.map((value, index) => Math.min(1, Math.max(0, value + stageCorrection[index])));
      const cumulative = clipCorrectionPairs(
        stepped.map((value, index) => value - baseline[index]),
        cumulativeCap,
        aspect,
        policy,
      );
      staged = baseline.map((value, index) => Math.min(1, Math.max(0, value + cumulative[index])));
    }
    const appliedCorrection = staged.map((value, index) => (accepted ? (value - baseline[index]) * taskPolicy.blend : 0));
    const prediction = baseline.map((value, index) => Math.min(1, Math.max(0, value + appliedCorrection[index])));
    const normalizedPoints = unflattenPoints(prediction);
    const pixelPoints = pixelsFromNormalized(normalizedPoints, canonical.width, canonical.height);
    const maximumFraction = deploymentRuntime ? deploymentRuntime.maximumFraction : correctionCap(modelDocument);
    return {
      accepted,
      nearestDistance,
      baselineFallback: !accepted,
      normalizedPoints,
      pixelPoints,
      metadata: {
        accepted,
        nearestDistance,
        baselineFallback: !accepted,
        modelVersion: modelDocument.schemaVersion || null,
        trainingDataDigestSha256: modelDocument.trainingDataDigestSha256 || null,
        task: taskName,
        correctionCapPolicy: policy,
        maximumCorrectionFraction: maximumFraction,
        stageCount: model.stages.length,
        maximumCumulativeCorrectionFraction: cumulativeCap,
        axisNormalizedRadius: policy === CAP_POLICIES.LEGACY_AXIS_NORMALIZED ? maximumFraction * SQRT2 : null,
        blend: taskPolicy.blend,
        distanceGateMultiplier: taskPolicy.distanceGateMultiplier,
        originalDistanceGateThreshold: model.gateDistance,
        effectiveDistanceGateThreshold: effectiveGateThreshold,
        distanceGateThreshold: effectiveGateThreshold,
        deploymentPolicySchemaVersion: deploymentRuntime ? deploymentRuntime.schemaVersion : null,
        deploymentPolicyStatus: deploymentRuntime ? deploymentRuntime.status : null,
        deploymentModelFileSha256: deploymentRuntime ? deploymentRuntime.modelFileSha256 : null,
        deploymentModelFileSha256Verified: deploymentRuntime ? deploymentRuntime.modelFileSha256Verified : false,
        nestedValidationSchemaVersion: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.schemaVersion
          : null,
        nestedMetricsFileSha256: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.metricsFileSha256
          : null,
        nestedMetricsFileSha256Verified: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.metricsFileSha256Verified
          : false,
        nestedValidationPass: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.pass
          : null,
        nestedValidationDecision: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.decision
          : null,
        productionIntegrationAuthorized: deploymentRuntime
          ? deploymentRuntime.productionIntegrationAuthorized
          : null,
      },
    };
  }

  function predictResidualTask(modelDocument, taskName, draft, options) {
    const canonical = canonicalBaseline(draft);
    const featureVector = featureVectorFromCanonical(canonical);
    const normalizedOptions = options || {};
    const deploymentRuntime = validateDeploymentPolicy(modelDocument, normalizedOptions);
    return predictCanonicalTask(
      modelDocument,
      taskName,
      canonical,
      featureVector,
      normalizedOptions,
      deploymentRuntime,
    );
  }

  function applyResidualModel(modelDocument, draft, options) {
    const canonical = canonicalBaseline(draft);
    const featureVector = featureVectorFromCanonical(canonical);
    const normalizedOptions = options || {};
    const deploymentRuntime = validateDeploymentPolicy(modelDocument, normalizedOptions);
    const widthResult = predictCanonicalTask(
      modelDocument, 'width', canonical, featureVector, normalizedOptions, deploymentRuntime
    );
    const ezResult = predictCanonicalTask(
      modelDocument, 'ez', canonical, featureVector, normalizedOptions, deploymentRuntime
    );
    const centersPixels = pixelsFromNormalized(canonical.centers, canonical.width, canonical.height);
    const toothWidths = [];
    for (let index = 0; index < widthResult.pixelPoints.length; index += 2) {
      toothWidths.push({
        p1: pointObject(widthResult.pixelPoints[index]),
        p2: pointObject(widthResult.pixelPoints[index + 1]),
      });
    }
    const outputDraft = {
      imageWidth: canonical.width,
      imageHeight: canonical.height,
      toothWidths,
      ezPoints: ezResult.pixelPoints.map(pointObject),
      toothCenters: centersPixels.map(pointObject),
    };
    return {
      draft: outputDraft,
      tasks: { width: widthResult, ez: ezResult },
      metadata: {
        modelVersion: modelDocument.schemaVersion || null,
        trainingDataDigestSha256: modelDocument.trainingDataDigestSha256 || null,
        featureVersion: modelDocument.featureSpec && modelDocument.featureSpec.version || null,
        featureSize: featureVector.length,
        correctionCapPolicy: widthResult.metadata.correctionCapPolicy,
        deploymentPolicySchemaVersion: deploymentRuntime ? deploymentRuntime.schemaVersion : null,
        deploymentPolicyStatus: deploymentRuntime ? deploymentRuntime.status : null,
        deploymentModelFileSha256: deploymentRuntime ? deploymentRuntime.modelFileSha256 : null,
        deploymentModelFileSha256Verified: deploymentRuntime
          ? deploymentRuntime.modelFileSha256Verified
          : false,
        nestedValidationSchemaVersion: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.schemaVersion
          : null,
        nestedMetricsFileSha256: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.metricsFileSha256
          : null,
        nestedMetricsFileSha256Verified: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.metricsFileSha256Verified
          : false,
        nestedValidationPass: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.pass
          : null,
        nestedValidationDecision: deploymentRuntime && deploymentRuntime.nestedValidation
          ? deploymentRuntime.nestedValidation.decision
          : null,
        productionIntegrationAuthorized: deploymentRuntime
          ? deploymentRuntime.productionIntegrationAuthorized
          : null,
        width: widthResult.metadata,
        ez: ezResult.metadata,
      },
    };
  }

  return Object.freeze({
    FEATURE_SIZE,
    DEPLOYMENT_POLICY_SCHEMA,
    CAP_POLICIES,
    buildFeatureVector,
    predictResidualTask,
    applyResidualModel,
  });
}));
