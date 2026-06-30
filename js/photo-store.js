/* ==============================================================
   Photo Store — 진단 워크플로우 공유 이미지 저장소
   IndexedDB 기반. 1단계에서 저장, 2~4단계에서 읽기.
   ============================================================== */

(function () {
  'use strict';

  const DB_NAME = 'oa_photo_store';
  const DB_VERSION = 1;
  const STORE = 'photos';
  const SESSION_KEY = 'current_case';

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function base64ToBlob(dataUrl) {
    if (!dataUrl) return null;
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)?.[1] || 'image/jpeg';
    const binary = atob(data);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /**
   * 현재 케이스 사진 세트 저장
   * @param {Object} data - { patient, photos: { frontal, rightLateral, leftLateral, upperOcclusal, lowerOcclusal, ceph, pm, other }, ... }
   * photos 값은 { base64, name, type } 형태
   */
  async function saveCase(data) {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...data, savedAt: Date.now() }, SESSION_KEY);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
    try {
      const patientName = String(data?.patient?.name || '');
      if (data?.patient) localStorage.setItem('oa_step1_patient_info', JSON.stringify({ ...data.patient, savedAt: Date.now(), source: data.source || data.patient.source || 'photo-store' }));
      if (data?.source === 'supabase-yoon-sohee' || patientName.includes('\uC724\uC18C\uD76C')) {
        localStorage.setItem('oa_yoon_sohee_sample_ready', '1');
        localStorage.setItem('oa_yoon_sohee_sample_saved_at', String(Date.now()));
      } else {
        // \uB2E4\uB978 \uD658\uC790 \uC800\uC7A5 \uC2DC \uC724\uC18C\uD76C \uD50C\uB798\uADF8 \uC81C\uAC70
        localStorage.removeItem('oa_yoon_sohee_sample_ready');
        localStorage.removeItem('oa_yoon_sohee_sample_saved_at');
      }
    } catch {}
  }

  /**
   * 현재 케이스 사진 세트 읽기
   * @returns {Object|null}
   */
  async function loadCase() {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(SESSION_KEY);
    const result = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    db.close();
    if (!result) return null;
    try {
      if (result.patient) localStorage.setItem('oa_step1_patient_info', JSON.stringify({ ...result.patient, savedAt: result.savedAt || Date.now(), source: result.source || result.patient.source || 'photo-store' }));
    } catch {}
    return result;
  }

  /**
   * 특정 사진 키의 Blob 가져오기
   */
  async function getPhotoBlob(key) {
    const data = await loadCase();
    if (!data || !data.photos || !data.photos[key]) return null;
    return base64ToBlob(data.photos[key].base64);
  }

  /**
   * 특정 사진 키의 File 가져오기
   */
  async function getPhotoFile(key) {
    const data = await loadCase();
    if (!data || !data.photos || !data.photos[key]) return null;
    const entry = data.photos[key];
    const blob = base64ToBlob(entry.base64);
    if (!blob) return null;
    return new File([blob], entry.name || `${key}.jpg`, { type: blob.type });
  }

  /**
   * 모든 사진을 File 객체로 반환
   */
  async function getAllPhotoFiles() {
    const data = await loadCase();
    if (!data || !data.photos) return {};
    const result = {};
    for (const [key, entry] of Object.entries(data.photos)) {
      if (!entry || !entry.base64) continue;
      const blob = base64ToBlob(entry.base64);
      if (blob) result[key] = new File([blob], entry.name || `${key}.jpg`, { type: blob.type });
    }
    return result;
  }

  async function clearCase() {
    const db = await openDB();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(SESSION_KEY);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  }

  window.PhotoStore = {
    saveCase,
    loadCase,
    getPhotoBlob,
    getPhotoFile,
    getAllPhotoFiles,
    clearCase,
    fileToBase64,
    base64ToBlob
  };
})();
