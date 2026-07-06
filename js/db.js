// db.js — IndexedDB 草稿存储 + localStorage 预设
// v2: keyPath 改为 id，支持最多 6 条草稿

const DB_NAME = 'inspection-tool';
const DB_VERSION = 2;
const STORE_NAME = 'drafts';
const MAX_DRAFTS = 6;

// ---------- ID 生成 ----------

function generateId() {
  return 'draft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
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
    company: '广西糖业集团红河制糖有限公司',
    department: '压榨车间'
  };
}

function savePresets(presets) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

function getTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export { saveDraft, getDraft, deleteDraft, listDrafts, getBackupInfo, getPresets, savePresets, getTodayStr, MAX_DRAFTS, migrateFromV1 };
