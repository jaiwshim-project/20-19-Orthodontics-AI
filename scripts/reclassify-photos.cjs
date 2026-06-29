/**
 * 68명 환자 사진 일괄 재분류 스크립트 v2
 * JPEG 픽셀 색상 분석으로 확실한 분류:
 * - 안면(face): 파란색 배경 (B > 120, B > R*1.5, B > G*1.3)
 * - X-ray: 그레이스케일 (채도 < 0.12) + 파일 크기 < 3.5MB
 * - 구강내(intraoral): 나머지 (분홍/베이지 잇몸+치아색)
 */

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

function analyzeImageColors(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const raw = jpeg.decode(buf, { maxMemoryUsageInMB: 1024, formatAsRGBA: true });
    const { width, height, data } = raw;

    let blueCount = 0, grayCount = 0, totalSampled = 0;

    const stepX = Math.max(1, Math.floor(width / 80));
    const stepY = Math.max(1, Math.floor(height / 80));

    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        const isEdge = y < height * 0.15 || x < width * 0.12 || x > width * 0.88;
        if (!isEdge) continue;

        const i = (y * width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        totalSampled++;

        if (b > 120 && b > r * 1.5 && b > g * 1.3) blueCount++;

        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
        if (sat < 0.12) grayCount++;
      }
    }

    if (totalSampled === 0) return null;
    return { blueRatio: blueCount / totalSampled, grayRatio: grayCount / totalSampled };
  } catch (e) {
    return null;
  }
}

function getJpegDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let offset = 2;
  while (offset < buf.length - 8) {
    if (buf[offset] !== 0xFF) { offset++; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
    }
    const len = buf.readUInt16BE(offset + 2);
    offset += 2 + len;
  }
  return null;
}

function classifyImage(filePath) {
  const dim = getJpegDimensions(filePath);
  if (!dim) return null;
  const ratio = dim.width / dim.height;
  const sizeMB = fs.statSync(filePath).size / 1024 / 1024;

  // 확실한 X-ray: 파일 크기 작고 특정 비율
  if (sizeMB < 3.5 && ratio > 1.8) return 'xray';
  if (sizeMB < 3.5 && ratio >= 0.8 && ratio <= 1.05) return 'xray';

  // 확실한 세로형 안면 (ratio < 0.8)
  if (ratio < 0.8) return 'face';

  // 가로형 (ratio 1.2~1.8): 구강내 vs 가로 안면 → 색상 분석
  if (ratio >= 1.2 && ratio <= 1.8) {
    const colors = analyzeImageColors(filePath);
    if (colors) {
      if (colors.blueRatio > 0.10) return 'face';
      if (colors.grayRatio > 0.65) return 'xray';
    }
    return 'intraoral';
  }

  // 넓은 가로 (ratio > 1.8) = 파노라마
  if (ratio > 1.8) return 'xray';

  // 정사각에 가까운 이미지 — 색상 분석
  const colors = analyzeImageColors(filePath);
  if (colors) {
    if (colors.grayRatio > 0.6) return 'xray';
    if (colors.blueRatio > 0.10) return 'face';
  }

  if (sizeMB < 4) return 'xray';
  return 'intraoral';
}

const BASE = path.join(__dirname, '..', '재분류', '클래스1', '전체자료_5방향_세팔로_안면_AB기준');
const patients = fs.readdirSync(BASE).filter(d => fs.statSync(path.join(BASE, d)).isDirectory());

let fixCount = 0;

for (const p of patients) {
  for (const phase of ['초진', '최종']) {
    const phaseDir = path.join(BASE, p, phase);
    if (!fs.existsSync(phaseDir)) continue;

    const allFiles = [];
    for (const cat of ['face', 'intraoral', 'xray']) {
      const catDir = path.join(phaseDir, cat);
      if (!fs.existsSync(catDir)) continue;
      const files = fs.readdirSync(catDir).filter(f => f.endsWith('.jpg'));
      for (const f of files) {
        const fp = path.join(catDir, f);
        const realCat = classifyImage(fp);
        allFiles.push({ filePath: fp, currentCat: cat, currentSlot: f, realCat: realCat || cat });
      }
    }

    const needsFix = allFiles.filter(f => f.realCat !== f.currentCat);
    if (needsFix.length === 0) continue;

    const tempDir = path.join(phaseDir, '_reclassify_temp');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });

    for (let i = 0; i < allFiles.length; i++) {
      const tempFile = path.join(tempDir, `img_${i}.jpg`);
      fs.copyFileSync(allFiles[i].filePath, tempFile);
      allFiles[i].tempFile = tempFile;
    }

    const groups = { face: [], intraoral: [], xray: [] };
    for (const f of allFiles) {
      groups[f.realCat].push(f);
    }

    const SLOTS = {
      intraoral: ['01_front.jpg', '02_left.jpg', '03_lower.jpg', '04_right.jpg', '05_upper.jpg'],
      face: ['01_45degree.jpg', '02_front.jpg', '03_lateral.jpg', '04_smile.jpg'],
      xray: ['01_ceph.jpg', '02_pano.jpg']
    };

    for (const [cat, files] of Object.entries(groups)) {
      const catDir = path.join(phaseDir, cat);
      if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });

      if (cat === 'xray') {
        files.sort((a, b) => {
          const dimA = getJpegDimensions(a.tempFile);
          const dimB = getJpegDimensions(b.tempFile);
          return (dimA ? dimA.width / dimA.height : 1) - (dimB ? dimB.width / dimB.height : 1);
        });
      }

      const existingFiles = fs.readdirSync(catDir).filter(f => f.endsWith('.jpg'));
      for (const ef of existingFiles) fs.unlinkSync(path.join(catDir, ef));

      const slots = SLOTS[cat];
      for (let i = 0; i < Math.min(files.length, slots.length); i++) {
        fs.copyFileSync(files[i].tempFile, path.join(catDir, slots[i]));
      }
    }

    fs.rmSync(tempDir, { recursive: true });
    fixCount += needsFix.length;
    console.log(`[FIX] ${p}/${phase}: ${needsFix.length}개 (face:${groups.face.length} intra:${groups.intraoral.length} xray:${groups.xray.length})`);
  }
}

console.log(`\n=== 완료: ${fixCount}개 파일 재분류 ===`);
