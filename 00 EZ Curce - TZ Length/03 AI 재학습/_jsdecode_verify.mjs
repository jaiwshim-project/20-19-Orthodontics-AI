// pixel_inference.js의 decodeHeatmaps가 파이썬 decode()와 같은 좌표를 내는지 대조.
//
// 히트맵/오프셋 원시 텐서는 _fp16_impact.py가 덤프했다(fp32 ONNX 출력).
// ⚠️ dims는 ONNX Runtime의 규약대로 [N,C,H,W] **배열**이어야 한다. 객체를 넘기면
// channels가 undefined가 되어 루프가 0회 돌고, 좌표 차이 0 = "통과"로 보인다.
// 그래서 아래에 점 개수 검사를 둔다.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('./pixel_inference.js');
const expected = JSON.parse(readFileSync('./_jsdecode_dump/expected.json', 'utf8'));

let worst = 0;
const rows = [];
for (const item of expected.cases) {
  const hb = readFileSync(`./_jsdecode_dump/case${item.index}_heatmap.f32`);
  const ob = readFileSync(`./_jsdecode_dump/case${item.index}_offset.f32`);
  const heat = new Float32Array(hb.buffer, hb.byteOffset, hb.byteLength / 4);
  const off = new Float32Array(ob.buffer, ob.byteOffset, ob.byteLength / 4);
  const { points } = mod.decodeHeatmaps(heat, off, item.heatmapDims, item.stride);
  if (points.length !== item.pythonPoints.length) {
    throw new Error(`점 개수 불일치: JS ${points.length} vs PY ${item.pythonPoints.length}`);
  }
  if (points.length !== 24) throw new Error(`24점이 아니다: ${points.length}`);
  let caseWorst = 0;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i][0] - item.pythonPoints[i][0];
    const dy = points[i][1] - item.pythonPoints[i][1];
    caseWorst = Math.max(caseWorst, Math.hypot(dx, dy));
  }
  worst = Math.max(worst, caseWorst);
  rows.push({ case: item.index, points: points.length, maxDiffPx512: caseWorst });
}
const verdict = {
  schemaVersion: 'jsdecode-verify-v2',
  purpose: 'JS 디코더(pixel_inference.decodeHeatmaps)와 파이썬 decode() 좌표 동등성',
  cases: rows,
  pointsPerCase: 24,
  maxDiffPx512: worst,
  // 입력 512 기준 1e-3 px = 원본 6016 기준 0.012px = 0.00016mm. 부동소수 잡음 수준.
  tolerancePx: 1e-3,
  identical: worst <= 1e-3,
};
console.log(JSON.stringify(verdict, null, 2));
if (!verdict.identical) process.exit(1);
