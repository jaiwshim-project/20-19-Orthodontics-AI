/* ==============================================================
   Tooth Width Engine
   치아별 근원심 폭경(mesiodistal width) 측정 + TTL/EZL 비교
   ============================================================== */

(function () {
  'use strict';

  function distance(p1, p2) {
    if (!p1 || !p2) return 0;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function round(value, digits) {
    if (digits === undefined) digits = 2;
    var factor = Math.pow(10, digits);
    return Math.round(value * factor) / factor;
  }

  function calculatePxPerMm(refStartPoint, refEndPoint, realLengthMm) {
    if (!refStartPoint || !refEndPoint || !realLengthMm || realLengthMm <= 0) return null;
    return distance(refStartPoint, refEndPoint) / realLengthMm;
  }

  function calculateToothWidth(tooth, pxPerMm) {
    if (!tooth || !tooth.distalPoint || !tooth.mesialPoint || !pxPerMm || pxPerMm <= 0) {
      return { index: tooth ? tooth.index : 0, widthPx: 0, widthMm: 0, valid: false };
    }
    var widthPx = distance(tooth.distalPoint, tooth.mesialPoint);
    var widthMm = widthPx / pxPerMm;
    return {
      index: tooth.index,
      distalPoint: tooth.distalPoint,
      mesialPoint: tooth.mesialPoint,
      widthPx: round(widthPx, 1),
      widthMm: round(widthMm, 2),
      note: tooth.note || '',
      valid: true
    };
  }

  function calculateTTL(teeth, pxPerMm) {
    if (!Array.isArray(teeth) || !pxPerMm || pxPerMm <= 0) {
      return { teeth: [], totalWidthPx: 0, totalWidthMm: 0, measuredCount: 0 };
    }
    var measured = [];
    var totalPx = 0;
    var totalMm = 0;
    for (var i = 0; i < teeth.length; i++) {
      var result = calculateToothWidth(teeth[i], pxPerMm);
      measured.push(result);
      if (result.valid) {
        totalPx += result.widthPx;
        totalMm += result.widthMm;
      }
    }
    return {
      teeth: measured,
      totalWidthPx: round(totalPx, 1),
      totalWidthMm: round(totalMm, 2),
      measuredCount: measured.filter(function (t) { return t.valid; }).length
    };
  }

  function calculateDiscrepancy(ttlMm, ezlMm) {
    if (typeof ttlMm !== 'number' || typeof ezlMm !== 'number') {
      return { ttlMm: 0, ezlMm: 0, discrepancy: 0, classification: 'unknown', label: '데이터 부족', strategy: '' };
    }
    var discrepancy = round(ttlMm - ezlMm, 2);
    var classification, label, strategy;

    if (discrepancy <= 0) {
      classification = 'spacing_or_none';
      label = '공간 과다 또는 부족 없음';
      strategy = '관찰, 공간 폐쇄, 부분교정 검토';
    } else if (discrepancy <= 2) {
      classification = 'mild';
      label = '경미한 공간 부족';
      strategy = '비발치 또는 IPR 검토';
    } else if (discrepancy <= 6) {
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
      discrepancy: discrepancy,
      classification: classification,
      label: label,
      strategy: strategy
    };
  }

  function estimateConfidence(options) {
    var score = 0.5;
    if (options.scaleSource === 'stl' || options.scaleSource === 'plastic_model') score += 0.3;
    else if (options.scaleSource === 'ruler') score += 0.2;
    else if (options.scaleSource === 'known_tooth') score += 0.15;
    if (options.imageQuality === 'high') score += 0.1;
    if (options.measuredCount >= 14) score += 0.1;
    else if (options.measuredCount >= 10) score += 0.05;
    return Math.min(round(score, 2), 1.0);
  }

  var LOWER_TOOTH_NAMES = [
    '좌측 최후방 대구치', '좌측 대구치', '좌측 제2소구치', '좌측 제1소구치',
    '좌측 견치', '좌측 측절치', '좌측 중절치', '우측 중절치',
    '우측 측절치', '우측 견치', '우측 제1소구치', '우측 제2소구치',
    '우측 대구치', '우측 최후방 대구치'
  ];

  var UPPER_TOOTH_NAMES = [
    '좌측 최후방 대구치', '좌측 대구치', '좌측 제2소구치', '좌측 제1소구치',
    '좌측 견치', '좌측 측절치', '좌측 중절치', '우측 중절치',
    '우측 측절치', '우측 견치', '우측 제1소구치', '우측 제2소구치',
    '우측 대구치', '우측 최후방 대구치'
  ];

  window.ToothWidthEngine = {
    distance: distance,
    round: round,
    calculatePxPerMm: calculatePxPerMm,
    calculateToothWidth: calculateToothWidth,
    calculateTTL: calculateTTL,
    calculateDiscrepancy: calculateDiscrepancy,
    estimateConfidence: estimateConfidence,
    LOWER_TOOTH_NAMES: LOWER_TOOTH_NAMES,
    UPPER_TOOTH_NAMES: UPPER_TOOTH_NAMES
  };
})();
