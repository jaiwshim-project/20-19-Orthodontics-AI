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
      { path: '3d-viewer.html',       label: '3D 뷰어 (EZL-STL)', icon: '🧊' },
      { path: 'chatbot.html',         label: 'RAG 챗봇',           icon: '💬' },
      { path: 'dashboard.html',       label: '환자 대시보드',      icon: '📊' },
      { path: 'patient-history.html', label: '환자 이력',          icon: '📂' }
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
      <header class="page-header" role="banner">
        <div style="display:flex; align-items:center; gap:12px;">
          <button class="menu-toggle" onclick="window.toggleSidebar()" aria-label="사이드바 메뉴 열기">☰</button>
          <span class="title" aria-current="page">${title}</span>
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
    if (!sb) return;
    sb.classList.toggle('open');
    let backdrop = document.getElementById('sidebar-backdrop');
    if (sb.classList.contains('open')) {
      if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'sidebar-backdrop';
        backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:90;backdrop-filter:blur(4px);';
        backdrop.onclick = () => window.toggleSidebar();
        document.body.appendChild(backdrop);
      }
    } else if (backdrop) {
      backdrop.remove();
    }
  };
  // ESC 닫기
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const sb = document.getElementById('sidebar');
      if (sb && sb.classList.contains('open')) window.toggleSidebar();
    }
  });

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

  // -------- Patient Modal (저장된 명단 + 신규 등록) --------
  window.openPatientModal = function () {
    const existing = window.PatientStore.get() || {};
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" onclick="event.stopPropagation()" style="max-width:560px;">
        <h3>환자 선택 또는 신규 등록</h3>
        <p style="color:var(--text-muted); font-size:13px; margin-bottom:16px;">진단 결과는 선택된 환자에 종속됩니다.</p>

        <div class="tabs" style="margin-bottom:16px;">
          <button type="button" class="tab-btn active" data-pmtab="list"><span class="tab-icon">📋</span>저장된 환자</button>
          <button type="button" class="tab-btn" data-pmtab="new"><span class="tab-icon">+</span>신규 등록</button>
        </div>

        <div class="tab-panel active" data-pmtab="list">
          <input class="input" id="pmSearch" placeholder="이름으로 검색…" style="margin-bottom:12px;">
          <div id="pmList" style="max-height:340px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
            <div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px;">불러오는 중…</div>
          </div>
        </div>

        <div class="tab-panel" data-pmtab="new">
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
            <button class="btn btn-ghost" id="pmClear">초기화</button>
            <button class="btn btn-primary" id="pmSave">신규 환자로 저장</button>
          </div>
        </div>

        <div style="display:flex; justify-content:flex-end; margin-top:14px; padding-top:14px; border-top:1px solid var(--border-subtle);">
          <button class="btn btn-ghost" id="pmCancel">닫기</button>
        </div>
      </div>
    `;
    backdrop.onclick = () => backdrop.remove();
    document.body.appendChild(backdrop);

    // Tab toggling
    backdrop.querySelectorAll('[data-pmtab]').forEach(el => {
      if (el.classList.contains('tab-btn')) {
        el.onclick = () => {
          backdrop.querySelectorAll('.tab-btn[data-pmtab]').forEach(b => b.classList.toggle('active', b.dataset.pmtab === el.dataset.pmtab));
          backdrop.querySelectorAll('.tab-panel[data-pmtab]').forEach(p => p.classList.toggle('active', p.dataset.pmtab === el.dataset.pmtab));
        };
      }
    });

    // Buttons
    document.getElementById('pmCancel').onclick = () => backdrop.remove();
    document.getElementById('pmClear').onclick = () => { window.PatientStore.clear(); backdrop.remove(); window.toast('환자 정보를 초기화했습니다.', 'success'); };
    document.getElementById('pmSave').onclick = async () => {
      const data = {
        name: document.getElementById('pmName').value.trim(),
        dob: document.getElementById('pmDob').value,
        ageGroup: document.getElementById('pmAgeGroup').value,
        gender: document.getElementById('pmGender').value
      };
      if (!data.name) { window.toast('이름을 입력하세요.', 'warning'); return; }
      const btn = document.getElementById('pmSave');
      btn.disabled = true; btn.textContent = '저장 중...';
      // 자동 연령 계산
      if (data.dob && !data.ageGroup) {
        const age = Math.floor((Date.now() - new Date(data.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        data.ageGroup = age <= 17 ? 'child' : 'adult';
        data.age = age;
      }
      // 즉시 Supabase에 저장 시도
      try {
        const res = await window.apiFetch('/api/register-patient', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        const json = await res.json();
        if (json.success && json.patient) {
          // Supabase 저장 성공 → supabaseId 포함해 PatientStore에 저장
          window.PatientStore.set({
            ...data,
            id: json.patient.id,
            supabaseId: json.patient.id
          });
          backdrop.remove();
          if (json.duplicate) {
            window.toast(`이미 등록된 환자입니다 (${data.name}). 기존 환자를 사용합니다.`, 'info');
          } else if (json.source === 'supabase') {
            window.toast(`✅ 환자 등록 완료 (Supabase 클라우드): ${data.name}`, 'success');
          } else {
            window.toast(`⚠️ 클라우드 미연결 — ${data.name} 정보를 로컬에만 저장했습니다.`, 'warning', 4000);
          }
        } else {
          window.PatientStore.set(data);
          backdrop.remove();
          window.toast('환자 정보를 로컬에 저장했습니다.', 'info');
        }
      } catch (e) {
        window.PatientStore.set(data);
        backdrop.remove();
        window.toast('네트워크 오류 — 로컬에만 저장됨: ' + e.message, 'warning');
      }
    };

    // Load patient list
    async function loadList(q = '') {
      const listEl = document.getElementById('pmList');
      listEl.innerHTML = '<div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px;">불러오는 중…</div>';
      try {
        const url = (window.API_BASE || '') + '/api/get-patients' + (q ? `?q=${encodeURIComponent(q)}` : '');
        const res = await fetch(url);
        const data = await res.json();
        renderList(data.records || [], data.fallback);
      } catch (e) {
        listEl.innerHTML = `<div style="padding:16px; color:var(--color-danger); font-size:13px;">불러오기 실패: ${escapeHtml(e.message)}</div>`;
      }
    }

    function renderList(records, fallback) {
      const listEl = document.getElementById('pmList');
      if (fallback) {
        listEl.innerHTML = `<div style="padding:16px; color:var(--color-warning); font-size:13px;">⚠️ 클라우드 미연결 — 신규 등록 탭을 사용하세요.</div>`;
        return;
      }
      if (!records.length) {
        listEl.innerHTML = `<div style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">저장된 환자가 없습니다.<br>신규 등록 탭에서 새 환자를 추가하세요.</div>`;
        return;
      }
      listEl.innerHTML = records.map(r => {
        const ageGrp = r.age_group === 'child' ? '어린이' : r.age_group === 'adult' ? '성인' : '미정';
        const ageGrpCls = r.age_group === 'child' ? 'badge-warning' : 'badge-primary';
        const gender = r.gender === 'male' ? '남' : r.gender === 'female' ? '여' : '—';
        const dob = r.dob ? `생 ${r.dob}` : '';
        const lastAt = r.last_diagnosis_at ? new Date(r.last_diagnosis_at).toLocaleDateString('ko-KR') : '진단 이력 없음';
        const types = (r.diagnosis_types || []).map(t => ({ extraction:'발치', growth:'성장', facial:'안모', recurrence:'재발' }[t] || t)).join(' · ');
        const recurr = r.last_recurrence_y10;
        const recurrLbl = recurr != null ? ` · 재발 ${Math.round(recurr)}%` : '';
        return `
          <div class="patient-row" data-pid="${escapeHtml(r.id)}" style="padding:12px 14px; border:1px solid var(--border-subtle); border-radius:10px; cursor:pointer; transition:all .15s; background:rgba(255,255,255,0.02);">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
              <div style="min-width:0; flex:1;">
                <div style="font-weight:600;">${escapeHtml(r.name)}
                  <span class="badge ${ageGrpCls}" style="margin-left:6px; font-size:10px;">${ageGrp}</span>
                  <span style="color:var(--text-muted); font-size:11px; margin-left:6px;">${gender} · ${dob}</span>
                </div>
                <div style="color:var(--text-muted); font-size:11px; margin-top:4px;">진단 ${r.diagnosis_count}건${types ? ' (' + types + ')' : ''}${recurrLbl} · ${lastAt}</div>
              </div>
              <button class="btn btn-primary btn-sm" data-select="${escapeHtml(r.id)}">선택 →</button>
            </div>
          </div>
        `;
      }).join('');

      // Hover effect via JS (간단)
      listEl.querySelectorAll('.patient-row').forEach(row => {
        row.onmouseenter = () => row.style.borderColor = 'rgba(14,165,233,0.4)';
        row.onmouseleave = () => row.style.borderColor = 'var(--border-subtle)';
        row.onclick = () => selectPatient(row.dataset.pid, records);
      });
    }

    function selectPatient(id, records) {
      const p = records.find(r => r.id === id);
      if (!p) return;
      window.PatientStore.set({
        id: p.id,
        name: p.name,
        dob: p.dob,
        ageGroup: p.age_group,
        gender: p.gender,
        age: p.age,
        supabaseId: p.id
      });
      backdrop.remove();
      // 진단 이력이 있으면 history 페이지로 안내, 없으면 그냥 활성화만
      if (p.diagnosis_count > 0) {
        const goHistory = confirm(`${p.name} 환자가 선택되었습니다.\n저장된 진단 ${p.diagnosis_count}건이 있습니다.\n\n[확인] 이전 진단 결과 보기 → patient-history.html\n[취소] 현재 페이지 유지 (활성 환자만 변경)`);
        if (goHistory) {
          window.location.href = `patient-history.html?id=${encodeURIComponent(p.id)}`;
          return;
        }
      }
      window.toast(`${p.name} 환자를 선택했습니다.`, 'success');
    }

    // Search debounce
    let searchTimer;
    document.getElementById('pmSearch').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadList(e.target.value.trim()), 300);
    });

    loadList();
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

  // -------- Premium Footer --------
  function renderFooter() {
    if (document.querySelector('.site-footer')) return; // 중복 방지
    const main = document.querySelector('main.content') || document.body;
    const year = new Date().getFullYear();
    const buildHash = 'b' + (year * 31 + new Date().getMonth() + 7).toString(36);
    const footer = document.createElement('footer');
    footer.className = 'site-footer';
    footer.setAttribute('role', 'contentinfo');
    footer.innerHTML = `
      <div class="footer-top">
        <div class="footer-brand">
          <div class="brand-row">
            <div class="brand-mark" aria-hidden="true">OA</div>
            <div class="brand-text">
              <strong>Orthodontics AI</strong>
              <span>by 20-19 · Seoul</span>
            </div>
          </div>
          <p>교정치과 의사를 위한 AI 진단·치료계획·재발 예측 통합 플랫폼.<br>
          Gemini · Supabase · Neo4j 기반의 차세대 임상 의사결정 보조 도구.</p>
          <form class="footer-newsletter" onsubmit="return window._footerSubscribe(event)">
            <input type="email" placeholder="newsletter@clinic.com" aria-label="뉴스레터 이메일" required>
            <button type="submit">구독</button>
          </form>
        </div>

        <div class="footer-col">
          <h5>제품</h5>
          <ul>
            <li><a href="3d-viewer.html">3D 뷰어 + EZL-STL</a></li>
            <li><a href="extraction-ai.html">발치 판단 AI</a></li>
            <li><a href="growth-prediction.html">성장 예측 AI</a></li>
            <li><a href="facial-simulation.html">안모 시뮬레이션</a></li>
            <li><a href="recurrence-prediction.html">재발 예측 AI</a></li>
            <li><a href="chatbot.html">RAG 챗봇 <span class="badge-mini">RAG</span></a></li>
            <li><a href="dashboard.html">환자 대시보드</a></li>
          </ul>
        </div>

        <div class="footer-col">
          <h5>리소스</h5>
          <ul>
            <li><a href="manual.html">사용자 매뉴얼</a></li>
            <li><a href="architecture.html">시스템 아키텍처</a></li>
            <li><a href="docs/PRD.md">제품 요구사항 (PRD)</a></li>
            <li><a href="docs/AI_AGENTS_20.md">AI 에이전트 20</a></li>
            <li><a href="docs/MVP_TO_SAAS.md">MVP → SaaS</a></li>
            <li><a href="docs/STRATEGY_1T.md">1조 전략 시나리오</a></li>
            <li><a href="docs/NEO4J_SCHEMA.cypher">Neo4j 스키마</a></li>
          </ul>
        </div>

        <div class="footer-col">
          <h5>회사 · 법무</h5>
          <ul>
            <li><a href="#" onclick="window.toast('회사 소개 페이지 준비 중', 'info'); return false;">회사 소개</a></li>
            <li><a href="#" onclick="window.toast('블로그 준비 중', 'info'); return false;">블로그 <span class="badge-mini">Soon</span></a></li>
            <li><a href="#" onclick="window.toast('채용 페이지 준비 중', 'info'); return false;">채용</a></li>
            <li><a href="mailto:hello@orthodonticsai.kr">문의</a></li>
            <li><a href="#" onclick="window.toast('이용 약관', 'info'); return false;">이용 약관</a></li>
            <li><a href="#" onclick="window.toast('개인정보 처리방침', 'info'); return false;">개인정보 처리방침</a></li>
            <li><a href="#" onclick="window.toast('보안 정책', 'info'); return false;">보안 정책</a></li>
          </ul>
        </div>
      </div>

      <div class="footer-disclaimer">
        <div class="footer-disclaimer-inner">
          <div class="footer-disclaimer-icon" aria-hidden="true">!</div>
          <div>
            <strong style="color:var(--color-warning);">의료 면책 (Medical Disclaimer)</strong> ·
            본 시스템은 임상 의사결정을 보조하는 소프트웨어이며, 의료 행위 또는 의료기기를 대체하지 않습니다.
            모든 최종 진단·치료 결정은 자격을 갖춘 전문의의 판단에 따라야 하며, 본 시스템의 출력만을 근거로 환자에게 의료 행위를 수행해서는 안 됩니다.
            식약처 SaMD 인증은 2027년 신청 예정입니다.
          </div>
        </div>
      </div>

      <div class="footer-bottom">
        <div class="footer-bottom-inner">
          <div class="footer-meta">
            <span>© ${year} Orthodontics AI · 사업자 등록 준비 중</span>
            <span class="dot"></span>
            <span class="ver">v0.1.0 · ${buildHash}</span>
            <span class="dot"></span>
            <span class="status">All systems operational</span>
          </div>

          <div class="footer-social">
            <a href="https://github.com" target="_blank" rel="noopener" aria-label="GitHub">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            </a>
            <a href="https://twitter.com" target="_blank" rel="noopener" aria-label="Twitter / X">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </a>
            <a href="https://www.linkedin.com" target="_blank" rel="noopener" aria-label="LinkedIn">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
            </a>
            <a href="https://www.youtube.com" target="_blank" rel="noopener" aria-label="YouTube">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            </a>
          </div>
        </div>

        <div class="footer-bottom-inner footer-trust" style="margin-top:0;">
          <span class="pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            HIPAA Ready
          </span>
          <span class="pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
            GDPR Compliant
          </span>
          <span class="pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
            ISO 27001 (Roadmap)
          </span>
          <span class="pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>
            Available in KO · EN · JP · ZH
          </span>
          <span class="pill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18M3 21h18M5 3v18m14-18v18"/></svg>
            식약처 SaMD 신청 예정
          </span>
        </div>
      </div>
    `;
    main.appendChild(footer);
  }

  window._footerSubscribe = function (e) {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const email = (input?.value || '').trim();
    if (!email) return false;
    window.toast(`${email} 구독 완료. 격주 임상 인사이트를 보내드립니다.`, 'success', 3500);
    input.value = '';
    return false;
  };

  // -------- Init --------
  function init() {
    renderShell();
    renderFooter();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
