#!/usr/bin/env node
// 각 케이스마다 3장의 PNG 생성:
//  번호-오리지널.png : 원본 이미지(점 없음)
//  번호-EZL.png      : 원본 + EZ 곡선·점 (02 이퀼리브리엄 찍기)
//  번호-TZL.png      : 원본 + 치아폭 선분·점 (02 치아 좌우폭 찍기)
// 저장 위치: 02 사진 모음
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const EZ_DIR = path.join(PROJECT, '02 이퀼리브리엄 찍기');
const TZ_DIR = path.join(PROJECT, '02 치아 좌우폭 찍기');
const OUT_DIR = path.join(PROJECT, '02 사진 모음');
const SAMPLES_PER_SEGMENT = 40;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}
function catmullPath(pts) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let j = 0; j < SAMPLES_PER_SEGMENT; j += 1) {
      const p = catmull(p0, p1, p2, p3, j / SAMPLES_PER_SEGMENT);
      out.push((out.length === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1));
    }
  }
  const last = pts[pts.length - 1];
  out.push('L' + last.x.toFixed(1) + ',' + last.y.toFixed(1));
  return out.join(' ');
}

function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  return m ? JSON.parse(m[1]) : null;
}
function stripDataUrl(imageData) {
  return Buffer.from(imageData.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');
}
function stem(name) { return path.basename(name, path.extname(name)); }

// 용량 절감: 긴 변 1600px로 축소 + 최대 압축 + 팔레트 양자화. 좌표는 축소 배율(scale)로 맞춘다.
const MAX_DIM = 1600;
function pngOut(sharpInstance) {
  return sharpInstance.png({ compressionLevel: 9, palette: true, quality: 80, effort: 7 });
}

// 좌표 크기에 비례한 선/점 굵기(고해상도 대응)
function strokeFor(w, h) {
  const s = Math.max(w, h);
  return { line: Math.max(4, Math.round(s / 500)), dot: Math.max(6, Math.round(s / 350)), font: Math.max(20, Math.round(s / 90)) };
}

function ezSvg(ezPts, w, h) {
  const S = strokeFor(w, h);
  const pathD = catmullPath(ezPts);
  const dots = ezPts.map((p, i) =>
    `<circle cx="${p.x}" cy="${p.y}" r="${S.dot}" fill="#ffd400" stroke="#8a6d00" stroke-width="${S.line * 0.5}"/>` +
    `<text x="${p.x + S.dot + 2}" y="${p.y - S.dot}" font-size="${S.font}" fill="#ffea00" stroke="#000" stroke-width="1" font-weight="bold">${i + 1}</text>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<path d="${pathD}" fill="none" stroke="#ffd400" stroke-width="${S.line}" stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>` +
    `${dots}</svg>`;
}

function tzSvg(widths, w, h) {
  const S = strokeFor(w, h);
  const lines = widths.map((wd, i) => {
    if (!wd?.p1 || !wd?.p2) return '';
    const mx = (wd.p1.x + wd.p2.x) / 2, my = (wd.p1.y + wd.p2.y) / 2;
    return `<line x1="${wd.p1.x}" y1="${wd.p1.y}" x2="${wd.p2.x}" y2="${wd.p2.y}" stroke="#ff2d2d" stroke-width="${S.line}" stroke-linecap="round" opacity="0.95"/>` +
      `<circle cx="${wd.p1.x}" cy="${wd.p1.y}" r="${S.dot * 0.7}" fill="#ff2d2d"/><circle cx="${wd.p2.x}" cy="${wd.p2.y}" r="${S.dot * 0.7}" fill="#ff2d2d"/>` +
      `<text x="${mx}" y="${my}" font-size="${S.font}" fill="#fff" stroke="#000" stroke-width="1" font-weight="bold" text-anchor="middle">${i + 1}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${lines}</svg>`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const files = (await readdir(EZ_DIR)).filter(f => /\.md$/i.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  let ok = 0, skip = 0;
  const problems = [];

  for (const file of files) {
    const id = stem(file);
    try {
      const ezBuf = await readFile(path.join(EZ_DIR, file));
      const tzBuf = await readFile(path.join(TZ_DIR, file)).catch(() => Buffer.alloc(0));
      const ezJson = ezBuf.length ? extractJson(ezBuf.toString('utf8')) : null;
      const tzJson = tzBuf.length ? extractJson(tzBuf.toString('utf8')) : null;

      // 원본 이미지는 EZ md의 것을 기준(둘은 동일 SHA). EZ가 없으면 TZ에서.
      const imgData = ezJson?.imageData || tzJson?.imageData;
      if (!imgData) { problems.push(`${id}: 이미지 없음`); skip++; continue; }
      const imgBuf = stripDataUrl(imgData);
      const meta = await sharp(imgBuf).metadata();
      // 긴 변 MAX_DIM로 축소한 캔버스 기준으로 렌더 (용량 절감)
      const scale = Math.min(1, MAX_DIM / Math.max(meta.width, meta.height));
      const w = Math.round(meta.width * scale), h = Math.round(meta.height * scale);
      const baseBuf = await sharp(imgBuf).resize(w, h).toBuffer();
      const sc = (pts) => pts.map(p => ({ ...p, x: p.x * scale, y: p.y * scale }));
      const scW = (ws) => ws.map(wd => ({ p1: { x: wd.p1.x * scale, y: wd.p1.y * scale }, p2: { x: wd.p2.x * scale, y: wd.p2.y * scale } }));

      // 1) 오리지널
      await pngOut(sharp(baseBuf)).toFile(path.join(OUT_DIR, `${id}-오리지널.png`));

      // 2) EZL
      if (ezJson?.ezPoints?.length >= 2) {
        const overlay = Buffer.from(ezSvg(sc(ezJson.ezPoints.filter(p => Number.isFinite(p.x))), w, h));
        await pngOut(sharp(baseBuf).composite([{ input: overlay, top: 0, left: 0 }])).toFile(path.join(OUT_DIR, `${id}-EZL.png`));
      } else problems.push(`${id}: EZ점 부족(${ezJson?.ezPoints?.length ?? 0})`);

      // 3) TZL
      if (tzJson?.toothWidths?.length >= 1) {
        const overlay = Buffer.from(tzSvg(scW(tzJson.toothWidths.filter(x => x?.p1 && x?.p2)), w, h));
        await pngOut(sharp(baseBuf).composite([{ input: overlay, top: 0, left: 0 }])).toFile(path.join(OUT_DIR, `${id}-TZL.png`));
      } else problems.push(`${id}: 치아폭 부족(${tzJson?.toothWidths?.length ?? 0})`);

      ok++;
      if (ok % 20 === 0) console.log(`  진행 ${ok}/${files.length}`);
    } catch (e) {
      problems.push(`${id}: 오류 ${e.message}`);
      skip++;
    }
  }

  console.log(`\n완료: ${ok}건 처리, ${skip}건 스킵`);
  console.log(`저장 위치: ${OUT_DIR}`);
  if (problems.length) {
    console.log(`\n[확인 필요 ${problems.length}건]`);
    problems.forEach(p => console.log('  ' + p));
  }
}

main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
