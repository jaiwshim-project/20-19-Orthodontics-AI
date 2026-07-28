#!/usr/bin/env node

/*
 * 신규 라벨 폴더 감사 — 학습에 넣기 **전에** 확인해야 하는 것들.
 *
 * 섹션 34의 교훈: 개수만 맞춰 라벨을 넣으면 조용히 오답을 학습한다. 부분 주석 31건은
 * 치아 번호 규약이 달라서(정본 6·7 결손을 1~10으로 재부여) 위치 −10% 악화를 냈다.
 * 그래서 새 폴더는 다음을 먼저 본다:
 *
 *   1) 파싱 가능성 — 빈 파일 / JSON 블록 없음
 *   2) 치아 개수 분포 — 12개 완전 라벨이 몇 건인가(len==12만 학습에 들어간다)
 *   3) 임베디드 이미지 SHA-256 중복 — 기존 라벨(01/TS/교정후/클래스2김)과 겹치면
 *      같은 케이스를 두 번 학습하는 셈이고, 정본 root와 겹치면 매칭 경로가 달라진다
 *   4) **치아 번호 규약** — 12개 미만 라벨의 번호가 정본 번호인지. 상대폭 프로파일을
 *      기존 완전 라벨과 비교해 66가지 매핑 중 어디에 맞는지 본다
 *   5) 상대폭 프로파일 자체가 기존 완전 라벨과 같은 분포인지(스케일·좌우 대칭)
 *
 * 원본 폴더는 읽기 전용. 출력은 PHI 없이 집계만.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const HERE = path.join(PROJECT, '03 AI 재학습');
const NEW_DIR = path.join(PROJECT, '03 치아 좌우폭 찍기(유라쌤-클래스2)');
const EXISTING_DIRS = [
  '01 치아 좌우폭 찍기 (유라쌤)',
  '02 치아 좌우폭 찍기(김원장님)',
  '02 교정 후 치아폭 찍기(김원장님)',
  '03 치아 좌우폭 찍기(김원장님-클래스2)',
].map((name) => path.join(PROJECT, name)).filter((p) => existsSync(p));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extractJson(text, filePath) {
  const marker = text.indexOf('```json');
  if (marker < 0) throw new Error(`JSON fence not found: ${path.basename(filePath)}`);
  const start = text.indexOf('{', marker);
  const end = text.indexOf('\n```', start);
  if (start < 0 || end < 0) throw new Error(`JSON fence incomplete: ${path.basename(filePath)}`);
  return JSON.parse(text.slice(start, end));
}

function decodeImage(imageData) {
  if (typeof imageData !== 'string') return null;
  const comma = imageData.indexOf(',');
  const payload = comma >= 0 ? imageData.slice(comma + 1) : imageData;
  const buffer = Buffer.from(payload, 'base64');
  let width = null;
  let height = null;
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      let marker = buffer[offset + 1];
      while (marker === 0xff && offset + 2 < buffer.length) marker = buffer[++offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 8 < buffer.length) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return { sha256: sha256(buffer), bytes: buffer.length, width, height };
}

async function readFolder(directory) {
  const names = (await readdir(directory)).filter((n) => /\.md$/i.test(n));
  const records = [];
  const skipped = [];
  for (const fileName of names) {
    const buffer = await readFile(path.join(directory, fileName));
    const text = buffer.toString('utf8');
    if (buffer.length === 0 || text.indexOf('```json') < 0) {
      skipped.push({ reason: buffer.length === 0 ? 'empty_file' : 'no_json_block' });
      continue;
    }
    let json;
    try {
      json = extractJson(text, fileName);
    } catch (error) {
      skipped.push({ reason: 'json_parse_error' });
      continue;
    }
    const image = decodeImage(json.imageData);
    records.push({
      image,
      toothWidths: Array.isArray(json.toothWidths) ? json.toothWidths : [],
      ezPoints: Array.isArray(json.ezPoints) ? json.ezPoints : [],
      keys: Object.keys(json).filter((k) => k !== 'imageData').sort(),
    });
  }
  return { records, skipped };
}

function pairOf(item) {
  const p1 = item?.p1 ?? item?.a ?? item?.start;
  const p2 = item?.p2 ?? item?.b ?? item?.end;
  if (!p1 || !p2 || ![p1.x, p1.y, p2.x, p2.y].every(Number.isFinite)) return null;
  return [p1, p2];
}

/* 상대폭: 자기 케이스의 주석된 치아 스팬으로 정규화. 픽셀 좌표라 등방이므로 종횡비 보정 불필요.
 *
 * ⚠️ 원본 md의 `toothWidths`에는 **치아 번호 필드가 없다**. 번호는 `build_dataset_index.mjs`가
 * 배열 순서로 `toothNo: index + 1`을 만들어 붙인 것이다(264행). 즉 "치아 번호"는 전부
 * **배열 위치**이고, 12개 미만 라벨에서 그 위치가 정본 치아를 가리킨다는 보장이 없다.
 * 이것이 섹션 34에서 부분 주석 학습이 −10% 악화된 기계적 원인이다. 따라서 여기서도
 * 위치 인덱스로 읽고, 12개 미만이면 그 위치가 무엇인지 별도 진단한다.
 */
function relativeWidths(record) {
  const pairs = record.toothWidths.map(pairOf);
  if (pairs.some((p) => p === null) || pairs.length < 2) return null;
  const widths = pairs.map(([p1, p2]) => Math.hypot(p2.x - p1.x, p2.y - p1.y));
  const ends = [...pairs[0], ...pairs.at(-1)];
  let span = 0;
  for (const a of ends) for (const b of ends) span = Math.max(span, Math.hypot(a.x - b.x, a.y - b.y));
  if (!(span > 0)) return null;
  return {
    numbers: pairs.map((_, index) => index + 1),
    relative: widths.map((w) => w / span),
  };
}

function stats(rows) {
  const columns = rows[0].length;
  const mean = Array.from({ length: columns }, (_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
  const sd = Array.from({ length: columns }, (_, i) =>
    Math.sqrt(rows.reduce((s, r) => s + (r[i] - mean[i]) ** 2, 0) / rows.length) + 1e-12);
  return { mean, sd };
}

function combinations(total, pick) {
  const out = [];
  const walk = (start, chosen) => {
    if (chosen.length === pick) { out.push([...chosen]); return; }
    for (let value = start; value <= total; value += 1) {
      chosen.push(value);
      walk(value + 1, chosen);
      chosen.pop();
    }
  };
  walk(1, []);
  return out;
}

async function main() {
  const fresh = await readFolder(NEW_DIR);
  const existingRecords = [];
  for (const directory of EXISTING_DIRS) {
    const loaded = await readFolder(directory);
    for (const record of loaded.records) existingRecords.push({ ...record, folder: path.basename(directory) });
  }

  // 1) 파싱 & 치아 개수
  const countHistogram = {};
  for (const record of fresh.records) {
    const valid = record.toothWidths.filter((item) => pairOf(item) !== null).length;
    countHistogram[valid] = (countHistogram[valid] || 0) + 1;
  }

  // 2) SHA 중복
  const existingSha = new Map();
  for (const record of existingRecords) {
    if (record.image?.sha256) {
      if (!existingSha.has(record.image.sha256)) existingSha.set(record.image.sha256, []);
      existingSha.get(record.image.sha256).push(record.folder);
    }
  }
  const rootNames = readdirSync(PROJECT).filter((n) => /^\d+\.(jpg|jpeg|png)$/i.test(n));
  const rootSha = new Set();
  for (const name of rootNames) rootSha.add(sha256(await readFile(path.join(PROJECT, name))));

  const freshSha = fresh.records.map((r) => r.image?.sha256).filter(Boolean);
  const internalDuplicates = freshSha.length - new Set(freshSha).size;
  const overlapWithExisting = {};
  let overlapCount = 0;
  let overlapWithRoot = 0;
  for (const sha of new Set(freshSha)) {
    if (existingSha.has(sha)) {
      overlapCount += 1;
      for (const folder of new Set(existingSha.get(sha))) {
        overlapWithExisting[folder] = (overlapWithExisting[folder] || 0) + 1;
      }
    }
    if (rootSha.has(sha)) overlapWithRoot += 1;
  }

  // 3) 치아 번호 규약 — 완전 12개 라벨끼리 상대폭 비교
  const freshFull = fresh.records.map(relativeWidths)
    .filter((r) => r && r.numbers.length === 12).map((r) => r.relative);
  const existingFull = existingRecords.map(relativeWidths)
    .filter((r) => r && r.numbers.length === 12).map((r) => r.relative);
  const referenceStats = existingFull.length ? stats(existingFull) : null;
  const profileCheck = (freshFull.length && referenceStats) ? (() => {
    const freshMean = stats(freshFull).mean;
    const z = freshMean.map((v, i) => Math.abs(v - referenceStats.mean[i]) / referenceStats.sd[i]);
    return {
      freshFullCases: freshFull.length,
      referenceFullCases: existingFull.length,
      freshMeanRelativeWidths: freshMean.map((v) => Number(v.toFixed(4))),
      referenceMeanRelativeWidths: referenceStats.mean.map((v) => Number(v.toFixed(4))),
      meanAbsoluteZ: Number((z.reduce((a, b) => a + b, 0) / z.length).toFixed(3)),
      maxAbsoluteZ: Number(Math.max(...z).toFixed(3)),
      perToothZ: z.map((v) => Number(v.toFixed(2))),
    };
  })() : null;

  // 4) 12개 미만 라벨의 번호 규약 — 66가지 매핑 z 적합도(섹션 34-3과 동일 절차)
  const partialGroups = {};
  for (const record of fresh.records) {
    const relative = relativeWidths(record);
    if (!relative || relative.numbers.length === 12) continue;
    const key = relative.numbers.join(',');
    if (!partialGroups[key]) partialGroups[key] = [];
    partialGroups[key].push(relative.relative);
  }
  const partialDiagnosis = [];
  for (const [key, rows] of Object.entries(partialGroups)) {
    const size = key.split(',').length;
    if (!existingFull.length || size < 2 || size >= 12) {
      partialDiagnosis.push({ annotatedNumbers: key, cases: rows.length, verdict: 'not_diagnosable' });
      continue;
    }
    const observed = stats(rows).mean;
    const candidates = combinations(12, size).map((subset) => {
      // 완전 라벨을 같은 부분집합으로 잘라 그 부분집합의 스팬으로 재정규화해야 공정하다.
      const projected = existingRecords.map(relativeWidths).filter((r) => r && r.numbers.length === 12)
        .map((r) => {
          const picked = subset.map((n) => r.relative[n - 1]);
          // r.relative는 12치 스팬 기준이므로, 부분집합 스팬 기준으로 다시 나눈다.
          // 부분집합 스팬은 원 좌표가 필요하지만 근사로 양끝 치아 사이 상대거리를 쓸 수 없어,
          // 여기서는 부분집합 폭 합으로 정규화해 형태(shape)만 비교한다.
          const total = picked.reduce((a, b) => a + b, 0);
          return picked.map((v) => v / total);
        });
      const reference = stats(projected);
      const observedTotal = observed.reduce((a, b) => a + b, 0);
      const shape = observed.map((v) => v / observedTotal);
      const z = shape.map((v, i) => Math.abs(v - reference.mean[i]) / reference.sd[i]);
      return {
        missingTeeth: Array.from({ length: 12 }, (_, i) => i + 1).filter((n) => !subset.includes(n)),
        meanAbsoluteZ: Number((z.reduce((a, b) => a + b, 0) / z.length).toFixed(3)),
      };
    }).sort((a, b) => a.meanAbsoluteZ - b.meanAbsoluteZ);
    const literal = candidates.find((c) =>
      c.missingTeeth.join(',') === Array.from({ length: 12 }, (_, i) => i + 1)
        .filter((n) => !key.split(',').map(Number).includes(n)).join(','));
    partialDiagnosis.push({
      annotatedNumbers: key,
      cases: rows.length,
      bestFit: candidates[0],
      literalReading: literal || null,
      literalRank: literal ? candidates.indexOf(literal) + 1 : null,
      totalCandidates: candidates.length,
      numberingLikelyShifted: Boolean(literal && candidates[0].meanAbsoluteZ < literal.meanAbsoluteZ * 0.6),
    });
  }

  const report = {
    schemaVersion: 'new-label-audit-v1',
    privacy: {
      containsPhi: false, containsCaseIdentifiers: false, containsFilePaths: false,
      containsImageCoordinates: false, containsFileNames: false,
    },
    note: '신규 라벨 폴더를 학습 전에 감사한다. 섹션 34 교훈: 개수만 맞춰 넣으면 조용히 오답을 학습한다.',
    newFolderBasename: path.basename(NEW_DIR),
    files: { markdownFiles: (await readdir(NEW_DIR)).filter((n) => /\.md$/i.test(n)).length, parsed: fresh.records.length, skipped: fresh.skipped },
    toothCountHistogram: countHistogram,
    completeTwelveToothCases: countHistogram['12'] || 0,
    imageIdentity: {
      distinctEmbeddedImages: new Set(freshSha).size,
      duplicatesWithinNewFolder: internalDuplicates,
      overlapWithExistingLabelFolders: overlapCount,
      overlapByFolder: overlapWithExisting,
      overlapWithNumberedRootImages: overlapWithRoot,
    },
    profileCheck,
    partialAnnotationDiagnosis: partialDiagnosis,
    hasEzAnnotations: fresh.records.filter((r) => r.ezPoints.length > 0).length,
    observedJsonKeys: [...new Set(fresh.records.flatMap((r) => r.keys))].sort(),
  };
  await writeFile(path.join(HERE, 'new_label_audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
