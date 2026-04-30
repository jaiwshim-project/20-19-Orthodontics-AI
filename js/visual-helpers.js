/* ==============================================================
   Visual Helpers — 측정값 시각화 SVG 생성 함수 (공통)
   ============================================================== */

(function () {
  function classify(val, normal, range) {
    if (!Number.isFinite(val)) return 'warn';
    if (val < range[0] || val > range[1]) return 'danger';
    if (val >= normal[0] && val <= normal[1]) return 'ok';
    return 'warn';
  }

  // 컬러 게이지 막대
  function gaugeCard(name, unit, val, lo, hi, zones, note, extraSvg = '') {
    const v = Number.isFinite(val) ? val : 0;
    const pct = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    let cls = 'ok';
    for (const z of zones) {
      if (v <= z.to) { cls = z.cls; break; }
    }
    if (v > zones[zones.length - 1].to) cls = zones[zones.length - 1].cls;
    const W = 240;
    const zoneSvg = zones.map((z, idx) => {
      const x1 = ((idx === 0 ? lo : zones[idx - 1].to) - lo) / (hi - lo) * W;
      const x2 = (z.to - lo) / (hi - lo) * W;
      return `<rect class="gauge-zone-${z.cls}" x="${x1}" y="20" width="${x2 - x1}" height="14" rx="3"/>`;
    }).join('');
    const ticks = zones.map(z => {
      const x = (z.to - lo) / (hi - lo) * W;
      return `<text x="${x}" y="48" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.4)">${z.to}</text>`;
    }).join('');
    const pinX = pct * W;
    const valLabel = Number.isFinite(val) ? (typeof val === 'number' ? val.toFixed(1) : String(val)) : '—';
    return `
      <div class="visual-card">
        <div class="vc-head">
          <div class="vc-name">${name}${unit ? ' (' + unit + ')' : ''}</div>
          <div class="vc-val ${cls}">${valLabel}</div>
        </div>
        <svg viewBox="0 0 ${W} 50" preserveAspectRatio="none">
          <rect class="gauge-track" x="0" y="20" width="${W}" height="14" rx="3"/>
          ${zoneSvg}
          <line x1="${pinX}" y1="14" x2="${pinX}" y2="40" stroke="#fff" stroke-width="2"/>
          <circle class="gauge-pin" cx="${pinX}" cy="27" r="6"/>
          ${ticks}
        </svg>
        ${extraSvg ? `<div style="margin-top:6px;">${extraSvg}</div>` : ''}
        <div class="vc-note">${note}</div>
      </div>
    `;
  }

  // 각도 카드 (커스텀 SVG 필요)
  function angleCard(name, unit, val, normal, range, note, svg) {
    const cls = classify(val, normal, range);
    return `
      <div class="visual-card">
        <div class="vc-head">
          <div class="vc-name">${name}${unit ? ' (' + unit + ')' : ''}</div>
          <div class="vc-val ${cls}">${Number.isFinite(val) ? val.toFixed(1) + '°' : '—'}</div>
        </div>
        ${svg}
        <div class="vc-note">${note}</div>
      </div>
    `;
  }

  // 선택형 카드 (옵션 중 하나 강조)
  function choiceCard(name, value, options, note) {
    const items = options.map(o => {
      const active = o.value === value;
      return `
        <div style="text-align:center; flex:1;">
          <div style="display:inline-block; padding:6px; border-radius:8px; ${active ? 'background:rgba(14,165,233,0.18); box-shadow:0 0 12px rgba(14,165,233,0.35);' : 'opacity:0.35;'}">
            ${o.icon}
          </div>
          <div style="font-size:10px; margin-top:4px; color:${active ? 'var(--color-primary)' : 'var(--text-muted)'}; font-weight:${active ? '700' : '400'};">${o.label}</div>
        </div>
      `;
    }).join('');
    const valLabel = options.find(o => o.value === value)?.label || '—';
    return `
      <div class="visual-card">
        <div class="vc-head">
          <div class="vc-name">${name}</div>
          <div class="vc-val">${valLabel}</div>
        </div>
        <div style="display:flex; align-items:center; gap:6px; padding:6px 0;">${items}</div>
        <div class="vc-note">${note}</div>
      </div>
    `;
  }

  // ========== SVG 그래픽 함수 ==========

  // 두 직선 사이 각도 (Vertical 기준 vs 회전된 선)
  function svgAngleVertical(deg, labelA = 'A', labelB = 'B', topLabel = 'N', colorA = '#0EA5E9', colorB = '#8B5CF6') {
    if (!Number.isFinite(deg)) deg = 0;
    const cx = 100, cy = 12, r = 60;
    const aX = cx, aY = cy + r;
    const bRad = deg * Math.PI / 180;
    const bX = cx + Math.sin(bRad) * r;
    const bY = cy + Math.cos(bRad) * r;
    return `
      <svg viewBox="0 0 200 80" style="height:80px;">
        <text x="${cx}" y="10" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.5)">${topLabel}</text>
        <line x1="${cx}" y1="${cy}" x2="${aX}" y2="${aY}" stroke="${colorA}" stroke-width="1.5"/>
        <line x1="${cx}" y1="${cy}" x2="${bX}" y2="${bY}" stroke="${colorB}" stroke-width="1.5"/>
        <text x="${aX-4}" y="${aY+8}" font-size="9" fill="${colorA}">${labelA}</text>
        <text x="${bX+2}" y="${bY+8}" font-size="9" fill="${colorB}">${labelB}</text>
        <path d="M ${cx} ${cy+18} A 18 18 0 0 1 ${cx + Math.sin(bRad)*18} ${cy + Math.cos(bRad)*18}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>
        <text x="${cx+20}" y="${cy+18}" font-size="9" fill="rgba(255,255,255,0.7)">${deg.toFixed(1)}°</text>
      </svg>`;
  }

  // 수평선 + 회전선 (FMA 등)
  function svgFrankfort(deg, refLabel = 'Ref', rotLabel = 'Mand.') {
    if (!Number.isFinite(deg)) deg = 0;
    return `
      <svg viewBox="0 0 200 60" style="height:60px;">
        <line x1="20" y1="20" x2="180" y2="20" stroke="#0EA5E9" stroke-width="1.5"/>
        <text x="22" y="14" font-size="8" fill="#0EA5E9">${refLabel}</text>
        <line x1="20" y1="20" x2="${20 + 160*Math.cos(deg*Math.PI/180)}" y2="${20 + 160*Math.sin(deg*Math.PI/180)}" stroke="#8B5CF6" stroke-width="1.5"/>
        <text x="${20 + 80*Math.cos(deg*Math.PI/180) + 8}" y="${20 + 80*Math.sin(deg*Math.PI/180)}" font-size="8" fill="#8B5CF6">${rotLabel}</text>
        <path d="M 60 20 A 40 40 0 0 1 ${60 + 40*Math.cos(deg*Math.PI/180)} ${20 + 40*Math.sin(deg*Math.PI/180)}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>
        <text x="78" y="36" font-size="9" fill="rgba(255,255,255,0.7)" font-weight="600">${deg.toFixed(1)}°</text>
      </svg>`;
  }

  // 절치-기저면 각도 (IMPA 등)
  function svgIncisorAngle(deg) {
    if (!Number.isFinite(deg)) deg = 0;
    const dev = 90 - deg;
    return `
      <svg viewBox="0 0 200 70" style="height:70px;">
        <line x1="20" y1="50" x2="180" y2="50" stroke="#0EA5E9" stroke-width="1.5"/>
        <text x="22" y="60" font-size="8" fill="#0EA5E9">Mand. plane</text>
        <line x1="100" y1="50" x2="${100 + 30*Math.sin(dev*Math.PI/180)}" y2="${50 - 30*Math.cos(dev*Math.PI/180)}" stroke="#EF4444" stroke-width="2.5" stroke-linecap="round"/>
        <text x="115" y="20" font-size="9" fill="rgba(255,255,255,0.7)" font-weight="600">${deg.toFixed(1)}°</text>
        <path d="M 100 50 A 12 12 0 0 0 ${100 + 12*Math.sin(dev*Math.PI/180)} ${50 - 12*Math.cos(dev*Math.PI/180)}" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>
      </svg>`;
  }

  // 두 막대 비교 (예: 골연령 vs 역연령)
  function svgBarCompare(a, b, labelA, labelB, colorA = '#0EA5E9', colorB = '#8B5CF6', max = 20) {
    const aH = (a / max) * 60;
    const bH = (b / max) * 60;
    return `
      <svg viewBox="0 0 200 80" style="height:80px;">
        <rect x="40" y="${70 - aH}" width="40" height="${aH}" fill="${colorA}" rx="3"/>
        <text x="60" y="${68 - aH}" text-anchor="middle" font-size="9" fill="${colorA}" font-weight="700">${a.toFixed(1)}</text>
        <text x="60" y="78" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.6)">${labelA}</text>
        <rect x="120" y="${70 - bH}" width="40" height="${bH}" fill="${colorB}" rx="3"/>
        <text x="140" y="${68 - bH}" text-anchor="middle" font-size="9" fill="${colorB}" font-weight="700">${b.toFixed(1)}</text>
        <text x="140" y="78" text-anchor="middle" font-size="9" fill="rgba(255,255,255,0.6)">${labelB}</text>
      </svg>`;
  }

  // 6단계 단계 트래커 (CVMS)
  function svgStageBar(current, total, labels) {
    const W = 240;
    const stepW = W / total;
    const items = [];
    for (let i = 1; i <= total; i++) {
      const x = (i - 1) * stepW;
      const isActive = i === current;
      const isPassed = i < current;
      const fill = isActive ? '#0EA5E9' : (isPassed ? '#10B981' : 'rgba(255,255,255,0.06)');
      items.push(`
        <rect x="${x + 2}" y="14" width="${stepW - 4}" height="14" rx="3" fill="${fill}"/>
        <text x="${x + stepW/2}" y="42" text-anchor="middle" font-size="9" fill="${isActive ? '#0EA5E9' : 'rgba(255,255,255,0.4)'}">${labels[i-1] || i}</text>
      `);
    }
    return `<svg viewBox="0 0 ${W} 50" preserveAspectRatio="none">${items.join('')}</svg>`;
  }

  // 신장 막대 (mid-parental + 환자 + 예상)
  function svgHeightBar(current, mid, predicted, lo = 130, hi = 200) {
    const W = 240;
    const range = hi - lo;
    const xC = ((current - lo) / range) * W;
    const xM = ((mid - lo) / range) * W;
    const xP = ((predicted - lo) / range) * W;
    return `
      <svg viewBox="0 0 ${W} 60" preserveAspectRatio="none">
        <rect x="0" y="22" width="${W}" height="8" rx="4" fill="rgba(255,255,255,0.06)"/>
        <line x1="${xC}" y1="14" x2="${xC}" y2="42" stroke="#0EA5E9" stroke-width="2"/>
        <text x="${xC}" y="12" text-anchor="middle" font-size="8" fill="#0EA5E9" font-weight="700">현재 ${current.toFixed(0)}</text>
        <line x1="${xM}" y1="14" x2="${xM}" y2="42" stroke="rgba(255,255,255,0.5)" stroke-width="1.5" stroke-dasharray="2,2"/>
        <text x="${xM}" y="56" text-anchor="middle" font-size="8" fill="rgba(255,255,255,0.6)">목표 ${mid.toFixed(0)}</text>
        <line x1="${xP}" y1="14" x2="${xP}" y2="42" stroke="#10B981" stroke-width="2"/>
        <text x="${xP}" y="56" text-anchor="middle" font-size="8" fill="#10B981" font-weight="700">예상 ${predicted.toFixed(0)}</text>
        <text x="0" y="50" font-size="8" fill="rgba(255,255,255,0.4)">${lo}cm</text>
        <text x="${W}" y="50" text-anchor="end" font-size="8" fill="rgba(255,255,255,0.4)">${hi}cm</text>
      </svg>`;
  }

  // 입술 곡선 (Lip strain)
  function svgLip(level, active = true) {
    const w = level === 'none' ? 1 : level === 'mild' ? 1.8 : 3;
    const color = level === 'severe' ? '#EF4444' : level === 'mild' ? '#F59E0B' : '#10B981';
    return `
      <svg viewBox="0 0 60 30" style="width:48px; height:24px; ${active ? '' : 'opacity:0.35;'}">
        <path d="M 6 15 Q 30 ${15 - 8*w} 54 15" fill="none" stroke="${active ? color : 'rgba(255,255,255,0.4)'}" stroke-width="${active ? 2 : 1.4}" stroke-linecap="round"/>
      </svg>`;
  }

  // Profile silhouette
  function svgProfile(type, active = true) {
    const paths = {
      straight: 'M 30 10 Q 38 25 38 40 L 38 70 Q 38 78 30 80',
      convex:   'M 30 10 Q 50 25 50 40 L 38 70 Q 30 78 22 80',
      concave:  'M 30 10 Q 22 25 22 40 L 38 70 Q 50 78 50 80'
    };
    return `
      <svg viewBox="0 0 60 90" style="width:48px; height:72px; ${active ? 'filter: drop-shadow(0 0 6px var(--color-primary));' : 'opacity:0.4;'}">
        <path d="${paths[type]}" fill="none" stroke="${active ? 'var(--color-primary)' : 'rgba(255,255,255,0.3)'}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>`;
  }

  // 보정장치 아이콘 (재발 예측용)
  function svgRetainer(type, active = true) {
    const icons = {
      hawley:  '<rect x="6" y="20" width="28" height="6" fill="rgba(255,255,255,0.6)"/><line x1="6" y1="14" x2="34" y2="14" stroke="rgba(255,255,255,0.6)" stroke-width="2"/>',
      essix:   '<path d="M 5 15 Q 20 8 35 15 L 35 25 Q 20 32 5 25 Z" fill="rgba(14,165,233,0.3)" stroke="#0EA5E9" stroke-width="1"/>',
      bonded:  '<line x1="6" y1="20" x2="34" y2="20" stroke="#10B981" stroke-width="2.5"/><circle cx="10" cy="20" r="2" fill="#10B981"/><circle cx="20" cy="20" r="2" fill="#10B981"/><circle cx="30" cy="20" r="2" fill="#10B981"/>',
      dual:    '<line x1="6" y1="14" x2="34" y2="14" stroke="#10B981" stroke-width="2"/><path d="M 5 22 Q 20 26 35 22" fill="none" stroke="#0EA5E9" stroke-width="1.5"/>'
    };
    return `
      <svg viewBox="0 0 40 40" style="width:32px; height:32px; ${active ? '' : 'opacity:0.35;'}">
        ${icons[type] || ''}
      </svg>`;
  }

  // 협조도 미터
  function svgComplianceMeter(level) {
    const map = { high: 0.95, medium: 0.55, low: 0.2 };
    const v = map[level] ?? 0;
    const W = 240, cy = 30, cx = W/2;
    const r = 50;
    // Half-circle gauge
    const angle = -Math.PI + Math.PI * v;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const colors = ['#EF4444', '#F59E0B', '#10B981'];
    const color = level === 'high' ? colors[2] : level === 'medium' ? colors[1] : colors[0];
    return `
      <svg viewBox="0 0 ${W} 50" preserveAspectRatio="none">
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>
        <path d="M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
        <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2"/>
        <circle cx="${cx}" cy="${cy}" r="3" fill="${color}"/>
      </svg>`;
  }

  // 타임라인 (재발 보정 기간)
  function svgTimeline(months, max = 36) {
    const W = 240;
    const pct = Math.min(1, months / max);
    return `
      <svg viewBox="0 0 ${W} 50" preserveAspectRatio="none">
        <rect x="0" y="20" width="${W}" height="8" rx="4" fill="rgba(255,255,255,0.06)"/>
        <rect x="0" y="20" width="${pct * W}" height="8" rx="4" fill="url(#timelineGrad)"/>
        <defs>
          <linearGradient id="timelineGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#EF4444"/>
            <stop offset="40%" stop-color="#F59E0B"/>
            <stop offset="80%" stop-color="#10B981"/>
          </linearGradient>
        </defs>
        <circle cx="${pct * W}" cy="24" r="6" fill="#fff" stroke="${months >= 24 ? '#10B981' : months >= 12 ? '#F59E0B' : '#EF4444'}" stroke-width="2"/>
        <text x="0" y="44" font-size="8" fill="rgba(255,255,255,0.4)">0개월</text>
        <text x="${0.33 * W}" y="44" text-anchor="middle" font-size="8" fill="rgba(245,158,11,0.6)">12</text>
        <text x="${0.66 * W}" y="44" text-anchor="middle" font-size="8" fill="rgba(16,185,129,0.6)">24</text>
        <text x="${W}" y="44" text-anchor="end" font-size="8" fill="rgba(255,255,255,0.4)">${max}+</text>
      </svg>`;
  }

  // 안모 슬라이더 변화 막대
  function svgSliderBar(val, min, max, label) {
    const W = 200;
    const pct = (val - min) / (max - min);
    const zero = (-min / (max - min)) * W;
    const fillX = Math.min(zero, pct * W);
    const fillW = Math.abs(pct * W - zero);
    const color = val > 0 ? '#0EA5E9' : val < 0 ? '#F59E0B' : 'rgba(255,255,255,0.4)';
    return `
      <svg viewBox="0 0 ${W} 32" preserveAspectRatio="none" style="height:32px;">
        <rect x="0" y="12" width="${W}" height="8" rx="4" fill="rgba(255,255,255,0.06)"/>
        <rect x="${fillX}" y="12" width="${fillW}" height="8" rx="4" fill="${color}"/>
        <line x1="${zero}" y1="6" x2="${zero}" y2="26" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
        <circle cx="${pct * W}" cy="16" r="5" fill="#fff" stroke="${color}" stroke-width="2"/>
        <text x="0" y="32" font-size="8" fill="rgba(255,255,255,0.4)">${min}</text>
        <text x="${W}" y="32" text-anchor="end" font-size="8" fill="rgba(255,255,255,0.4)">${max}</text>
      </svg>`;
  }

  window.VisualHelpers = {
    classify, gaugeCard, angleCard, choiceCard,
    svgAngleVertical, svgFrankfort, svgIncisorAngle,
    svgBarCompare, svgStageBar, svgHeightBar,
    svgLip, svgProfile, svgRetainer, svgComplianceMeter,
    svgTimeline, svgSliderBar
  };
})();
