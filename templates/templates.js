// templates.js — 内置模板注册表
// 导出所有内置模板，支持按 id 查找

import safety from './safety.json' with { type: 'json' };
import s5s from './5s.json' with { type: 'json' };
import company from './company.json' with { type: 'json' };

/** 所有内置模板 */
const builtinTemplates = {
  safety,
  '5s': s5s,
  company,
};

/** 按 id 获取模板 */
function getTemplate(id) {
  const t = builtinTemplates[id];
  if (!t) throw new Error(`未找到模板: ${id}`);
  // 深拷贝，防止模板被意外修改
  return JSON.parse(JSON.stringify(t));
}

/** 获取模板列表（只读，用于 UI 展示） */
function listTemplates() {
  return Object.values(builtinTemplates).map(t => ({
    id: t.id,
    name: t.name,
    industry: t.industry,
    description: t.description,
  }));
}

export { getTemplate, listTemplates };
