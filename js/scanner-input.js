/* ==============================================================
   ScannerInput — 멀티 이미지 슬롯 업로드 컴포넌트
   슬롯 키: scanner / xray / faceFront / faceSide / intraoral
   각 AI 페이지가 사용할 슬롯 목록을 TYPE_CONFIG에서 선언.
   ============================================================== */

(function () {
  const COMMON_SLOTS = {
    scanner:    { title: '3D 스캐너 / 구강 모형',   hint: 'STL 스크린샷 · 모형 사진',     icon: '🦷', tag: '3D' },
    xray:       { title: 'X-ray / 두부방사선',      hint: 'Lateral Ceph · Pano · 손목', icon: '🩻', tag: 'X-ray' },
    faceFront:  { title: '정면 안모 사진',           hint: '입을 다문 정면, 자연광',       icon: '😐', tag: '정면' },
    faceSide:   { title: '측면 안모 사진',           hint: '90도 측면 (Profile)',         icon: '👤', tag: '측면' },
    intraoral:  { title: '입술 벌린 정면',           hint: '치아 노출 정면 사진',          icon: '😬', tag: '입속' }
  };

  const TYPE_CONFIG = {
    extraction: {
      slots: ['scanner', 'xray', 'faceFront', 'faceSide', 'intraoral'],
      fields: ['anb', 'crowding', 'overjet', 'overbite', 'profile', 'lipStrain', 'fma', 'impa']
    },
    growth: {
      slots: ['xray', 'scanner', 'faceFront', 'faceSide'],
      fields: ['boneAge', 'cvms', 'height', 'weight']
    },
    facial: {
      slots: ['faceSide', 'faceFront', 'intraoral', 'xray'],
      fields: ['maxRetract', 'mandShift', 'lipUpper', 'lipLower', 'chin']
    },
    recurrence: {
      slots: ['scanner', 'xray', 'intraoral', 'faceSide'],
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
     * @param {HTMLElement} container
     * @param {Object} options { type, onAnalyzed: (fields, raw) => void, onSwitchToData: () => void }
     */
    mount(container, options = {}) {
      const cfg = TYPE_CONFIG[options.type];
      if (!cfg) {
        container.innerHTML = '<p>지원하지 않는 진단 type입니다.</p>';
        return;
      }
      const SLOT_KEYS = cfg.slots;

      const dualHtml = SLOT_KEYS.map(key => {
        const slot = COMMON_SLOTS[key];
        if (!slot) return '';
        return `
          <div class="scanner-slot" data-slot="${key}">
            <div class="scanner-slot-label">
              <span>${escapeHtml(slot.tag)}</span>
              <span class="pill optional">선택</span>
            </div>
            <div class="scanner-zone" data-zone>
              <input type="file" accept="image/*" hidden data-file>
              <div data-empty class="inner">
                <div class="scanner-icon" aria-hidden="true">${slot.icon}</div>
                <div class="scanner-title">${escapeHtml(slot.title)}</div>
                <div class="scanner-hint">${escapeHtml(slot.hint)}</div>
              </div>
              <div data-preview hidden class="inner"></div>
            </div>
          </div>
        `;
      }).join('');

      container.innerHTML = `
        <div class="scanner-dual">${dualHtml}</div>
        <p style="font-size:11px; color:var(--text-muted); text-align:center; margin: 4px 0 12px;">
          최소 1장만 있어도 분석 가능. 여러 장 업로드 시 정확도가 가장 높습니다.
        </p>
        <div data-status hidden class="scanner-status"></div>
        <div data-fields hidden></div>
        <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" data-analyze disabled>🧠 AI 분석 시작</button>
          <button type="button" class="btn btn-ghost" data-apply hidden>✓ 분석 결과 적용 → 데이터 탭</button>
          <button type="button" class="btn btn-ghost" data-clear hidden>모두 초기화</button>
        </div>
      `;

      const slots = {};
      SLOT_KEYS.forEach(key => {
        slots[key] = {
          el: container.querySelector(`[data-slot="${key}"]`),
          file: null, base64: null, contentType: null
        };
      });

      const statusEl = container.querySelector('[data-status]');
      const fieldsEl = container.querySelector('[data-fields]');
      const analyzeBtn = container.querySelector('[data-analyze]');
      const applyBtn = container.querySelector('[data-apply]');
      const clearBtn = container.querySelector('[data-clear]');
      let lastAnalysis = null;

      function setStatus(text, kind) {
        if (!text) { statusEl.hidden = true; return; }
        statusEl.hidden = false;
        statusEl.textContent = text;
        statusEl.className = 'scanner-status ' + (kind || '');
        statusEl.style.whiteSpace = 'pre-wrap';
      }

      function refreshAnalyzeBtn() {
        const anyUploaded = SLOT_KEYS.some(k => slots[k].base64);
        analyzeBtn.disabled = !anyUploaded;
        clearBtn.hidden = !anyUploaded;
      }

      function setupSlot(key) {
        const slot = slots[key];
        const zone = slot.el.querySelector('[data-zone]');
        const fileInput = slot.el.querySelector('[data-file]');
        const emptyEl = slot.el.querySelector('[data-empty]');
        const previewEl = slot.el.querySelector('[data-preview]');

        function showPreview(dataUrl, file) {
          slot.file = file;
          slot.base64 = dataUrl.split(',')[1];
          slot.contentType = file.type;
          emptyEl.hidden = true;
          previewEl.hidden = false;
          previewEl.innerHTML = `
            <div class="scanner-preview" style="margin:0;">
              <img src="${dataUrl}" alt="${escapeHtml(key)} 이미지">
              <button type="button" class="remove-btn" aria-label="제거" data-remove>×</button>
            </div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:4px; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(file.name)}</div>
          `;
          previewEl.querySelector('[data-remove]').onclick = (ev) => { ev.stopPropagation(); resetSlot(key); };
          refreshAnalyzeBtn();
        }

        function loadFile(file) {
          if (!file) return;
          if (!file.type.startsWith('image/')) { setStatus('이미지 파일만 지원합니다 (JPG/PNG).', 'error'); return; }
          if (file.size > 20 * 1024 * 1024) { setStatus('파일이 20MB를 초과합니다.', 'error'); return; }
          const reader = new FileReader();
          reader.onload = e => showPreview(e.target.result, file);
          reader.readAsDataURL(file);
        }

        zone.addEventListener('click', () => { if (!slot.file) fileInput.click(); });
        fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
        zone.addEventListener('drop', e => {
          e.preventDefault();
          zone.classList.remove('drag');
          loadFile(e.dataTransfer.files[0]);
        });
      }

      function resetSlot(key) {
        const slot = slots[key];
        slot.file = null; slot.base64 = null; slot.contentType = null;
        slot.el.querySelector('[data-empty]').hidden = false;
        const previewEl = slot.el.querySelector('[data-preview]');
        previewEl.hidden = true;
        previewEl.innerHTML = '';
        slot.el.querySelector('[data-file]').value = '';
        refreshAnalyzeBtn();
      }

      function resetAll() {
        SLOT_KEYS.forEach(resetSlot);
        lastAnalysis = null;
        applyBtn.hidden = true;
        fieldsEl.hidden = true;
        fieldsEl.innerHTML = '';
        setStatus('');
      }

      SLOT_KEYS.forEach(setupSlot);

      analyzeBtn.addEventListener('click', async () => {
        const images = {};
        const usedTags = [];
        SLOT_KEYS.forEach(k => {
          if (slots[k].base64) {
            images[k] = { base64: slots[k].base64, contentType: slots[k].contentType };
            usedTags.push(COMMON_SLOTS[k].tag);
          }
        });
        if (Object.keys(images).length === 0) { setStatus('이미지를 1장 이상 업로드하세요.', 'error'); return; }
        analyzeBtn.disabled = true;
        setStatus(`AI 분석 중 (${usedTags.join(' + ')})... Gemini Vision 5-15초 소요`, 'analyzing');
        try {
          const res = await fetch('/api/analyze-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: options.type, images })
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
              ? `⚠️ ${data.note || 'AI 호출 실패 — 데모 추정값 표시. 직접 검증 필요.'}`
              : `✅ 분석 완료 (${usedTags.join(' + ')} · 신뢰도 ${Math.round((data.confidence || 0) * 100)}%) — 데이터 탭으로 적용하세요.`,
            data.fallback ? 'error' : 'success'
          );
          applyBtn.hidden = false;
        } catch (e) {
          console.error('[scanner] 분석 실패:', e);
          const isFetchFail = e.message === 'Failed to fetch' || e.name === 'TypeError';
          const hint = isFetchFail
            ? 'API 서버 미실행. 터미널에서 `npm run dev` 후 http://localhost:3000 접속.'
            : '데이터 탭에서 직접 입력하세요.';
          setStatus(`❌ 분석 실패: ${e.message}\n${hint}`, 'error');
        } finally {
          refreshAnalyzeBtn();
        }
      });

      function renderFields(data) {
        const fields = data.fields || {};
        const keys = cfg.fields.filter(k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '');
        if (!keys.length) { fieldsEl.hidden = true; return; }
        fieldsEl.hidden = false;
        const sourceTag = Array.isArray(data.usedImages) && data.usedImages.length
          ? `<span style="font-size:10px; padding:2px 8px; border-radius:4px; background:rgba(14,165,233,0.1); color:var(--color-primary); margin-left:8px;">${escapeHtml(data.usedImages.join(' + '))}</span>`
          : '';
        fieldsEl.innerHTML = `
          <div style="margin: 14px 0 8px; font-size:12px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px;">
            추출된 측정값 ${sourceTag}
          </div>
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

      applyBtn.addEventListener('click', () => {
        if (!lastAnalysis || !lastAnalysis.fields) return;
        if (typeof options.onAnalyzed === 'function') options.onAnalyzed(lastAnalysis.fields, lastAnalysis);
        if (typeof options.onSwitchToData === 'function') options.onSwitchToData();
        if (window.toast) window.toast('분석 결과가 데이터 탭에 적용되었습니다.', 'success');
      });

      clearBtn.addEventListener('click', resetAll);
    },

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
