/* ==============================================================
   WizardState — 위저드 단계 간 상태 관리 + 진행도 UI
   sessionStorage 기반 (탭 닫으면 초기화).
   ============================================================== */

(function () {
  const KEY_PREFIX = 'oa_wiz_';

  const ENGINES = {
    extraction: {
      label: '발치 판단', sub: 'Extraction',
      steps: [
        { slug: 'data',   title: '데이터 입력', icon: '📋' },
        { slug: 'scan',   title: '이미지 업로드', icon: '📷' },
        { slug: 'result', title: 'AI 진단 결과', icon: '🧠' }
      ]
    },
    growth: {
      label: '성장 예측', sub: 'Growth',
      steps: [
        { slug: 'data',   title: '데이터 입력', icon: '📋' },
        { slug: 'scan',   title: '영상 업로드', icon: '🩻' },
        { slug: 'result', title: '예측 결과',  icon: '📈' }
      ]
    },
    facial: {
      label: '안모 시뮬레이션', sub: 'Facial',
      steps: [
        { slug: 'data',   title: '슬라이더 조정', icon: '🎚' },
        { slug: 'scan',   title: '안모 사진',     icon: '👤' },
        { slug: 'result', title: '시뮬 결과',     icon: '✨' }
      ]
    },
    recurrence: {
      label: '재발 예측', sub: 'Recurrence',
      steps: [
        { slug: 'data',   title: '데이터 입력', icon: '📋' },
        { slug: 'scan',   title: '치료 후 사진', icon: '📷' },
        { slug: 'result', title: '재발 예측',   icon: '🔁' }
      ]
    }
  };

  function k(engine, step) { return `${KEY_PREFIX}${engine}_${step}`; }

  window.WizardState = {
    ENGINES,

    save(engine, step, data) {
      sessionStorage.setItem(k(engine, step), JSON.stringify({ data, savedAt: Date.now() }));
    },

    load(engine, step) {
      try {
        const raw = sessionStorage.getItem(k(engine, step));
        if (!raw) return null;
        return JSON.parse(raw).data;
      } catch { return null; }
    },

    has(engine, step) {
      return !!sessionStorage.getItem(k(engine, step));
    },

    clear(engine) {
      const eng = ENGINES[engine];
      if (!eng) return;
      eng.steps.forEach(s => sessionStorage.removeItem(k(engine, s.slug)));
    },

    clearAll() {
      Object.keys(sessionStorage)
        .filter(key => key.startsWith(KEY_PREFIX))
        .forEach(key => sessionStorage.removeItem(key));
    },

    /**
     * 진행 바 렌더링.
     * @param {HTMLElement} container
     * @param {string} engine
     * @param {string} currentSlug
     */
    renderProgress(container, engine, currentSlug) {
      const eng = ENGINES[engine];
      if (!eng || !container) return;

      const stepsHtml = eng.steps.map((s, i) => {
        const filled = this.has(engine, s.slug);
        const active = s.slug === currentSlug;
        const cls = active ? 'active' : (filled ? 'done' : 'pending');
        return `
          <div class="wiz-step ${cls}" data-slug="${s.slug}">
            <div class="wiz-dot">
              <span class="wiz-num">${i + 1}</span>
              <span class="wiz-check">✓</span>
            </div>
            <div class="wiz-meta">
              <div class="wiz-title">${s.title}</div>
              <div class="wiz-sub">Step ${i + 1} of ${eng.steps.length}</div>
            </div>
          </div>
        `;
      }).join('<div class="wiz-bar"></div>');

      container.innerHTML = `
        <div class="wizard-progress">
          <div class="wiz-header">
            <div>
              <span class="wiz-engine-icon">${eng.steps[0].icon}</span>
              <strong>${eng.label}</strong>
              <span style="color:var(--text-muted); font-size:12px; margin-left:6px;">${eng.sub} · 위저드</span>
            </div>
            <div>
              <a href="${engine}-data.html" class="btn btn-ghost btn-sm">처음부터</a>
              <button type="button" class="btn btn-ghost btn-sm" onclick="window.WizardState.clear('${engine}'); location.reload();">초기화</button>
            </div>
          </div>
          <div class="wiz-track">${stepsHtml}</div>
        </div>
      `;

      container.querySelectorAll('.wiz-step').forEach(el => {
        el.addEventListener('click', () => {
          const slug = el.dataset.slug;
          if (slug && slug !== currentSlug) {
            window.location.href = `${engine}-${slug}.html`;
          }
        });
      });
    },

    /**
     * 페이지 하단 Prev/Next 버튼.
     */
    renderNav(container, engine, currentSlug, opts = {}) {
      const eng = ENGINES[engine];
      const idx = eng.steps.findIndex(s => s.slug === currentSlug);
      const prev = idx > 0 ? eng.steps[idx - 1] : null;
      const next = idx < eng.steps.length - 1 ? eng.steps[idx + 1] : null;

      const prevBtn = prev
        ? `<a href="${engine}-${prev.slug}.html" class="btn btn-ghost">← ${prev.title}</a>`
        : `<a href="index.html" class="btn btn-ghost">← 허브로</a>`;

      const nextLabel = opts.nextLabel || (next ? `${next.title} →` : '완료');
      const nextHref = next ? `${engine}-${next.slug}.html` : 'index.html';
      const nextDisabled = opts.nextDisabled ? 'disabled style="opacity:.5; pointer-events:none;"' : '';
      const nextOnClick = opts.nextOnClick ? `onclick="${opts.nextOnClick}"` : '';
      const nextBtn = opts.hideNext ? ''
        : `<a href="${nextHref}" class="btn btn-primary" ${nextDisabled} ${nextOnClick}>${nextLabel}</a>`;

      container.innerHTML = `
        <div class="wizard-nav">
          ${prevBtn}
          <div style="flex:1;"></div>
          ${nextBtn}
        </div>
      `;
    }
  };
})();
