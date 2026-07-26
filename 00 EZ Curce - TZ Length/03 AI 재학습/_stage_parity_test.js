'use strict';

/*
 * 다단(반복) 잔차보정의 JS↔Python 비트 동등성 검사.
 *
 * _stage_parity.py가 train_residual.predict_stages로 만든 기준값과
 * residual_inference.js의 스테이지 루프 출력을 비교한다. 캡 정책은
 * legacy-axis-normalized(=train_residual.clip_corrections와 동일 식)를 쓴다.
 *
 * 1단계 모델(stages 없음)과 2단계 모델을 모두 검사하므로 하위호환도 함께 확인된다.
 */

const fs = require('fs');
const path = require('path');
const inference = require('./residual_inference.js');

const ROOT = __dirname;
const TOLERANCE = 1e-12;

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

const state = { compared: 0, maximumDifference: 0 };

function compareNumber(actual, expected, label) {
  assert(Number.isFinite(actual), `${label}: JS value is not finite`);
  assert(Number.isFinite(expected), `${label}: Python value is not finite`);
  const difference = Math.abs(actual - expected);
  state.maximumDifference = Math.max(state.maximumDifference, difference);
  state.compared += 1;
  if (difference > TOLERANCE) {
    throw new Error(`${label}: |JS-Python|=${difference} > ${TOLERANCE} (JS=${actual}, Python=${expected})`);
  }
}

function zeroAlphaModel(model) {
  const copy = JSON.parse(JSON.stringify(model));
  for (const task of Object.values(copy.tasks)) {
    task.alpha = task.alpha.map((row) => row.map(() => 0));
    if (Array.isArray(task.stages)) {
      task.stages = task.stages.map((stage) => ({ ...stage, alpha: stage.alpha.map((row) => row.map(() => 0)) }));
    }
  }
  return copy;
}

function runFixture(fixturePath, modelPath) {
  const fixture = readJson(fixturePath);
  const model = readJson(modelPath);
  assert(fixture.schemaVersion === 'ez-tzl-staged-parity/v1', `${fixture.label}: unexpected fixture schema`);
  assert(fixture.modelVersion === model.schemaVersion, `${fixture.label}: fixture/model schema mismatch`);
  assert(fixture.capPolicy === inference.CAP_POLICIES.LEGACY_AXIS_NORMALIZED, `${fixture.label}: cap policy mismatch`);
  assert(fixture.cases.length >= 10, `${fixture.label}: at least 10 parity cases are required`);

  const acceptance = { accepted: 0, fallback: 0 };
  let fallbackExact = 0;
  for (const fixtureCase of fixture.cases) {
    const feature = inference.buildFeatureVector(fixtureCase.input);
    assert(feature.length === inference.FEATURE_SIZE, `${fixtureCase.caseId}: feature size differs`);
    for (let index = 0; index < feature.length; index += 1) {
      compareNumber(feature[index], fixtureCase.expectedFeatureVector[index], `${fixtureCase.caseId}.feature[${index}]`);
    }

    const result = inference.applyResidualModel(model, fixtureCase.input, {
      correctionCapPolicy: inference.CAP_POLICIES.LEGACY_AXIS_NORMALIZED,
    });
    for (const task of ['width', 'ez']) {
      const actual = result.tasks[task];
      const expected = fixtureCase.expected[task];
      assert(actual.accepted === expected.accepted, `${fixtureCase.caseId}.${task}: gate decision differs (JS=${actual.accepted}, Python=${expected.accepted})`);
      assert(actual.baselineFallback === !expected.accepted, `${fixtureCase.caseId}.${task}: fallback flag differs`);
      assert(actual.metadata.stageCount === fixture.stageCount, `${fixtureCase.caseId}.${task}: stageCount metadata differs`);
      compareNumber(actual.metadata.maximumCorrectionFraction, fixture.perStageCap, `${fixtureCase.caseId}.${task}.perStageCap`);
      compareNumber(actual.metadata.maximumCumulativeCorrectionFraction, fixture.cumulativeCap, `${fixtureCase.caseId}.${task}.cumulativeCap`);
      compareNumber(actual.nearestDistance, expected.nearestDistance, `${fixtureCase.caseId}.${task}.nearestDistance`);
      assert(actual.normalizedPoints.length === expected.normalizedPoints.length, `${fixtureCase.caseId}.${task}: point count differs`);
      for (let index = 0; index < expected.normalizedPoints.length; index += 1) {
        compareNumber(actual.normalizedPoints[index][0], expected.normalizedPoints[index][0], `${fixtureCase.caseId}.${task}[${index}].x`);
        compareNumber(actual.normalizedPoints[index][1], expected.normalizedPoints[index][1], `${fixtureCase.caseId}.${task}[${index}].y`);
      }
      acceptance[expected.accepted ? 'accepted' : 'fallback'] += 1;
    }

    if (fixtureCase.syntheticOutlier === true) {
      // 미숙지 입력은 규칙엔진 초안을 비트 단위로 그대로 되돌려야 한다.
      // 초안 기준값은 alpha=0 모델(보정량이 항상 0)을 같은 코드경로로 통과시켜 얻는다.
      // Python이 계산한 초안과 직접 비교하면 극단적 합성 형상에서 정규화 부동소수
      // 잡음(~1e-15)이 섞여 폴백 자체의 정확성을 검증할 수 없기 때문이다.
      // (Python 대비 좌표 일치는 위의 normalizedPoints 비교에서 이미 확인했다.)
      const zeroAlpha = zeroAlphaModel(model);
      const draftResult = inference.applyResidualModel(zeroAlpha, fixtureCase.input, {
        correctionCapPolicy: inference.CAP_POLICIES.LEGACY_AXIS_NORMALIZED,
      });
      for (const task of ['width', 'ez']) {
        const points = draftResult.tasks[task].normalizedPoints;
        const actual = result.tasks[task].normalizedPoints;
        assert(actual.length === points.length, `${fixtureCase.caseId}.${task}: fallback point count differs`);
        for (let index = 0; index < points.length; index += 1) {
          assert(actual[index][0] === points[index][0] && actual[index][1] === points[index][1],
            `${fixtureCase.caseId}.${task}[${index}]: unfamiliar fallback is not the exact rule-engine draft`);
        }
        fallbackExact += 1;
      }
    }
  }
  assert(acceptance.accepted >= 10, `${fixture.label}: accepted path was not exercised enough`);
  assert(acceptance.fallback >= 2, `${fixture.label}: both task fallback paths were not exercised`);
  assert(fallbackExact === 2, `${fixture.label}: synthetic outlier case is missing`);
  return { label: fixture.label, stageCount: fixture.stageCount, cases: fixture.cases.length, acceptance };
}

function guardTests() {
  const model = readJson(path.join(ROOT, 'residual-model.json'));
  // 게이트 계약 위반은 형상 파싱 이후 단계에서 걸러져야 하므로 유효한 입력을 쓴다.
  const input = readJson(path.join(ROOT, '_stage_parity_two.json')).cases[0].input;

  // 하위호환 계약: stages[0]는 최상위 alpha/gamma와 동일해야 한다.
  const brokenGamma = JSON.parse(JSON.stringify(model));
  brokenGamma.tasks.width.stages[0].gamma *= 1.5;
  assertThrows(
    () => inference.applyResidualModel(brokenGamma, input),
    /stages\[0\]\.gamma must equal hyperparameters\.gamma/,
    'stage gamma contract',
  );
  const brokenAlpha = JSON.parse(JSON.stringify(model));
  brokenAlpha.tasks.width.stages[0].alpha[0][0] += 1e-9;
  brokenAlpha.tasks.width.stageCount = 2;
  assertThrows(
    () => inference.applyResidualModel(brokenAlpha, input),
    /stages\[0\]\.alpha must equal the top-level alpha/,
    'stage alpha contract',
  );
  const brokenCount = JSON.parse(JSON.stringify(model));
  brokenCount.tasks.width.stageCount = 3;
  assertThrows(
    () => inference.applyResidualModel(brokenCount, input),
    /stageCount does not match stages length/,
    'stageCount consistency',
  );
  const tooLoose = JSON.parse(JSON.stringify(model));
  tooLoose.correctionPolicy.maximumCumulativeCorrectionDiagonalFraction = 0.4;
  assertThrows(
    () => inference.applyResidualModel(tooLoose, input),
    /cumulative correction cap must not exceed 0\.25/,
    'cumulative cap ceiling',
  );
  const tooTight = JSON.parse(JSON.stringify(model));
  tooTight.correctionPolicy.maximumCumulativeCorrectionDiagonalFraction = 0.01;
  assertThrows(
    () => inference.applyResidualModel(tooTight, input),
    /cumulative correction cap must be at least the per-stage cap/,
    'cumulative cap floor',
  );
  return 5;
}

function main() {
  const results = [
    runFixture(path.join(ROOT, '_stage_parity_single.json'), path.join(ROOT, 'residual-model.before-stage2-20260727.json.bak')),
    runFixture(path.join(ROOT, '_stage_parity_two.json'), path.join(ROOT, 'residual-model.json')),
  ];
  const guards = guardTests();
  assert(state.maximumDifference <= TOLERANCE, `maximum parity difference exceeds ${TOLERANCE}`);
  process.stdout.write(`${JSON.stringify({
    pass: true,
    fixtures: results,
    failClosedGuardsExercised: guards,
    comparedNumericValues: state.compared,
    maximumAbsoluteDifference: state.maximumDifference,
    tolerance: TOLERANCE,
  }, null, 2)}\n`);
}

main();
