#!/usr/bin/env node
/*
 * 재학습 순환 (수동 수집 → 재학습 → 검증) 오케스트레이터.
 *
 * 흐름:
 *   1) "04 수정본 수집" 폴더의 수정본 md(EZ점+치아폭 함께 저장된 파일)를 읽어,
 *      이미지 SHA-256 기준으로 EZ 정답은 "02 이퀼리브리엄 찍기", 치아폭 정답은 "TS" 폴더에 반영(추가/갱신).
 *      - 원본 정답은 덮어쓰기 전 .bak 백업.
 *   2) build_dataset_index → run_rule_baseline(root/embedded) → merge → evaluate → train_residual → validate → measure
 *      순으로 파이프라인 재실행.
 *   3) measure_engine 결과(engine_metrics.json)로 개선 여부 요약 출력.
 *
 * 사용:
 *   node retrain_loop.mjs                # 수집본 반영 + 전체 재학습
 *   node retrain_loop.mjs --ingest-only  # 수집본을 학습 폴더에 반영만 (재학습 X)
 *   node retrain_loop.mjs --measure-only # 재학습 없이 현재 예측으로 측정만
 *   node retrain_loop.mjs --python <exe> # Python 실행파일 지정
 */
import { readdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
const COLLECT_DIR = path.join(PROJECT, '04 수정본 수집');
// 라벨 폴더 담당자 접미어("(김원장님)") 자동 탐지. 원본은 읽기 전용.
function resolveDir(...prefixes) {
  for (const pre of prefixes) { const p = path.join(PROJECT, pre); if (existsSync(p)) return p; }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim();
  try { const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory()); if (hit) return path.join(PROJECT, hit); } catch { /* */ }
  return path.join(PROJECT, prefixes[0]);
}
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
const TS_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');

const args = process.argv.slice(2);
const INGEST_ONLY = args.includes('--ingest-only');
const MEASURE_ONLY = args.includes('--measure-only');
const PYTHON = (() => {
  const i = args.indexOf('--python');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const bundled = 'C:\\Users\\USER\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
  return existsSync(bundled) ? bundled : 'python';
})();

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function extractJson(text) { const m = text.match(/```json\s*([\s\S]*?)```/); return m ? JSON.parse(m[1]) : null; }
function stem(n) { return path.basename(n, path.extname(n)); }
function stripDataUrl(d) { return Buffer.from(String(d).replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64'); }

function run(cmd, cmdArgs, label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`\n▶ ${label}\n  $ ${path.basename(cmd)} ${cmdArgs.join(' ')}\n`);
    const child = spawn(cmd, cmdArgs, { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    child.stdout.on('data', d => { tail = (tail + d).slice(-2000); });
    child.stderr.on('data', d => { tail = (tail + d).slice(-2000); });
    child.on('close', code => {
      if (code === 0) { process.stdout.write(`  ✓ 완료\n`); resolve(tail); }
      else { process.stdout.write(`  ✗ 실패(code ${code})\n${tail}\n`); reject(new Error(`${label} 실패`)); }
    });
    child.on('error', reject);
  });
}

// 수집본을 EZ/TS 폴더 md에 반영. 파일명은 이미지 SHA 앞 12자리 + 원본 stem 우선.
async function ingestCorrections() {
  if (!existsSync(COLLECT_DIR)) { console.log('수집 폴더 없음, 건너뜀'); return { ez: 0, tw: 0 }; }
  const files = (await readdir(COLLECT_DIR)).filter(f => /\.md$/i.test(f));
  if (!files.length) { console.log('수집본 없음(0건), 건너뜀'); return { ez: 0, tw: 0 }; }

  // 기존 EZ/TS 폴더의 이미지 SHA → 파일명 인덱스
  async function shaIndex(dir) {
    const idx = {};
    for (const f of (await readdir(dir)).filter(x => /\.md$/i.test(x))) {
      try {
        const buf = await readFile(path.join(dir, f));
        if (!buf.length) continue;
        const j = extractJson(buf.toString('utf8'));
        if (j?.imageData) idx[sha256(stripDataUrl(j.imageData))] = f;
      } catch {}
    }
    return idx;
  }
  if (!existsSync(EZ_DIR) || !existsSync(TS_DIR)) {
    throw new Error(`정답 폴더가 없습니다. EZ:${existsSync(EZ_DIR)} 치아폭:${existsSync(TS_DIR)}`);
  }
  const ezIdx = await shaIndex(EZ_DIR), tsIdx = await shaIndex(TS_DIR);
  let ezCount = 0, twCount = 0;

  for (const f of files) {
    const buf = await readFile(path.join(COLLECT_DIR, f));
    const j = extractJson(buf.toString('utf8'));
    if (!j?.imageData) { console.log(`  skip ${f}: imageData 없음`); continue; }
    const isha = sha256(stripDataUrl(j.imageData));
    const ezPts = (j.ezPoints || []).filter(p => Number.isFinite(p?.x));
    const tw = (j.toothWidths || []).filter(w => w?.p1 && w?.p2);

    // EZ 정답 반영 (수정본에 EZ점 3개 이상 있을 때)
    if (ezPts.length >= 3) {
      const target = ezIdx[isha] || `${stem(f)}.md`;
      const targetPath = path.join(EZ_DIR, target);
      if (existsSync(targetPath)) await copyFile(targetPath, targetPath + `.bak-${isha.slice(0,8)}`);
      await writeFile(targetPath, buildMd(j, 'ez'), 'utf8');
      ezCount++;
    }
    // 치아폭 정답 반영 (수정본에 치아폭 1개 이상 있을 때)
    if (tw.length >= 1) {
      const target = tsIdx[isha] || `${stem(f)}.md`;
      const targetPath = path.join(TS_DIR, target);
      if (existsSync(targetPath)) await copyFile(targetPath, targetPath + `.bak-${isha.slice(0,8)}`);
      await writeFile(targetPath, buildMd(j, 'width'), 'utf8');
      twCount++;
    }
    console.log(`  반영 ${f} (sha ${isha.slice(0,8)}, ez=${ezPts.length} tw=${tw.length})`);
  }
  return { ez: ezCount, tw: twCount };
}

// 학습 폴더 md 형식으로 직렬화 (JSON 블록에 imageData 포함)
function buildMd(j, kind) {
  const data = {
    origin: j.origin ?? null,
    toothCenters: j.toothCenters || [],
    ezPoints: kind === 'ez' ? (j.ezPoints || []) : [],
    toothWidths: kind === 'width' ? (j.toothWidths || []) : [],
    imageName: j.imageName || 'correction',
    imageData: j.imageData,
    molarMm: j.molarMm || 54,
    savedAt: j.savedAt || new Date(0).toISOString(),
    correctionSource: '04 수정본 수집',
  };
  return '# EZ-Curve Location Data (correction)\n\n## JSON (프로그램용)\n```json\n'
    + JSON.stringify(data, null, 2) + '\n```\n';
}

async function main() {
  console.log('=== 재학습 순환 시작 ===');
  console.log('Python:', PYTHON);

  if (!MEASURE_ONLY) {
    console.log('\n[1] 수집본 반영');
    const { ez, tw } = await ingestCorrections();
    console.log(`  → EZ 정답 ${ez}건, 치아폭 정답 ${tw}건 반영`);
    if (INGEST_ONLY) { console.log('\n--ingest-only: 반영만 완료.'); return; }
  }

  if (!MEASURE_ONLY) {
    console.log('\n[2] 파이프라인 재실행');
    await run('node', ['build_dataset_index.mjs', '--output', 'dataset-index.json'], '데이터셋 인덱스 재빌드');
    await run('node', ['run_rule_baseline.js', '--output=baseline_predictions.json', '--csv=baseline_predictions.csv'], '규칙 베이스라인(root)');
    await run('node', ['run_rule_baseline.js', '--source=ez-embedded-only', '--output=baseline_ez_embedded_predictions.json', '--csv=baseline_ez_embedded_predictions.csv'], '규칙 베이스라인(embedded)');
    // 교정후 치아폭 학습용 규칙 baseline(width_embedded_only 케이스). corrected_after_predictions.json이
    // 있으면 사진 SHA로 매핑해 생성한다. 없으면(교정후 예측 미생성) 건너뛰고 경고만 — merge는 optional 처리.
    if (existsSync(path.join(HERE, 'corrected_after_predictions.json'))) {
      await run('node', ['build_corrected_width_baseline.mjs'], '교정후 치아폭 규칙 베이스라인');
    } else {
      console.log('  ⚠ corrected_after_predictions.json 없음 → 교정후 baseline 건너뜀. 필요시 run_corrected_after.js 먼저 실행.');
    }
    await run('node', ['merge_baselines.js'], '베이스라인 병합');
    await run('node', ['evaluate_baseline.mjs'], '베이스라인 평가');
    await run(PYTHON, ['train_residual.py', '--dataset-index', 'dataset-index.json', '--baseline-predictions', 'baseline_predictions_all.json', '--output-dir', '.'], 'KRR 재학습');
    await run(PYTHON, ['validate_deployment_policy_nested.py', '--dataset-index', 'dataset-index.json', '--baseline-predictions', 'baseline_predictions_all.json', '--output', 'nested-policy-metrics.json'], '중첩 독립검증');
  }

  console.log('\n[3] 측정 (KRR 적용 엔진으로 자동분석 후 정답 대비)');
  // 보정후 HTML 대상 러너가 있으면 그것으로 KRR 적용 예측 생성
  if (existsSync(path.join(HERE, 'run_rule_baseline_fixed.js'))) {
    await run('node', ['run_rule_baseline_fixed.js', '--output=krr_pred_root.json', '--csv=krr_pred_root.csv'], 'KRR엔진 예측(root)');
    await run('node', ['run_rule_baseline_fixed.js', '--source=ez-embedded-only', '--output=krr_pred_emb.json', '--csv=krr_pred_emb.csv'], 'KRR엔진 예측(embedded)');
    const root = JSON.parse(await readFile(path.join(HERE, 'krr_pred_root.json'), 'utf8'));
    const emb = JSON.parse(await readFile(path.join(HERE, 'krr_pred_emb.json'), 'utf8'));
    await writeFile(path.join(HERE, 'krr_pred_all.json'), JSON.stringify({ schemaVersion: 'krr', results: [...root.results, ...emb.results] }), 'utf8');
    await run('node', ['measure_engine.mjs', 'krr_pred_all.json'], '오차 측정(KRR)');
  } else {
    await run('node', ['measure_engine.mjs', 'baseline_predictions_all.json'], '오차 측정(규칙)');
  }

  // 결과 요약
  try {
    const g = JSON.parse(await readFile(path.join(HERE, 'engine_metrics.json'), 'utf8')).summary;
    const nested = existsSync(path.join(HERE, 'nested-policy-metrics.json'))
      ? JSON.parse(await readFile(path.join(HERE, 'nested-policy-metrics.json'), 'utf8')) : null;
    console.log('\n=== 재학습 순환 결과 ===');
    console.log('정답 매칭:', g.정답매칭, '건');
    console.log('치아폭 끝점 오차: 평균', g.치아폭끝점_대각선퍼센트?.mean + '%');
    console.log('EZ 이탈 오차: 평균', g.EZ이탈_대각선퍼센트?.mean + '%');
    console.log('TZL 오차:', g.TZL오차mm?.mean + 'mm | EZL 오차:', g.EZL오차mm?.mean + 'mm');
    if (nested) console.log('독립검증 판정:', nested.promotionGate?.decision, '| pass:', nested.promotionGate?.pass);
    console.log('\n다음: 개선됐으면 residual-model.json을 HTML에 재임베드하세요 (embed_krr 절차).');
  } catch (e) { console.log('요약 생성 실패:', e.message); }
}

main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
