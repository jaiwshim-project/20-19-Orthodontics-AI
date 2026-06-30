/* ==============================================================
   Curve Editor v2
   Canvas-based EZ/TZ landmark and curve editor with drag support
   ============================================================== */

(function () {
  'use strict';

  class CurveEditor {
    constructor(options) {
      this.canvas = options.canvas;
      this.ctx = this.canvas.getContext('2d');
      this.image = null;
      this.imageSrc = null;
      this.mode = 'tz';
      this.tool = 'draw';
      this.points = { ez: [], tz: [] };
      this.scale = 1;
      this.offset = { x: 0, y: 0 };
      this.onChange = options.onChange || function () {};
      this.pxPerMm = options.pxPerMm || null;
      this.disabled = false;
      this.showGuide = true;
      this.showLengths = true;
      this.showDiffArea = true;

      this.colors = {
        ez: '#2563eb',
        tz: '#ef4444',
        diff: 'rgba(250, 204, 21, 0.25)',
        guide: 'rgba(255,255,255,0.7)'
      };

      this._dragging = null;
      this._hovered = null;
      this._bind();
      this._fitCanvas();
      this.render();
    }

    _bind() {
      this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
      this.canvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
      this.canvas.addEventListener('mouseup', () => this._onMouseUp());
      this.canvas.addEventListener('mouseleave', () => this._onMouseUp());
      this.canvas.addEventListener('dblclick', (e) => this._onDblClick(e));

      this.canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this._onMouseDown(e.touches[0]);
      }, { passive: false });
      this.canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        this._onMouseMove(e.touches[0]);
      }, { passive: false });
      this.canvas.addEventListener('touchend', () => this._onMouseUp());

      window.addEventListener('resize', () => {
        this._fitCanvas();
        this.render();
      });
    }

    _eventToImagePoint(event) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left - this.offset.x) / this.scale;
      const y = (event.clientY - rect.top - this.offset.y) / this.scale;
      return {
        x: Math.max(0, Math.min(this.image ? this.image.width : 9999, x)),
        y: Math.max(0, Math.min(this.image ? this.image.height : 9999, y))
      };
    }

    _findNearPoint(imgPt, threshold) {
      const t = (threshold || 12) / this.scale;
      for (const mode of [this.mode, this.mode === 'tz' ? 'ez' : 'tz']) {
        for (let i = 0; i < this.points[mode].length; i++) {
          const p = this.points[mode][i];
          const dx = p.x - imgPt.x;
          const dy = p.y - imgPt.y;
          if (Math.sqrt(dx * dx + dy * dy) < t) {
            return { mode, index: i };
          }
        }
      }
      return null;
    }

    _onMouseDown(event) {
      if (!this.image || this.disabled) return;
      const p = this._eventToImagePoint(event);
      const near = this._findNearPoint(p, 14);
      if (near) {
        this._dragging = near;
        this.canvas.style.cursor = 'grabbing';
      } else if (this.tool !== 'move') {
        this.points[this.mode].push(p);
        this._dragging = { mode: this.mode, index: this.points[this.mode].length - 1 };
        this._emit();
      }
    }

    _onMouseMove(event) {
      if (!this.image || this.disabled) return;
      const p = this._eventToImagePoint(event);
      if (this._dragging) {
        const { mode, index } = this._dragging;
        this.points[mode][index] = p;
        this.render();
      } else {
        const near = this._findNearPoint(p, 14);
        this.canvas.style.cursor = near ? 'grab' : (this.tool === 'move' ? 'default' : 'crosshair');
        if (near !== this._hovered) {
          this._hovered = near;
          this.render();
        }
      }
    }

    _onMouseUp() {
      if (this._dragging) {
        this._dragging = null;
        this.canvas.style.cursor = this.tool === 'move' ? 'default' : 'crosshair';
        this._emit();
      }
    }

    _onDblClick(event) {
      if (!this.image || this.disabled) return;
      const p = this._eventToImagePoint(event);
      const near = this._findNearPoint(p, 14);
      if (near) {
        this.points[near.mode].splice(near.index, 1);
        this._emit();
      }
    }

    setMode(mode) {
      if (mode !== 'ez' && mode !== 'tz') return;
      this.mode = mode;
      this.tool = 'draw';
      this.canvas.style.cursor = 'crosshair';
      this.render();
    }

    setTool(tool) {
      this.tool = tool === 'move' ? 'move' : 'draw';
      this.canvas.style.cursor = this.tool === 'move' ? 'default' : 'crosshair';
      this.render();
    }

    setPxPerMm(value) {
      this.pxPerMm = Number(value) > 0 ? Number(value) : null;
      this.render();
    }

    setImage(fileOrUrl) {
      return new Promise((resolve, reject) => {
        const src = fileOrUrl instanceof File ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
        const img = new Image();
        img.onload = () => {
          this.image = img;
          this.imageSrc = src;
          this.points = { ez: [], tz: [] };
          this._fitCanvas();
          this._emit();
          resolve(img);
        };
        img.onerror = reject;
        img.src = src;
      });
    }

    clear(mode = this.mode) {
      if (mode === 'all') this.points = { ez: [], tz: [] };
      else this.points[mode] = [];
      this._emit();
    }

    undo(mode = this.mode) {
      this.points[mode].pop();
      this._emit();
    }

    autoTrace(mode = 'both', options = {}) {
      if (!this.image) return null;
      const arch = options.arch === 'upper' ? 'upper' : 'lower';
      const w = this.image.width;
      const h = this.image.height;
      const learnedTz = options.useLearned !== false ? this._getLearnedTzPoints(arch, w, h) : null;
      const learnedEz = options.useLearned !== false ? this._getLearnedEzPoints(arch, w, h) : null;
      const curve = this._estimateArchCurves(w, h, arch);
      if (learnedTz && learnedTz.length >= 2) {
        curve.tz = learnedTz;
        curve.ez = this._estimateEzFromTz(learnedTz, arch);
      }
      if (learnedEz && learnedEz.length >= 2) {
        curve.ez = learnedEz;
      }

      if (mode === 'tz' || mode === 'both') this.points.tz = curve.tz;
      if (mode === 'ez') {
        this.points.ez = learnedEz && learnedEz.length >= 2 ? learnedEz : this._estimateEzFromTz(this.points.tz.length >= 2 ? this.points.tz : curve.tz, arch);
      } else if (mode === 'both') {
        this.points.ez = curve.ez;
      }
      this._emit();
      return this.getData();
    }

    _getLearnedEzPoints(arch, width, height) {
      try {
        if (typeof localStorage === 'undefined') return null;
        const record = JSON.parse(localStorage.getItem('oa_eq_latest_ez_learning') || 'null');
        if (!record || record.arch !== arch || !Array.isArray(record.ezPoints) || record.ezPoints.length < 2) return null;

        const currentBounds = this._estimateAlveolarBounds(width, height, arch);
        const sourceBounds = record.alveolarBounds;
        const hasBounds = sourceBounds && currentBounds && sourceBounds.width > 0 && sourceBounds.height > 0;
        const sourceWidth = Number(record.image && record.image.width) || width;
        const sourceHeight = Number(record.image && record.image.height) || height;
        const scaleX = sourceWidth > 0 ? width / sourceWidth : 1;
        const scaleY = sourceHeight > 0 ? height / sourceHeight : 1;

        return record.ezPoints
          .slice()
          .sort((a, b) => Number(a.index) - Number(b.index))
          .map(point => {
            const px = Number(point.x);
            const py = Number(point.y);
            if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
            if (hasBounds) {
              const rx = (px - sourceBounds.x) / sourceBounds.width;
              const ry = (py - sourceBounds.y) / sourceBounds.height;
              return {
                x: Math.round(currentBounds.x + rx * currentBounds.width),
                y: Math.round(currentBounds.y + ry * currentBounds.height)
              };
            }
            return { x: Math.round(px * scaleX), y: Math.round(py * scaleY) };
          })
          .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y));
      } catch (e) {
        return null;
      }
    }
    _getLearnedTzPoints(arch, width, height) {
      try {
        if (typeof localStorage === 'undefined') return null;
        const record = JSON.parse(localStorage.getItem('oa_eq_latest_tz_learning') || 'null');
        if (!record || record.arch !== arch || !Array.isArray(record.tzPoints) || record.tzPoints.length < 2) return null;

        const currentBounds = this._analyzeToothArea(width, height).bounds;
        const sourceBounds = record.toothBounds;
        const hasBounds = sourceBounds && currentBounds && sourceBounds.width > 0 && sourceBounds.height > 0;
        const sourceWidth = Number(record.image && record.image.width) || width;
        const sourceHeight = Number(record.image && record.image.height) || height;
        const scaleX = sourceWidth > 0 ? width / sourceWidth : 1;
        const scaleY = sourceHeight > 0 ? height / sourceHeight : 1;

        return record.tzPoints
          .slice()
          .sort((a, b) => Number(a.index) - Number(b.index))
          .map(point => {
            const px = Number(point.x);
            const py = Number(point.y);
            if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
            if (hasBounds) {
              const rx = (px - sourceBounds.x) / sourceBounds.width;
              const ry = (py - sourceBounds.y) / sourceBounds.height;
              return {
                x: Math.round(currentBounds.x + rx * currentBounds.width),
                y: Math.round(currentBounds.y + ry * currentBounds.height)
              };
            }
            return { x: Math.round(px * scaleX), y: Math.round(py * scaleY) };
          })
          .filter(point => point && Number.isFinite(point.x) && Number.isFinite(point.y));
      } catch (e) {
        return null;
      }
    }

    applyToothLandmarks(points, options = {}) {
      if (!Array.isArray(points) || points.length < 2) return null;
      const arch = options.arch === 'upper' ? 'upper' : 'lower';
      const ordered = points
        .map(p => ({ x: Number(p.x), y: Number(p.y) }))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (ordered.length < 2) return null;

      this.points.tz = ordered;
      this.points.ez = this._estimateEzFromTz(ordered, arch);
      this._emit();
      return this.getData();
    }

    _estimateArchCurves(width, height, arch) {
      const isLower = arch === 'lower';
      const analysis = this._analyzeToothArea(width, height);
      const bounds = analysis.bounds;
      const posteriorY = isLower ? 0.18 : 0.82;
      const anteriorY = isLower ? 0.86 : 0.14;
      const dir = isLower ? 1 : -1;

      // TZ starts and ends at the centers of the closest left/right molars.
      // Posterior points use tooth centers; anterior points follow incisal/cusp tips.
      const layout = [
        { x: 0.04, y: posteriorY, role: 'center' },
        { x: 0.12, y: posteriorY + dir * 0.08, role: 'center' },
        { x: 0.21, y: posteriorY + dir * 0.18, role: 'center' },
        { x: 0.30, y: posteriorY + dir * 0.30, role: 'center' },
        { x: 0.38, y: posteriorY + dir * 0.44, role: 'edge' },
        { x: 0.45, y: posteriorY + dir * 0.58, role: 'edge' },
        { x: 0.49, y: anteriorY, role: 'edge' },
        { x: 0.51, y: anteriorY, role: 'edge' },
        { x: 0.55, y: posteriorY + dir * 0.58, role: 'edge' },
        { x: 0.62, y: posteriorY + dir * 0.44, role: 'edge', tipNudge: { x: -0.045, y: 0.085 } },
        { x: 0.70, y: posteriorY + dir * 0.30, role: 'edge', tipNudge: { x: -0.070, y: 0.090 } },
        { x: 0.79, y: posteriorY + dir * 0.18, role: 'edge', tipNudge: { x: -0.085, y: 0.075 } },
        { x: 0.88, y: posteriorY + dir * 0.08, role: 'center' },
        { x: 0.96, y: posteriorY, role: 'center' }
      ];

      let tzPoints = layout.map(item => {
        const fallback = {
          x: bounds.x + bounds.width * item.x,
          y: bounds.y + bounds.height * item.y
        };
        const point = this._sampleToothPoint(analysis, fallback, item.role, arch);
        if (item.tipNudge) {
          const nudgeY = arch === 'lower' ? item.tipNudge.y : -item.tipNudge.y;
          return {
            x: Math.round(point.x + bounds.width * item.tipNudge.x),
            y: Math.round(point.y + bounds.height * nudgeY)
          };
        }
        return point;
      });
      tzPoints = tzPoints.map(point => this._snapPointToToothPixel(analysis, point));
      const ezPoints = this._estimateEzFromTz(tzPoints, arch);

      return { ez: ezPoints, tz: tzPoints };
    }

    _analyzeToothArea(width, height) {
      const fallbackBounds = {
        x: width * 0.12,
        y: height * 0.12,
        width: width * 0.76,
        height: height * 0.76
      };
      if (!this.image || typeof document === 'undefined') {
        return { bounds: fallbackBounds, scale: 1, sample: null };
      }

      const maxDim = 420;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const sw = Math.max(1, Math.round(width * scale));
      const sh = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(this.image, 0, 0, sw, sh);
      const imageData = ctx.getImageData(0, 0, sw, sh);
      const data = imageData.data;

      const lumas = [];
      for (let y = Math.floor(sh * 0.04); y < Math.ceil(sh * 0.96); y += 3) {
        for (let x = Math.floor(sw * 0.04); x < Math.ceil(sw * 0.96); x += 3) {
          const i = (y * sw + x) * 4;
          lumas.push((data[i] + data[i + 1] + data[i + 2]) / 3);
        }
      }
      lumas.sort((a, b) => a - b);
      const p78 = lumas[Math.floor(lumas.length * 0.78)] || 150;
      const threshold = Math.max(138, Math.min(205, p78 + 12));

      let minX = sw, minY = sh, maxX = 0, maxY = 0, count = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (!this._isToothPixel(data, sw, x, y, threshold)) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          count += 1;
        }
      }

      if (count < 80 || maxX <= minX || maxY <= minY) {
        return { bounds: fallbackBounds, scale, sample: { data, width: sw, height: sh, threshold } };
      }

      const padX = Math.max(8, (maxX - minX) * 0.08);
      const padY = Math.max(8, (maxY - minY) * 0.10);
      const bx = Math.max(0, minX - padX) / scale;
      const by = Math.max(0, minY - padY) / scale;
      const bw = Math.min(sw, maxX + padX) / scale - bx;
      const bh = Math.min(sh, maxY + padY) / scale - by;

      return {
        bounds: { x: bx, y: by, width: bw, height: bh },
        scale,
        sample: { data, width: sw, height: sh, threshold }
      };
    }

    _isToothPixel(data, width, x, y, threshold) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const luma = (r + g + b) / 3;
      const saturation = max - min;
      return luma >= threshold && saturation <= 105 && r >= 115 && g >= 105 && b >= 90;
    }

    _sampleToothPoint(analysis, fallback, role, arch) {
      if (!analysis.sample) return { x: Math.round(fallback.x), y: Math.round(fallback.y) };
      const { data, width, height, threshold } = analysis.sample;
      const scale = analysis.scale;
      const sx = Math.round(fallback.x * scale);
      const sy = Math.round(fallback.y * scale);
      const searchX = Math.max(8, Math.round(analysis.bounds.width * scale * (role === 'center' ? 0.075 : 0.04)));
      const searchY = Math.max(12, Math.round(analysis.bounds.height * scale * (role === 'center' ? 0.18 : 0.22)));
      const minX = Math.max(0, sx - searchX);
      const maxX = Math.min(width - 1, sx + searchX);
      const minY = Math.max(0, sy - searchY);
      const maxY = Math.min(height - 1, sy + searchY);
      const component = this._nearestToothComponent(data, width, height, threshold, sx, sy, minX, maxX, minY, maxY);
      const pixels = component.length ? component : [];

      if (pixels.length < 8) return { x: Math.round(fallback.x), y: Math.round(fallback.y) };

      if (role === 'edge') {
        const targetX = (analysis.bounds.x + analysis.bounds.width * 0.5) * scale;
        const targetY = (analysis.bounds.y + analysis.bounds.height * (arch === 'lower' ? 0.92 : 0.08)) * scale;
        const vx = targetX - sx;
        const vy = targetY - sy;
        const len = Math.hypot(vx, vy) || 1;
        const ux = vx / len;
        const uy = vy / len;
        const edgePixels = pixels
          .slice()
          .sort((a, b) => ((b.x - sx) * ux + (b.y - sy) * uy) - ((a.x - sx) * ux + (a.y - sy) * uy))
          .slice(0, Math.max(6, Math.round(pixels.length * 0.16)));
        const avgX = edgePixels.reduce((sum, p) => sum + p.x, 0) / edgePixels.length;
        const avgY = edgePixels.reduce((sum, p) => sum + p.y, 0) / edgePixels.length;
        return {
          x: Math.round(avgX / scale),
          y: Math.round(avgY / scale)
        };
      }

      // For molars/premolars, use the center of the nearest tooth blob, not a stripe average.
      const xs = pixels.map(p => p.x);
      const ys = pixels.map(p => p.y);
      const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
      return {
        x: Math.round(centerX / scale),
        y: Math.round(centerY / scale)
      };
    }

    _nearestToothComponent(data, width, height, threshold, sx, sy, minX, maxX, minY, maxY) {
      let seed = null;
      let best = Infinity;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!this._isToothPixel(data, width, x, y, threshold)) continue;
          const dx = x - sx;
          const dy = y - sy;
          const score = dx * dx + dy * dy;
          if (score < best) {
            best = score;
            seed = { x, y };
          }
        }
      }
      if (!seed) return [];

      const queue = [seed];
      const seen = new Set([`${seed.x},${seed.y}`]);
      const out = [];
      const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
      while (queue.length && out.length < 3500) {
        const p = queue.shift();
        out.push(p);
        for (const [dx, dy] of dirs) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (x < minX || x > maxX || y < minY || y > maxY) continue;
          const key = `${x},${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (this._isToothPixel(data, width, x, y, threshold)) queue.push({ x, y });
        }
      }
      return out;
    }
    _snapPointToToothPixel(analysis, point) {
      if (!analysis.sample) return point;
      const { data, width, height, threshold } = analysis.sample;
      const scale = analysis.scale;
      const sx = Math.max(0, Math.min(width - 1, Math.round(point.x * scale)));
      const sy = Math.max(0, Math.min(height - 1, Math.round(point.y * scale)));
      if (this._isToothPixel(data, width, sx, sy, threshold)) {
        return { x: Math.round(sx / scale), y: Math.round(sy / scale) };
      }

      const radius = Math.max(10, Math.round(Math.max(width, height) * 0.045));
      let best = null;
      let bestScore = Infinity;
      for (let y = Math.max(0, sy - radius); y <= Math.min(height - 1, sy + radius); y++) {
        for (let x = Math.max(0, sx - radius); x <= Math.min(width - 1, sx + radius); x++) {
          if (!this._isToothPixel(data, width, x, y, threshold)) continue;
          const dx = x - sx;
          const dy = y - sy;
          const score = dx * dx + dy * dy;
          if (score < bestScore) {
            bestScore = score;
            best = { x, y };
          }
        }
      }
      return best ? { x: Math.round(best.x / scale), y: Math.round(best.y / scale) } : point;
    }
    _estimateEzFromTz(tzPoints, arch) {
      if (!Array.isArray(tzPoints) || tzPoints.length < 2) return [];
      const isLower = arch === 'lower';
      const dir = isLower ? 1 : -1;
      const n = tzPoints.length;
      const first = tzPoints[0];
      const last = tzPoints[n - 1];
      const width = Math.max(1, Math.abs(last.x - first.x));
      const posteriorY = (first.y + last.y) / 2;
      const anteriorY = isLower
        ? Math.max(...tzPoints.map(p => p.y))
        : Math.min(...tzPoints.map(p => p.y));
      const archDepth = Math.max(1, Math.abs(anteriorY - posteriorY));
      const midX = (first.x + last.x) / 2;

      return tzPoints.map((p, idx) => {
        if (idx === 0) return { x: Math.round(first.x), y: Math.round(first.y) };
        if (idx === n - 1) return { x: Math.round(last.x), y: Math.round(last.y) };

        const t = idx / (n - 1);
        const centerWeight = Math.sin(Math.PI * t);
        const posteriorWeight = 1 - Math.abs(t - 0.5) * 2;
        const idealY = posteriorY + dir * archDepth * 0.62 * centerWeight;
        const blendedY = p.y * 0.22 + idealY * 0.78;
        const blendedX = p.x + (midX - p.x) * 0.06 * posteriorWeight;

        return {
          x: Math.round(Math.max(0, Math.min(midX + width, blendedX))),
          y: Math.round(blendedY)
        };
      });
    }

    _estimateAlveolarBounds(width, height, arch) {
      const tooth = this._analyzeToothArea(width, height).bounds;
      if (!tooth) return null;
      const insetX = tooth.width * 0.06;
      const isLower = arch === 'lower';
      return {
        x: tooth.x + insetX,
        y: isLower ? tooth.y + tooth.height * 0.18 : tooth.y + tooth.height * 0.08,
        width: Math.max(1, tooth.width - insetX * 2),
        height: Math.max(1, tooth.height * 0.74)
      };
    }

    getAlveolarBounds(arch) {
      if (!this.image) return null;
      const b = this._estimateAlveolarBounds(this.image.width, this.image.height, arch);
      if (!b) return null;
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height)
      };
    }
    getToothBounds() {
      if (!this.image) return null;
      const analysis = this._analyzeToothArea(this.image.width, this.image.height);
      const b = analysis && analysis.bounds;
      if (!b) return null;
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height)
      };
    }
    getData() {
      return {
        ezPoints: this.points.ez.map(p => ({ ...p })),
        tzPoints: this.points.tz.map(p => ({ ...p })),
        image: this.image ? { width: this.image.width, height: this.image.height } : null,
        imageSrc: this.imageSrc
      };
    }

    setData(data = {}) {
      this.points.ez = Array.isArray(data.ezPoints) ? data.ezPoints : [];
      this.points.tz = Array.isArray(data.tzPoints) ? data.tzPoints : [];

      if (data.imageSrc && data.imageSrc !== this.imageSrc) {
        const img = new Image();
        img.onload = () => {
          this.image = img;
          this.imageSrc = data.imageSrc;
          this._fitCanvas();
          this._emit();
        };
        img.src = data.imageSrc;
        return;
      }

      if (!data.imageSrc) {
        this.image = null;
        this.imageSrc = null;
      }
      this._emit();
    }

    _fitCanvas() {
      const parent = this.canvas.parentElement;
      const width = Math.max(360, parent?.clientWidth || 900);
      const height = Math.max(480, Math.round(width * 0.65));
      this.canvas.width = width;
      this.canvas.height = height;

      if (!this.image) {
        this.scale = 1;
        this.offset = { x: 0, y: 0 };
        return;
      }

      this.scale = Math.min(width / this.image.width, height / this.image.height);
      this.offset = {
        x: (width - this.image.width * this.scale) / 2,
        y: (height - this.image.height * this.scale) / 2
      };
    }

    render() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      if (!this.image) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('상악 또는 하악 교합면 사진을 업로드하세요', this.canvas.width / 2, this.canvas.height / 2 - 10);
        ctx.fillStyle = '#64748b';
        ctx.font = '13px sans-serif';
        ctx.fillText('TZ/EZ 점을 찍고, 점 이동 버튼으로 위치를 조정하세요', this.canvas.width / 2, this.canvas.height / 2 + 16);
        return;
      }

      ctx.save();
      ctx.translate(this.offset.x, this.offset.y);
      ctx.scale(this.scale, this.scale);
      ctx.drawImage(this.image, 0, 0);
      ctx.restore();

      if (this.showDiffArea && this.showTz !== false) this._drawDiffArea();
      this._drawCurve('ez');
      if (this.showTz !== false) this._drawCurve('tz');
      if (this.showLengths) this._drawLengthLabels();
      if (this.showTz !== false) this._drawLegend();
      this._drawInstructions();
    }

    _drawDiffArea() {
      const engine = window.EquilibriumZoneEngine;
      if (!engine) return;
      const ezCurve = engine.sampleCurve(this.points.ez);
      const tzCurve = engine.sampleCurve(this.points.tz);
      if (ezCurve.length < 2 || tzCurve.length < 2) return;

      this.ctx.save();
      this.ctx.translate(this.offset.x, this.offset.y);
      this.ctx.scale(this.scale, this.scale);

      this.ctx.beginPath();
      this.ctx.moveTo(ezCurve[0].x, ezCurve[0].y);
      for (let i = 1; i < ezCurve.length; i++) {
        this.ctx.lineTo(ezCurve[i].x, ezCurve[i].y);
      }
      for (let i = tzCurve.length - 1; i >= 0; i--) {
        this.ctx.lineTo(tzCurve[i].x, tzCurve[i].y);
      }
      this.ctx.closePath();
      this.ctx.fillStyle = this.colors.diff;
      this.ctx.fill();

      this.ctx.restore();
    }

    _drawCurve(mode) {
      const engine = window.EquilibriumZoneEngine;
      const pts = this.points[mode];
      if (pts.length < 1) return;
      const curve = engine ? engine.sampleCurve(pts) : pts;
      const color = this.colors[mode];
      const isActive = mode === this.mode;

      this.ctx.save();
      this.ctx.translate(this.offset.x, this.offset.y);
      this.ctx.scale(this.scale, this.scale);

      // Draw curve
      if (curve.length > 1) {
        this.ctx.beginPath();
        this.ctx.moveTo(curve[0].x, curve[0].y);
        for (let i = 1; i < curve.length; i++) this.ctx.lineTo(curve[i].x, curve[i].y);
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = (isActive ? 3.5 : 2.5) / this.scale;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        if (mode === 'ez') {
          this.ctx.setLineDash([8 / this.scale, 5 / this.scale]);
        }
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }

      // Draw control points
      pts.forEach((p, idx) => {
        const isHovered = this._hovered && this._hovered.mode === mode && this._hovered.index === idx;
        const radius = (isHovered ? 9 : 6) / this.scale;

        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        this.ctx.fillStyle = color;
        this.ctx.fill();
        this.ctx.lineWidth = 2 / this.scale;
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.stroke();

        // Point number
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = `bold ${11 / this.scale}px sans-serif`;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        if (radius > 7 / this.scale) {
          this.ctx.fillText(String(idx + 1), p.x, p.y);
        } else {
          this.ctx.fillStyle = '#ffffff';
          this.ctx.font = `${10 / this.scale}px sans-serif`;
          this.ctx.textAlign = 'left';
          this.ctx.fillText(String(idx + 1), p.x + 9 / this.scale, p.y - 9 / this.scale);
        }
      });

      this.ctx.restore();
    }

    _drawLengthLabels() {
      const engine = window.EquilibriumZoneEngine;
      if (!engine) return;

      const ezCurve = engine.sampleCurve(this.points.ez);
      const tzCurve = engine.sampleCurve(this.points.tz);
      const ezLen = engine.curveLength(ezCurve);
      const tzLen = engine.curveLength(tzCurve);

      if (ezLen === 0 && tzLen === 0) return;

      const ctx = this.ctx;
      ctx.save();

      const x = this.canvas.width - 16;
      let y = this.canvas.height - 80;

      ctx.textAlign = 'right';
      ctx.font = 'bold 13px sans-serif';

      const fmtLen = (px) => {
        if (this.pxPerMm && this.pxPerMm > 0) {
          return (px / this.pxPerMm).toFixed(1) + ' mm';
        }
        return Math.round(px) + ' px';
      };

      if (tzLen > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 150, y - 14, 158, 22);
        ctx.fillStyle = this.colors.tz;
        ctx.fillText('TZ: ' + fmtLen(tzLen), x, y);
        y += 24;
      }
      if (ezLen > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 150, y - 14, 158, 22);
        ctx.fillStyle = this.colors.ez;
        ctx.fillText('EZ: ' + fmtLen(ezLen), x, y);
        y += 24;
      }
      if (tzLen > 0 && ezLen > 0) {
        const diff = tzLen - ezLen;
        const diffMm = this.pxPerMm ? (diff / this.pxPerMm).toFixed(1) + ' mm' : Math.round(diff) + ' px';
        const label = diff > 0 ? 'Crowding: +' + diffMm : 'Spacing: ' + diffMm;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - 180, y - 14, 188, 22);
        ctx.fillStyle = diff > 0 ? '#fbbf24' : '#34d399';
        ctx.fillText(label, x, y);
      }

      ctx.restore();
    }

    _drawLegend() {
      const ctx = this.ctx;
      ctx.save();

      const items = [
        { label: 'TZ 현재 치열선', color: this.colors.tz, dash: false },
        { label: 'EZ 안정 배열선', color: this.colors.ez, dash: true },
        { label: '차이 영역', color: this.colors.diff, fill: true },
      ];

      let x = 14;
      const y = 18;
      ctx.font = '12px sans-serif';

      items.forEach(item => {
        const tw = ctx.measureText(item.label).width;
        const boxW = tw + 38;

        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(x, y - 4, boxW, 20);

        if (item.fill) {
          ctx.fillStyle = item.color;
          ctx.fillRect(x + 6, y + 2, 16, 10);
        } else {
          ctx.beginPath();
          ctx.moveTo(x + 6, y + 7);
          ctx.lineTo(x + 22, y + 7);
          ctx.strokeStyle = item.color;
          ctx.lineWidth = 3;
          if (item.dash) ctx.setLineDash([4, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(item.label, x + 26, y + 12);
        x += boxW + 6;
      });

      // Current mode label
      const modeLabel = this.tool === 'move' ? '[ 점 이동 모드 ]' : (this.mode === 'tz' ? '[ TZ 입력 모드 ]' : '[ EZ 입력 모드 ]');
      const modeColor = this.mode === 'tz' ? this.colors.tz : this.colors.ez;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const mw = ctx.measureText(modeLabel).width + 12;
      ctx.fillRect(x, y - 4, mw, 20);
      ctx.fillStyle = modeColor;
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(modeLabel, x + 6, y + 12);

      ctx.restore();
    }

    _drawInstructions() {
      if (this.points.tz.length > 0 || this.points.ez.length > 0) return;

      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(this.canvas.width / 2 - 220, this.canvas.height - 60, 440, 48);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('각 치아의 끝단 또는 중심을 순서대로 클릭하세요.', this.canvas.width / 2, this.canvas.height - 40);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px sans-serif';
      ctx.fillText('좌측 구치부에서 전치부를 지나 우측 구치부까지 14개 포인트를 권장합니다.', this.canvas.width / 2, this.canvas.height - 22);
      ctx.restore();
    }

    _emit() {
      this.render();
      this.onChange(this.getData());
    }
  }

  window.CurveEditor = CurveEditor;
})();











