#!/usr/bin/env node
'use strict';

/*
 * 연구용 HTML에 **박혀 있는** 잔차모델 + 추론엔진을 HTML에서 직접 뜯어내 검증한다.
 *
 * 왜 별도 검사가 필요한가: HTML은 모델 사본과 추론엔진 사본을 둘 다 품는다.
 * 모델만 갈아끼우면 엔진이 구버전이라 다단 보정이 조용히 1단계로 동작해도
 * 아무 에러가 나지 않는다([[project-embedded-engine-staleness]]).
 * `_stage_parity_test.js`는 리포지토리의 residual_inference.js를 검사할 뿐이므로
 * HTML 내부 사본이 같다는 보장은 주지 않는다.
 *
 * 검사 항목:
 *   1) HTML에서 추출한 모델 JSON == 03 AI 재학습/residual-model.json (직렬화 동등)
 *   2) HTML에서 추출한 UMD 엔진 == residual_inference.js의 UMD 블록 (문자 동등)
 *   3) 추출한 엔진 + 추출한 모델로 3단계 패리티 픽스처를 통과 (Python 기준값 비트 동등)
 *   4) 추출한 모델의 stageCount / 캡 / 학습 표본 수가 선언과 일치
 *   5) HTML의 WIDTH_BIAS 상수값 확인
 *   6) 운영 HTML(보정 전) SHA-256 불변 확인 — 연구용 작업이 운영본을 건드리지 않았음
 *
 * 출력에 PHI·좌표·모델 파라미터 없음.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createHash } = require('crypto');

const HERE = __dirname;
const PROJECT_DIR = path.resolve(HERE, '..');
const RESEARCH_HTML = path.join(PROJECT_DIR, 'EZ Curve - TZ Length - 보정 후 알고리즘 적용.html');
const PRODUCTION_HTML = path.join(PROJECT_DIR, 'EZ Curve - TZ Length - 보정 전 알고리즘 적용.html');
const PRODUCTION_SHA = '6ee351135a8e31f9960fd1a223f65d33e50c6df9204d31e349f9a30cdf712197';
const PRODUCTION_BYTES = 89330;
const FIXTURE = path.join(HERE, '_stage_parity_three.json');
const MODEL_FILE = path.join(HERE, 'residual-model.json');
const ENGINE_FILE = path.join(HERE, 'residual_inference.js');
const TOLERANCE = 1e-12;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// embed_model.py와 동일한 경계 판정을 쓴다. 여기서만 다르게 잘라내면
// "심었는데 검사에서는 다른 것을 본다"가 되어 검증 자체가 무의미해진다.
function extractModelJson(text) {
  const marker = 'window.EZ_RESIDUAL_MODEL=';
  assert(text.split(marker).length - 1 === 1, 'HTML must contain exactly one model marker');
  const brace = text.indexOf('{', text.indexOf(marker));
  const anchor = text.indexOf('\n}\n;\n</script>', brace);
  assert(anchor > brace, 'model end anchor not found');
  return text.slice(brace, anchor + '\n}'.length);
}

function extractEngineBlock(text) {
  const marker = '(function universalModule(';
  const start = text.indexOf(marker);
  assert(start >= 0, 'HTML must contain the UMD inference engine');
  assert(text.indexOf(marker, start + 1) < 0, 'HTML must contain exactly one UMD engine block');
  const end = text.indexOf('\n}));', start);
  assert(end > start, 'UMD engine end anchor not found');
  return text.slice(start, end + '\n}));'.length);
}

function loadEngineFromSource(source, label) {
  // 브라우저 사본을 그대로 평가한다. module 객체를 주지 않으면 UMD가 root에 붙는다.
  const sandbox = { globalThis: {}, console: { warn() {}, log() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: label }).runInContext(sandbox);
  const api = sandbox.EzResidualInference;
  assert(api && typeof api.applyResidualModel === 'function', `${label}: engine did not export applyResidualModel`);
  return api;
}

// HTML은 CRLF로 저장된다(Python이 write_text로 쓰면서 os.linesep로 변환). Python 쪽은
// read_text가 개행을 LF로 번역해 읽으므로, JS에서도 같은 정규화를 해야 같은 경계를 본다.
function normalizeNewlines(text) {
  // CR(13)을 문자코드로 다루는 이유: 이 파일을 생성/패치하는 도구 사슬에서
  // 이스케이프가 실제 개행으로 접히는 사고가 있었다. 코드값이 가장 안전하다.
  return text.split(String.fromCharCode(13)).join('');
}

function main() {
  const researchText = normalizeNewlines(fs.readFileSync(RESEARCH_HTML, 'utf8'));
  const modelJson = extractModelJson(researchText);
  const engineSource = extractEngineBlock(researchText);

  const embeddedModel = JSON.parse(modelJson);
  const fileModel = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  const modelMatches = JSON.stringify(embeddedModel) === JSON.stringify(fileModel);

  const fileEngine = normalizeNewlines(fs.readFileSync(ENGINE_FILE, 'utf8'));
  const fileEngineBlock = extractEngineBlock(fileEngine).trimEnd();
  const engineMatches = engineSource.trimEnd() === fileEngineBlock;

  const engine = loadEngineFromSource(engineSource, 'embedded-engine');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert(fixture.modelVersion === embeddedModel.schemaVersion, 'fixture/embedded model schema mismatch');

  let compared = 0;
  let maximumDifference = 0;
  const acceptance = { accepted: 0, fallback: 0 };
  const observedStageCounts = new Set();

  for (const fixtureCase of fixture.cases) {
    const result = engine.applyResidualModel(embeddedModel, fixtureCase.input, {
      correctionCapPolicy: engine.CAP_POLICIES.LEGACY_AXIS_NORMALIZED,
    });
    for (const task of ['width', 'ez']) {
      const actual = result.tasks[task];
      const expected = fixtureCase.expected[task];
      assert(actual.accepted === expected.accepted,
        `${fixtureCase.caseId}.${task}: embedded gate decision differs`);
      observedStageCounts.add(actual.metadata.stageCount);
      assert(actual.metadata.stageCount === fixture.stageCount,
        `${fixtureCase.caseId}.${task}: embedded engine ran ${actual.metadata.stageCount} stage(s), expected ${fixture.stageCount}`);
      assert(Math.abs(actual.metadata.maximumCumulativeCorrectionFraction - fixture.cumulativeCap) <= TOLERANCE,
        `${fixtureCase.caseId}.${task}: embedded cumulative cap differs`);
      for (let index = 0; index < expected.normalizedPoints.length; index += 1) {
        for (const axis of [0, 1]) {
          const difference = Math.abs(actual.normalizedPoints[index][axis] - expected.normalizedPoints[index][axis]);
          maximumDifference = Math.max(maximumDifference, difference);
          compared += 1;
          assert(difference <= TOLERANCE,
            `${fixtureCase.caseId}.${task}[${index}] axis ${axis}: |embedded-Python|=${difference} > ${TOLERANCE}`);
        }
      }
      acceptance[expected.accepted ? 'accepted' : 'fallback'] += 1;
    }
  }
  assert(acceptance.accepted >= 10, 'embedded accepted path was not exercised enough');
  assert(acceptance.fallback >= 2, 'embedded fallback path was not exercised');

  const biasMatch = /const WIDTH_BIAS = ([0-9.]+);/.exec(researchText);
  assert(biasMatch, 'WIDTH_BIAS constant not found in the research HTML');

  const productionBuffer = fs.readFileSync(PRODUCTION_HTML);
  const productionSha = createHash('sha256').update(productionBuffer).digest('hex');

  const declared = embeddedModel.correctionPolicy || {};
  const report = {
    schemaVersion: 'ez-embed-verify-v1',
    privacy: {
      containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
      containsImageCoordinates: false, containsModelParameters: false,
    },
    pass: true,
    embeddedModelMatchesFile: modelMatches,
    embeddedEngineMatchesFile: engineMatches,
    embedded: {
      schemaVersion: embeddedModel.schemaVersion,
      stageCountWidth: embeddedModel.tasks.width.stages.length,
      stageCountEz: embeddedModel.tasks.ez.stages.length,
      perStageCap: declared.maximumPerLandmarkCorrectionDiagonalFraction,
      declaredStageCount: declared.stageCount,
      cumulativeCap: declared.maximumCumulativeCorrectionDiagonalFraction,
      widthSamples: embeddedModel.tasks.width.trainingSamples || embeddedModel.tasks.width.samples || null,
      ezSamples: embeddedModel.tasks.ez.trainingSamples || embeddedModel.tasks.ez.samples || null,
      widthBias: Number(biasMatch[1]),
    },
    runtimeStageCountsObserved: [...observedStageCounts],
    parity: { comparedCoordinateValues: compared, maximumAbsoluteDifference: maximumDifference, tolerance: TOLERANCE, acceptance },
    productionHtmlUnchanged: productionSha === PRODUCTION_SHA && productionBuffer.length === PRODUCTION_BYTES,
    productionHtmlBytes: productionBuffer.length,
  };
  assert(declared.stageCount === embeddedModel.tasks.width.stages.length,
    'embedded correctionPolicy.stageCount disagrees with the width stage list');
  assert(modelMatches, 'embedded model differs from residual-model.json — re-run embed_model.py');
  assert(engineMatches, 'embedded engine differs from residual_inference.js — re-run embed_model.py');
  assert(report.productionHtmlUnchanged, 'production HTML changed — this must never happen from research work');

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
