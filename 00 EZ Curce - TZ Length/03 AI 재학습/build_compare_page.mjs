#!/usr/bin/env node
// EZL > TZL 인 케이스의 전문가 정답 사진 좌우 비교 페이지 생성.
// 왼쪽 = EZ 점 표기 정답(02 이퀼리브리엄 찍기), 오른쪽 = 치아폭 점 표기 정답(TS).
// 각 원본 이미지를 폭 700px로 축소해 base64 임베드하고, 좌표를 같은 비율로 SVG 오버레이한다.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PROJECT = 'C:\\01 클로드코드\\20-19 Orthodontics AI\\00 EZ Curce - TZ Length';
const EZ_DIR = path.join(PROJECT, '02 이퀼리브리엄 찍기');
const TS_DIR = path.join(PROJECT, '02 치아 좌우폭 찍기');
const XLSX_PATH = path.join(PROJECT, 'EZL_TZL_114_분석표.xlsx');
const TARGET_W = 720;                 // 축소 후 이미지 폭(px)
const SCALE_CHORD_MM = 54;
const SAMPLES_PER_SEGMENT = 50;
const COMPARE_POINTS = 200;

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}
function generateCatmullRom(points) {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return points.slice();
  const result = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < SAMPLES_PER_SEGMENT; j += 1) result.push(catmull(p0, p1, p2, p3, j / SAMPLES_PER_SEGMENT));
  }
  result.push(points[points.length - 1]);
  return result;
}

function extractJson(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  return m ? JSON.parse(m[1]) : null;
}
function stripDataUrl(imageData) {
  return Buffer.from(imageData.replace(/^data:image\/[a-zA-Z]+;base64,/, ''), 'base64');
}

async function loadCase(caseId) {
  const ezText = (await readFile(path.join(EZ_DIR, caseId + '.md'))).toString('utf8');
  const tsBuf = await readFile(path.join(TS_DIR, caseId + '.md'));
  const ezJson = extractJson(ezText);
  const tsJson = tsBuf.length ? extractJson(tsBuf.toString('utf8')) : null;
  return { ezJson, tsJson };
}

// 원본 버퍼를 폭 TARGET_W로 축소하고 base64 + scale 반환
async function resizeToDataUrl(buffer) {
  const meta = await sharp(buffer).metadata();
  const scale = TARGET_W / meta.width;
  const outH = Math.round(meta.height * scale);
  const resized = await sharp(buffer).resize(TARGET_W, outH).jpeg({ quality: 72 }).toBuffer();
  return { dataUrl: 'data:image/jpeg;base64,' + resized.toString('base64'), scale, w: TARGET_W, h: outH, origW: meta.width, origH: meta.height };
}

function svgEzOverlay(ezPts, s, w, h) {
  const P = ezPts.map(p => ({ x: p.x * s, y: p.y * s }));
  const curve = generateCatmullRom(P);
  const pathD = curve.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
  const dots = P.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#ffd400" stroke="#8a6d00" stroke-width="1.5"/><text x="${(p.x+7).toFixed(1)}" y="${(p.y-6).toFixed(1)}" font-size="12" fill="#ffea00" stroke="#000" stroke-width="0.4" font-weight="bold">${i+1}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
<path d="${pathD}" fill="none" stroke="#ffd400" stroke-width="3.5" opacity="0.95"/>
${dots}</svg>`;
}

function svgTzOverlay(toothWidths, s, w, h) {
  const lines = toothWidths.map((wd, i) => {
    if (!wd?.p1 || !wd?.p2) return '';
    const a = { x: wd.p1.x * s, y: wd.p1.y * s }, b = { x: wd.p2.x * s, y: wd.p2.y * s };
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#ff2d2d" stroke-width="3.5" opacity="0.95"/>
<circle cx="${a.x.toFixed(1)}" cy="${a.y.toFixed(1)}" r="4" fill="#ff2d2d"/><circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="4" fill="#ff2d2d"/>
<text x="${mx.toFixed(1)}" y="${my.toFixed(1)}" font-size="12" fill="#fff" stroke="#000" stroke-width="0.5" font-weight="bold" text-anchor="middle">${i+1}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${lines}</svg>`;
}

const GAP_THRESHOLD = 25;      // 치아 간격 "큼" 기준(mm) = build_ezl_tzl_table.mjs와 동일
const INFLATE_THRESHOLD = 5;   // EZL 팽창분(원본-보정) "큼" 기준(mm) = 완전케이스 평균(3.2)+~1SD
// 열: 0파일번호,1치아개수,2EZ점,3완전성,4EZL곡선원본,5EZL보정,6TZL,7치아간격합,8차이(TZL-보정EZL),9비율,10큰값,11비고
// mode: 'EZL' | 'TZL'(큰값 기준) | 'GAP'(치아간격 큰 순) | 'INFLATE'(EZL 팽창분 큰 순)
function readTargets(mode) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(XLSX_PATH);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  const out = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || typeof r[0] !== 'string' || r[0].startsWith('[') || r[0].startsWith('▶') || r[0].startsWith(' ')) continue;
    if (r[1] !== 12) continue;
    const inflate = (typeof r[4] === 'number' && typeof r[5] === 'number') ? r[4] - r[5] : null;  // 원본EZL - 보정EZL
    const rec = { id: r[0], ezlRaw: r[4], ezl: r[5], tzl: r[6], gap: r[7], diff: r[8], inflate };
    if (mode === 'GAP') { if (typeof r[7] === 'number' && r[7] >= GAP_THRESHOLD) out.push(rec); }
    else if (mode === 'INFLATE') { if (inflate !== null && inflate >= INFLATE_THRESHOLD) out.push(rec); }
    else if (r[10] === mode) out.push(rec);
  }
  if (mode === 'GAP') out.sort((a, b) => b.gap - a.gap);            // 간격 큰 순
  else if (mode === 'INFLATE') out.sort((a, b) => b.inflate - a.inflate);  // 팽창분 큰 순
  else out.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return out;
}

const VIEWS = [
  {
    mode: 'EZL',
    outPath: path.join(PROJECT, 'ezl_gt_tzl_compare.html'),
    title: 'EZL > TZL 사진 비교 보기 (보정 EZL 기준)',
    desc: '보정 EZL(치아 점유 구간)이 TZL보다 큰 완전 케이스(치아 12개)',
    note: '보정 EZL(치아 간 간격 제외) 기준으로도 EZL이 TZL보다 큰 예외 케이스',
    bigger: '보정EZL이',
  },
  {
    mode: 'TZL',
    outPath: path.join(PROJECT, 'tzl_gt_ezl_compare.html'),
    title: 'TZL > EZL 사진 비교 보기 (보정 EZL 기준)',
    desc: 'TZL이 보정 EZL보다 큰 완전 케이스(치아 12개)',
    note: '치아폭 선분 합이 보정 EZL(치아 점유 구간)보다 길게 표기됨 (교정 총생 경향, 정상)',
    bigger: 'TZL이',
  },
  {
    mode: 'GAP',
    outPath: path.join(PROJECT, 'big_gap_compare.html'),
    title: '치아 간격 큰 사례 보기',
    desc: `치아 간 간격 합이 ${GAP_THRESHOLD}mm 이상(완전케이스 평균+1SD)인 완전 케이스(치아 12개)`,
    note: `인접 치아 사이 간격이 넓은 배열. 간격이 클수록 EZ 곡선(간격 위 통과)과 치아폭 합의 차이가 커짐`,
    bigger: 'TZL이',
    showGap: true,
  },
  {
    mode: 'INFLATE',
    outPath: path.join(PROJECT, 'ezl_inflate_compare.html'),
    title: 'EZL 증가 원인 보기',
    desc: `치아 간 간격 때문에 EZL(곡선)이 실제보다 ${INFLATE_THRESHOLD}mm 이상 커진 완전 케이스(치아 12개)`,
    note: `EZ 곡선이 치아 사이 간격 위를 지나며 길이가 부풀려진 케이스. 팽창분 = 원본 EZL − 보정 EZL(치아 점유 구간만). 왼쪽 노란 곡선이 치아 사이 빈 공간을 가로지르는 부분이 EZL 증가 원인`,
    bigger: 'TZL이',
    showInflate: true,
  },
];

async function buildView(view) {
  const targets = readTargets(view.mode);
  console.log(view.title, '— 대상(완전 12개):', targets.length, '건');
  const cards = [];
  for (const t of targets) {
    try {
      const { ezJson, tsJson } = await loadCase(t.id);
      if (!ezJson || !tsJson) { console.log('  skip', t.id, '(정답 누락)'); continue; }
      const ezImg = await resizeToDataUrl(stripDataUrl(ezJson.imageData));
      const tsImg = await resizeToDataUrl(stripDataUrl(tsJson.imageData));
      const ezOverlay = svgEzOverlay(ezJson.ezPoints, ezImg.scale, ezImg.w, ezImg.h);
      const tzOverlay = svgTzOverlay(tsJson.toothWidths, tsImg.scale, tsImg.w, tsImg.h);
      cards.push({ ...t, ezImg, tsImg, ezOverlay, tzOverlay, ezPts: ezJson.ezPoints.length, twN: tsJson.toothWidths.length });
      console.log('  ok', t.id);
    } catch (e) { console.log('  error', t.id, e.message); }
  }

  const cardHtml = cards.map((c, idx) => `
<section class="case" data-id="${c.id}">
  <div class="case-head">
    <span class="idx">#${idx + 1}</span>
    <span class="cid">파일 ${c.id}</span>
    <span class="metrics">
      ${view.showInflate ? `<b class="infl">EZL 팽창분 +${c.inflate.toFixed(1)}mm</b> · <span class="raw">원본EZL ${c.ezlRaw.toFixed(1)}→보정 ${c.ezl.toFixed(1)}mm</span> · <b class="gap">간격 ${c.gap.toFixed(1)}mm</b>` : ''}${view.showGap ? `<b class="gap">치아 간격 합 ${c.gap.toFixed(1)}mm</b> · <b class="ezl">보정EZL ${c.ezl.toFixed(1)}mm</b> vs <b class="tzl">TZL ${c.tzl.toFixed(1)}mm</b>` : ''}${(!view.showGap && !view.showInflate) ? `<b class="ezl">보정EZL ${c.ezl.toFixed(1)}mm</b> vs <b class="tzl">TZL ${c.tzl.toFixed(1)}mm</b>` : ''}
      ${view.showInflate ? '' : `<span class="diff">차이 ${c.diff.toFixed(2)}mm (${view.bigger} ${Math.abs(c.diff).toFixed(2)}mm 큼)</span>`}
    </span>
  </div>
  <div class="pair">
    <figure>
      <figcaption><span class="dot yellow"></span>EZL 정답 — EZ 곡선 점 ${c.ezPts}개</figcaption>
      <div class="imgbox">
        <img src="${c.ezImg.dataUrl}" width="${c.ezImg.w}" height="${c.ezImg.h}" loading="lazy">
        <div class="ov">${c.ezOverlay}</div>
      </div>
    </figure>
    <figure>
      <figcaption><span class="dot red"></span>TZL 정답 — 치아폭 선분 ${c.twN}개</figcaption>
      <div class="imgbox">
        <img src="${c.tsImg.dataUrl}" width="${c.tsImg.w}" height="${c.tsImg.h}" loading="lazy">
        <div class="ov">${c.tzOverlay}</div>
      </div>
    </figure>
  </div>
</section>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${view.title}</title>
<style>
  *{box-sizing:border-box;} body{font-family:'Malgun Gothic',sans-serif;margin:0;background:#f4f6f9;color:#222;}
  .wrap{max-width:1560px;margin:0 auto;padding:20px 16px 60px;}
  h1{font-size:21px;margin:0 0 4px;} .sub{color:#667;font-size:13px;margin-bottom:16px;}
  .legend{background:#fff;border-radius:8px;padding:10px 16px;font-size:13px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  .legend .dot{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:middle;margin-right:5px;}
  .dot.yellow{background:#ffd400;border:1px solid #8a6d00;} .dot.red{background:#ff2d2d;}
  .case{background:#fff;border-radius:10px;padding:14px 16px;margin-bottom:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);}
  .case-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #eef0f4;}
  .idx{background:#2d3748;color:#fff;border-radius:6px;padding:3px 9px;font-size:13px;font-weight:700;}
  .cid{font-weight:700;font-size:15px;} .metrics{font-size:13px;color:#556;}
  .metrics .ezl{color:#b7791f;} .metrics .tzl{color:#c53030;}
  .metrics .gap{background:#fff7e6;color:#b7791f;padding:2px 8px;border-radius:6px;}
  .metrics .infl{background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:6px;}
  .metrics .raw{color:#667;font-weight:400;}
  .metrics .diff{margin-left:8px;background:#fef2f2;color:#c53030;padding:2px 8px;border-radius:6px;font-weight:600;}
  .pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
  figure{margin:0;} figcaption{font-size:13px;font-weight:600;margin-bottom:6px;color:#334;}
  .imgbox{position:relative;line-height:0;border-radius:6px;overflow:hidden;background:#000;}
  .imgbox img{width:100%;height:auto;display:block;} .ov{position:absolute;inset:0;} .ov svg{width:100%;height:100%;}
  @media(max-width:900px){.pair{grid-template-columns:1fr;}}
</style></head><body>
<div class="wrap">
  <h1>${view.title}</h1>
  <div class="sub">${view.desc} ${cards.length}건 · 좌: EZ 점 표기 정답 · 우: 치아폭 점 표기 정답 · 동일 원본 이미지(SHA 일치) · 차이 큰 순 정렬</div>
  <div class="legend">
    <span class="dot yellow"></span><b>EZL(노란색)</b> = EZ 점을 잇는 Catmull-Rom 곡선 &nbsp;&nbsp;
    <span class="dot red"></span><b>TZL(빨간색)</b> = 12개 치아폭 선분(p1–p2) &nbsp;&nbsp;
    | ${view.note}
  </div>
  ${cardHtml}
</div></body></html>`;

  await writeFile(view.outPath, html, 'utf8');
  console.log('생성 완료:', view.outPath, '(', cards.length, '케이스,', Math.round(html.length / 1024), 'KB )');
}

async function main() {
  for (const view of VIEWS) await buildView(view);
}

main().catch(e => { console.error(e?.stack || String(e)); process.exitCode = 1; });
