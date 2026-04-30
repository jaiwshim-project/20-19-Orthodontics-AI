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

  const FIELD_LEGENDS = {
    anb: 'A점-Nasion-B점 각도(Steiner 분석). 상하악 골격 관계 지표. 정상 2°±2. 4° 이상이면 골격성 II급(상악 전돌), 0° 이하면 III급(하악 전돌). 발치·수술 결정의 일차 기준.',
    crowding: '치열궁 길이와 치아 폭 합의 차이(mm). 음수일수록 공간 부족. Proffit 기준 <4mm 경미, 4–8mm 중등도, >8mm 심함. 발치 vs IPR·확장 결정의 가장 직접적 근거.',
    overjet: '상하악 전치 절단연의 수평 거리(mm). 정상 2–4mm. 5mm 초과 시 II급 동반 가능성, 음수면 III급 반대교합. 치아 외상 위험·입술 관계·안모 돌출과 직결되는 핵심 지표.',
    overbite: '상하악 전치의 수직 겹침(mm). 정상 2–4mm. 6mm 이상 deep bite, 0 이하 open bite. 측두하악관절 부담, 치주 건강, 발음에 영향. 교합 깊이는 안모와 직결.',
    profile: '측면 안모 형태 분류. straight(균형), convex(볼록·II급/상악 전돌), concave(오목·III급/하악 전돌). 발치 시 안모 변화 방향을 결정하며 비발치 결정 시 보존 우선.',
    lipStrain: '입을 다물 때 입술 긴장도. none(자연 폐구), mild(경미한 노력), severe(현저). 전치 돌출의 간접 지표이며 발치 후방이동으로 긴장 완화·심미 개선 기대 가능.',
    fma: 'Frankfort-하악평면 각도(Tweed 분석). 정상 25°±5. 30° 이상 hyperdivergent(수직 성장형), 20° 이하 hypodivergent(수평형). 치료 방향, 예후, 보정 프로토콜 결정의 핵심.',
    impa: '하악 절치 장축과 하악 평면의 각도. 정상 90°±5. 95° 초과 시 설측 경사 한계 시사. Tweed 진단 삼각형의 핵심으로 IMPA 정상화는 장기 안정성과 직결.',
    boneAge: '손목 X-ray 기반 골 성숙도 추정 나이(세). MP3·sesamoid·distal phalanx 단계로 평가. 역연령과 비교해 성장 잠재력과 치료 시기 결정. 잔여 성장량 예측의 일차 지표.',
    cvms: '경추 골성숙 단계(1-6, Baccetti). CS3가 peak velocity로 골격 치료 골든타임. CS5-6은 성장 완료. Lateral Ceph로 측정 가능해 손목 X-ray 없이 시기 판단 가능.',
    height: '환자의 현재 신장(cm). 부모 키와 함께 mid-parental height 계산해 잔여 성장량 추정. 치료 기간·기능 장치 효과 예측에 사용. 6개월 단위로 재측정 권장.',
    weight: '환자의 현재 체중(kg). 신장과 함께 BMI 산출. 영양 상태와 골 성숙 진행 평가에 보조적 사용. 어린이의 경우 성장 곡선 백분위수 추적의 기준치.',
    maxRetract: '상악 전치 후방 이동 권장량(mm). 양수=후방 이동, 음수=전방. 발치 후 공간 폐쇄 시 가능한 이동량 추정. 안모 볼록 개선과 입술 긴장 완화의 핵심 변수.',
    mandShift: '하악 전후방 이동 권장량(mm). 양수=전방, 음수=후방. 골격성 II급에선 전방 이동, III급에선 후방 이동 검토. 기능 장치·수술 결정의 직접 지표.',
    lipUpper: '상순 위치 변화 권장량(mm). 음수=후방. E-line 기준 -4mm가 이상적. 상악 전치 후방 이동에 비례해 약 60% 후퇴. 발치 시 1차 안모 변화 예측.',
    lipLower: '하순 위치 변화 권장량(mm). 음수=후방. E-line 기준 -2mm 이상적. 하악 절치 위치와 강하게 연관. 입술 긴장도와 미소선 분석에 함께 고려.',
    chin: '턱(Pogonion) 위치 변화 권장량(mm). 양수=전방. 골격성 II급에선 turbo·기능 장치로 전방, III급에선 chin cup으로 후방 이동 검토. 수술 시 genioplasty 대안.',
    incisorShift: '치료 중 하악 절치 위치 변화량(mm). 양수=전방, 음수=후방. 2mm 이상 전방 이동 시 재발 위험 급증. 보정 기간·종류 선택과 장기 안정성의 핵심 예측 변수.',
    residual: '치료 종료 시 잔여 Crowding(mm). 0에 가까울수록 안정적. 1mm 이상 잔존 시 재발 가속. 보정 강도(Bonded vs Essix) 결정과 정기 검진 주기 단축 사유.'
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
        <div data-prev-images hidden style="margin-bottom:12px; padding:12px 14px; background:rgba(14,165,233,0.06); border:1px solid rgba(14,165,233,0.25); border-radius:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong style="font-size:12px; color:var(--color-primary);">📸 이전 진단 이미지 <span data-prev-count style="font-weight:400; color:var(--text-muted);"></span></strong>
            <button type="button" data-clear-prev style="background:transparent; border:none; color:var(--text-muted); font-size:11px; cursor:pointer;">숨기기</button>
          </div>
          <div data-prev-grid style="display:grid; grid-template-columns:repeat(auto-fill, minmax(80px, 1fr)); gap:6px;"></div>
        </div>
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

      // 환자 supabaseId 있으면 같은 type의 최근 진단 이미지 자동 로드
      (async () => {
        try {
          const patient = window.PatientStore?.get();
          const pid = patient?.supabaseId || patient?.id;
          if (!pid || !window.apiFetch) return;
          const res = await window.apiFetch(`/api/get-diagnoses?patient_id=${encodeURIComponent(pid)}&type=${options.type}&limit=5`);
          const data = await res.json();
          const images = [];
          (data.records || []).forEach(d => {
            (d.result?.imagesMeta || []).forEach(im => images.push({ ...im, date: d.created_at }));
          });
          if (images.length === 0) return;
          const prevBox = container.querySelector('[data-prev-images]');
          const prevGrid = container.querySelector('[data-prev-grid]');
          const prevCount = container.querySelector('[data-prev-count]');
          prevBox.hidden = false;
          prevCount.textContent = `(${images.length}장 발견)`;
          const SLOT_KO = { scanner: '3D', xray: 'X-ray', faceFront: '정면', faceSide: '측면', intraoral: '입속' };
          prevGrid.innerHTML = images.slice(0, 10).map(im => `
            <a href="${im.url}" target="_blank" rel="noopener" style="display:block; border:1px solid var(--border-subtle); border-radius:6px; overflow:hidden; cursor:zoom-in; position:relative;">
              <img src="${im.url}" style="width:100%; height:60px; object-fit:cover; display:block;">
              <div style="position:absolute; bottom:0; left:0; right:0; padding:2px 4px; background:rgba(0,0,0,0.7); font-size:9px; color:#fff; font-weight:600;">${SLOT_KO[im.slot] || im.slot}</div>
            </a>
          `).join('');
          container.querySelector('[data-clear-prev]').onclick = () => { prevBox.hidden = true; };
        } catch (e) {
          console.warn('[scanner] 이전 이미지 로드 실패:', e.message);
        }
      })();

      // 외부에서 업로드된 이미지 가져갈 수 있도록 노출
      container._getUploadedImages = () => {
        const out = {};
        SLOT_KEYS.forEach(k => {
          if (slots[k].base64) {
            out[k] = {
              base64: slots[k].base64,
              contentType: slots[k].contentType,
              filename: slots[k].file?.name
            };
          }
        });
        return out;
      };

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
          const res = await window.apiFetch('/api/analyze-image', {
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
              <div class="ext-field" style="flex-direction:column; align-items:stretch; padding:10px 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                  <span class="key">${escapeHtml(FIELD_LABELS[k] || k)}</span>
                  <span class="val">${escapeHtml(fields[k])}</span>
                </div>
                ${FIELD_LEGENDS[k] ? `<div style="font-size:11px; color:var(--text-muted); line-height:1.55; padding-top:6px; border-top:1px dashed var(--border-subtle);">${escapeHtml(FIELD_LEGENDS[k])}</div>` : ''}
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
