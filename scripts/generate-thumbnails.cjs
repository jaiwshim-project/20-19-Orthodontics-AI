/**
 * 썸네일 생성 스크립트
 * 각 환자 이미지를 400px 너비로 축소하여 thumb/ 폴더에 저장
 * patient-view.html에서 썸네일 우선 로딩 → 클릭 시 원본 로드
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const BASE = path.join(__dirname, '..', '재분류', '클래스1', '전체자료_5방향_세팔로_안면_AB기준');
const THUMB_WIDTH = 400;

async function run() {
  const patients = fs.readdirSync(BASE).filter(d => fs.statSync(path.join(BASE, d)).isDirectory());
  let total = 0, skipped = 0;

  for (const p of patients) {
    for (const phase of ['초진', '최종']) {
      for (const cat of ['face', 'intraoral', 'xray']) {
        const srcDir = path.join(BASE, p, phase, cat);
        if (!fs.existsSync(srcDir)) continue;

        const thumbDir = path.join(BASE, p, phase, cat, 'thumb');
        if (!fs.existsSync(thumbDir)) fs.mkdirSync(thumbDir, { recursive: true });

        const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.jpg') && f !== 'thumb');
        for (const f of files) {
          const src = path.join(srcDir, f);
          const dest = path.join(thumbDir, f);

          if (fs.existsSync(dest)) { skipped++; continue; }

          try {
            await sharp(src)
              .resize(THUMB_WIDTH, null, { fit: 'inside' })
              .jpeg({ quality: 75 })
              .toFile(dest);
            total++;
          } catch (e) {
            console.warn(`[SKIP] ${p}/${phase}/${cat}/${f}: ${e.message}`);
          }
        }
      }
    }
    process.stdout.write(`\r${p} 완료 (${total} 생성, ${skipped} 기존)`);
  }

  console.log(`\n=== 완료: ${total}개 썸네일 생성, ${skipped}개 기존 유지 ===`);
}

run().catch(console.error);
