/* ==============================================================
   DiagnosisStore — Supabase 우선 + localStorage 폴백
   진단 결과 저장/조회/상태 변경.
   ============================================================== */

(function () {
  const LS_KEY = 'oa_diagnoses_v1';

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { return []; }
  }
  function saveLocal(list) {
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, 500)));
  }

  window.DiagnosisStore = {
    /**
     * 진단 결과 저장 (Supabase 우선, 실패 시 localStorage).
     * @param {Object} payload { patient, type, inputs, result, imagesMeta, notes }
     */
    async save(payload) {
      try {
        const res = await window.apiFetch('/api/save-diagnosis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.fallback || data.source === 'local') {
          // Supabase 미연결 → localStorage에 저장
          const record = data.record || {
            id: 'local_' + Date.now(),
            ...payload,
            created_at: new Date().toISOString()
          };
          const list = loadLocal();
          list.unshift(record);
          saveLocal(list);
          return { success: true, source: 'local', id: record.id, record };
        }
        return data;
      } catch (e) {
        console.warn('[DiagnosisStore] API 실패, localStorage 사용:', e.message);
        const record = {
          id: 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          ...payload,
          created_at: new Date().toISOString()
        };
        const list = loadLocal();
        list.unshift(record);
        saveLocal(list);
        return { success: true, source: 'local-only', id: record.id, record };
      }
    },

    /**
     * 진단 목록 조회 (Supabase 우선 + localStorage 머지).
     */
    async list({ type = null, limit = 100 } = {}) {
      const localList = loadLocal();
      const localFiltered = type ? localList.filter(r => r.type === type) : localList;

      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (type) params.set('type', type);
        const res = await window.apiFetch(`/api/get-diagnoses?${params}`);
        const data = await res.json();
        const remote = (data.records || []).map(normalizeRemote);
        if (data.fallback) return { source: 'local', records: localFiltered.slice(0, limit) };
        // 머지: 로컬 + 원격 (중복 id 제거)
        const ids = new Set(remote.map(r => r.id));
        const merged = [...remote, ...localFiltered.filter(r => !ids.has(r.id))]
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .slice(0, limit);
        return { source: 'mixed', records: merged };
      } catch (e) {
        console.warn('[DiagnosisStore] 조회 실패, 로컬만 반환:', e.message);
        return { source: 'local-only', records: localFiltered.slice(0, limit) };
      }
    },

    /**
     * 진단 단건 조회.
     */
    async get(id) {
      // 로컬 ID인 경우
      if (String(id).startsWith('local_')) {
        const list = loadLocal();
        const found = list.find(r => r.id === id);
        return found ? { source: 'local', record: found } : null;
      }
      try {
        const res = await window.apiFetch(`/api/get-diagnoses?id=${encodeURIComponent(id)}`);
        const data = await res.json();
        if (data.record) return { source: 'supabase', record: normalizeRemote(data.record) };
        return null;
      } catch (e) {
        console.warn('[DiagnosisStore] get 실패:', e.message);
        return null;
      }
    },

    /**
     * 상태 변경 (accepted / rejected / reviewed / archived).
     */
    async updateStatus(id, status, doctorNote) {
      // 로컬 레코드
      if (String(id).startsWith('local_')) {
        const list = loadLocal();
        const idx = list.findIndex(r => r.id === id);
        if (idx < 0) return { success: false };
        list[idx].result = list[idx].result || {};
        list[idx].result.status = status;
        list[idx].result.status_changed_at = new Date().toISOString();
        if (doctorNote !== undefined) list[idx].result.doctor_note = doctorNote;
        saveLocal(list);
        return { success: true, source: 'local', record: list[idx] };
      }
      try {
        const res = await window.apiFetch('/api/update-diagnosis', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status, doctor_note: doctorNote })
        });
        const data = await res.json();
        return data;
      } catch (e) {
        return { success: false, error: e.message };
      }
    },

    /**
     * 로컬 모든 진단 삭제 (개발용).
     */
    clearLocal() {
      localStorage.removeItem(LS_KEY);
    }
  };

  function normalizeRemote(row) {
    if (!row) return row;
    return {
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      inputs: row.inputs || {},
      result: row.result || {},
      patient: row.patients
        ? {
            id: row.patients.id,
            name: row.patients.name,
            ageGroup: row.patients.age_group,
            gender: row.patients.gender,
            dob: row.patients.dob
          }
        : (row.patient || null),
      patient_id: row.patient_id
    };
  }
})();
