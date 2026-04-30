/* ==============================================================
   EZL-STL Engine — 교정 측정 알고리즘
   - 치열궁 길이 (Cubic Bezier 누적)
   - 치아 폭 합 (Mesiodistal width)
   - 부조화 (Discrepancy)
   - Bolton 비율 (anterior 77.2%±2, overall 91.3%±2)
   - Spee 만곡 (점-기준선 거리)
   - Crowding 분류 (Mild/Moderate/Severe)
   - 통합 measure(stlMesh) 진입점
   ============================================================== */

class EZLEngine {
  constructor() {
    this.version = '0.1.0';
  }

  // -------- Geometry helpers --------
  distance(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = (b.z || 0) - (a.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // De Casteljau cubic Bezier point
  bezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
      x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
      y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y,
      z: u*u*u*(p0.z||0) + 3*u*u*t*(p1.z||0) + 3*u*t*t*(p2.z||0) + t*t*t*(p3.z||0)
    };
  }

  /**
   * 치열궁 길이. 입력이 4점이면 Cubic Bezier로 근사, 그 외는 점간 누적.
   * @param {{x,y,z?}[]} points
   * @returns {number} 길이 mm
   */
  computeArchLength(points) {
    if (!Array.isArray(points) || points.length < 2) return 0;
    if (points.length === 4) {
      const segments = 64;
      let len = 0;
      let prev = this.bezierPoint(points[0], points[1], points[2], points[3], 0);
      for (let i = 1; i <= segments; i++) {
        const cur = this.bezierPoint(points[0], points[1], points[2], points[3], i / segments);
        len += this.distance(prev, cur);
        prev = cur;
      }
      return len;
    }
    let total = 0;
    for (let i = 1; i < points.length; i++) total += this.distance(points[i-1], points[i]);
    return total;
  }

  /**
   * 치아 너비 합 (Mesiodistal). 입력 배열의 width 합.
   * @param {{fdi:number, width:number}[]} teeth
   */
  computeTotalToothWidth(teeth) {
    if (!Array.isArray(teeth)) return 0;
    return teeth.reduce((s, t) => s + (Number(t.width) || 0), 0);
  }

  /**
   * 부조화 = 치열궁 길이 - 치아 폭 합. 음수일수록 crowding 심함.
   */
  discrepancy(archLength, toothSum) {
    return Number((archLength - toothSum).toFixed(2));
  }

  /**
   * Bolton 비율
   *   anterior = 하악 6전치 합 / 상악 6전치 합 × 100  (정상 77.2 ± 1.65)
   *   overall  = 하악 12치 합 / 상악 12치 합 × 100   (정상 91.3 ± 1.91)
   * @param {{anterior:number, overall:number}} upper sums
   * @param {{anterior:number, overall:number}} lower sums
   */
  boltonRatio(upper, lower) {
    const safe = (n) => (Number(n) || 0);
    const ant = safe(upper.anterior) > 0 ? (safe(lower.anterior) / safe(upper.anterior)) * 100 : 0;
    const ovr = safe(upper.overall)  > 0 ? (safe(lower.overall)  / safe(upper.overall))  * 100 : 0;
    return {
      anterior: Number(ant.toFixed(2)),
      overall: Number(ovr.toFixed(2)),
      anteriorNormal: { mean: 77.2, sd: 1.65, range: [73.9, 80.5] },
      overallNormal:  { mean: 91.3, sd: 1.91, range: [87.5, 95.1] },
      anteriorOffset: Number((ant - 77.2).toFixed(2)),
      overallOffset:  Number((ovr - 91.3).toFixed(2))
    };
  }

  /**
   * Spee 만곡: 가장 깊은 점부터 occlusal plane(전치 절단연-제2대구치 협측교두 직선)까지 거리.
   * @param {{x,y,z?}[]} points 후방 → 전방 순서
   */
  curveOfSpee(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    const a = points[0];
    const b = points[points.length - 1];
    // Distance from each interior point to line a-b (in y axis, vertical)
    let max = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) /
                ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1);
      const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      const d = this.distance(p, proj);
      if (d > max) max = d;
    }
    return Number(max.toFixed(2));
  }

  /**
   * Crowding 분류 — Proffit 기준
   * 부조화 absolute: <4mm Mild, 4-8 Moderate, >8 Severe
   */
  crowdingScore(discrepancy) {
    const abs = Math.abs(discrepancy);
    if (discrepancy >= 0) return 'Spacing (여유)';
    if (abs < 4) return 'Mild Crowding (경미)';
    if (abs <= 8) return 'Moderate Crowding (중등도)';
    return 'Severe Crowding (심함)';
  }

  // -------- Demo data generator (Three.js mesh가 들어오면 bbox 기반 mock 측정) --------
  _mockMeasureFromMesh(meshOrGroup) {
    let bbox = null;
    let triangleCount = 0;
    if (meshOrGroup) {
      try {
        if (meshOrGroup.traverse) {
          meshOrGroup.traverse(o => {
            if (o.geometry) {
              o.geometry.computeBoundingBox?.();
              if (o.geometry.boundingBox) {
                if (!bbox) bbox = o.geometry.boundingBox.clone();
                else bbox.union(o.geometry.boundingBox);
              }
              if (o.geometry.attributes?.position) {
                triangleCount += o.geometry.attributes.position.count / 3;
              }
            }
          });
        }
      } catch (e) {
        console.warn('[ezl] bbox 추출 실패:', e.message);
      }
    }
    const sizeX = bbox ? Math.abs(bbox.max.x - bbox.min.x) : 50;
    const sizeZ = bbox ? Math.abs(bbox.max.z - bbox.min.z) : 35;
    // Approximate arch length from bounding box ellipse perimeter (Ramanujan)
    const a = sizeX / 2, b = sizeZ / 2;
    const h = ((a - b) ** 2) / ((a + b) ** 2 + 1e-6);
    const ellipsePerim = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    // 결정론적 변동: bbox 크기 기반 의사 난수(같은 메쉬 = 같은 결과)
    const seed = Math.abs(Math.sin(sizeX * 12.9898 + sizeZ * 78.233) * 43758.5453);
    const jitter = (k) => ((seed * (k + 1)) % 1 - 0.5);
    return {
      archUpper: Math.max(70, ellipsePerim * 0.5 + 78),
      archLower: Math.max(65, ellipsePerim * 0.48 + 72),
      toothSumUpper: 91 + jitter(1) * 4,
      toothSumLower: 84 + jitter(2) * 3.5,
      antUpper: 45.8 + jitter(3) * 1.5,
      antLower: 35.4 + jitter(4) * 1.5,
      ovrUpper: 91 + jitter(5) * 4,
      ovrLower: 83 + jitter(6) * 4,
      speePoints: this._generateSpeePoints(sizeX),
      triangleCount,
      sizeX, sizeZ
    };
  }

  _generateSpeePoints(sizeX) {
    const N = 7;
    const pts = [];
    const span = sizeX || 50;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const x = -span / 2 + t * span;
      // sinusoidal curve depth ~ 1.5mm peak around mid
      const y = -1.5 * Math.sin(t * Math.PI);
      pts.push({ x, y, z: 0 });
    }
    return pts;
  }

  /**
   * 통합 진입점. Three.js mesh/group 또는 raw data 객체를 받음.
   * Raw data: { upperArchPoints, lowerArchPoints, upperTeeth, lowerTeeth, upper:{anterior,overall}, lower:{anterior,overall}, speePoints }
   */
  measure(input) {
    let raw;
    let confidence = 0.65; // demo 메쉬 기본 신뢰도
    if (input && (input.isObject3D || input.traverse)) {
      // Three.js 메쉬 (실제 STL 분석은 별도 구현 필요 — 여기선 bbox 기반 추정)
      const mock = this._mockMeasureFromMesh(input);
      raw = mock;
      confidence = mock.triangleCount > 1000 ? 0.78 : 0.62;
    } else if (input && typeof input === 'object') {
      raw = input;
      confidence = 0.92;
    } else {
      raw = this._mockMeasureFromMesh(null);
      confidence = 0.55;
    }

    const archUpper = raw.archUpper ?? this.computeArchLength(raw.upperArchPoints || []);
    const archLower = raw.archLower ?? this.computeArchLength(raw.lowerArchPoints || []);
    const tUpper    = raw.toothSumUpper ?? this.computeTotalToothWidth(raw.upperTeeth || []);
    const tLower    = raw.toothSumLower ?? this.computeTotalToothWidth(raw.lowerTeeth || []);
    const dUpper    = this.discrepancy(archUpper, tUpper);
    const dLower    = this.discrepancy(archLower, tLower);
    const bolton    = this.boltonRatio(
      { anterior: raw.antUpper ?? raw.upper?.anterior ?? 45.8, overall: raw.ovrUpper ?? raw.upper?.overall ?? 91 },
      { anterior: raw.antLower ?? raw.lower?.anterior ?? 35.4, overall: raw.ovrLower ?? raw.lower?.overall ?? 83 }
    );
    const spee     = this.curveOfSpee(raw.speePoints || []);
    const crowding = this.crowdingScore(Math.min(dUpper, dLower));

    return {
      arch: { upper: archUpper, lower: archLower },
      tooth: { upper: tUpper, lower: tLower },
      discrepancy: { upper: dUpper, lower: dLower },
      bolton,
      spee,
      crowding,
      confidence,
      version: this.version,
      timestamp: new Date().toISOString()
    };
  }
}

// 전역 노출
window.ezlEngine = new EZLEngine();
window.EZLEngine = EZLEngine;
