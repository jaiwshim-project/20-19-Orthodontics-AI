/* ==============================================================
   Equilibrium Zone Engine v2
   EZ 곡선 생성 + EZL 계산 + TTL/EZL 비교 판정

   EZ = 치조골 중심선 (Buccinator Mechanism 평형 영역)
   EZ 양쪽 끝점 = 좌우 어금니 최상단 끝점
   EZL = EZ curve arc length (mm)
   ============================================================== */

(function () {
  'use strict';

  function round(value, digits) {
    if (digits === undefined) digits = 2;
    if (!Number.isFinite(Number(value))) return value;
    var factor = Math.pow(10, digits);
    return Math.round(Number(value) * factor) / factor;
  }

  function distance(p1, p2) {
    if (!p1 || !p2) return 0;
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // =========================================================
  // 스케일 계산
  // =========================================================
  function calculatePxPerMm(refStart, refEnd, realLengthMm) {
    if (!refStart || !refEnd || !realLengthMm || realLengthMm <= 0) return null;
    return distance(refStart, refEnd) / realLengthMm;
  }

  function pxToMm(px, pxPerMm) {
    if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null;
    return px / pxPerMm;
  }

  // =========================================================
  // Catmull-Rom Spline 곡선 생성
  // =========================================================
  function catmullRomPoint(p0, p1, p2, p3, t) {
    var t2 = t * t;
    var t3 = t2 * t;
    return {
      x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
      y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
    };
  }

  function sortAnchorPoints(points) {
    return points.slice().sort(function (a, b) { return a.x - b.x; });
  }

  function sampleCurve(points, samplesPerSegment) {
    if (samplesPerSegment === undefined) samplesPerSegment = 24;
    if (!Array.isArray(points) || points.length < 2) return [];
    if (points.length === 2) return points.map(function (p) { return { x: Number(p.x), y: Number(p.y) }; });

    var pts = points.map(function (p) { return { x: Number(p.x), y: Number(p.y) }; });
    var out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (var j = 0; j < samplesPerSegment; j++) {
        out.push(catmullRomPoint(p0, p1, p2, p3, j / samplesPerSegment));
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // =========================================================
  // 곡선 길이 계산
  // =========================================================
  function curveLength(points) {
    if (!Array.isArray(points) || points.length < 2) return 0;
    var total = 0;
    for (var i = 1; i < points.length; i++) {
      total += distance(points[i - 1], points[i]);
    }
    return total;
  }

  // =========================================================
  // EZ 곡선 생성 + EZL 계산
  // =========================================================
  function buildEZCurve(options) {
    var anchorPoints = options.anchorPoints;
    var rulerStart = options.rulerStart || null;
    var rulerEnd = options.rulerEnd || null;
    var rulerLengthMm = options.rulerLengthMm || 10;
    var pxPerMm = options.pxPerMm || null;
    var segments = options.segments || 25;

    if (!Array.isArray(anchorPoints) || anchorPoints.length < 3) {
      return { anchorPoints: [], curvePoints: [], lengthPx: 0, lengthMm: null, scale: { pxPerMm: null }, qualityCheck: { isValid: false, warnings: ['EZ anchor point가 3개 미만입니다.'] } };
    }

    var scale = pxPerMm;
    if (!scale && rulerStart && rulerEnd) {
      scale = calculatePxPerMm(rulerStart, rulerEnd, rulerLengthMm);
    }

    var sorted = sortAnchorPoints(anchorPoints);
    var curvePoints = sampleCurve(sorted, segments);
    var lengthPx = curveLength(curvePoints);
    var lengthMm = scale ? lengthPx / scale : null;
    var qualityCheck = validateEZCurve(sorted, curvePoints);

    return {
      anchorPoints: sorted,
      curvePoints: curvePoints,
      lengthPx: round(lengthPx, 1),
      lengthMm: lengthMm !== null ? round(lengthMm, 2) : null,
      scale: { pxPerMm: scale ? round(scale, 4) : null },
      qualityCheck: qualityCheck
    };
  }

  // =========================================================
  // 품질 검증
  // =========================================================
  function validateEZCurve(anchorPoints, curvePoints) {
    var warnings = [];

    if (!anchorPoints || anchorPoints.length < 5) {
      warnings.push('EZ anchor point가 부족합니다. 7~9개를 권장합니다.');
    }
    if (!curvePoints || curvePoints.length < 10) {
      warnings.push('생성된 곡선 point가 너무 적습니다.');
    }
    if (anchorPoints && anchorPoints.length >= 3) {
      var left = anchorPoints[0];
      var right = anchorPoints[anchorPoints.length - 1];
      var center = anchorPoints[Math.floor(anchorPoints.length / 2)];
      var avgEndY = (left.y + right.y) / 2;
      if (center.y < avgEndY - 50) {
        warnings.push('전치부 중심이 지나치게 위에 있습니다. EZ가 너무 평평할 수 있습니다.');
      }
    }
    return { isValid: warnings.length === 0, warnings: warnings };
  }

  function validateEZvsTTL(ezlMm, ttlMm, options) {
    var warnings = [];
    if (options && options.visibleCrowding && ezlMm > ttlMm) {
      warnings.push('Crowding이 관찰되는데 EZL > TTL입니다. EZ 과대 설정 가능성을 확인하세요.');
    }
    if (ezlMm && ezlMm < 70) warnings.push('EZL이 지나치게 짧습니다 (' + ezlMm + 'mm). anchor point를 재확인하세요.');
    if (ezlMm && ezlMm > 130) warnings.push('EZL이 지나치게 길 수 있습니다 (' + ezlMm + 'mm). 양 끝점을 재확인하세요.');
    return warnings;
  }

  // =========================================================
  // TTL vs EZL 판정 (Space Discrepancy)
  // =========================================================
  function classifyDiscrepancy(ttlMm, ezlMm, modifiers) {
    if (!Number.isFinite(ttlMm) || !Number.isFinite(ezlMm)) {
      return { classification: 'insufficient_data', label: '데이터 부족', discrepancy: null, severity: 0, reasons: [] };
    }

    var d = round(ttlMm - ezlMm, 2);
    var adjusted = d;
    var reasons = [];

    if (modifiers) {
      if (modifiers.profile === 'protrusive') { adjusted += 1; reasons.push('돌출 안모로 공간 확보 필요성 상향 보정'); }
      if (modifiers.profile === 'retrusive') { adjusted -= 1; reasons.push('후퇴 안모로 하향 보정'); }
      if (modifiers.incisorInclination === 'proclined') { adjusted += 0.8; reasons.push('전치부 순측 경사로 상향 보정'); }
      if (modifiers.incisorInclination === 'retroclined') { adjusted -= 0.8; reasons.push('전치부 설측 경사로 하향 보정'); }
      if (modifiers.periodontalRisk) { adjusted += 0.8; reasons.push('치주 한계로 보수적 평가'); }
      if (modifiers.growthPotential) { adjusted -= 0.5; reasons.push('성장 가능성 반영'); }
    }

    var classification, label, strategy;
    if (adjusted <= 0) {
      classification = 'spacing_or_none';
      label = '공간 과다 또는 부족 없음';
      strategy = '관찰, 공간 폐쇄, 부분교정 검토';
    } else if (adjusted <= 2) {
      classification = 'mild';
      label = '경미한 공간 부족';
      strategy = '비발치 또는 IPR 검토';
    } else if (adjusted <= 6) {
      classification = 'borderline';
      label = '경계/중등도 공간 부족';
      strategy = '안모, 성장, 세팔로, 치주 상태와 함께 발치 여부 판단';
    } else {
      classification = 'severe';
      label = '심한 공간 부족';
      strategy = '발치 또는 적극적 공간 확보 전략 검토';
    }

    return {
      ttlMm: round(ttlMm, 2),
      ezlMm: round(ezlMm, 2),
      rawDiscrepancy: d,
      adjustedDiscrepancy: round(adjusted, 2),
      classification: classification,
      label: label,
      strategy: strategy,
      severity: Math.max(0, Math.min(100, Math.round((adjusted / 10) * 100))),
      reasons: reasons
    };
  }

  // =========================================================
  // 하위 호환 (기존 analyzeArch / analyzeCase 유지)
  // =========================================================
  function analyzeArch(options) {
    var ezPoints = options.ezPoints || [];
    var tzPoints = options.tzPoints || [];
    var pxPerMm = options.pxPerMm || null;
    var ezCurve = sampleCurve(ezPoints);
    var tzCurve = sampleCurve(tzPoints);
    var ezLengthPx = curveLength(ezCurve);
    var tzLengthPx = curveLength(tzCurve);
    var ezLengthMm = pxToMm(ezLengthPx, pxPerMm);
    var tzLengthMm = pxToMm(tzLengthPx, pxPerMm);
    var discrepancyMm = (ezLengthMm != null && tzLengthMm != null) ? tzLengthMm - ezLengthMm : null;

    return {
      ezCurve: ezCurve, tzCurve: tzCurve,
      ezLengthPx: round(ezLengthPx), tzLengthPx: round(tzLengthPx),
      ezLengthMm: ezLengthMm != null ? round(ezLengthMm) : null,
      tzLengthMm: tzLengthMm != null ? round(tzLengthMm) : null,
      discrepancyMm: discrepancyMm != null ? round(discrepancyMm) : null
    };
  }

  function analyzeCase(options) {
    var upper = options.upper || {};
    var lower = options.lower || {};
    var scale = options.scale || {};
    var modifiers = options.modifiers || {};
    var pxPerMm = Number(scale.pxPerMm);
    var upperResult = analyzeArch({ ezPoints: upper.ezPoints, tzPoints: upper.tzPoints, pxPerMm: pxPerMm });
    var lowerResult = analyzeArch({ ezPoints: lower.ezPoints, tzPoints: lower.tzPoints, pxPerMm: pxPerMm });
    var values = [upperResult.discrepancyMm, lowerResult.discrepancyMm].filter(function (v) { return Number.isFinite(v); });
    var total = values.length ? values.reduce(function (a, b) { return a + b; }, 0) : null;
    var maxArch = values.length ? Math.max.apply(null, values) : null;
    var decisionBasis = maxArch == null ? total : Math.max(maxArch, total / Math.max(values.length, 1));

    return {
      upper: upperResult,
      lower: lowerResult,
      totalDiscrepancyMm: total != null ? round(total) : null,
      decision: classifyDiscrepancy(decisionBasis || 0, 0, modifiers),
      scale: { pxPerMm: Number.isFinite(pxPerMm) ? pxPerMm : null, source: scale.source || 'manual', confidence: Number(scale.confidence || 0.7) },
      generatedAt: new Date().toISOString()
    };
  }

  // =========================================================
  // Export
  // =========================================================
  window.EquilibriumZoneEngine = {
    // 핵심 v2 API
    buildEZCurve: buildEZCurve,
    validateEZCurve: validateEZCurve,
    validateEZvsTTL: validateEZvsTTL,
    classifyDiscrepancy: classifyDiscrepancy,
    calculatePxPerMm: calculatePxPerMm,
    sortAnchorPoints: sortAnchorPoints,

    // 곡선 유틸
    sampleCurve: sampleCurve,
    curveLength: curveLength,
    distance: distance,
    pxToMm: pxToMm,
    round: round,

    // 하위 호환
    analyzeArch: analyzeArch,
    analyzeCase: analyzeCase
  };
})();
