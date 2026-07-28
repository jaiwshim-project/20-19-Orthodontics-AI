#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
// 라벨 폴더는 담당자 접미어(예: "(김원장님)", " (유라쌤)")가 세션마다 붙었다 빠졌다 하므로
// 접두어(핵심 이름)로 실제 존재하는 폴더를 자동 탐지한다. 원본 폴더는 읽기 전용.
function resolveDir(...prefixes) {
  for (const pre of prefixes) {
    const exact = path.join(PROJECT, pre);
    if (existsSync(exact)) return exact;
  }
  const base = prefixes[0].replace(/\s*\(.*$/, '').trim(); // 담당자 괄호 앞까지의 핵심 이름
  try {
    const hit = readdirSync(PROJECT).find((n) => n.startsWith(base) && statSync(path.join(PROJECT, n)).isDirectory());
    if (hit) return path.join(PROJECT, hit);
  } catch { /* ignore */ }
  return path.join(PROJECT, prefixes[0]);
}
const WIDTH_DIR = resolveDir('01 치아 좌우폭 찍기 (유라쌤)', '01 치아 좌우폭 찍기');
const EZ_DIR = resolveDir('02 이퀼리브리엄 찍기(김원장님)', '02 이퀼리브리엄 찍기');
// TS 폴더: EZ(02)와 동일 이미지 SHA-256를 공유하는 동일 환자 치아 좌우폭 정답.
// 파일명이 EZ 폴더와 1:1 대응하며, 검증 결과 112/112 임베디드 이미지 해시가 일치한다.
const TS_WIDTH_DIR = resolveDir('02 치아 좌우폭 찍기(김원장님)', '02 치아 좌우폭 찍기');
// 교정 후 치아폭 정답(신규): 교정 후 재촬영 사진이라 임베디드 이미지 SHA-256가
// 교정 전(01/TS) 및 번호 root와 전부 다르다. 따라서 root/EZ와 매칭되지 않고
// width_embedded_only 케이스로 편입된다. 발치 케이스는 치아폭이 12개 미만이라
// train_residual의 len==12 필터에서 자동 제외되고, 12개 완전 라벨만 학습에 채택된다.
const CORRECTED_WIDTH_DIR = resolveDir('02 교정 후 치아폭 찍기(김원장님)', '02 교정 후 치아폭 찍기');
// 클래스2 치아폭 정답(2026-07-26 신규 101건). 감사 결과 유효 99건 전부
// ① 치아 12개 완전 라벨(발치 0건) ② 임베디드 이미지 SHA-256이 기존 모든 라벨(01/TS/교정후/EZ)과
// 중복 0건인 완전 신규 케이스다. EZ 라벨은 없어 width_embedded_only 케이스로 편입되며,
// 어금니 잔차 분산(TZL P95 꼬리)을 줄이기 위한 표본 확대분이다.
const CLASS2_WIDTH_DIR = resolveDir('03 치아 좌우폭 찍기(김원장님-클래스2)', '03 치아 좌우폭 찍기');
// 클래스2 치아폭 정답 2차(2026-07-27 신규 118건, 유라쌤). 감사(`_audit_new_labels.mjs`) 결과
// ① 117건 파싱(빈 파일 1건) 중 **116건이 치아 12개 완전 라벨** ② 임베디드 이미지 SHA-256이
// 기존 모든 라벨 폴더 및 번호 root와 **중복 0건**인 완전 신규 케이스 ③ 상대폭 프로파일이
// 기존 완전 라벨 322건과 통계적으로 동일(평균 |z| 0.253, 최대 0.354).
// 남은 1건(11개 라벨)은 번호 규약 진단에서 "위치가 정본을 가리키지 않음"으로 나왔고
// len==12 필터에서 자동 제외된다. EZ 라벨은 없어 width_embedded_only로 편입된다.
const CLASS2B_WIDTH_DIR = resolveDir('03 치아 좌우폭 찍기(유라쌤-클래스2)');

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function detectMime(buffer, declared = null) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  return declared || 'application/octet-stream';
}

function imageDimensions(buffer, mime) {
  if (mime === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime !== 'image/jpeg') return { width: null, height: null };
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) marker = buffer[++offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof && offset + 8 < buffer.length) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function extractJson(text, filePath) {
  const marker = text.indexOf('```json');
  if (marker < 0) throw new Error(`JSON fence not found: ${filePath}`);
  const start = text.indexOf('{', marker);
  const end = text.indexOf('\n```', start);
  if (start < 0 || end < 0) throw new Error(`JSON fence is incomplete: ${filePath}`);
  return JSON.parse(text.slice(start, end));
}

function decodeImageData(imageData, filePath) {
  if (typeof imageData !== 'string') throw new Error(`imageData is missing: ${filePath}`);
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(imageData);
  if (!match) throw new Error(`imageData is not a base64 data URL: ${filePath}`);
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const mime = detectMime(buffer, match[1]);
  return { buffer, mime, ...imageDimensions(buffer, mime) };
}

function numericStem(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  return /^\d+$/.test(stem) ? Number(stem) : null;
}

function threeDigit(number) {
  return String(number).padStart(3, '0');
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function duplicateGroups(items, keyFn, nameFn) {
  return [...groupBy(items, keyFn).entries()]
    .filter(([, values]) => values.length > 1)
    .map(([key, values]) => ({ key, files: values.map(nameFn) }));
}

function scalarFromJson(json, candidates) {
  for (const key of candidates) {
    if (typeof json[key] === 'number' && Number.isFinite(json[key])) return json[key];
  }
  return null;
}

async function readRootImages() {
  const names = (await readdir(PROJECT))
    .filter(name => /^\d{3}\.(?:jpe?g|png)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const records = [];
  for (const fileName of names) {
    const filePath = path.join(PROJECT, fileName);
    const bytes = (await stat(filePath)).size;
    const buffer = await readFile(filePath);
    const mime = detectMime(buffer);
    records.push({
      caseNumber: numericStem(fileName),
      caseId: threeDigit(numericStem(fileName)),
      fileName,
      filePath,
      sha256: sha256Buffer(buffer),
      bytes,
      mime,
      ...imageDimensions(buffer, mime),
    });
  }
  return records;
}

async function readAnnotations(directory, kind, skipped = null) {
  const names = (await readdir(directory))
    .filter(name => /\.md$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const records = [];
  for (const fileName of names) {
    const filePath = path.join(directory, fileName);
    const mdBuffer = await readFile(filePath);
    const text = mdBuffer.toString('utf8');
    // 빈 파일(예: TS/3415.md 0 byte)이나 JSON 블록이 없는 손상 파일은 정답에서 제외하고 기록만 남긴다.
    if (mdBuffer.length === 0 || text.indexOf('```json') < 0) {
      if (skipped) skipped.push({ kind, fileName, reason: mdBuffer.length === 0 ? 'empty_file' : 'no_json_block' });
      continue;
    }
    const json = extractJson(text, filePath);
    const decoded = decodeImageData(json.imageData, filePath);
    const savedAtMatch = /^저장 시간:\s*(.+)$/m.exec(text);
    records.push({
      kind,
      fileName,
      filePath,
      annotationSha256: sha256Buffer(mdBuffer),
      numericStem: numericStem(fileName),
      embeddedImage: {
        imageName: typeof json.imageName === 'string' ? json.imageName : null,
        sha256: sha256Buffer(decoded.buffer),
        bytes: decoded.buffer.length,
        mime: decoded.mime,
        width: decoded.width,
        height: decoded.height,
      },
      savedAt: typeof json.savedAt === 'string' ? json.savedAt : (savedAtMatch?.[1]?.trim() || null),
      scaleMm: scalarFromJson(json, ['molarMm', 'molarDistanceMm', 'scaleMm', 'referenceDistanceMm']),
      origin: json.origin ?? null,
      toothCenters: Array.isArray(json.toothCenters) ? json.toothCenters : [],
      ezPoints: Array.isArray(json.ezPoints) ? json.ezPoints : [],
      toothWidths: Array.isArray(json.toothWidths) ? json.toothWidths : [],
      jsonKeys: Object.keys(json).filter(key => key !== 'imageData').sort(),
    });
  }
  return records;
}

function annotationSummary(annotation) {
  if (!annotation) return null;
  return {
    fileName: annotation.fileName,
    filePath: annotation.filePath,
    numericStem: annotation.numericStem,
    savedAt: annotation.savedAt,
    embeddedImage: annotation.embeddedImage,
    scaleMm: annotation.scaleMm,
    labelCounts: {
      toothCenters: annotation.toothCenters.length,
      ezPoints: annotation.ezPoints.length,
      toothWidths: annotation.toothWidths.length,
    },
  };
}

function resolveAnnotation(annotation, rootByHash, rootByNumber) {
  const hashCandidates = rootByHash.get(annotation.embeddedImage.sha256) || [];
  const numericCandidate = annotation.numericStem == null ? null : rootByNumber.get(annotation.numericStem) || null;
  if (hashCandidates.length === 1) {
    const root = hashCandidates[0];
    return {
      root,
      method: numericCandidate === root ? 'numeric_id+embedded_sha256' : 'embedded_sha256',
      conflict: numericCandidate && numericCandidate !== root
        ? `numeric stem points to ${numericCandidate.caseId}, SHA-256 points to ${root.caseId}`
        : null,
    };
  }
  if (hashCandidates.length > 1) {
    if (numericCandidate && hashCandidates.includes(numericCandidate)) {
      return { root: numericCandidate, method: 'numeric_id_disambiguates_duplicate_sha256', conflict: null };
    }
    return { root: null, method: 'ambiguous_duplicate_sha256', conflict: `SHA-256 matches ${hashCandidates.map(x => x.caseId).join(', ')}` };
  }
  if (numericCandidate) {
    return { root: numericCandidate, method: 'numeric_id_only_unverified', conflict: 'embedded image SHA-256 does not match the numbered root image' };
  }
  return { root: null, method: 'unmatched', conflict: 'no root image has the embedded image SHA-256' };
}

function countBy(items, keyFn) {
  const result = {};
  for (const item of items) {
    const key = keyFn(item);
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function canonicalPoint(point) {
  if (!point || !finiteNumber(point.x) || !finiteNumber(point.y)) return null;
  return { x: point.x, y: point.y };
}

function canonicalRawCoordinates(annotation) {
  return {
    originPx: canonicalPoint(annotation.origin),
    toothCentersPx: annotation.toothCenters.map(canonicalPoint),
    ezPointsPx: annotation.ezPoints.map(canonicalPoint),
    toothWidthsPx: annotation.toothWidths.map((width, index) => ({
      toothNo: index + 1,
      p1: canonicalPoint(width?.p1),
      p2: canonicalPoint(width?.p2),
    })),
  };
}

function coordinateSlotsForAnnotation(annotation, raw) {
  const points = [];
  if (annotation.kind === 'ez_curve' || annotation.origin !== null) points.push(raw.originPx);
  points.push(...raw.toothCentersPx, ...raw.ezPointsPx);
  for (const width of raw.toothWidthsPx) points.push(width.p1, width.p2);
  return points;
}

function annotationQualityFlags(annotation, image, raw) {
  const flags = [];
  if (annotation.kind === 'tooth_width') {
    if (annotation.toothWidths.length === 0) flags.push('missing_tooth_width_labels');
    else if (annotation.toothWidths.length !== 12) flags.push('incomplete_tooth_width_labels');
  }
  if (annotation.kind === 'ez_curve') {
    if (annotation.ezPoints.length === 0) flags.push('missing_ez_point_labels');
    else if (annotation.ezPoints.length !== 12) flags.push('incomplete_ez_point_labels');
    if (!raw.originPx) flags.push('missing_ez_origin');
  }
  if (!finiteNumber(annotation.scaleMm) || annotation.scaleMm <= 0) flags.push('missing_or_invalid_scale_mm');
  else flags.push('scale_conversion_unverifiable_from_annotation');

  const points = coordinateSlotsForAnnotation(annotation, raw);
  if (points.some(point => point === null)) flags.push('invalid_coordinate');
  if (finiteNumber(image.widthPx) && finiteNumber(image.heightPx) && points.some(point =>
    point && (point.x < 0 || point.y < 0 || point.x > image.widthPx || point.y > image.heightPx))) {
    flags.push('coordinate_outside_image_bounds');
  }
  return [...new Set(flags)].sort();
}

function annotationLabelPayload(annotation) {
  const raw = canonicalRawCoordinates(annotation);
  return {
    annotationKind: annotation.kind,
    scaleMm: finiteNumber(annotation.scaleMm) ? annotation.scaleMm : null,
    raw,
  };
}

function canonicalAnnotation(annotation, image) {
  const payload = annotationLabelPayload(annotation);
  const labelSha256 = sha256Buffer(Buffer.from(JSON.stringify(payload), 'utf8'));
  return {
    labelSha256,
    sourceAnnotationSha256s: [annotation.annotationSha256],
    embeddedImageSha256: annotation.embeddedImage.sha256,
    imageSha256ExactMatch: annotation.embeddedImage.sha256 === image.sha256,
    scaleMm: payload.scaleMm,
    raw: payload.raw,
    labelCounts: {
      toothCenters: annotation.toothCenters.length,
      ezPoints: annotation.ezPoints.length,
      toothWidths: annotation.toothWidths.length,
    },
    completeness: {
      toothCenters12: annotation.toothCenters.length === 12,
      ezPoints12: annotation.ezPoints.length === 12,
      toothWidths12: annotation.toothWidths.length === 12,
    },
    qualityFlags: annotationQualityFlags(annotation, image, payload.raw),
  };
}

function mergeCanonicalAnnotations(annotations, image) {
  const byLabel = groupBy(annotations.map(annotation => canonicalAnnotation(annotation, image)), item => item.labelSha256);
  return [...byLabel.values()].map(group => {
    const first = structuredClone(group[0]);
    first.sourceAnnotationSha256s = [...new Set(group.flatMap(item => item.sourceAnnotationSha256s))].sort();
    if (first.sourceAnnotationSha256s.length > 1) {
      first.qualityFlags = [...new Set([...first.qualityFlags, 'duplicate_annotation_sources_collapsed'])].sort();
    }
    return first;
  }).sort((a, b) => a.labelSha256.localeCompare(b.labelSha256, 'en'));
}

function normalizeImageNameForGrouping(imageName) {
  if (typeof imageName !== 'string' || !imageName.trim()) return null;
  return path.basename(imageName)
    .replace(/\.[^.]+$/u, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[_\s-]+(?:000[_\s-]+)?intraoral[_\s-]+lower$/u, '')
    .replace(/[_\s-]+\d{8}[_\s-]+\d+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function patientGroupForAnnotations(annotations) {
  const salt = process.env.EZ_DATASET_HASH_SALT;
  if (!salt) {
    return {
      patientGroupIds: [],
      patientGroupProvenance: 'not_generated_missing_private_salt',
    };
  }
  const ids = annotations
    .filter(annotation => annotation.kind === 'ez_curve')
    .map(annotation => normalizeImageNameForGrouping(annotation.embeddedImage.imageName))
    .filter(Boolean)
    .map(normalized => sha256Buffer(Buffer.from(`${salt}\0${normalized}`, 'utf8')));
  return {
    patientGroupIds: [...new Set(ids)].sort(),
    patientGroupProvenance: ids.length ? 'image_name_hash_unverified' : 'unavailable',
  };
}

function imageRecord({ sha256, bytes, mime, width, height }) {
  return {
    sha256,
    bytes,
    mime,
    widthPx: width,
    heightPx: height,
  };
}

function rootCaseQualityFlags(widthAnnotations, ezAnnotations, widthCanonical, ezCanonical) {
  const flags = [];
  if (widthAnnotations.length === 0) flags.push('missing_width_annotation');
  if (ezAnnotations.length === 0) flags.push('missing_ez_annotation');
  if (widthCanonical.length > 1) flags.push('multiple_distinct_width_annotation_versions');
  if (ezCanonical.length > 1) flags.push('multiple_distinct_ez_annotation_versions');
  if (widthAnnotations.length > 1) flags.push('duplicate_width_image_annotation_sources');
  if (ezAnnotations.length > 1) flags.push('duplicate_ez_image_annotation_sources');
  if (widthAnnotations.length > 1 && widthCanonical.length > 1) flags.push('width_expert_label_variability');
  if (ezAnnotations.length > 1 && ezCanonical.length > 1) flags.push('ez_expert_label_variability');
  if (widthAnnotations.length > widthCanonical.length) flags.push('duplicate_width_annotation_sources_collapsed');
  if (ezAnnotations.length > ezCanonical.length) flags.push('duplicate_ez_annotation_sources_collapsed');
  return flags.sort();
}

function buildCanonicalDataset({ roots, mappedWidths, mappedEz, duplicateImageRowsGrouped }) {
  const widthByCase = groupBy(mappedWidths.filter(item => item.root), item => item.root.caseId);
  const ezByCase = groupBy(mappedEz.filter(item => item.root), item => item.root.caseId);
  const canonicalCases = [];

  for (const root of roots) {
    const image = imageRecord(root);
    const widthMatches = widthByCase.get(root.caseId) || [];
    const ezMatches = ezByCase.get(root.caseId) || [];
    const widthAnnotations = widthMatches.map(item => item.annotation);
    const ezAnnotations = ezMatches.map(item => item.annotation);
    const widthCanonical = mergeCanonicalAnnotations(widthAnnotations, image);
    const ezCanonical = mergeCanonicalAnnotations(ezAnnotations, image);
    const patientGrouping = patientGroupForAnnotations([...widthAnnotations, ...ezAnnotations]);
    canonicalCases.push({
      caseId: root.caseId,
      sourceKind: 'root_backed',
      rootNumber: root.caseNumber,
      image,
      splitGrouping: {
        minimumGroupId: image.sha256,
        minimumGroupProvenance: 'exact_image_sha256',
        ...patientGrouping,
      },
      matching: {
        status: 'numbered_root_source',
        methods: {
          width: [...new Set(widthMatches.map(item => item.method))].sort(),
          ez: [...new Set(ezMatches.map(item => item.method))].sort(),
        },
        evidence: {
          rootNumberFromThreeDigitFileName: true,
          rootSha256Unique: true,
          widthEmbeddedSha256ExactMatchCount: widthAnnotations.filter(item => item.embeddedImage.sha256 === image.sha256).length,
          ezEmbeddedSha256ExactMatchCount: ezAnnotations.filter(item => item.embeddedImage.sha256 === image.sha256).length,
          unresolvedConflictCount: [...widthMatches, ...ezMatches].filter(item => item.conflict).length,
        },
      },
      expert: {
        widthAnnotations: widthCanonical,
        ezAnnotations: ezCanonical,
      },
      qualityFlags: rootCaseQualityFlags(widthAnnotations, ezAnnotations, widthCanonical, ezCanonical),
    });
  }

  // embedded-only 폭 정답(주로 TS 폴더)을 임베디드 이미지 SHA-256 기준으로 묶어,
  // root에 없는 EZ 케이스에도 동일 좌표계 폭 정답을 결합할 수 있게 한다.
  const embeddedOnlyWidthByHash = groupBy(
    mappedWidths.filter(item => !item.root).map(item => item.annotation),
    item => item.embeddedImage.sha256,
  );

  const embeddedOnlyEz = mappedEz.filter(item => !item.root).map(item => item.annotation);
  const embeddedOnlyByHash = groupBy(embeddedOnlyEz, item => item.embeddedImage.sha256);
  const embeddedWidthConsumed = new Set();
  for (const [sha256, annotations] of [...embeddedOnlyByHash.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const first = annotations[0];
    const image = imageRecord(first.embeddedImage);
    const ezCanonical = mergeCanonicalAnnotations(annotations, image);
    const widthAnnotations = embeddedOnlyWidthByHash.get(sha256) || [];
    if (widthAnnotations.length) embeddedWidthConsumed.add(sha256);
    const widthCanonical = mergeCanonicalAnnotations(widthAnnotations, image);
    const hasWidth = widthCanonical.length > 0;
    canonicalCases.push({
      caseId: `embedded-${sha256.slice(0, 16)}`,
      sourceKind: 'ez_embedded_only',
      rootNumber: null,
      image,
      splitGrouping: {
        minimumGroupId: image.sha256,
        minimumGroupProvenance: 'exact_image_sha256',
        ...patientGroupForAnnotations([...annotations, ...widthAnnotations]),
      },
      matching: {
        status: 'embedded_only_unmatched_numbered_root',
        methods: hasWidth
          ? ['embedded_sha256_grouping', 'width_ez_paired_by_embedded_sha256']
          : ['embedded_sha256_grouping'],
        evidence: {
          embeddedSha256UniqueWithinCanonicalCases: true,
          matchingNumberedRootSha256Count: 0,
          annotationSourceCount: annotations.length + widthAnnotations.length,
          widthEmbeddedSha256ExactMatchCount: widthAnnotations.filter(item => item.embeddedImage.sha256 === image.sha256).length,
        },
      },
      expert: {
        widthAnnotations: widthCanonical,
        ezAnnotations: ezCanonical,
      },
      qualityFlags: [
        ...(hasWidth ? [] : ['missing_width_annotation']),
        'not_backed_by_numbered_root',
        'requires_mapping_review',
        ...(ezCanonical.length > 1 ? ['multiple_distinct_ez_annotation_versions'] : []),
        ...(widthCanonical.length > 1 ? ['multiple_distinct_width_annotation_versions'] : []),
        ...(annotations.length > ezCanonical.length ? ['duplicate_ez_annotation_sources_collapsed'] : []),
        ...(widthAnnotations.length > widthCanonical.length ? ['duplicate_width_annotation_sources_collapsed'] : []),
      ].sort(),
    });
  }

  // 어떤 root/EZ 케이스에도 결합되지 못한 embedded-only 폭 정답(있다면)을 폭 전용 케이스로 보존한다.
  for (const [sha256, annotations] of [...embeddedOnlyWidthByHash.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    if (embeddedWidthConsumed.has(sha256)) continue;
    const first = annotations[0];
    const image = imageRecord(first.embeddedImage);
    const widthCanonical = mergeCanonicalAnnotations(annotations, image);
    canonicalCases.push({
      caseId: `embedded-${sha256.slice(0, 16)}`,
      sourceKind: 'width_embedded_only',
      rootNumber: null,
      image,
      splitGrouping: {
        minimumGroupId: image.sha256,
        minimumGroupProvenance: 'exact_image_sha256',
        ...patientGroupForAnnotations(annotations),
      },
      matching: {
        status: 'embedded_only_unmatched_numbered_root',
        methods: ['embedded_sha256_grouping'],
        evidence: {
          embeddedSha256UniqueWithinCanonicalCases: true,
          matchingNumberedRootSha256Count: 0,
          annotationSourceCount: annotations.length,
        },
      },
      expert: {
        widthAnnotations: widthCanonical,
        ezAnnotations: [],
      },
      qualityFlags: [
        'missing_ez_annotation',
        'not_backed_by_numbered_root',
        'requires_mapping_review',
        ...(widthCanonical.length > 1 ? ['multiple_distinct_width_annotation_versions'] : []),
        ...(annotations.length > widthCanonical.length ? ['duplicate_width_annotation_sources_collapsed'] : []),
      ].sort(),
    });
  }

  const rootBacked = canonicalCases.filter(item => item.sourceKind === 'root_backed');
  const embeddedOnly = canonicalCases.filter(item => item.sourceKind === 'ez_embedded_only');
  const allCanonicalAnnotations = canonicalCases.flatMap(item => [
    ...item.expert.widthAnnotations,
    ...item.expert.ezAnnotations,
  ]);
  return {
    schemaVersion: 'ez-canonical-dataset-index/v1',
    generatedAt: new Date().toISOString(),
    privacy: {
      phiFieldsEmitted: false,
      imageNamesEmitted: false,
      sourcePathsEmitted: false,
      sourceFileNamesEmitted: false,
      patientGroupHashing: process.env.EZ_DATASET_HASH_SALT
        ? 'salted_sha256_from_normalized_image_name_unverified'
        : 'disabled_without_private_salt',
      minimumSplitGrouping: 'exact_image_sha256',
    },
    summary: {
      canonicalCases: canonicalCases.length,
      rootBackedCases: rootBacked.length,
      ezEmbeddedOnlyCases: embeddedOnly.length,
      compositeWidthAndEzCases: canonicalCases.filter(item =>
        item.expert.widthAnnotations.length > 0 && item.expert.ezAnnotations.length > 0).length,
      rootBackedWithWidth: rootBacked.filter(item => item.expert.widthAnnotations.length > 0).length,
      rootBackedWithEz: rootBacked.filter(item => item.expert.ezAnnotations.length > 0).length,
      sourceWidthAnnotationFiles: mappedWidths.length,
      sourceEzAnnotationFiles: mappedEz.length,
      canonicalAnnotationRecords: allCanonicalAnnotations.length,
      duplicateImageRowsGroupedIntoCanonicalCases: duplicateImageRowsGrouped,
      identicalLabelSourcesCollapsed:
        mappedWidths.length + mappedEz.length - allCanonicalAnnotations.length,
      patientGroupIdsGenerated: canonicalCases.filter(item => item.splitGrouping.patientGroupIds.length > 0).length,
    },
    cases: canonicalCases,
  };
}

function assertCanonicalPhiFree(dataset, annotations) {
  const forbiddenKeys = new Set([
    'imagename', 'filename', 'filepath', 'path', 'projectpath', 'savedat', 'patientname', 'name',
  ]);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLocaleLowerCase('en-US'))) throw new Error(`PHI-sensitive key emitted: ${key}`);
      visit(child);
    }
  };
  visit(dataset);

  const serialized = JSON.stringify(dataset);
  const sensitiveValues = annotations.flatMap(annotation => [
    annotation.fileName,
    annotation.filePath,
    annotation.savedAt,
    annotation.embeddedImage.imageName,
  ]).filter(value => typeof value === 'string' && value.length >= 4);
  for (const sensitive of sensitiveValues) {
    if (serialized.includes(sensitive)) throw new Error('A source PHI/provenance string leaked into canonical output');
  }
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a path argument`);
  return value;
}

async function main() {
  const skippedAnnotations = [];
  const roots = await readRootImages();
  const widths01 = await readAnnotations(WIDTH_DIR, 'tooth_width', skippedAnnotations);
  const widthsTs = await readAnnotations(TS_WIDTH_DIR, 'tooth_width', skippedAnnotations);
  const widthsCorrected = CORRECTED_WIDTH_DIR !== TS_WIDTH_DIR
    ? await readAnnotations(CORRECTED_WIDTH_DIR, 'tooth_width', skippedAnnotations)
    : [];
  const class2Dirs = new Set([WIDTH_DIR, TS_WIDTH_DIR, CORRECTED_WIDTH_DIR]);
  const widthsClass2 = !class2Dirs.has(CLASS2_WIDTH_DIR)
    ? await readAnnotations(CLASS2_WIDTH_DIR, 'tooth_width', skippedAnnotations)
    : [];
  // resolveDir는 접두어 폴백이 있어 두 클래스2 폴더가 같은 경로로 해석될 수 있다.
  // 같은 폴더를 두 번 읽으면 동일 정답이 중복 주석으로 잡히므로 경로로 방어한다.
  const class2bDirs = new Set([...class2Dirs, CLASS2_WIDTH_DIR]);
  const widthsClass2b = !class2bDirs.has(CLASS2B_WIDTH_DIR)
    ? await readAnnotations(CLASS2B_WIDTH_DIR, 'tooth_width', skippedAnnotations)
    : [];
  const widths = [...widths01, ...widthsTs, ...widthsCorrected, ...widthsClass2, ...widthsClass2b];
  const ez = await readAnnotations(EZ_DIR, 'ez_curve', skippedAnnotations);
  const rootByHash = groupBy(roots, item => item.sha256);
  const rootByNumber = new Map(roots.map(item => [item.caseNumber, item]));

  const mappedWidths = widths.map(annotation => ({ annotation, ...resolveAnnotation(annotation, rootByHash, rootByNumber) }));
  const mappedEz = ez.map(annotation => ({ annotation, ...resolveAnnotation(annotation, rootByHash, rootByNumber) }));
  const mappings = [...mappedWidths, ...mappedEz];

  const widthByCase = groupBy(mappedWidths.filter(x => x.root), x => x.root.caseId);
  const ezByCase = groupBy(mappedEz.filter(x => x.root), x => x.root.caseId);
  const cases = roots.map(root => {
    const widthMatches = widthByCase.get(root.caseId) || [];
    const ezMatches = ezByCase.get(root.caseId) || [];
    const flags = [];
    if (widthMatches.length === 0) flags.push('missing_width_annotation');
    if (ezMatches.length === 0) flags.push('missing_ez_annotation');
    if (widthMatches.length > 1) flags.push('duplicate_width_annotations');
    if (ezMatches.length > 1) flags.push('duplicate_ez_annotations');
    for (const match of [...widthMatches, ...ezMatches]) if (match.conflict) flags.push(`${match.annotation.kind}:${match.conflict}`);
    return {
      caseId: root.caseId,
      caseNumber: root.caseNumber,
      sourceImage: root,
      widthAnnotations: widthMatches.map(x => annotationSummary(x.annotation)),
      ezAnnotations: ezMatches.map(x => annotationSummary(x.annotation)),
      mappingMethods: {
        width: widthMatches.map(x => x.method),
        ez: ezMatches.map(x => x.method),
      },
      flags,
    };
  });

  const rootDuplicates = duplicateGroups(roots, x => x.sha256, x => x.fileName);
  const widthDuplicates = duplicateGroups(widths, x => x.embeddedImage.sha256, x => x.fileName);
  const ezDuplicates = duplicateGroups(ez, x => x.embeddedImage.sha256, x => x.fileName);
  const unmatched = mappings.filter(x => !x.root).map(x => ({
    kind: x.annotation.kind,
    fileName: x.annotation.fileName,
    imageName: x.annotation.embeddedImage.imageName,
    sha256: x.annotation.embeddedImage.sha256,
    width: x.annotation.embeddedImage.width,
    height: x.annotation.embeddedImage.height,
    sameDimensionRootIds: roots
      .filter(root => root.width === x.annotation.embeddedImage.width && root.height === x.annotation.embeddedImage.height)
      .map(root => root.caseId),
    method: x.method,
    conflict: x.conflict,
  }));
  const conflicts = mappings.filter(x => x.root && x.conflict).map(x => ({
    kind: x.annotation.kind,
    fileName: x.annotation.fileName,
    mappedCaseId: x.root?.caseId || null,
    method: x.method,
    conflict: x.conflict,
  }));
  const numericSequence = roots.map(x => x.caseNumber).sort((a, b) => a - b);
  const expectedSequence = Array.from({ length: numericSequence.at(-1) || 0 }, (_, index) => index + 1);
  const missingRootNumbers = expectedSequence.filter(number => !rootByNumber.has(number));
  const observedJsonKeys = {
    width: [...new Set(widths.flatMap(x => x.jsonKeys))].sort(),
    ez: [...new Set(ez.flatMap(x => x.jsonKeys))].sort(),
  };

  const report = {
    schemaVersion: 'ez-dataset-index/v1-draft',
    generatedAt: new Date().toISOString(),
    projectPath: PROJECT,
    summary: {
      rootImages: roots.length,
      rootRange: numericSequence.length ? [numericSequence[0], numericSequence.at(-1)] : null,
      missingRootNumbers,
      widthMdFiles: widths.length,
      ezMdFiles: ez.length,
      widthMapped: mappedWidths.filter(x => x.root).length,
      ezMapped: mappedEz.filter(x => x.root).length,
      casesWithBoth: cases.filter(x => x.widthAnnotations.length && x.ezAnnotations.length).length,
      casesWidthOnly: cases.filter(x => x.widthAnnotations.length && !x.ezAnnotations.length).length,
      casesEzOnly: cases.filter(x => !x.widthAnnotations.length && x.ezAnnotations.length).length,
      casesWithNeither: cases.filter(x => !x.widthAnnotations.length && !x.ezAnnotations.length).length,
      mappingMethods: countBy(mappings, x => `${x.annotation.kind}:${x.method}`),
      unmatchedAnnotations: unmatched.length,
      mappingConflicts: conflicts.length,
      rootDuplicateHashGroups: rootDuplicates.length,
      widthDuplicateHashGroups: widthDuplicates.length,
      ezDuplicateHashGroups: ezDuplicates.length,
    },
    observedJsonKeys,
    duplicates: {
      roots: rootDuplicates,
      widths: widthDuplicates,
      ez: ezDuplicates,
    },
    unmatched,
    conflicts,
    cases,
  };

  const outputPathArgument = argumentValue('--output');
  if (outputPathArgument) {
    const duplicateImageRowsGrouped = [...widthDuplicates, ...ezDuplicates]
      .reduce((sum, group) => sum + group.files.length - 1, 0);
    const canonicalDataset = buildCanonicalDataset({
      roots,
      mappedWidths,
      mappedEz,
      duplicateImageRowsGrouped,
    });
    assertCanonicalPhiFree(canonicalDataset, [...widths, ...ez]);
    const outputPath = path.resolve(outputPathArgument);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(canonicalDataset, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      outputPath,
      ...canonicalDataset.summary,
      phiAuditPassed: true,
    }, null, 2));
    return;
  }

  if (process.argv.includes('--unmatched-table')) {
    console.log('kind\tmd_file\timage_name\twidth\theight\tsame_dimension_root_ids\tsha256');
    for (const item of unmatched) {
      console.log([
        item.kind,
        item.fileName,
        item.imageName || '-',
        item.width ?? '-',
        item.height ?? '-',
        item.sameDimensionRootIds.join('|') || '-',
        item.sha256,
      ].join('\t'));
    }
    return;
  }

  if (process.argv.includes('--table')) {
    console.log('case_id\troot_file\twidth_md\tez_md\twidth_method\tez_method');
    for (const item of cases) {
      console.log([
        item.caseId,
        item.sourceImage.fileName,
        item.widthAnnotations.map(x => x.fileName).join('|') || '-',
        item.ezAnnotations.map(x => x.fileName).join('|') || '-',
        item.mappingMethods.width.join('|') || '-',
        item.mappingMethods.ez.join('|') || '-',
      ].join('\t'));
    }
    return;
  }

  if (process.argv.includes('--json')) {
    // The full report is intentionally emitted to stdout; the source folders remain read-only.
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const compact = {
    ...report.summary,
    observedJsonKeys,
    rootDuplicateGroups: rootDuplicates,
    widthDuplicateGroups: widthDuplicates,
    ezDuplicateGroups: ezDuplicates,
    unmatched,
    conflicts,
    caseIdsWithDuplicateWidth: cases.filter(x => x.widthAnnotations.length > 1).map(x => x.caseId),
    caseIdsWithDuplicateEz: cases.filter(x => x.ezAnnotations.length > 1).map(x => x.caseId),
    caseIdsMissingWidth: cases.filter(x => !x.widthAnnotations.length).map(x => x.caseId),
    caseIdsMissingEz: cases.filter(x => !x.ezAnnotations.length).map(x => x.caseId),
  };
  console.log(JSON.stringify(compact, null, 2));
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
