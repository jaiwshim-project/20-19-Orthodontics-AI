'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const inference = require('./residual_inference.js');

const ROOT = __dirname;
const MODEL_PATH = path.join(ROOT, 'residual-model.json');
const FIXTURE_PATH = path.join(ROOT, 'residual-parity-fixture.json');
const POLICY_PATH = path.join(ROOT, 'residual-deployment-policy.json');
const TOLERANCE = 1e-9;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(action, pattern, label) {
  let error = null;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, `${label}: expected an exception`);
  assert(pattern.test(error.message), `${label}: unexpected error: ${error.message}`);
}

let maximumAbsoluteDifference = 0;
let comparedNumericValues = 0;

function compareNumber(actual, expected, label) {
  assert(Number.isFinite(actual), `${label}: JS result is not finite`);
  assert(Number.isFinite(expected), `${label}: Python reference is not finite`);
  const difference = Math.abs(actual - expected);
  maximumAbsoluteDifference = Math.max(maximumAbsoluteDifference, difference);
  comparedNumericValues += 1;
  if (difference > TOLERANCE) {
    throw new Error(`${label}: |JS-Python|=${difference} exceeds ${TOLERANCE}; JS=${actual}, Python=${expected}`);
  }
}

function comparePoints(actual, expected, label) {
  assert(Array.isArray(actual) && actual.length === expected.length, `${label}: point count differs`);
  for (let index = 0; index < expected.length; index += 1) {
    const actualPoint = Array.isArray(actual[index]) ? actual[index] : [actual[index].x, actual[index].y];
    compareNumber(actualPoint[0], expected[index][0], `${label}[${index}].x`);
    compareNumber(actualPoint[1], expected[index][1], `${label}[${index}].y`);
  }
}

function flattenWidthDraft(widths) {
  return widths.flatMap((item) => [[item.p1.x, item.p1.y], [item.p2.x, item.p2.y]]);
}

function browserGlobalSmokeTest() {
  const source = fs.readFileSync(path.join(ROOT, 'residual_inference.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'residual_inference.js' });
  assert(sandbox.EzResidualInference, 'browser global EzResidualInference was not created');
  assert(typeof sandbox.EzResidualInference.applyResidualModel === 'function', 'browser global API is incomplete');
  assert(sandbox.EzResidualInference.FEATURE_SIZE === 169, 'browser global feature size differs');
}

function main() {
  const model = readJson(MODEL_PATH);
  const fixture = readJson(FIXTURE_PATH);
  const deploymentPolicy = readJson(POLICY_PATH);
  assert(model.schemaVersion === fixture.modelVersion, 'fixture/model schema mismatch');
  assert(model.trainingDataDigestSha256 === fixture.trainingDataDigestSha256, 'fixture/model digest mismatch');
  assert(fixture.caseCount >= 10 && fixture.cases.length >= 10, 'at least 10 parity cases are required');
  assert(inference.FEATURE_SIZE === 169, 'JS feature size must be 169');
  assert(inference.DEPLOYMENT_POLICY_SCHEMA === fixture.deploymentPolicySchemaVersion, 'JS deployment policy schema differs');
  browserGlobalSmokeTest();

  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, { deploymentPolicy }),
    /requires allowResearchPolicy=true/,
    'rejected policy fail-closed guard',
  );
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy,
      allowPendingPolicy: true,
    }),
    /requires allowResearchPolicy=true/,
    'allowPending cannot open a rejected research policy',
  );
  const pendingPolicy = JSON.parse(JSON.stringify(deploymentPolicy));
  pendingPolicy.status = 'candidate_pending_nested_validation';
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, { deploymentPolicy: pendingPolicy }),
    /requires allowPendingPolicy=true/,
    'pending policy fail-closed guard',
  );
  const badDigestPolicy = JSON.parse(JSON.stringify(deploymentPolicy));
  badDigestPolicy.modelTrainingDataDigestSha256 = '0'.repeat(64);
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy: badDigestPolicy,
      allowResearchPolicy: true,
    }),
    /digest does not match/,
    'model digest fail-closed guard',
  );
  const badSchemaPolicy = JSON.parse(JSON.stringify(deploymentPolicy));
  badSchemaPolicy.schemaVersion = 'ez-tzl-residual-deployment-policy/unknown';
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy: badSchemaPolicy,
      allowResearchPolicy: true,
    }),
    /unsupported deployment policy schema/,
    'policy schema fail-closed guard',
  );
  const badStatusPolicy = JSON.parse(JSON.stringify(deploymentPolicy));
  badStatusPolicy.status = 'unreviewed_unknown_state';
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy: badStatusPolicy,
      allowResearchPolicy: true,
    }),
    /unsupported deployment policy status/,
    'policy status fail-closed guard',
  );
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy,
      allowResearchPolicy: true,
      modelFileSha256: 'f'.repeat(64),
    }),
    /file SHA-256 does not match/,
    'model file SHA-256 fail-closed guard',
  );
  assertThrows(
    () => inference.applyResidualModel(model, fixture.cases[0].input, {
      deploymentPolicy,
      allowResearchPolicy: true,
      modelFileSha256: fixture.modelFileSha256,
      nestedMetricsFileSha256: 'e'.repeat(64),
    }),
    /nested metrics SHA-256 does not match/,
    'nested metrics SHA-256 fail-closed guard',
  );

  let taskEvaluations = 0;
  const policyAcceptance = {};
  for (const policy of [
    inference.CAP_POLICIES.LEGACY_AXIS_NORMALIZED,
    inference.CAP_POLICIES.PIXEL_DIAGONAL,
  ]) {
    policyAcceptance[policy] = { accepted: 0, fallback: 0 };
    for (const fixtureCase of fixture.cases) {
      const feature = inference.buildFeatureVector(fixtureCase.input);
      assert(feature.length === 169, `${fixtureCase.fixtureId}: feature size differs`);
      for (let index = 0; index < feature.length; index += 1) {
        compareNumber(feature[index], fixtureCase.expectedFeatureVector[index], `${fixtureCase.fixtureId}.feature[${index}]`);
      }

      const result = inference.applyResidualModel(model, fixtureCase.input, { correctionCapPolicy: policy });
      assert(result.metadata.modelVersion === fixture.modelVersion, `${fixtureCase.fixtureId}: model version metadata differs`);
      assert(result.metadata.correctionCapPolicy === policy, `${fixtureCase.fixtureId}: cap policy metadata differs`);
      assert(result.metadata.featureSize === 169, `${fixtureCase.fixtureId}: output feature size metadata differs`);
      const expectedPolicy = fixtureCase.expected[policy];
      for (const task of ['width', 'ez']) {
        const actual = result.tasks[task];
        const expected = expectedPolicy[task];
        assert(actual.accepted === expected.accepted, `${fixtureCase.fixtureId}.${policy}.${task}: gate decision differs`);
        assert(actual.baselineFallback === !expected.accepted, `${fixtureCase.fixtureId}.${policy}.${task}: fallback flag differs`);
        assert(actual.metadata.modelVersion === fixture.modelVersion, `${fixtureCase.fixtureId}.${policy}.${task}: task model version differs`);
        assert(actual.metadata.correctionCapPolicy === policy, `${fixtureCase.fixtureId}.${policy}.${task}: task cap policy differs`);
        compareNumber(actual.nearestDistance, expected.nearestDistance, `${fixtureCase.fixtureId}.${policy}.${task}.nearestDistance`);
        comparePoints(actual.normalizedPoints, expected.normalizedPoints, `${fixtureCase.fixtureId}.${policy}.${task}.normalized`);
        comparePoints(actual.pixelPoints, expected.pixelPoints, `${fixtureCase.fixtureId}.${policy}.${task}.pixels`);
        policyAcceptance[policy][expected.accepted ? 'accepted' : 'fallback'] += 1;
        taskEvaluations += 1;
      }
      comparePoints(flattenWidthDraft(result.draft.toothWidths), expectedPolicy.width.pixelPoints, `${fixtureCase.fixtureId}.${policy}.draft.width`);
      comparePoints(result.draft.ezPoints, expectedPolicy.ez.pixelPoints, `${fixtureCase.fixtureId}.${policy}.draft.ez`);
    }
  }

  const deploymentMode = 'deployment-policy';
  policyAcceptance[deploymentMode] = { accepted: 0, fallback: 0 };
  const boundaryRolesSeen = new Set();
  for (const fixtureCase of fixture.cases) {
    for (const role of fixtureCase.deploymentGateBoundaryRoles || []) boundaryRolesSeen.add(role);
    const result = inference.applyResidualModel(model, fixtureCase.input, {
      deploymentPolicy,
      allowResearchPolicy: true,
      modelFileSha256: fixture.modelFileSha256,
      nestedMetricsFileSha256: fixture.nestedValidation.metricsFileSha256,
    });
    assert(result.metadata.deploymentPolicySchemaVersion === fixture.deploymentPolicySchemaVersion,
      `${fixtureCase.fixtureId}: deployment schema metadata differs`);
    assert(result.metadata.deploymentPolicyStatus === fixture.deploymentPolicyStatus,
      `${fixtureCase.fixtureId}: deployment status metadata differs`);
    assert(result.metadata.deploymentModelFileSha256Verified === true,
      `${fixtureCase.fixtureId}: model file SHA-256 was not verified`);
    assert(result.metadata.nestedMetricsFileSha256Verified === true,
      `${fixtureCase.fixtureId}: nested metrics SHA-256 was not verified`);
    assert(result.metadata.nestedValidationPass === false,
      `${fixtureCase.fixtureId}: rejected nested validation pass metadata differs`);
    assert(result.metadata.nestedValidationDecision === 'do_not_promote_research_only',
      `${fixtureCase.fixtureId}: nested validation decision metadata differs`);
    assert(result.metadata.correctionCapPolicy === inference.CAP_POLICIES.PIXEL_DIAGONAL,
      `${fixtureCase.fixtureId}: deployment cap is not pixel-diagonal`);
    const expectedPolicy = fixtureCase.expected[deploymentMode];
    for (const task of ['width', 'ez']) {
      const actual = result.tasks[task];
      const expected = expectedPolicy[task];
      assert(actual.accepted === expected.accepted,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}: gate decision differs`);
      assert(actual.baselineFallback === !expected.accepted,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}: fallback flag differs`);
      assert(actual.metadata.deploymentPolicyStatus === fixture.deploymentPolicyStatus,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}: policy status differs`);
      assert(actual.metadata.correctionCapPolicy === inference.CAP_POLICIES.PIXEL_DIAGONAL,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}: cap policy differs`);
      compareNumber(actual.metadata.blend, expected.blend,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.blend`);
      compareNumber(actual.metadata.distanceGateMultiplier, expected.distanceGateMultiplier,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.gateMultiplier`);
      compareNumber(actual.metadata.effectiveDistanceGateThreshold, expected.effectiveDistanceGateThreshold,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.effectiveGate`);
      compareNumber(actual.nearestDistance, expected.nearestDistance,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.nearestDistance`);
      comparePoints(actual.normalizedPoints, expected.normalizedPoints,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.normalized`);
      comparePoints(actual.pixelPoints, expected.pixelPoints,
        `${fixtureCase.fixtureId}.${deploymentMode}.${task}.pixels`);
      policyAcceptance[deploymentMode][expected.accepted ? 'accepted' : 'fallback'] += 1;
      taskEvaluations += 1;
    }
    comparePoints(flattenWidthDraft(result.draft.toothWidths), expectedPolicy.width.pixelPoints,
      `${fixtureCase.fixtureId}.${deploymentMode}.draft.width`);
    comparePoints(result.draft.ezPoints, expectedPolicy.ez.pixelPoints,
      `${fixtureCase.fixtureId}.${deploymentMode}.draft.ez`);
  }

  for (const requiredRole of ['width-inside', 'width-outside', 'ez-inside', 'ez-outside']) {
    assert(boundaryRolesSeen.has(requiredRole), `deployment gate boundary role not covered: ${requiredRole}`);
  }
  assert(taskEvaluations >= 60, 'expected at least 10 cases x 2 tasks x 3 policies');
  for (const policy of Object.keys(policyAcceptance)) {
    const minimumAccepted = policy === deploymentMode ? 10 : 20;
    assert(policyAcceptance[policy].accepted >= minimumAccepted, `${policy}: independent accepted cases were not exercised`);
    assert(policyAcceptance[policy].fallback >= 2, `${policy}: both task fallback paths were not exercised`);
  }
  assert(maximumAbsoluteDifference <= TOLERANCE, `maximum parity difference exceeds ${TOLERANCE}`);
  process.stdout.write(`${JSON.stringify({
    pass: true,
    cases: fixture.cases.length,
    taskEvaluations,
    policies: Object.keys(policyAcceptance),
    policyAcceptance,
    comparedNumericValues,
    maximumAbsoluteDifference,
    tolerance: TOLERANCE,
    browserGlobalSmoke: true,
  }, null, 2)}\n`);
}

main();
