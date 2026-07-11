// db.js — IndexedDB 草稿存储 + localStorage 预设 + 模板管理 + 检查清单 + 报告历史
// v5: 新增 reports store

const DB_NAME = 'inspection-tool-pro';
const DB_VERSION = 5;
const STORE_NAME = 'drafts';
const TEMPLATE_STORE = 'templates';
const CHECKLIST_STORE = 'checklists';
const REPORT_STORE = 'reports';
const MAX_DRAFTS = 6;
const MAX_REPORTS = 20;

// 防抖备份：数据变更后 2 秒自动备份到 localStorage
let _backupTimer = null;
function scheduleBackup() {
  if (_backupTimer) clearTimeout(_backupTimer);
  _backupTimer = setTimeout(() => backupAllToLocalStorage().catch(() => {}), 2000);
}

// ---------- ID 生成 ----------

function generateId() {
  return 'draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function generateTemplateId() {
  return 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

// ---------- IndexedDB ----------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;

      if (oldVersion < 1) {
        // 首次创建：直接用新 schema (keyPath: id)
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }

      if (oldVersion === 1) {
        // v1 → v2：删除旧 store (keyPath: type)，创建新 store (keyPath: id)
        // 旧数据已在 migrateFromV1() 中提前备份
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }

      if (oldVersion < 3) {
        // v2 → v3：新增模板存储
        if (!db.objectStoreNames.contains(TEMPLATE_STORE)) {
          db.createObjectStore(TEMPLATE_STORE, { keyPath: 'id' });
        }
      }

      if (oldVersion < 4) {
        // v3 → v4：新增检查清单存储
        if (!db.objectStoreNames.contains(CHECKLIST_STORE)) {
          db.createObjectStore(CHECKLIST_STORE, { keyPath: 'id' });
        }
      }

      if (oldVersion < 5) {
        // v4 → v5：新增报告历史存储
        if (!db.objectStoreNames.contains(REPORT_STORE)) {
          db.createObjectStore(REPORT_STORE, { keyPath: 'id' });
        }
      }
    };

    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

// v1 → v2 迁移辅助：在 openDB 升级之前读取旧数据
async function migrateFromV1() {
  if (localStorage.getItem('draft_migration_done') === 'v2') return;

  try {
    const v1Data = await readV1Data();
    if (v1Data.length > 0) {
      const db = await openDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const old of v1Data) {
        store.put({
          id: generateId(),
          type: old.type,
          data: old.data,
          updatedAt: old.updatedAt || Date.now(),
        });
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
      });
      db.close();
    }
    localStorage.setItem('draft_migration_done', 'v2');
  } catch (e) {
    console.warn('[DB] v1→v2 迁移失败（如无旧数据可忽略）:', e.message);
    localStorage.setItem('draft_migration_done', 'v2');
  }
}

// 在升级前用 v1 连接读取旧数据
function readV1Data() {
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve([]);
        return;
      }
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          db.close();
          resolve(getAllReq.result || []);
        };
        getAllReq.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch (err) {
        db.close();
        resolve([]);
      }
    };
    req.onerror = () => resolve([]);
  });
}

async function saveDraft(type, data, existingId) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const draft = {
    id: existingId || generateId(),
    type,
    data,
    updatedAt: Date.now(),
  };

  store.put(draft);

  // 限制最多 MAX_DRAFTS 条
  const all = await new Promise((resolve, reject) => {
    const getAllReq = store.getAll();
    getAllReq.onsuccess = () => resolve(getAllReq.result || []);
    getAllReq.onerror = (e) => reject(e.target.error);
  });

  if (all.length > MAX_DRAFTS) {
    const sorted = all.sort((a, b) => a.updatedAt - b.updatedAt);
    const toDelete = sorted.slice(0, all.length - MAX_DRAFTS);
    for (const d of toDelete) {
      store.delete(d.id);
    }
  }

  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      // 每次保存后自动备份到 localStorage（防浏览器清空 IndexedDB）
      try {
        const backup = (all.length <= MAX_DRAFTS ? all : all.slice(-MAX_DRAFTS)).map(d => ({
          id: d.id, type: d.type, updatedAt: d.updatedAt,
          itemCount: d.data?.items?.length || 0,
        }));
        localStorage.setItem('drafts_backup', JSON.stringify(backup));
        localStorage.setItem('drafts_backup_time', String(Date.now()));
      } catch (e) { /* localStorage 满则跳过 */ }
      resolve(draft.id);
    };
    tx.onerror = (e) => reject(e.target.error);
  });
}

// 读取备份（用于检测数据丢失）
function getBackupInfo() {
  try {
    const raw = localStorage.getItem('drafts_backup');
    if (!raw) return null;
    const backup = JSON.parse(raw);
    const time = localStorage.getItem('drafts_backup_time');
    return { drafts: backup, time: time ? Number(time) : 0 };
  } catch (e) { return null; }
}

async function getDraft(id) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ? req.result.data : null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function deleteDraft(id) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.delete(id);
  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = async () => {
      // 刷新备份
      try {
        const all = await listDrafts();
        const backup = all.map(d => ({
          id: d.id, type: d.type, updatedAt: d.updatedAt,
          itemCount: d.data?.items?.length || 0,
        }));
        localStorage.setItem('drafts_backup', JSON.stringify(backup));
      } catch (e) { /* ignore */ }
      resolve();
    };
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function listDrafts() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result = req.result || [];
      result.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(result);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

// ---------- localStorage ----------

const PRESETS_KEY = 'inspection-presets';

function getPresets() {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return {
    company: '',
    department: '',
    departments: [],
  };
}

function savePresets(presets) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

/** 添加部门到预设列表（去重） */
function addDepartmentPreset(dept) {
  const p = getPresets();
  if (!p.departments) p.departments = [];
  if (dept && !p.departments.includes(dept)) {
    p.departments.push(dept);
    savePresets(p);
  }
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 模板管理 ----------

async function saveTemplate(templateData) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readwrite');
  const store = tx.objectStore(TEMPLATE_STORE);

  const record = {
    id: templateData.id || generateTemplateId(),
    name: templateData.name,
    industry: templateData.industry || '通用',
    description: templateData.description || '',
    source: templateData.source || 'imported',
    isBuiltin: templateData.isBuiltin || false,
    data: templateData.data || templateData,
    createdAt: templateData.createdAt || new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  store.put(record);

  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function deleteTemplate(id) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readwrite');
  const store = tx.objectStore(TEMPLATE_STORE);
  store.delete(id);
  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getCustomTemplate(id) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readonly');
  const store = tx.objectStore(TEMPLATE_STORE);
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function listCustomTemplates() {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readonly');
  const store = tx.objectStore(TEMPLATE_STORE);
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result = req.result || [];
      result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      resolve(result);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/** 将模板导出为 .json 文件下载 */
function exportTemplateAsFile(templateRecord) {
  const jsonStr = JSON.stringify(templateRecord.data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${templateRecord.name}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- 检查清单 ----------

async function saveChecklist(name, items) {
  const db = await openDB();
  const tx = db.transaction(CHECKLIST_STORE, 'readwrite');
  const store = tx.objectStore(CHECKLIST_STORE);
  const record = {
    id: 'cl_' + Date.now(),
    name,
    items: items || [],
    updatedAt: Date.now(),
  };
  store.put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function listChecklists() {
  const db = await openDB();
  const tx = db.transaction(CHECKLIST_STORE, 'readonly');
  const store = tx.objectStore(CHECKLIST_STORE);
  const req = store.getAll();
  return new Promise((resolve) => {
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.updatedAt - a.updatedAt));
    req.onerror = () => resolve([]);
  });
}

async function deleteChecklist(id) {
  const db = await openDB();
  const tx = db.transaction(CHECKLIST_STORE, 'readwrite');
  const store = tx.objectStore(CHECKLIST_STORE);
  store.delete(id);
  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---------- 报告历史 ----------

async function saveReport(reportData) {
  const db = await openDB();
  const tx = db.transaction(REPORT_STORE, 'readwrite');
  const store = tx.objectStore(REPORT_STORE);

  const record = {
    id: 'rpt_' + Date.now(),
    type: reportData.type,
    typeName: reportData.typeName,
    items: reportData.items,
    headerInfo: reportData.headerInfo,
    itemCount: reportData.items?.length || 0,
    createdAt: new Date().toISOString(),
  };

  store.put(record);

  // 限制最多 MAX_REPORTS 条
  const all = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });

  if (all.length > MAX_REPORTS) {
    const sorted = all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const r of sorted.slice(0, all.length - MAX_REPORTS)) {
      store.delete(r.id);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function listReports() {
  const db = await openDB();
  const tx = db.transaction(REPORT_STORE, 'readonly');
  const store = tx.objectStore(REPORT_STORE);
  const req = store.getAll();
  return new Promise((resolve) => {
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
    req.onerror = () => resolve([]);
  });
}

async function deleteReport(id) {
  const db = await openDB();
  const tx = db.transaction(REPORT_STORE, 'readwrite');
  const store = tx.objectStore(REPORT_STORE);
  store.delete(id);
  scheduleBackup();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ---------- 全量数据备份/恢复 ----------

const BACKUP_KEY = 'itp_full_backup';

/** 备份所有数据到 localStorage（每次写操作后自动调用） */
async function backupAllToLocalStorage() {
  try {
    const [drafts, templates, checklists, reports] = await Promise.all([
      listDrafts().catch(() => []),
      listCustomTemplates().catch(() => []),
      listChecklists().catch(() => []),
      listReports().catch(() => []),
    ]);
    // 也带上激活状态
    const activation = localStorage.getItem('_iap_v') || '';
    const backup = {
      version: 1,
      time: Date.now(),
      drafts: drafts.map(d => ({ id: d.id, type: d.type, updatedAt: d.updatedAt, itemCount: d.data?.items?.length || 0 })),
      templates: templates.map(t => ({ id: t.id, name: t.name, industry: t.industry, updatedAt: t.updatedAt })),
      checklists: checklists.map(c => ({ id: c.id, name: c.name, itemCount: c.items?.length || 0 })),
      reports: reports.map(r => ({ id: r.id, type: r.type, typeName: r.typeName, itemCount: r.itemCount, createdAt: r.createdAt })),
      activation,
    };
    localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
  } catch (e) { /* localStorage 满则跳过 */ }
}

/** 获取备份信息（用于检测数据是否丢失） */
function getFullBackupInfo() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/** 导出全部数据为 JSON 文件（包含完整内容，不只是摘要） */
async function exportAllDataAsFile() {
  const [drafts, templates, checklists, reports] = await Promise.all([
    listDrafts().catch(() => []),
    listCustomTemplates().catch(() => []),
    listChecklists().catch(() => []),
    listReports().catch(() => []),
  ]);
  const presets = getPresets();
  const activation = localStorage.getItem('_iap_v') || '';

  const exportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    presets,
    activation,
    drafts,
    templates,
    checklists,
    reports,
  };

  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `检查工具Pro_数据备份_${getTodayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 从 JSON 文件导入全部数据 */
async function importAllDataFromFile(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('文件格式不正确，无法解析'); }

  if (!data.version) throw new Error('备份文件格式不兼容（缺少 version 字段）');

  const db = await openDB();
  let imported = { drafts: 0, templates: 0, checklists: 0, reports: 0 };

  // 恢复预设
  if (data.presets) savePresets(data.presets);

  // 恢复激活状态
  if (data.activation) localStorage.setItem('_iap_v', data.activation);

  // 恢复模板（内置模板不覆盖）
  if (data.templates && data.templates.length > 0) {
    const tx = db.transaction(TEMPLATE_STORE, 'readwrite');
    const store = tx.objectStore(TEMPLATE_STORE);
    for (const t of data.templates) {
      if (t.id && !t.id.startsWith('tpl_')) continue; // 跳过内置模板
      store.put(t);
      imported.templates++;
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
  }

  // 恢复检查清单
  if (data.checklists && data.checklists.length > 0) {
    const tx = db.transaction(CHECKLIST_STORE, 'readwrite');
    const store = tx.objectStore(CHECKLIST_STORE);
    for (const c of data.checklists) { store.put(c); imported.checklists++; }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
  }

  // 恢复报告历史
  if (data.reports && data.reports.length > 0) {
    const tx = db.transaction(REPORT_STORE, 'readwrite');
    const store = tx.objectStore(REPORT_STORE);
    for (const r of data.reports) { store.put(r); imported.reports++; }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
  }

  // 恢复草稿
  if (data.drafts && data.drafts.length > 0) {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const d of data.drafts) { store.put(d); imported.drafts++; }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
  }

  db.close();

  // 刷新自定义模板缓存
  try {
    const { loadCustomTemplates } = await import('../templates/templates.js');
    await loadCustomTemplates();
  } catch (e) { /* ignore */ }

  return imported;
}

export { saveDraft, getDraft, deleteDraft, listDrafts, getBackupInfo, getPresets, savePresets, addDepartmentPreset, getTodayStr, MAX_DRAFTS, migrateFromV1, saveTemplate, deleteTemplate, getCustomTemplate, listCustomTemplates, exportTemplateAsFile, saveChecklist, listChecklists, deleteChecklist, saveReport, listReports, deleteReport, backupAllToLocalStorage, getFullBackupInfo, exportAllDataAsFile, importAllDataFromFile };
