// templates.js — 模板注册表（内置 + 自定义）
// 导出所有内置模板，支持按 id 查找，同时合并 IndexedDB 自定义模板

import universal from './universal.json' with { type: 'json' };

/** 所有内置模板（当前仅通用模板，行业模板由客户自行导入） */
const builtinTemplates = {
  universal,
};

/** 内置模板 ID 集合，用于判断是否可删除 */
const BUILTIN_IDS = new Set(Object.keys(builtinTemplates));

/** 自定义模板缓存（从 IndexedDB 加载） */
let customTemplates = {};

/** 加载自定义模板（app.js 初始化时调用） */
async function loadCustomTemplates() {
  try {
    const { listCustomTemplates } = await import('../js/db.js?v=20260711c');
    const records = await listCustomTemplates();
    customTemplates = {};
    records.forEach(r => {
      customTemplates[r.id] = r.data;
    });
  } catch (e) {
    console.warn('加载自定义模板失败:', e);
    customTemplates = {};
  }
}

/** 刷新单个自定义模板（保存后调用） */
function refreshCustomTemplate(id, data) {
  customTemplates[id] = data;
}

/** 移除自定义模板（删除后调用） */
function removeCustomTemplate(id) {
  delete customTemplates[id];
}

/** 按 id 获取模板（内置优先，再查自定义） */
function getTemplate(id) {
  const t = builtinTemplates[id] || customTemplates[id];
  if (!t) throw new Error(`未找到模板: ${id}`);
  // 深拷贝，防止模板被意外修改
  return JSON.parse(JSON.stringify(t));
}

/** 获取全部模板列表（只读，用于 UI 展示） */
function listTemplates() {
  const builtin = Object.values(builtinTemplates).map(t => ({
    id: t.id,
    name: t.name,
    industry: t.industry,
    description: t.description,
    isBuiltin: true,
  }));
  // 过滤掉非模板记录（如 _original_docx_ 存储）
  const custom = Object.values(customTemplates)
    .filter(t => t && t.id && t.columns)
    .map(t => ({
      id: t.id,
      name: t.name,
      industry: t.industry || '通用',
      description: t.description || '',
      isBuiltin: false,
    }));
  return [...builtin, ...custom];
}

/** 检查模板是否为内置 */
function isBuiltinTemplate(id) {
  return BUILTIN_IDS.has(id);
}

export { getTemplate, listTemplates, loadCustomTemplates, refreshCustomTemplate, removeCustomTemplate, isBuiltinTemplate };
