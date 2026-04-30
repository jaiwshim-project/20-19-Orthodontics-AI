/* ==============================================================
   ScannerInput — 구강 스캐너 사진 입력 탭 컴포넌트
   각 AI 페이지에 mount(container, options)로 부착.
   사진 업로드 → /api/analyze-image 호출 → onAnalyzed(fields)로 폼 자동 채움.
   ============================================================== */

(function () {
  const TYPE_CONFIG = {
    extraction: {
      title: '구강 사진 + 측면 두부방사선 업로드',
      hint: '구강 정면/측면 사진 또는 Lateral Cephalogram. JPG/PNG, 최대 20MB',
      fields: ['anb', 'crowding', 'overjet', 'overbite', 'profile', 'lipStrain', 'fma', 'impa']
    },
    growth: {
      title: '손목 X-ray 또는 측면 두부방사선 업로드',
      hint: 'Hand-wrist 골연령 사진 또는 측면 ceph. JPG/PNG, 최대 20MB',
      fields: ['boneAge', 'cvms', 'height', 'weight']
    },
    facial: {
      title: '측면 안모 사진 업로드',
      hint: '환자 측면(profile) 사진을 자연광에서 촬영. JPG/PNG, 최대 20MB',
      fields: ['maxRetract', 'mandShift', 'lipUpper', 'lipLower', 'chin']
    },
    recurrence: {
      title: '치료 종료 시 측면 두부방사선 / 모형 사진',
      hint: '치료 직후 Lateral Ceph 또는 STL 스크린샷. JPG/PNG, 최대 20MB',
      fields: ['impa', 'incisorShift', 'residual']
    }
  };

  const FIELD_LABELS = {
    anb: 'ANB (도)', crowding: 'Crowding (mm)', overjet: 'Overjet (mm)', overbite: 'Overbite (mm)',
    profile: 'Profile', lipStrain: 'Lip Strain', fma: 'FMA (도)', impa: 'IMPA (도)',
    boneAge: '골연령 (세)', cvms: 'CVMS (1-6)', height: '신장 (cm)', weight: '체중 (kg)',
    maxRetract: '상악 후방 (mm)', mandShift: '하악 전후방 (mm)',
    lipUpper: '상순 (mm)', lipLower: '하순 (mm)', chin: '턱 (mm)',
    incisorShift: '하악 절치 변화 (mm)', residual: '잔여 Crowding (mm)'
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  window.ScannerInput = {
    /**
     * @param {HTMLElement} container 마운트 대상 요소
     * @param {Object} options { type, onAnalyzed: (fields, raw) => void, onSwitchToData: () => void }
     */
    mount(container, options = {}) {
      const cfg = TYPE_CONFIG[options.type];
      if (!cfg) {
        container.innerHTML = '<p>지원하지 않는 진단 type입니다.</p>';
        return;
      }

      container.innerHTML = `
        <div class="scanner-zone" data-zone>
          <input type="file" accept="image/*" hidden data-file>
          <div data-empty>
            <div class="scanner-icon" aria-hidden="true">📷</div>
            <div class="scanner-title">${escapeHtml(cfg.title)}</div>
            <div class="scanner-hint">${escapeHtml(cfg.hint)}</div>
          </div>
          <div data-preview hidden></div>
        </div>
        <div data-status hidden class="scanner-status"></div>
        <div data-fields hidden></div>
        <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" data-analyze hidden>🧠 AI 분석 시작</button>
          <button type="button" class="btn btn-ghost" data-apply hidden>✓ 분석 결과 적용 → 데이터 탭</button>
          <button type="button" class="btn btn-ghost" data-clear hidden>다시 업로드</button>
        </div>
      `;

      const zone = container.querySelector('[data-zone]');
      const fileInput = container.querySelector('[data-file]');
      const emptyEl = container.querySelector('[data-empty]');
      const previewEl = container.querySelector('[data-preview]');
      const statusEl = container.querySelector('[data-status]');
      const fieldsEl = container.querySelector('[data-fields]');
      const analyzeBtn = container.querySelector('[data-analyze]');
      const applyBtn = container.querySelector('[data-apply]');
      const clearBtn = container.querySelector('[data-clear]');

      let currentFile = null;
      let currentBase64 = null;
      let lastAnalysis = null;

      function setStatus(text, kind) {
        if (!text) { statusEl.hidden = true; return; }
        statusEl.hidden = false;
        statusEl.textContent = text;
        statusEl.className = 'scanner-status ' + (kind || '');
      }

      function reset() {
        currentFile = null; currentBase64 = null; lastAnalysis = null;
        emptyEl.hidden = false;
        previewEl.hidden = true;
        previewEl.innerHTML = '';
        analyzeBtn.hidden = true;
        applyBtn.hidden = true;
        clearBtn.hidden = true;
        fieldsEl.hidden = true;
        fieldsEl.innerHTML = '';
        setStatus('');
        fileInput.value = '';
      }

      function loadFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/')) {
          setStatus('이미지 파일만 지원합니다 (JPG/PNG).', 'error');
          return;
        }
        if (file.size > 20 * 1024 * 1024) {
          setStatus('파일이 20MB를 초과합니다.', 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = e => {
          currentFile = file;
          currentBase64 = (e.target.result || '').split(',')[1];
          emptyEl.hidden = true;
          previewEl.hidden = false;
          previewEl.innerHTML = `
            <div class="scanner-preview">
              <img src="${e.target.result}" alt="업로드된 이미지">
              <button type="button" class="remove-btn" aria-label="제거" onclick="event.stopPropagation();">×</button>
            </div>
          `;
          previewEl.querySelector('.remove-btn').onclick = (ev) => { ev.stopPropagation(); reset(); };
          analyzeBtn.hidden = false;
          clearBtn.hidden = false;
          setStatus(`${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB) — AI 분석 버튼을 클릭하세요.`, '');
        };
        reader.readAsDataURL(file);
      }

      // Click → file picker
      zone.addEventListener('click', (e) => {
        if (currentFile) return;
        fileInput.click();
      });
      fileInput.addEventListener('change', e => loadFile(e.target.files[0]));

      // Drag & drop
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('drag');
        loadFile(e.dataTransfer.files[0]);
      });

      // Analyze
      analyzeBtn.addEventListener('click', async () => {
        if (!currentBase64) return;
        analyzeBtn.disabled = true;
        setStatus('AI 분석 중... (Gemini Vision, 5-15초 소요)', 'analyzing');
        try {
          const res = await fetch('/api/analyze-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: options.type,
              filename: currentFile.name,
              contentType: currentFile.type,
              base64: currentBase64
            })
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
          }
          const data = await res.json();
          lastAnalysis = data;
          renderFields(data);
          setStatus(
            data.fallback
              ? `⚠️ ${data.note || 'AI 호출이 실패해 데모 추정값을 사용했습니다. 반드시 직접 검증하세요.'}`
              : `✅ 분석 완료 (신뢰도 ${Math.round((data.confidence || 0) * 100)}%) — 데이터 탭으로 적용하세요.`,
            data.fallback ? 'error' : 'success'
          );
          applyBtn.hidden = false;
        } catch (e) {
          console.error('[scanner] 분석 실패:', e);
          setStatus(`분석 실패: ${e.message}. 데이터 탭에서 직접 입력하세요.`, 'error');
        } finally {
          analyzeBtn.disabled = false;
        }
      });

      function renderFields(data) {
        const fields = data.fields || {};
        const keys = cfg.fields.filter(k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
        if (!keys.length) {
          fieldsEl.hidden = true;
          return;
        }
        fieldsEl.hidden = false;
        fieldsEl.innerHTML = `
          <div style="margin: 14px 0 8px; font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">추출된 측정값</div>
          <div class="scanner-fields">
            ${keys.map(k => `
              <div class="ext-field">
                <span class="key">${escapeHtml(FIELD_LABELS[k] || k)}</span>
                <span class="val">${escapeHtml(fields[k])}</span>
              </div>
            `).join('')}
          </div>
          ${data.notes ? `<div style="margin-top:10px; font-size:12px; color:var(--text-secondary); line-height:1.6;">📝 ${escapeHtml(data.notes)}</div>` : ''}
        `;
      }

      // Apply → fill form
      applyBtn.addEventListener('click', () => {
        if (!lastAnalysis || !lastAnalysis.fields) return;
        if (typeof options.onAnalyzed === 'function') {
          options.onAnalyzed(lastAnalysis.fields, lastAnalysis);
        }
        if (typeof options.onSwitchToData === 'function') {
          options.onSwitchToData();
        }
        if (window.toast) window.toast('분석 결과가 데이터 탭에 적용되었습니다.', 'success');
      });

      clearBtn.addEventListener('click', reset);
    },

    /**
     * 탭 위젯 표준 셋업: 컨테이너 안에 .tabs와 .tab-panel[data-tab]이 있을 때.
     */
    setupTabs(container) {
      const btns = container.querySelectorAll('.tab-btn[data-tab]');
      const panels = container.querySelectorAll('.tab-panel[data-tab]');
      btns.forEach(btn => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.tab;
          btns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
          panels.forEach(p => p.classList.toggle('active', p.dataset.tab === target));
        });
      });
      return {
        switchTo(name) {
          btns.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
          panels.forEach(p => p.classList.toggle('active', p.dataset.tab === name));
        }
      };
    }
  };
})();
