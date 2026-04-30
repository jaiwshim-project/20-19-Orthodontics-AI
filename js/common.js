/* ==============================================================
   20-19 Orthodontics AI — Common Scripts
   사이드바, 라우팅, 토스트, 환자 스토어, i18n 골격
   ============================================================== */

(function () {
  'use strict';

  // -------- Navigation Items --------
  const NAV_ITEMS = [
    { group: '홈', items: [
      { path: 'index.html', label: '대시보드 허브', icon: '🏠' }
    ]},
    { group: 'AI 진단', items: [
      { path: 'extraction-ai.html',     label: '발치 판단',         icon: '🦷' },
      { path: 'growth-prediction.html', label: '성장 예측',         icon: '📈' },
      { path: 'facial-simulation.html', label: '안모 시뮬레이션',   icon: '👤' },
      { path: 'recurrence-prediction.html', label: '재발 예측',     icon: '🔁' }
    ]},
    { group: '도구', items: [
      { path: '3d-viewer.html', label: '3D 뷰어 (EZL-STL)', icon: '🧊' },
      { path: 'chatbot.html',   label: 'RAG 챗봇',           icon: '💬' },
      { path: 'dashboard.html', label: '환자 대시보드',      icon: '📊' }
    ]},
    { group: '문서', items: [
      { path: 'manual.html',       label: '매뉴얼',     icon: '📖' },
      { path: 'architecture.html', label: '아키텍처',   icon: '🗺️' }
    ]}
  ];

  function getCurrentPath() {
    const p = window.location.pathname.split('/').pop();
    return p || 'index.html';
  }

  function renderShell() {
    const shell = document.getElementById('app-shell');
    if (!shell) return;
    const current = getCurrentPath();
    const navHtml = NAV_ITEMS.map(group => `
      <div class="group-label">${group.group}</div>
      ${group.items.map(item => `
        <a href="${item.path}" class="${item.path === current ? 'active' : ''}">
          <span style="font-size:16px;">${item.icon}</span>
          <span>${item.label}</span>
        </a>
      `).join('')}
    `).join('');

    const titleNode = NAV_ITEMS.flatMap(g => g.items).find(i => i.path === current);
    const title = titleNode ? titleNode.label : 'Orthodontics AI';

    shell.innerHTML = `
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">OA</div>
          <div>
            <div class="brand-name">Orthodontics AI</div>
            <div class="brand-sub">v0.1 · 20-19</div>
          </div>
        </div>
        <nav>${navHtml}</nav>
        <div style="margin-top:24px; padding:12px; background:rgba(255,255,255,0.03); border-radius:12px; font-size:12px; color: var(--text-muted);">
          <div id="patientChip" style="cursor:pointer;">👤 환자 정보 입력</div>
        </div>
      </aside>
      <header class="page-header">
        <div style="display:flex; align-items:center; gap:12px;">
          <button class="menu-toggle" onclick="window.toggleSidebar()" aria-label="메뉴">☰</button>
          <span class="title">${title}</span>
        </div>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" onclick="window.openPatientModal()">환자 변경</button>
          <select class="select btn-sm" id="langSelect" style="width:auto; padding:6px 10px;" onchange="window.setLang(this.value)">
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </div>
      </header>
      <div class="toast-stack" id="toastStack"></div>
    `;

    document.getElementById('langSelect').value = window.I18n.getLang();
    document.getElementById('patientChip').onclick = () => window.openPatientModal();
    refreshPatientChip();
  }

  // -------- Sidebar Toggle --------
  window.toggleSidebar = function () {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.toggle('open');
  };

  // -------- Routing Helper --------
  window.navigate = function (path) {
    window.location.href = path;
  };

  // -------- Toast --------
  window.toast = function (message, type = 'info', duration = 3000) {
    const stack = document.getElementById('toastStack');
    if (!stack) return console.log('[toast]', type, message);
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = message;
    stack.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transform = 'translateX(20px)';
      t.style.transition = 'all .25s';
      setTimeout(() => t.remove(), 250);
    }, duration);
  };

  // -------- Global Error Handler --------
  window.addEventListener('error', e => {
    if (e.message && !e.message.includes('ResizeObserver')) {
      window.toast(`오류: ${e.message}`, 'error', 4000);
    }
  });
  window.addEventListener('unhandledrejection', e => {
    window.toast(`Promise 오류: ${e.reason?.message || e.reason}`, 'error', 4000);
  });

  // -------- Patient Store --------
  const PATIENT_KEY = 'oa_patient';
  window.PatientStore = {
    set(p) {
      const enriched = { ...p };
      if (p.dob && !p.ageGroup) {
        const age = computeAge(p.dob);
        enriched.ageGroup = age <= 17 ? 'child' : 'adult';
        enriched.age = age;
      }
      enriched.updatedAt = new Date().toISOString();
      localStorage.setItem(PATIENT_KEY, JSON.stringify(enriched));
      refreshPatientChip();
      return enriched;
    },
    get() {
      try { return JSON.parse(localStorage.getItem(PATIENT_KEY) || 'null'); }
      catch { return null; }
    },
    clear() { localStorage.removeItem(PATIENT_KEY); refreshPatientChip(); }
  };

  function computeAge(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const diff = Date.now() - d.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
  }

  function refreshPatientChip() {
    const chip = document.getElementById('patientChip');
    if (!chip) return;
    const p = window.PatientStore.get();
    if (p && p.name) {
      const ageLabel = p.ageGroup === 'child' ? '어린이' : '성인';
      chip.innerHTML = `👤 <strong>${escapeHtml(p.name)}</strong> · ${p.age || '?'}세 · ${ageLabel}`;
    } else {
      chip.textContent = '👤 환자 정보 입력';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // -------- Patient Modal --------
  window.openPatientModal = function () {
    const existing = window.PatientStore.get() || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()">
        <h3>환자 정보 입력</h3>
        <p style="color:var(--text-muted); font-size:13px; margin-bottom:16px;">진단 결과는 입력된 환자에 종속됩니다.</p>
        <div class="field">
          <label>이름</label>
          <input class="input" id="pmName" value="${escapeHtml(existing.name || '')}" placeholder="홍길동">
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label>생년월일</label>
            <input class="input" type="date" id="pmDob" value="${existing.dob || ''}">
          </div>
          <div class="field">
            <label>연령 구분</label>
            <select class="select" id="pmAgeGroup">
              <option value="">자동 판정</option>
              <option value="child" ${existing.ageGroup === 'child' ? 'selected' : ''}>어린이 (≤17세)</option>
              <option value="adult" ${existing.ageGroup === 'adult' ? 'selected' : ''}>성인</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>성별</label>
          <select class="select" id="pmGender">
            <option value="">선택</option>
            <option value="male"   ${existing.gender === 'male' ? 'selected' : ''}>남성</option>
            <option value="female" ${existing.gender === 'female' ? 'selected' : ''}>여성</option>
            <option value="other"  ${existing.gender === 'other' ? 'selected' : ''}>기타</option>
          </select>
        </div>
        <div class="actions">
          <button class="btn btn-ghost" id="pmCancel">취소</button>
          <button class="btn btn-ghost" id="pmClear">초기화</button>
          <button class="btn btn-primary" id="pmSave">저장</button>
        </div>
      </div>
    `;
    backdrop.onclick = () => backdrop.remove();
    document.body.appendChild(backdrop);
    document.getElementById('pmCancel').onclick = () => backdrop.remove();
    document.getElementById('pmClear').onclick = () => { window.PatientStore.clear(); backdrop.remove(); window.toast('환자 정보를 초기화했습니다.', 'success'); };
    document.getElementById('pmSave').onclick = () => {
      const data = {
        name: document.getElementById('pmName').value.trim(),
        dob: document.getElementById('pmDob').value,
        ageGroup: document.getElementById('pmAgeGroup').value,
        gender: document.getElementById('pmGender').value
      };
      if (!data.name) { window.toast('이름을 입력하세요.', 'warning'); return; }
      window.PatientStore.set(data);
      backdrop.remove();
      window.toast('환자 정보가 저장되었습니다.', 'success');
    };
  };

  // -------- i18n (skeleton) --------
  const I18N_KEY = 'oa_lang';
  const DICT = {
    ko: { extract: '발치', non_extract: '비발치', borderline: '경계', save: '저장', cancel: '취소' },
    en: { extract: 'Extract', non_extract: 'Non-extract', borderline: 'Borderline', save: 'Save', cancel: 'Cancel' }
  };
  window.I18n = {
    getLang() { return localStorage.getItem(I18N_KEY) || 'ko'; },
    setLang(lang) { localStorage.setItem(I18N_KEY, lang); },
    t(key) { const lang = this.getLang(); return DICT[lang]?.[key] || DICT.ko[key] || key; }
  };
  window.setLang = function (lang) {
    window.I18n.setLang(lang);
    window.toast(`언어가 ${lang === 'ko' ? '한국어' : 'English'}로 변경되었습니다.`, 'info');
  };

  // -------- Init --------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderShell);
  } else {
    renderShell();
  }
})();
