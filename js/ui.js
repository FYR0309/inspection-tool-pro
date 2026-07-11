// ui.js — 所有页面视图的渲染函数

import { getPresets, savePresets, getTodayStr } from './db.js?v=20260711f';
import { callImageEdit, callOptimizePrompt } from './ai.js?v=20260711f';
import { getTemplate, listTemplates, refreshCustomTemplate, removeCustomTemplate, isBuiltinTemplate } from '../templates/templates.js';
import { checkActivation, getUsageThisMonth, activateCode, isFeatureAllowed, FREE_MONTHLY_LIMIT } from './activate.js?v=20260711f';
import { showToast, registerOverlay, closeAllOverlays, showConfirm, escapeHtml } from './utils.js?v=20260711f';

const pageContainer = document.getElementById('page-container');

// ---------- 预设信息（从 localStorage 读取，首次为空） ----------

function getPresetCompany() {
  try { return getPresets().company || ''; } catch (e) { return ''; }
}

function getPresetDepartment() {
  try { return getPresets().department || ''; } catch (e) { return ''; }
}

// ---------- 模板信息辅助 ----------

/** 默认图标（行业 → 标签文字映射） */
const INDUSTRY_ICONS = {
  '制造业': '制造',
  '化工': '化工',
  '建筑': '建筑',
  '仓储': '仓储',
  '餐饮': '餐饮',
  '消防': '消防',
  '电力': '电力',
};

/** 从模板列表构建类型信息映射（带缓存） */
let _typeInfoCache = null;
function getTypeInfo() {
  if (_typeInfoCache) return _typeInfoCache;
  try {
    const templates = listTemplates();
    const map = {};
    templates.forEach(t => {
      map[t.id] = {
        id: t.id,
        name: t.name,
        industry: t.industry,
        description: t.description,
        isBuiltin: t.isBuiltin !== false,
        icon: INDUSTRY_ICONS[t.industry] || t.industry || '通用',
        // 简称和颜色从行业派生
        shortName: t.industry || t.name.slice(0, 4),
        color: getIndustryColor(t.industry),
      };
    });
    _typeInfoCache = map;
  } catch (e) {
    // 模板加载失败时回退到硬编码默认值
    console.warn('模板列表加载失败，使用默认值:', e);
    _typeInfoCache = {
      safety: { id: 'safety', name: '安全检查报告', industry: '制造业', description: '工厂车间安全检查，整改前后对比报告', icon: '安全', shortName: '安全', color: '#3b5998' },
      '5s': { id: '5s', name: '现场检查报告', industry: '制造业', description: '现场管理检查通报，含签名行', icon: '现场', shortName: '5S', color: '#e07b20' },
      company: { id: 'company', name: '公司现场检查整改报告', industry: '制造业', description: '公司检查组检查后整改', icon: '公司', shortName: '公司', color: '#5a6b8a' },
    };
  }
  return _typeInfoCache;
}

/** 清除类型信息缓存（模板变更后调用） */
function clearTypeInfoCache() {
  _typeInfoCache = null;
}

function getIndustryColor(industry) {
  const colors = { '制造业': '#c0833c', '化工': '#4a90d9', '建筑': '#e07030', '仓储': '#5a8a6a', '餐饮': '#d45060', '消防': '#c0392b', '电力': '#d4a017' };
  return colors[industry] || '#888';
}

/** 生成激活状态文本（集成到 presets-bar 中） */
function getActivationStatusHtml() {
  const activation = checkActivation();
  if (activation.activated) {
    return '<span style="background:#3b5998;color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;font-weight:600;">PRO</span>';
  }
  const usage = getUsageThisMonth();
  const mainRemaining = usage.remaining;
  const graceRemaining = usage.graceRemaining;
  let text = '';
  if (mainRemaining > 0) text += `本月${mainRemaining}次`;
  if (graceRemaining > 0) text += `${text ? ' + ' : ''}赠送${graceRemaining}次`;
  if (!text) text = '已用完';
  return `<span style="font-size:10px;color:var(--text-secondary);">${text}</span>`;
}

function getActivationAction() {
  const activation = checkActivation();
  return activation.activated ? 'show-settings' : 'show-upgrade';
}
function getPhotoLabels(reportType) {
  try {
    const t = getTemplate(reportType);
    const imageCols = t.columns.filter(c => c.type === 'image');
    if (imageCols.length >= 2) {
      return { before: imageCols[0].label, after: imageCols[1].label };
    }
  } catch (e) {}
  return { before: '整改前', after: '整改后' };
}

/** 获取模板中描述列的标签 */
function getDescLabel(reportType) {
  try {
    const t = getTemplate(reportType);
    const descCol = t.columns.find(c => c.type === 'description');
    if (descCol) return descCol.label;
  } catch (e) {}
  return '问题描述';
}

// ---------- 通用 ----------

/**
 * @deprecated 使用 utils.js 的 showToast（导入后直接使用，不再重复定义）
 * 此模块重新导出 utils.showToast 供 app.js 使用
 */

// ---------- 历史记录工具 ----------

function getHistory(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) { return []; }
}

function addHistory(key, value, max = 3) {
  if (!value) return;
  const list = getHistory(key).filter(v => v !== value);
  list.unshift(value);
  localStorage.setItem(key, JSON.stringify(list.slice(0, max)));
}

/** 行业关键词映射：用于过滤不相关的AI历史 */
const INDUSTRY_KEYWORDS = {
  safety: ['安全', '隐患', '整改', '消防', '事故', '风险', '防护', '灭火', '逃生', '触电', '坠落', '爆炸', '泄漏'],
  '5s': ['5S', '现场', '卫生', '整理', '整顿', '清扫', '清洁', '现场管理', '通报'],
  company: ['整改', '检查', '现场', '安全', '隐患', '车间'],
  universal: [],  // 通用模板不过滤
};

function renderHistoryTags(key, onClick, reportType) {
  let list = getHistory(key);
  if (!list.length) return '';

  // 按报告类型过滤不相关内容
  if (reportType) {
    const keywords = INDUSTRY_KEYWORDS[reportType] || [];
    if (keywords.length > 0) {
      list = list.filter(h => keywords.some(kw => h.includes(kw)));
    }
  }

  if (!list.length) return '';
  return `<div class="history-tags">${list.map((h, i) =>
    `<button class="history-tag" data-history="${escapeHtml(h)}">${escapeHtml(h.length > 18 ? h.slice(0, 18) + '…' : h)}</button>`
  ).join(' ')}</div>`;
}

// ---------- 首页 ----------

async function renderHomePage({ presets, drafts, onSelectType }) {
  closeAllOverlays();
  const today = getTodayStr();

  // 加载报告历史
  let reports = [];
  try {
    const { listReports } = await import('./db.js?v=20260711f');
    reports = await listReports();
  } catch (e) { /* ignore */ }

  // 从模板列表动态生成类型卡片（分组：内置 / 自定义）
  const typeInfo = getTypeInfo();
  const allTemplates = Object.values(typeInfo);
  const builtinCards = allTemplates.filter(t => t.isBuiltin !== false);
  const customCards = allTemplates.filter(t => t.isBuiltin === false);

  let draftsHtml = '';
  if (drafts && drafts.length > 0) {
    draftsHtml = `
      <div style="margin-top:16px;">
        <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;">草稿箱 (${drafts.length}/6)</h3>
        ${drafts.map(d => {
          const info = typeInfo[d.type] || { shortName: d.type || '未知', color: '#ccc', name: d.type || '未知' };
          return `
          <div class="card draft-card" style="display:flex;align-items:center;gap:10px;border-left:4px solid ${info.color};">
            <span style="background:${info.color};color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;flex-shrink:0;">${info.shortName}</span>
            <div style="flex:1;min-width:0;" data-action="resume" data-id="${d.id}" data-type="${d.type}">
              <div style="font-weight:600;font-size:14px;">${info.name}</div>
              <div style="font-size:12px;opacity:0.65;">${d.data?.items?.length || 0} 条记录 · ${new Date(d.updatedAt).toLocaleDateString('zh-CN')}</div>
            </div>
            <button class="draft-delete-btn" data-action="delete-draft" data-id="${d.id}" style="background:none;border:none;font-size:18px;cursor:pointer;padding:6px 8px;color:#ccc;flex-shrink:0;" title="删除草稿">删除</button>
          </div>
        `}).join('')}
      </div>
    `;
  }

  pageContainer.innerHTML = `
    <div class="page active" id="home-page">
      <h2 style="font-size:18px;margin-bottom:10px;letter-spacing:-0.02em;">安全检查报告</h2>
      <div class="presets-bar" id="presets-bar" style="cursor:pointer;${!getPresetCompany() ? 'border-color:#d14343;opacity:1;' : ''}" title="点击编辑公司/部门信息（报告落款使用）">
        ${!getPresetCompany()
          ? `<span style="color:#d14343;font-weight:600;">请设置公司名称（报告必填）</span>`
          : `<span style="opacity:0.65;font-size:12px;">${escapeHtml(getPresetCompany())} / ${escapeHtml(getPresetDepartment() || '未设部门')} / ${today} / ${getActivationStatusHtml()}</span>`}
      </div>

      ${builtinCards.length > 0 ? `
        <div style="font-size:11px;opacity:0.65;margin:10px 0;text-align:center;">—— 内置模板 ——</div>
        ${builtinCards.map(c => `
          <div class="card card-type-${c.id}" style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:11px;flex-shrink:0;opacity:0.5;min-width:28px;">${c.icon}</span>
            <div style="flex:1;min-width:0;" data-action="select-type" data-type="${c.id}">
              <div class="card-title">${c.name}</div>
              <div class="card-desc">${c.description}</div>
            </div>
            <button class="type-import-btn" data-action="import-file-type" data-type="${c.id}" style="background:none;border:none;font-size:22px;cursor:pointer;padding:10px;flex-shrink:0;border-radius:50%;transition:background 0.2s;" title="导入已有报告或照片">导入</button>
          </div>
        `).join('')}
      ` : ''}

      ${customCards.length > 0 ? `
        <div style="font-size:11px;opacity:0.65;margin:16px 0 10px;text-align:center;">—— 我的模板 ——</div>
        ${customCards.map(c => `
          <div class="card card-type-${c.id}" style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:11px;flex-shrink:0;opacity:0.5;min-width:28px;">${c.icon}</span>
            <div style="flex:1;min-width:0;" data-action="select-type" data-type="${c.id}">
              <div class="card-title">${c.name}</div>
              <div class="card-desc">${c.description}</div>
            </div>
            <button data-action="edit-template" data-id="${c.id}" style="background:none;border:none;font-size:18px;cursor:pointer;padding:8px;flex-shrink:0;" title="编辑">编辑</button>
            <button data-action="delete-template" data-id="${c.id}" style="background:none;border:none;font-size:18px;cursor:pointer;padding:8px;flex-shrink:0;" title="删除">删除</button>
          </div>
        `).join('')}
      ` : ''}

      <p style="font-size:11px;color:#bbb;text-align:center;margin:8px 0;"></p>

      <div style="text-align:center;margin-top:8px;">
        <button class="btn btn-outline" id="import-template-btn" style="width:100%;">导入新模板（.docx / .json）</button>
      </div>

      ${draftsHtml}

      ${reports.length > 0 ? `
        <div style="margin-top:16px;">
          <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;cursor:pointer;" id="history-toggle">历史报告 (${reports.length}) <span style="font-size:11px;opacity:0.65;">▸ 展开</span></h3>
          <div id="history-reports-list" style="display:none;">
            ${reports.map(r => `
              <div class="card" style="display:flex;align-items:center;gap:10px;border-left:4px solid #4caf50;cursor:pointer;" data-action="regen-report" data-id="${r.id}">
                <span style="font-size:24px;flex-shrink:0;">📄</span>
                <div style="flex:1;min-width:0;">
                  <div style="font-weight:600;font-size:14px;">${escapeHtml(r.typeName || r.type)}</div>
                  <div style="font-size:12px;opacity:0.65;">${r.itemCount} 项 · ${new Date(r.createdAt).toLocaleDateString('zh-CN')} ${new Date(r.createdAt).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'})}</div>
                </div>
                <button data-action="del-report" data-id="${r.id}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;flex-shrink:0;" title="删除">删除</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  document.getElementById('home-page').addEventListener('click', (e) => {
    // 删除草稿按钮：先确认→执行删除→撤回toast备份
    const delBtn = e.target.closest('[data-action="delete-draft"]');
    if (delBtn) {
      e.stopPropagation();
      const draftId = delBtn.dataset.id;
      const deletedDraft = drafts.find(d => d.id === draftId);
      if (!deletedDraft) return;

      showConfirm({
        title: '删除草稿',
        message: '确定要删除此草稿吗？删除后可在5秒内撤回。',
        confirmText: '删除',
        cancelText: '取消',
        onConfirm: () => {
          // 立即从显示中移除
          const remaining = drafts.filter(d => d.id !== draftId);
          renderHomePage({ drafts: remaining, onSelectType });

          // 显示撤回 toast
          showToast('草稿已删除', 5000, {
            label: '撤回',
            onUndo: () => {
              import('./db.js?v=20260711f').then(({ listDrafts }) => {
                listDrafts().then(newDrafts => {
                  renderHomePage({ drafts: newDrafts, onSelectType });
                });
              });
            },
            onTimeout: () => {
              import('./db.js?v=20260711f').then(({ deleteDraft }) => {
                deleteDraft(draftId).catch(() => {});
              });
            },
          });
        },
      });
      return;
    }

    // 导入文件到指定类型（卡片上的 按钮）
    const importBtn = e.target.closest('[data-action="import-file-type"]');
    if (importBtn) {
      e.stopPropagation();
      const reportType = importBtn.dataset.type;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.docx,image/*';
      input.onchange = (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        // 大文件提示但不阻止（浏览器可以处理）
        if (file.size > 30 * 1024 * 1024) {
          showToast(`文件较大（${(file.size / 1024 / 1024).toFixed(0)}MB），处理可能需要时间...`);
        }
        if (file.name.endsWith('.docx')) {
          onSelectType('__import_docx__', false, null, file, reportType);
        } else if (file.type.startsWith('image/')) {
          onSelectType('__import_photo__', false, null, file, reportType);
        }
      };
      input.click();
      return;
    }

    const card = e.target.closest('[data-action]');
    if (!card) return;
    const action = card.dataset.action;

    if (action === 'select-type') {
      onSelectType(card.dataset.type);
    } else if (action === 'resume') {
      onSelectType(card.dataset.type, true, card.dataset.id);
    }

    // 模板编辑
    if (action === 'edit-template') {
      e.stopPropagation();
      const tplId = card.dataset.id;
      showTemplateEditor({ templateId: tplId, onBack: () => {
        import('./db.js?v=20260711f').then(({ listDrafts }) => {
          listDrafts().then(newDrafts => renderHomePage({ drafts: newDrafts, onSelectType }));
        });
      }});
      return;
    }

    // 模板删除
    if (action === 'delete-template') {
      e.stopPropagation();
      const tplId = card.dataset.id;
      import('./db.js?v=20260711f').then(({ deleteTemplate }) => {
        deleteTemplate(tplId).then(() => {
          // 同步删除原始 .docx 存储
          import('./docx-template-cloner.js').then(({ deleteOriginalTemplate }) => {
            deleteOriginalTemplate(tplId);
          }).catch(() => {});
          removeCustomTemplate(tplId);
          clearTypeInfoCache();
          import('./db.js?v=20260711f').then(({ listDrafts }) => {
            listDrafts().then(newDrafts => {
              renderHomePage({ drafts: newDrafts, onSelectType });
            });
          });
          showToast('模板已删除');
        }).catch(() => showToast('删除失败'));
      });
      return;
    }
  });
  // 历史报告：删除按钮（必须在 regen 之前检查，因为删除按钮嵌套在卡片内）
  document.getElementById('home-page').addEventListener('click', async (e) => {
    const delReportBtn = e.target.closest('[data-action="del-report"]');
    if (delReportBtn) {
      e.stopPropagation();
      const rptId = delReportBtn.dataset.id;
      import('./db.js?v=20260711f').then(async ({ deleteReport, listDrafts }) => {
        await deleteReport(rptId);
        const d = await listDrafts();
        renderHomePage({ drafts: d, onSelectType });
        showToast('报告记录已删除');
      });
      return;
    }
    const regenBtn = e.target.closest('[data-action="regen-report"]');
    if (regenBtn) {
      e.stopPropagation();
      showToast('正在重新生成报告...');
      try {
        const { listReports } = await import('./db.js?v=20260711f');
        const all = await listReports();
        const rpt = all.find(r => r.id === regenBtn.dataset.id);
        if (!rpt) { showToast('报告数据已丢失'); return; }

        const { generateDocx, loadTemplate } = await import('./docx-gen.js?v=20260711f');
        const { getTemplate } = await import('../templates/templates.js');
        const tpl = getTemplate(rpt.type);
        loadTemplate(tpl);
        const blob = await generateDocx(rpt.headerInfo, rpt.items);

        const fileName = `${tpl.name}_${rpt.headerInfo.date || getTodayStr()}.docx`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('报告已重新下载');
      } catch (err) {
        console.error('重新生成失败:', err);
        showToast('重新生成失败，请重试');
      }
      return;
    }
  });

  // 设置栏点击 → 始终弹出设置面板（激活/升级在设置面板内处理）
  const presetsBar = document.getElementById('presets-bar');
  if (presetsBar) {
    presetsBar.onclick = () => {
      showSettingsPanel({ onSave: () => {
        import('./db.js?v=20260711f').then(({ listDrafts }) => {
          listDrafts().then(d => renderHomePage({ drafts: d, onSelectType }));
        });
      }});
    };
  }

  // 历史报告折叠/展开切换
  setTimeout(() => {
    const historyToggle = document.getElementById('history-toggle');
    const historyList = document.getElementById('history-reports-list');
    if (historyToggle && historyList) {
      historyToggle.onclick = () => {
        const isVisible = historyList.style.display !== 'none';
        historyList.style.display = isVisible ? 'none' : 'block';
        historyToggle.innerHTML = `历史报告 (${reports.length}) <span style="font-size:11px;opacity:0.65;">${isVisible ? '▸ 展开' : '▾ 收起'}</span>`;
      };
    }
  }, 0);

  // 导入模板按钮（延迟绑定，因为按钮在 innerHTML 中）
  setTimeout(() => {
    const importBtn = document.getElementById('import-template-btn');
    if (importBtn) {
      importBtn.onclick = () => showImportPanel({ onSelectType, onBack: (jumpToTemplateId) => {
        import('./db.js?v=20260711f').then(({ listDrafts }) => {
          listDrafts().then(d => {
            renderHomePage({ drafts: d, onSelectType });
            if (jumpToTemplateId) {
              setTimeout(() => onSelectType(jumpToTemplateId), 300);
            }
          });
        });
      }});
    }
  }, 0);
}

// ---------- 条目列表页 ----------

function renderItemList({ reportType, items, headerInfo, onAdd, onEdit, onDelete, onGenerate, onBack }) {
  closeAllOverlays();
  const typeInfo = getTypeInfo();
  const typeName = (typeInfo[reportType] || {}).name || reportType;
  const doneCount = items.filter(i => i.afterPhoto).length;
  const doneLabel = items.length > 0 ? `已整改 ${doneCount}/${items.length}` : '';

  // 上传照片数 = 问题项数
  const photoCount = items.filter(i => i.beforePhoto).length;

  pageContainer.innerHTML = `
    <div class="page active" id="list-page">
      <div class="nav-bar">
        <button class="back-btn" id="list-back">←</button>
        <span class="title">${typeName}</span>
      </div>

      <div style="padding:12px 0;font-size:13px;color:var(--text-secondary);display:flex;justify-content:space-between;">
        <span>${items.length} 个问题项（${photoCount} 张照片）</span>
        <span>${doneLabel}</span>
      </div>

      <div id="items-container">
        ${items.length === 0 ? `
          <div style="text-align:center;padding:60px 20px;color:var(--text-secondary);">
            <div style="font-size:48px;margin-bottom:12px;"></div>
            <p>还没有添加问题项</p>
            <p style="font-size:13px;">点击下方按钮开始拍照记录</p>
          </div>
        ` : items.map((item, i) => `
          <div class="item-row" data-action="edit" data-index="${i}">
            <div class="thumb">
              ${item.beforePhoto ? `<img src="${item.beforePhoto}" alt="整改前" loading="lazy" decoding="async">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px;opacity:0.65;">📷</div>'}
            </div>
            <div class="info">
              <div class="desc">${escapeHtml(item.description || '(未填写描述)')}</div>
              <div class="meta">
                ${item.beforePhoto ? '📷前' : '无前'} ·
                ${item.afterPhoto ? '📷后' : '无后'} ·
                ${item.afterPhoto ? '✓已整改' : '待整改'}
              </div>
            </div>
            <button style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px;" data-action="delete" data-index="${i}">删除</button>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="bottom-bar">
      <button class="btn btn-primary btn-block" id="add-item-btn" style="font-size:18px;">+ 新增问题项</button>
      <button class="btn btn-outline" id="checklist-btn" style="flex-shrink:0;display:none;" title="检查清单">📋</button>
      ${items.length > 0 ? `
        <button class="btn btn-success" id="generate-btn" style="flex-shrink:0;">生成报告</button>
      ` : ''}
    </div>
  `;

  document.getElementById('list-back').onclick = onBack;
  document.getElementById('add-item-btn').onclick = onAdd;
  document.getElementById('checklist-btn').onclick = () => showChecklistPanel({ items, reportType, onLoad: (loadedItems) => {
    // 加载检查清单项——返回带描述的对象，由上层批量添加
    if (onAdd) {
      loadedItems.forEach(li => onAdd(li));
      showToast(`已加载${loadedItems.length}项`);
    }
  }});
  if (items.length > 0) {
    document.getElementById('generate-btn').onclick = onGenerate;
  }

  document.getElementById('items-container').addEventListener('click', (e) => {
    // 先检查删除（delete 按钮在 edit 行内部，必须先判断）
    const delBtn = e.target.closest('[data-action="delete"]');
    if (delBtn) {
      e.stopPropagation();
      onDelete(parseInt(delBtn.dataset.index));
      return;
    }
    const row = e.target.closest('[data-action="edit"]');
    if (row) { onEdit(parseInt(row.dataset.index)); }
  });
}

// ---------- 新增/编辑条目页 ----------

function renderItemForm({ item, index, reportType, onSave, onCancel, onOptimize, photoOverride }) {
  closeAllOverlays();
  const isEdit = index !== undefined;
  const desc = item?.description || '';
  const beforePhoto = (photoOverride && photoOverride.beforePhoto !== undefined) ? photoOverride.beforePhoto : (item?.beforePhoto || '');
  const afterPhoto = (photoOverride && photoOverride.afterPhoto !== undefined) ? photoOverride.afterPhoto : (item?.afterPhoto || '');
  const photoLabels = getPhotoLabels(reportType);
  const descLabel = getDescLabel(reportType);

  pageContainer.innerHTML = `
    <div class="page active" id="item-page">
      <div class="nav-bar">
        <button class="back-btn" id="item-back">←</button>
        <span class="title">${isEdit ? '编辑问题项' : '新增问题项'}</span>
      </div>

      <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;margin-top:8px;">📷 现场照片（点击进相册 · 点📷拍照）</h3>
      <div class="photo-slots">
        <div class="photo-slot ${beforePhoto ? 'has-photo' : ''}" id="slot-before" style="position:relative;">
          ${beforePhoto
            ? `<img src="${beforePhoto}" alt="${photoLabels.before}"><div style="position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:4px;">${photoLabels.before} ✓</div><button class="slot-edit-btn" data-slot="slot-before">修图</button>`
            : `<span class="slot-icon">🖼️</span><span class="slot-label">${photoLabels.before}</span>`}
          <button class="slot-camera-btn" data-slot="slot-before" style="position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:16px;line-height:32px;text-align:center;cursor:pointer;padding:0;z-index:5;">📷</button>
        </div>
        <div class="photo-slot ${afterPhoto ? 'has-photo' : ''}" id="slot-after" style="position:relative;">
          ${afterPhoto
            ? `<img src="${afterPhoto}" alt="${photoLabels.after}"><div style="position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:4px;">${photoLabels.after} ✓</div><button class="slot-edit-btn" data-slot="slot-after">修图</button>`
            : `<span class="slot-icon">🖼️</span><span class="slot-label">${photoLabels.after}<br><small>(选填，上传=已整改)</small></span>`}
          <button class="slot-camera-btn" data-slot="slot-after" style="position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:16px;line-height:32px;text-align:center;cursor:pointer;padding:0;z-index:5;">📷</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>${descLabel}</span>
          <button class="btn btn-purple btn-sm" id="optimize-btn-inline" ${!desc.trim() ? 'disabled' : ''} style="${!desc.trim() ? 'opacity:0.5;' : ''}">AI润色</button>
        </label>
        <textarea class="form-input" id="item-desc" placeholder="例如：灭火器过期未更换，存在火灾隐患">${escapeHtml(desc)}</textarea>
        ${renderHistoryTags('optimize_history', null, reportType)}
      </div>

      <div style="display:flex;gap:10px;margin-bottom:14px;">
        <button class="btn btn-primary btn-block" id="voice-btn">语音输入</button>
        <button class="btn btn-outline btn-block" id="text-focus-btn">文字输入</button>
      </div>

      <div id="voice-status" style="display:none;text-align:center;padding:12px;background:#fdf3e0;border-radius:10px;margin-bottom:10px;">
        <span class="spinner" style="margin-right:8px;vertical-align:middle;"></span>
        <span id="voice-text" style="font-size:14px;">正在聆听...</span>
      </div>

      <button class="btn btn-success btn-block" id="save-item-btn">保存</button>
    </div>
  `;

  function setupPhotoSlot(slotId) {
    const slot = document.getElementById(slotId);

    function pickImage(source) {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (source === 'camera') input.capture = 'environment';
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
          if (slotId === 'slot-before') {
            window._formBeforePhoto = e.target.result;
          } else {
            window._formAfterPhoto = e.target.result;
          }
          renderItemForm({
            item: {
              description: document.getElementById('item-desc')?.value || desc,
              beforePhoto: slotId === 'slot-before' ? window._formBeforePhoto : (window._formBeforePhoto !== undefined ? window._formBeforePhoto : beforePhoto),
              afterPhoto: slotId === 'slot-after' ? window._formAfterPhoto : (window._formAfterPhoto !== undefined ? window._formAfterPhoto : afterPhoto),
            },
            index,
            reportType,
            onSave, onCancel, onOptimize,
          });
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }

    // 点击插槽主体 → 直接进相册
    slot.addEventListener('click', (e) => {
      if (e.target.closest('.slot-camera-btn')) return;
      pickImage('gallery');
    });

    // 📷 小按钮 → 拍照
    const camBtn = slot.querySelector('.slot-camera-btn');
    if (camBtn) {
      camBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pickImage('camera');
      });
    }

    // 修图按钮 → AI 修图面板（Pro版功能）
    const editBtn = slot.querySelector('.slot-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentPhoto = slotId === 'slot-before' ? beforePhoto : afterPhoto;
        if (!currentPhoto) return;

        // 免费版检查
        if (!isFeatureAllowed('image-edit')) {
          showUpgradePanel({
            reason: 'image-edit',
            message: 'AI修图是Pro版功能，升级后即可使用',
            currentUsage: getUsageThisMonth(),
            onActivate: async (code) => {
              const result = await activateCode(code);
              if (result.success) {
                renderItemForm({
                  item: {
                    description: document.getElementById('item-desc')?.value || desc,
                    beforePhoto: window._formBeforePhoto !== undefined ? window._formBeforePhoto : beforePhoto,
                    afterPhoto: window._formAfterPhoto !== undefined ? window._formAfterPhoto : afterPhoto,
                  },
                  index, reportType, onSave, onCancel, onOptimize,
                });
              }
              return result;
            },
          });
          return;
        }

        showImageEditPanel(slotId, currentPhoto, (editedImage) => {
          if (slotId === 'slot-before') {
            window._formBeforePhoto = editedImage;
          } else {
            window._formAfterPhoto = editedImage;
          }
          renderItemForm({
            item: {
              description: document.getElementById('item-desc')?.value || desc,
              beforePhoto: window._formBeforePhoto !== undefined ? window._formBeforePhoto : beforePhoto,
              afterPhoto: window._formAfterPhoto !== undefined ? window._formAfterPhoto : afterPhoto,
            },
            index,
            reportType,
            onSave, onCancel, onOptimize,
          });
          showToast('修图完成');
        });
      });
    }
  }

  window._formBeforePhoto = beforePhoto;
  window._formAfterPhoto = afterPhoto;

  setupPhotoSlot('slot-before');
  setupPhotoSlot('slot-after');

  // 返回时检查是否有未保存修改
  const origDesc = desc;
  const origBefore = beforePhoto;
  const origAfter = afterPhoto;
  window._formDirty = false;

  function checkDirty() {
    const curDesc = document.getElementById('item-desc')?.value || '';
    const curBefore = window._formBeforePhoto !== undefined ? window._formBeforePhoto : '';
    const curAfter = window._formAfterPhoto !== undefined ? window._formAfterPhoto : '';
    return curDesc !== origDesc || curBefore !== origBefore || curAfter !== origAfter;
  }

  document.getElementById('item-back').onclick = () => {
    if (checkDirty()) {
      showConfirm({
        title: '放弃编辑？',
        message: '当前内容尚未保存，返回将丢失所有修改。',
        confirmText: '放弃并返回',
        cancelText: '继续编辑',
        onConfirm: () => {
          delete window._formBeforePhoto;
          delete window._formAfterPhoto;
          window._formDirty = false;
          onCancel();
        },
      });
    } else {
      delete window._formBeforePhoto;
      delete window._formAfterPhoto;
      onCancel();
    }
  };
  document.getElementById('text-focus-btn').onclick = () => document.getElementById('item-desc').focus();

  document.getElementById('voice-btn').onclick = async () => {
    const statusDiv = document.getElementById('voice-status');
    const voiceText = document.getElementById('voice-text');
    statusDiv.style.display = 'block';
    voiceText.textContent = '正在聆听...';
    const { startVoiceRecognition } = await import('./camera-voice.js?v=20260711f');
    window._voiceRecognition = startVoiceRecognition({
      onResult: (text) => {
        voiceText.textContent = text;
        document.getElementById('item-desc').value = text;
        document.getElementById('item-desc').dispatchEvent(new Event('input'));
        setTimeout(() => { statusDiv.style.display = 'none'; }, 1000);
      },
      onInterim: (text) => { voiceText.textContent = text + ' ...'; },
      onEnd: () => {
        if (voiceText.textContent === '正在聆听...') voiceText.textContent = '未识别到语音';
        setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);
        window._voiceRecognition = null;
      },
      onError: (err) => {
        voiceText.textContent = err.message;
        setTimeout(() => { statusDiv.style.display = 'none'; }, 2500);
        window._voiceRecognition = null;
      },
    });
  };

  // 历史标签点击 → 填入输入框
  document.getElementById('item-page').addEventListener('click', (e) => {
    const tag = e.target.closest('.history-tag');
    if (!tag) return;
    document.getElementById('item-desc').value = tag.dataset.history;
    document.getElementById('item-desc').dispatchEvent(new Event('input'));
  });

  document.getElementById('optimize-btn-inline').onclick = () => {
    const currentDesc = document.getElementById('item-desc').value.trim();
    if (!currentDesc) { showToast('请先填写问题描述'); return; }
    addHistory('optimize_history', currentDesc, 3);
    onOptimize(currentDesc);
  };

  // 文字输入时动态启用/禁用 AI 润色按钮
  document.getElementById('item-desc').addEventListener('input', function() {
    const btn = document.getElementById('optimize-btn-inline');
    const hasText = this.value.trim().length > 0;
    btn.disabled = !hasText;
    btn.style.opacity = hasText ? '1' : '0.5';
  });

  document.getElementById('save-item-btn').onclick = () => {
    const savedItem = {
      description: document.getElementById('item-desc').value.trim(),
      beforePhoto: window._formBeforePhoto || '',
      afterPhoto: window._formAfterPhoto || '',
      status: window._formAfterPhoto ? '已整改' : '待整改',
    };
    delete window._formBeforePhoto;
    delete window._formAfterPhoto;
    onSave(savedItem, index);
  };
}

// ---------- AI 润色结果页 ----------

function renderOptimizePage({ text, reportType, options, loading, onSelect, onEdit, onRetry, onBack, onUseOriginal, onCancel }) {
  closeAllOverlays();
  pageContainer.innerHTML = `
    <div class="page active" id="optimize-page">
      <div class="nav-bar">
        <button class="back-btn" id="optimize-back">←</button>
        <span class="title">AI 润色结果</span>
      </div>
      <div style="background:#fafaf7;border-radius:10px;padding:12px;margin-bottom:14px;margin-top:10px;">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">原始描述：</div>
        <div style="font-size:14px;">${escapeHtml(text)}</div>
        <div style="font-size:11px;color:var(--primary);margin-top:6px;">
          ${reportType === 'safety' ? '安全类 — 附加风险描述(≤15字)' : '现场类 — 附加影响说明(≤15字)'}
        </div>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;">请选择一个优化结果：</p>
      <div id="options-container">
        ${loading ? `
          <div style="text-align:center;padding:40px;">
            <span class="spinner" style="width:32px;height:32px;"></span>
            <p style="margin-top:12px;color:var(--text-secondary);">AI 正在优化描述...</p>
            <button class="btn btn-outline" id="cancel-optimize-btn" style="margin-top:12px;color:#c4553d;border-color:#c4553d;">✕ 取消</button>
          </div>
        ` : options.map((opt, i) => `
          <div class="option-card" data-index="${i}" id="option-${i}">
            <div style="font-weight:500;">${String.fromCharCode(65 + i)}. ${escapeHtml(opt)}</div>
          </div>
        `).join('')}
      </div>
      ${!loading ? `
        <div style="display:flex;gap:10px;margin-top:14px;">
          <button class="btn btn-warning btn-block" id="edit-selected-btn" disabled>编辑修改</button>
          <button class="btn btn-purple btn-block" id="retry-btn">换一批</button>
        </div>
        <button class="btn" id="use-original-btn" style="width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #999;background:#fff;color:#666;font-size:14px;">直接使用原文（不用 AI 结果）</button>
      ` : ''}
    </div>
  `;

  // 取消按钮
  const cancelBtn = document.getElementById('cancel-optimize-btn');
  if (cancelBtn && onCancel) {
    cancelBtn.onclick = () => onCancel();
  }

  // 使用原文按钮
  const useOriginalBtn = document.getElementById('use-original-btn');
  if (useOriginalBtn && onUseOriginal) {
    useOriginalBtn.onclick = () => onUseOriginal(text);
  }

  document.getElementById('optimize-back').onclick = onBack;

  if (!loading) {
    let selectedIndex = -1;
    document.getElementById('options-container').addEventListener('click', (e) => {
      const card = e.target.closest('.option-card');
      if (!card) return;
      document.querySelectorAll('.option-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedIndex = parseInt(card.dataset.index);
      document.getElementById('edit-selected-btn').disabled = false;
    });
    document.getElementById('edit-selected-btn').onclick = () => {
      if (selectedIndex >= 0) onEdit(options[selectedIndex]);
    };
    document.getElementById('retry-btn').onclick = () => onRetry();
  }
}

// ---------- 编辑弹窗 ----------

function showEditModal(initialText, onConfirm) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;">
      <h3 style="margin-bottom:12px;">编辑描述</h3>
      <textarea class="form-input" id="edit-textarea" style="min-height:120px;">${escapeHtml(initialText)}</textarea>
      <div style="display:flex;gap:10px;margin-top:16px;">
        <button class="btn btn-outline btn-block" id="edit-cancel">取消</button>
        <button class="btn btn-primary btn-block" id="edit-confirm">确认</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#edit-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#edit-confirm').onclick = () => {
    const newText = overlay.querySelector('#edit-textarea').value.trim();
    if (newText) { onConfirm(newText); overlay.remove(); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  setTimeout(() => overlay.querySelector('#edit-textarea').focus(), 300);
}

// ---------- AI 修图面板 ----------

const QUICK_PROMPTS = [
  { label: '调亮', prompt: '调亮图片，增强光线，让画面更清晰明亮' },
  { label: '去水印', prompt: '去掉图片上的水印和日期文字' },
  { label: '增强清晰度', prompt: '提高图片清晰度和细节，去噪，锐化' },
  { label: '校正颜色', prompt: '校正图片颜色，让色彩自然真实' },
  { label: '裁剪杂乱', prompt: '去掉图片边缘杂乱无关的物体和背景' },
  { label: '突出主体', prompt: '虚化背景，突出画面主体' },
];

function showImageEditPanel(slotId, imageDataUrl, onConfirm, reportType) {
  const photoLabels = getPhotoLabels(reportType);
  const slotLabel = slotId === 'slot-before' ? photoLabels.before : photoLabels.after;

  const overlay = document.createElement('div');
  overlay.className = 'edit-panel-overlay';
  overlay.innerHTML = `
    <div class="edit-panel">
      <div class="edit-panel-header">
        <span class="edit-panel-title">AI 修图 — ${slotLabel}照片</span>
        <button class="edit-panel-close" id="edit-panel-close">✕</button>
      </div>

      <div class="edit-panel-body">
        <!-- 原图预览 -->
        <div class="edit-panel-section">
          <div class="edit-panel-label">📷 当前照片</div>
          <div class="edit-panel-preview" id="edit-panel-preview">
            <img src="${imageDataUrl}" alt="原图" style="width:100%;max-height:200px;object-fit:contain;border-radius:8px;">
          </div>
        </div>

        <!-- 修改指令 -->
        <div class="edit-panel-section">
          <div class="edit-panel-label" style="display:flex;align-items:center;justify-content:space-between;">
            <span>编辑 修改指令</span>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-primary btn-sm" id="edit-voice-btn" style="padding:6px 10px;font-size:15px;">🎤</button>
              <button class="btn btn-purple btn-sm" id="edit-optimize-btn" disabled style="opacity:0.5;">润色</button>
            </div>
          </div>
          <textarea class="form-input edit-prompt-input" id="edit-prompt-input"
            placeholder="描述你想怎么修改这张图，如：调亮背景、去掉右下角水印、把日期抹掉…"
            rows="2"></textarea>
          <div id="edit-voice-status" style="display:none;text-align:center;padding:8px;background:#fdf3e0;border-radius:8px;margin-top:6px;font-size:13px;">
            <span class="spinner" style="width:14px;height:14px;margin-right:6px;vertical-align:middle;"></span>
            <span id="edit-voice-text">正在聆听...</span>
          </div>
        </div>

        <!-- 快捷指令 -->
        <div class="edit-panel-quick-prompts" id="edit-quick-prompts">
          ${QUICK_PROMPTS.map(p => `
            <button class="quick-prompt-tag" data-prompt="${escapeHtml(p.prompt)}">${p.label}</button>
          `).join('')}
        </div>

        <!-- 历史指令 -->
        ${renderHistoryTags('edit_prompt_history')}

        <!-- 操作按钮 -->
        <div style="display:flex;gap:10px;margin-top:12px;">
          <button class="btn btn-outline btn-block" id="edit-panel-cancel">取消</button>
          <button class="btn btn-purple btn-block" id="edit-panel-submit" disabled>开始修图</button>
        </div>

        <!-- 加载状态 -->
        <div id="edit-panel-loading" style="display:none;text-align:center;padding:24px;">
          <span class="spinner" style="width:32px;height:32px;"></span>
          <p id="edit-progress-text" style="margin-top:12px;color:var(--text-secondary);font-size:14px;">正在准备...</p>
        </div>

        <!-- 结果预览 -->
        <div id="edit-panel-result" style="display:none;">
          <div class="edit-panel-label">修图结果</div>
          <div class="edit-panel-preview" id="edit-result-preview" style="border:2px solid var(--success);"></div>
          <div style="display:flex;gap:10px;margin-top:10px;">
            <button class="btn btn-outline btn-block" id="edit-retry-btn">换一批 重试</button>
            <button class="btn btn-success btn-block" id="edit-use-btn">使用此图</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const promptInput = overlay.querySelector('#edit-prompt-input');
  const submitBtn = overlay.querySelector('#edit-panel-submit');
  const loadingDiv = overlay.querySelector('#edit-panel-loading');
  const progressText = overlay.querySelector('#edit-progress-text');
  const resultDiv = overlay.querySelector('#edit-panel-result');
  const previewArea = overlay.querySelector('#edit-panel-preview');
  const quickPromptsDiv = overlay.querySelector('#edit-quick-prompts');
  const cancelBtn = overlay.querySelector('#edit-panel-cancel');
  const actionBtns = cancelBtn.parentElement;

  // 快捷指令点击
  overlay.querySelector('#edit-quick-prompts').addEventListener('click', (e) => {
    const tag = e.target.closest('.quick-prompt-tag');
    if (!tag) return;
    promptInput.value = tag.dataset.prompt;
    submitBtn.disabled = false;
    promptInput.dispatchEvent(new Event('input'));
    // 高亮选中
    overlay.querySelectorAll('.quick-prompt-tag').forEach(t => t.classList.remove('active'));
    tag.classList.add('active');
  });

  // 历史指令点击
  overlay.querySelector('.edit-panel-body').addEventListener('click', (e) => {
    const tag = e.target.closest('.history-tag');
    if (!tag) return;
    promptInput.value = tag.dataset.history;
    submitBtn.disabled = false;
    promptInput.dispatchEvent(new Event('input'));
  });

  // 输入框变化 → 启用提交按钮 + AI润色按钮
  const optimizePromptBtn = overlay.querySelector('#edit-optimize-btn');
  promptInput.addEventListener('input', () => {
    const hasText = promptInput.value.trim().length > 0;
    submitBtn.disabled = !hasText;
    optimizePromptBtn.disabled = !hasText;
    optimizePromptBtn.style.opacity = hasText ? '1' : '0.5';
  });

  // 语音输入修图指令
  const editVoiceBtn = overlay.querySelector('#edit-voice-btn');
  const editVoiceStatus = overlay.querySelector('#edit-voice-status');
  const editVoiceText = overlay.querySelector('#edit-voice-text');
  editVoiceBtn.onclick = async () => {
    editVoiceStatus.style.display = 'block';
    editVoiceText.textContent = '正在聆听...';
    try {
      const { startVoiceRecognition } = await import('./camera-voice.js?v=20260711f');
      startVoiceRecognition({
        onResult: (text) => {
          promptInput.value = text;
          promptInput.dispatchEvent(new Event('input'));
          editVoiceText.textContent = text;
          setTimeout(() => { editVoiceStatus.style.display = 'none'; }, 1000);
        },
        onInterim: (text) => { editVoiceText.textContent = text + ' ...'; },
        onEnd: () => {
          if (editVoiceText.textContent === '正在聆听...') editVoiceText.textContent = '未识别到语音';
          setTimeout(() => { editVoiceStatus.style.display = 'none'; }, 2000);
        },
        onError: (err) => {
          editVoiceText.textContent = err.message;
          setTimeout(() => { editVoiceStatus.style.display = 'none'; }, 2500);
        },
      });
    } catch (e) {
      editVoiceText.textContent = '语音功能加载失败';
      setTimeout(() => { editVoiceStatus.style.display = 'none'; }, 2000);
    }
  };

  // AI 润色修图指令
  optimizePromptBtn.onclick = async () => {
    const rawPrompt = promptInput.value.trim();
    if (!rawPrompt) return;
    optimizePromptBtn.disabled = true;
    optimizePromptBtn.textContent = '⏳';
    try {
      const optimized = await callOptimizePrompt(rawPrompt);
      promptInput.value = optimized;
      promptInput.dispatchEvent(new Event('input'));
    } catch (e) {
      showToast(e.message || 'AI 润色失败');
    } finally {
      optimizePromptBtn.disabled = false;
      optimizePromptBtn.textContent = '润色';
    }
  };

  // 关闭
  function close() { overlay.remove(); }
  overlay.querySelector('#edit-panel-close').onclick = close;
  cancelBtn.onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // 提交修图
  submitBtn.onclick = async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    // 保存修图指令历史
    addHistory('edit_prompt_history', prompt, 3);

    // 切换到加载态
    previewArea.style.display = 'none';
    quickPromptsDiv.style.display = 'none';
    actionBtns.style.display = 'none';
    loadingDiv.style.display = 'block';
    resultDiv.style.display = 'none';

    try {
      if (progressText) progressText.textContent = '正在准备...';
      const result = await callImageEdit(imageDataUrl, prompt, (msg) => {
        if (progressText) progressText.textContent = msg;
      });

      if (result.success && result.image) {
        // 显示结果
        loadingDiv.style.display = 'none';
        resultDiv.style.display = 'block';
        resultDiv.querySelector('#edit-result-preview').innerHTML = `
          <img src="${result.image}" alt="修图结果" style="width:100%;max-height:250px;object-fit:contain;border-radius:8px;">
        `;

        // 使用此图
        resultDiv.querySelector('#edit-use-btn').onclick = () => {
          onConfirm(result.image);
          overlay.remove();
        };

        // 重试
        resultDiv.querySelector('#edit-retry-btn').onclick = () => {
          // 恢复编辑态
          previewArea.style.display = 'block';
          quickPromptsDiv.style.display = 'flex';
          actionBtns.style.display = 'flex';
          loadingDiv.style.display = 'none';
          resultDiv.style.display = 'none';
        };
      } else {
        throw new Error(result.error || '修图失败');
      }
    } catch (err) {
      loadingDiv.style.display = 'none';
      resultDiv.style.display = 'block';
      resultDiv.querySelector('#edit-result-preview').innerHTML = `
        <div style="text-align:center;padding:24px;color:var(--danger);">
          <div style="font-size:32px;margin-bottom:8px;"></div>
          <div style="font-size:14px;">${escapeHtml(err.message || '网络异常，请检查网络后重试')}</div>
        </div>`;
      resultDiv.querySelector('#edit-use-btn').style.display = 'none';
      resultDiv.querySelector('#edit-retry-btn').textContent = '返回修改';
      resultDiv.querySelector('#edit-retry-btn').onclick = () => {
        previewArea.style.display = 'block';
        quickPromptsDiv.style.display = 'flex';
        actionBtns.style.display = 'flex';
        loadingDiv.style.display = 'none';
        resultDiv.style.display = 'none';
        resultDiv.querySelector('#edit-use-btn').style.display = '';
        resultDiv.querySelector('#edit-retry-btn').textContent = '换一批 重试';
      };
    }
  };
}

// ---------- 生成确认页 ----------

function renderGeneratePage({ reportType, headerInfo, items, onConfirm, onBack, onEditDate, onEditInspectionDate, onToggleHalfMonth, preTitle, preOverview }) {
  closeAllOverlays();
  const typeInfo = getTypeInfo();
  const typeName = (typeInfo[reportType] || {}).name || reportType;
  const h = headerInfo;
  const doneCount = items.filter(i => i.afterPhoto).length;

  // 5S 类型：半月选择 + 标题预览同步
  let halfMonthPreviewHtml = '';
  if (reportType === '5s') {
    const halfLabel = h.halfMonth === 'first' ? '上半月' : '下半月';
    const d = (h.inspectionDate || h.date) ? new Date(h.inspectionDate || h.date) : new Date();
    halfMonthPreviewHtml = `
      <div style="margin-top:10px;border-radius:4px;padding:10px;">
        <div style="font-size:11px;color:var(--primary);margin-bottom:4px;">标题预览：</div>
        <div style="font-size:13px;font-weight:600;">${d.getFullYear()}年${d.getMonth()+1}月${getPresetDepartment() || '部门'}5S现场检查通报（${halfLabel}）</div>
        <div style="margin-top:8px;">
          <button class="btn btn-sm ${h.halfMonth === 'first' ? 'btn-primary' : 'btn-outline'}" id="hm-first" style="margin-right:8px;">上半月</button>
          <button class="btn btn-sm ${h.halfMonth === 'second' ? 'btn-primary' : 'btn-outline'}" id="hm-second">下半月</button>
        </div>
      </div>
    `;
  }

  pageContainer.innerHTML = `
    <div class="page active" id="generate-page">
      <div class="nav-bar">
        <button class="back-btn" id="generate-back">←</button>
        <span class="title">生成报告</span>
      </div>

      <div style="margin-top:12px;">
        <div class="card" style="cursor:default;">
          <div style="font-weight:600;margin-bottom:8px;">${typeName}</div>
          <div style="font-size:13px;line-height:2;color:var(--text-secondary);">
            公司：${escapeHtml(getPresetCompany() || '(未设置)')}<br>
            部门：${escapeHtml(getPresetDepartment() || '(未设置)')}<br>
            问题数：${items.length} · 已整改：${doneCount}
          </div>
          <div style="margin-top:10px;">
            <label style="font-size:13px;color:var(--text-secondary);">检查日期：</label>
            <input type="date" class="form-input" id="inspection-date" value="${h.inspectionDate || h.date || getTodayStr()}" style="width:auto;display:inline-block;">
            <div style="font-size:10px;opacity:0.65;margin-top:2px;">用于确定检查区间（报告概述中的日期）</div>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:13px;color:var(--text-secondary);">落款日期：</label>
            <input type="date" class="form-input" id="sig-date" value="${h.date || getTodayStr()}" style="width:auto;display:inline-block;">
          </div>
          ${halfMonthPreviewHtml}
        </div>
      </div>

      <div style="margin-top:16px;background:#fafafa;border-radius:8px;padding:12px;">
        <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:4px;">编辑 报告概述（可修改）</h3>
        <label style="font-size:11px;opacity:0.65;">标题</label>
        <input type="text" id="overview-title" value="${escapeHtml(preTitle || '')}" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;margin-bottom:8px;box-sizing:border-box;">
        <label style="font-size:11px;opacity:0.65;">概述文字</label>
        <textarea id="overview-text" rows="3" style="width:100%;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;resize:vertical;">${escapeHtml(preOverview || '')}</textarea>
      </div>

      <div style="margin-top:16px;">
        <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;">报告预览（${items.length}项）</h3>
        ${items.map((item, i) => `
          <div style="display:flex;gap:10px;align-items:flex-start;font-size:13px;padding:10px 0;border-bottom:1px solid var(--border);">
            <span style="font-weight:600;min-width:24px;padding-top:2px;">#${i + 1}</span>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <div style="width:44px;height:44px;border-radius:6px;overflow:hidden;background:#eee;flex-shrink:0;position:relative;" title="${item.beforePhoto ? '整改前照片' : '无整改前照片'}">
                ${item.beforePhoto
                  ? `<img src="${item.beforePhoto}" style="width:100%;height:100%;object-fit:cover;">`
                  : '<span style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px;color:#bbb;line-height:1.2;"><span style="font-size:14px;">📷</span><span>未上传</span></span>'}
              </div>
              <div style="width:44px;height:44px;border-radius:6px;overflow:hidden;background:#eee;flex-shrink:0;position:relative;" title="${item.afterPhoto ? '整改后照片' : '无整改后照片'}">
                ${item.afterPhoto
                  ? `<img src="${item.afterPhoto}" style="width:100%;height:100%;object-fit:cover;">`
                  : '<span style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:10px;color:#bbb;line-height:1.2;"><span style="font-size:14px;">📷</span><span>未上传</span></span>'}
              </div>
            </div>
            <span style="flex:1;min-width:0;word-break:break-all;line-height:1.5;">${escapeHtml(item.description || '(无描述)')}</span>
            <span style="font-size:11px;flex-shrink:0;${item.afterPhoto ? 'color:var(--success);' : 'color:var(--warning);'}">${item.afterPhoto ? '✓已整改' : '待整改'}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="bottom-bar">
      <button class="btn btn-success btn-block" id="download-btn">下载 Word</button>
      <button class="btn btn-wechat btn-block" id="share-btn">分享</button>
    </div>
  `;

  document.getElementById('generate-back').onclick = onBack;
  document.getElementById('download-btn').onclick = () => {
    const editedTitle = document.getElementById('overview-title')?.value || '';
    const editedOverview = document.getElementById('overview-text')?.value || '';
    onConfirm('download', editedTitle, editedOverview);
  };
  document.getElementById('share-btn').onclick = () => {
    const editedTitle = document.getElementById('overview-title')?.value || '';
    const editedOverview = document.getElementById('overview-text')?.value || '';
    onConfirm('share', editedTitle, editedOverview);
  };

  document.getElementById('sig-date').addEventListener('change', (e) => {
    const newDate = e.target.value;
    if (newDate) onEditDate(newDate);
  });

  if (onEditInspectionDate) {
    document.getElementById('inspection-date').addEventListener('change', (e) => {
      const newDate = e.target.value;
      if (newDate) onEditInspectionDate(newDate);
    });
    // 如果没有单独设置检查日期，跟随落款日期变化
    if (!h.inspectionDate) {
      document.getElementById('sig-date').addEventListener('change', () => {
        document.getElementById('inspection-date').value = document.getElementById('sig-date').value;
      });
    }
  }

  if (reportType === '5s') {
    document.getElementById('hm-first').onclick = () => onToggleHalfMonth('first');
    document.getElementById('hm-second').onclick = () => onToggleHalfMonth('second');
  }
}

// ---------- 导入合并面板 ----------

/**
 * 显示导入合并目标选择面板
 */
function showMergePanel({ parsed, drafts, reportType, onConfirm, onCancel }) {
  // 按类型分组：同类型优先
  const sameTypeDrafts = drafts.filter(d => d.type === reportType);
  const otherDrafts = drafts.filter(d => d.type !== reportType);
  const recentSameType = sameTypeDrafts.length > 0 ? sameTypeDrafts[0] : null;
  const typeInfo = getTypeInfo();
  const currentTypeInfo = typeInfo[reportType] || { name: reportType, icon: '📄', color: '#888', shortName: reportType };

  // 默认选中：同类型最近 > 全局最近 > 新建
  const defaultTarget = recentSameType ? recentSameType.id : (drafts.length > 0 ? drafts[0].id : 'new');

  // 生成草稿选项 HTML
  function draftHtml(d, isSameType) {
    return `
      <div class="merge-option" data-target="${d.id}" style="border:1px solid #e0dbd2;border-radius:10px;padding:12px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="border:1px solid #ccc;color:#ccc;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;">○</span>
          <span style="background:${(typeInfo[d.type] || {}).color || '#ccc'};color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;flex-shrink:0;">${(typeInfo[d.type] || {}).shortName || d.type}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:14px;">${isSameType ? '合并到此草稿' : '合并到此草稿（不同类型）'}</div>
            <div style="font-size:12px;opacity:0.65;">${d.data?.items?.length || 0} 条 · ${new Date(d.updatedAt).toLocaleDateString('zh-CN')}</div>
          </div>
        </div>
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:4px;">导入预览</h3>
      <p style="font-size:13px;opacity:0.65;margin-bottom:4px;">识别到 <strong>${parsed.items.length}</strong> 条问题 · 类型：<span style="color:var(--primary);font-weight:600;">${currentTypeInfo.icon} ${currentTypeInfo.name}</span></p>

      <p style="font-size:13px;opacity:0.65;margin-bottom:8px;">选择导入目标：</p>

      ${sameTypeDrafts.length > 0 ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;margin-top:4px;">同类型草稿</p>
        ${sameTypeDrafts.map(d => draftHtml(d, true)).join('')}
      ` : ''}

      ${otherDrafts.length > 0 ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;margin-top:4px;">其他类型草稿</p>
        ${otherDrafts.map(d => draftHtml(d, false)).join('')}
      ` : ''}

      ${sameTypeDrafts.length === 0 && otherDrafts.length === 0 ? `
        <div style="text-align:center;padding:16px;opacity:0.65;font-size:13px;">暂无草稿</div>
      ` : ''}

      <div class="merge-option" data-target="new" style="border:1px solid #e0dbd2;border-radius:10px;padding:12px;margin-bottom:14px;margin-top:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="border:1px solid #ccc;color:#ccc;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;">○</span>
          <div>
            <div style="font-weight:600;font-size:14px;">创建新草稿</div>
            <div style="font-size:12px;opacity:0.65;">不合并，单独保存</div>
          </div>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="merge-confirm-btn" style="font-size:16px;">确认导入</button>
      <button class="btn btn-outline btn-block" id="merge-cancel-btn" style="margin-top:8px;">取消</button>
    </div>`;

  document.body.appendChild(overlay);

  let selectedTarget = defaultTarget;

  // 初始选中默认项
  function highlightSelected() {
    overlay.querySelectorAll('.merge-option').forEach(o => {
      const isSelected = o.dataset.target === selectedTarget;
      o.classList.toggle('selected', isSelected);
      o.style.border = isSelected ? '2px solid var(--primary)' : '1px solid #e0dbd2';
      o.style.background = isSelected ? '#fdf7f0' : '#fff';
      const check = o.querySelector('span');
      if (check) {
        check.style.background = isSelected ? 'var(--primary)' : 'transparent';
        check.style.color = isSelected ? '#fff' : '#ccc';
        check.style.border = isSelected ? 'none' : '1px solid #ccc';
        check.textContent = isSelected ? '✓' : '○';
      }
    });
  }
  highlightSelected();

  // 选项点击切换
  overlay.querySelectorAll('.merge-option').forEach(opt => {
    opt.addEventListener('click', () => {
      selectedTarget = opt.dataset.target;
      highlightSelected();
    });
  });

  overlay.querySelector('#merge-confirm-btn').onclick = () => {
    const targetDraftId = selectedTarget === 'new' ? null : selectedTarget;
    overlay.remove();
    onConfirm(targetDraftId);
  };

  overlay.querySelector('#merge-cancel-btn').onclick = () => {
    overlay.remove();
    onCancel();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); onCancel(); }
  });
}

// ---------- 模板导入面板 ----------

function showImportPanel({ onSelectType, onBack }) {
  const overlay = document.createElement('div');
  overlay.id = 'import-panel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">导入模板</h3>
      <p style="font-size:13px;opacity:0.65;margin-bottom:12px;">支持 .json（模板文件）和 .docx（Word模板自动识别）</p>

      <div id="import-drop-zone" style="border:2px dashed #ccc;border-radius:12px;padding:40px 20px;text-align:center;cursor:pointer;margin-bottom:12px;transition:border-color 0.2s;">
        <div style="font-size:40px;margin-bottom:8px;">📂</div>
        <div style="font-size:14px;color:#666;">点击选择文件或拖拽到此处</div>
        <input type="file" id="import-file-input" accept=".json,.docx" style="display:none;">
      </div>

      <div id="import-status" style="display:none;text-align:center;padding:12px;background:#fdf3e0;border-radius:10px;margin-bottom:10px;">
        <span class="spinner" style="margin-right:8px;vertical-align:middle;"></span>
        <span id="import-status-text">正在解析...</span>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="import-cancel-btn">取消</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('import-cancel-btn').onclick = () => {
    document.body.removeChild(overlay);
    onBack();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { document.body.removeChild(overlay); onBack(); }
  });

  const dropZone = document.getElementById('import-drop-zone');
  const fileInput = document.getElementById('import-file-input');

  dropZone.onclick = () => fileInput.click();

  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#4a90d9'; };
  dropZone.ondragleave = () => { dropZone.style.borderColor = '#ccc'; };
  dropZone.ondrop = (e) => { e.preventDefault(); dropZone.style.borderColor = '#ccc'; handleFile(e.dataTransfer.files[0]); };

  fileInput.onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };

  async function handleFile(file) {
    const statusDiv = document.getElementById('import-status');
    const statusText = document.getElementById('import-status-text');
    statusDiv.style.display = 'block';

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'json') {
      statusText.textContent = '正在导入 JSON 模板...';
      try {
        const text = await file.text();
        const tpl = JSON.parse(text);
        if (!tpl.id || !tpl.columns) throw new Error('JSON 格式不正确：缺少 id 或 columns');

        const { saveTemplate } = await import('./db.js?v=20260711f');
        const record = await saveTemplate({ ...tpl, source: 'imported', isBuiltin: false });
        refreshCustomTemplate(record.id, tpl);
        clearTypeInfoCache();

        document.body.removeChild(overlay);
        showToast(`模板"${tpl.name}"导入成功`);
        onBack();
      } catch (e) {
        statusText.textContent = '导入失败：' + (e.message || 'JSON 格式不正确');
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
      }
    } else if (ext === 'docx') {
      // 文件大小提醒：超过 20MB 提示但允许继续（解析可能较慢）
      if (file.size > 20 * 1024 * 1024) {
        statusText.textContent = `文件较大（${(file.size / 1024 / 1024).toFixed(0)}MB），解析可能需要较长时间，请耐心等待...`;
      } else {
        statusText.textContent = '正在解析 Word 模板...';
      }
      statusText.textContent = '正在解析 Word 模板...';
      try {
        const { parseDocxTemplate } = await import('./docx-parser.js');
        const result = await parseDocxTemplate(file);
        if (!result.success) {
          statusText.textContent = result.error;
          setTimeout(() => {
            document.body.removeChild(overlay);
            showManualBuilder({ onSave: async (tpl) => {
              const { saveTemplate } = await import('./db.js?v=20260711f');
              const record = await saveTemplate({ ...tpl, source: 'manual', isBuiltin: false });
              refreshCustomTemplate(record.id, tpl);
              clearTypeInfoCache();
              showToast(`模板"${tpl.name}"创建成功`);
              onBack();
            }, onCancel: onBack });
          }, 2000);
          return;
        }

        // 存储原始 .docx 文件（用于方案B克隆引擎）
        try {
          const { storeOriginalTemplate } = await import('./docx-template-cloner.js');
          await storeOriginalTemplate(result.template.id, file);
        } catch (e) {
          console.warn('存储原始模板失败，将使用再生模式:', e);
        }

        document.body.removeChild(overlay);
        showTemplateConfirm(result, { onBack });
      } catch (e) {
        statusText.textContent = '解析失败：' + (e.message || '未知错误');
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
      }
    } else {
      statusText.textContent = '不支持的文件格式，请上传 .json 或 .docx';
      setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
    }
  }
}

// ---------- 模板识别确认页 ----------

function showTemplateConfirm(parseResult, { onBack }) {
  const { template, unknowns } = parseResult;

  const overlay = document.createElement('div');
  overlay.id = 'tpl-confirm-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';

  const columnsHtml = template.columns.map((col, i) => {
    const unknown = unknowns.find(u => u.index === i);
    let statusIcon = '✅';
    let statusColor = '#4caf50';
    if (unknown) {
      statusIcon = unknown.guessedType ? '' : '';
      statusColor = unknown.guessedType ? '#e07b20' : '#d14343';
    }
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;">
        <span style="font-size:16px;" title="${statusIcon === '✅' ? '已识别' : statusIcon === '' ? 'AI猜测' : '未识别'}">${statusIcon}</span>
        <span style="flex:1;font-size:14px;">${escapeHtml(col.label)}</span>
        <select class="tpl-col-type" data-index="${i}" style="font-size:13px;padding:4px;border-radius:6px;border:1px solid ${statusColor};">
          <option value="number" ${col.type === 'number' ? 'selected' : ''}>序号</option>
          <option value="description" ${col.type === 'description' ? 'selected' : ''}>问题描述</option>
          <option value="image" ${col.type === 'image' ? 'selected' : ''}>照片</option>
          <option value="remark" ${col.type === 'remark' ? 'selected' : ''}>备注</option>
          <option value="text" ${col.type === 'text' ? 'selected' : ''}>普通文字</option>
        </select>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:85vh;overflow-y:auto;">
      <h3 style="margin-bottom:4px;">模板识别结果</h3>
      <p style="font-size:12px;opacity:0.65;margin-bottom:12px;">
        ✅已识别 | AI猜测(可改) | 未识别(请手动选择)
      </p>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">模板名称</label>
        <input type="text" id="tpl-name-input" value="${escapeHtml(template.name)}" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>


      <div style="margin-bottom:4px;font-size:13px;color:#666;">表格列识别</div>
      <div style="border:1px solid #eee;border-radius:8px;margin-bottom:16px;">
        ${columnsHtml}
      </div>

      ${unknowns.length > 0 ? `
        <button class="btn btn-purple btn-block" id="ai-guess-btn" style="margin-bottom:12px;">AI 智能识别未匹配列</button>
      ` : ''}

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="tpl-cancel-btn">取消</button>
        <button class="btn btn-primary btn-block" id="tpl-save-btn">保存模板</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('tpl-cancel-btn').onclick = () => {
    document.body.removeChild(overlay);
    onBack();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { document.body.removeChild(overlay); onBack(); }
  });

  document.getElementById('tpl-save-btn').onclick = async () => {
    template.name = document.getElementById('tpl-name-input').value.trim() || template.name;
    template.industry = template.industry || '通用';

    const typeSelects = overlay.querySelectorAll('.tpl-col-type');
    typeSelects.forEach(sel => {
      const i = parseInt(sel.dataset.index);
      template.columns[i].type = sel.value;
      if (sel.value === 'number') template.columns[i].field = '_index';
      else if (sel.value === 'description') template.columns[i].field = 'description';
      else if (sel.value === 'remark') template.columns[i].field = '_remark';
    });

    const { saveTemplate } = await import('./db.js?v=20260711f');
    const record = await saveTemplate({ ...template, source: 'docx-imported', isBuiltin: false });
    refreshCustomTemplate(record.id, template);
    clearTypeInfoCache();

    document.body.removeChild(overlay);
    // 询问是否立即使用
    showConfirm({
      title: '模板已就绪',
      message: `"${template.name}"导入成功！要现在开始创建报告吗？`,
      confirmText: '开始使用',
      cancelText: '返回首页',
      onConfirm: () => onBack(record.id),
      onCancel: () => onBack(),
    });
  };

  // AI 识别按钮
  const aiBtn = document.getElementById('ai-guess-btn');
  if (aiBtn) {
    aiBtn.onclick = async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = 'AI 识别中...';
      try {
        const { aiGuessColumns } = await import('./docx-parser.js');
        const guessed = await aiGuessColumns(unknowns);
        document.body.removeChild(overlay);
        showTemplateConfirm({ template, unknowns: guessed }, { onBack });
      } catch (e) {
        aiBtn.disabled = false;
        aiBtn.textContent = 'AI 智能识别未匹配列';
        showToast('AI 识别失败，请检查网络');
      }
    };
  }
}

// ---------- 手动建模板（降级方案）----------

function showManualBuilder({ onSave, onCancel }) {
  const overlay = document.createElement('div');
  overlay.id = 'manual-builder-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">手动创建模板</h3>
      <p style="font-size:13px;opacity:0.65;margin-bottom:12px;">Word 模板解析失败，请手动配置</p>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">模板名称</label>
        <input type="text" id="manual-name" value="自定义模板" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">列配置（5列推荐）</label>
        <div id="manual-columns">
          ${[0,1,2,3,4].map(i => `
            <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
              <input type="text" value="${escapeHtml(['序号','检查项目','检查情况','整改情况','备注'][i])}" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
              <select style="width:100px;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
                <option value="number" ${i===0?'selected':''}>序号</option>
                <option value="description" ${i===1?'selected':''}>描述</option>
                <option value="image" ${[2,3].includes(i)?'selected':''}>照片</option>
                <option value="remark" ${i===4?'selected':''}>备注</option>
                <option value="text">文字</option>
              </select>
            </div>
          `).join('')}
        </div>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="manual-cancel">取消</button>
        <button class="btn btn-primary btn-block" id="manual-save">保存 创建</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('manual-cancel').onclick = () => { document.body.removeChild(overlay); onCancel(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); onCancel(); } });

  document.getElementById('manual-save').onclick = () => {
    const name = document.getElementById('manual-name').value.trim() || '自定义模板';
    const colDivs = document.getElementById('manual-columns').children;
    const columns = [];
    const FIELD_MAP = { number: '_index', description: 'description', remark: '_remark' };
    let imgCount = 0;
    for (const div of colDivs) {
      const input = div.querySelector('input');
      const select = div.querySelector('select');
      if (!input.value.trim()) continue;
      let field = FIELD_MAP[select.value] || 'field_' + columns.length;
      if (select.value === 'image') {
        field = imgCount === 0 ? 'beforePhoto' : 'afterPhoto';
        imgCount++;
      }
      columns.push({ label: input.value.trim(), field, type: select.value, width: 1800 });
    }

    const tpl = {
      id: 'tpl_' + Date.now(),
      name, industry: '通用', description: '手动创建',
      overviewType: 'generic',
      page: { margins: { top: 1213, bottom: 1440, left: 1123, right: 1123 }, tableWidth: 9207 },
      title: { font: '宋体', size: 36, bold: true, alignment: 'center', spacing: { before: 242, after: 0, line: 400 } },
      overview: { font: '宋体', size: 24, alignment: 'justified', spacing: { before: 242, after: 120, line: 400 }, firstLineIndent: 560, leftIndent: 120 },
      columns,
      columnStyles: { header: { font: '宋体', size: 24, bold: true, background: 'D9E2F3' }, number: { font: '宋体', size: 28, alignment: 'center' }, text: { font: '宋体', size: 28, alignment: 'center' }, description: { font: '宋体', size: 22, alignment: 'left' }, remark: { font: '宋体', size: 20, alignment: 'center' }, image: { displayWidth: 192 } },
      cellMargins: { top: 0, bottom: 0, left: 108, right: 108 },
      rowHeight: { header: 90, data: 3400 },
      hasSignatures: true, signatureText: '编制：               审核：                 批准：',
      footer: { font: '宋体', size: 28, spacing: { after: 200 } },
      aiPromptTag: '影响',
      variables: { company: { label: '公司名称', default: '', editable: true }, department: { label: '部门', default: '', editable: true } },
    };

    document.body.removeChild(overlay);
    onSave(tpl);
  };
}

// ---------- 模板编辑器 ----------

function showTemplateEditor({ templateId, onBack }) {
  const tpl = getTemplate(templateId);
  if (!tpl) { showToast('模板未找到'); onBack(); return; }
  const isBuiltin = isBuiltinTemplate(templateId);

  // 构建预览数据
  const previewData = buildPreviewData(tpl);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:20px;max-height:90vh;overflow-y:auto;">
      <h3 style="margin-bottom:4px;">编辑模板：${escapeHtml(tpl.name)}</h3>
      ${isBuiltin ? '<p style="font-size:12px;color:#c4553d;margin-bottom:8px;"> 内置模板，编辑后将保存为我的模板</p>' : ''}

      <div style="margin-bottom:14px;">
        <label style="font-size:13px;color:#666;">报告标题模板</label>
        <textarea id="tpl-edit-title" rows="1" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;font-size:14px;">${escapeHtml(tpl.titleTemplate || '')}</textarea>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:13px;color:#666;">概述文字模板</label>
        <textarea id="tpl-edit-overview" rows="3" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;font-size:13px;">${escapeHtml(tpl.overviewTemplate || '')}</textarea>
      </div>

      <div style="margin-bottom:14px;">
        <label style="font-size:13px;color:#666;">落款设置（报告末尾右对齐显示）</label>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <input type="text" id="tpl-edit-footer-co" placeholder="公司名称" value="${escapeHtml(getFooterPart(tpl, 0))}" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
          <input type="text" id="tpl-edit-footer-dept" placeholder="部门" value="${escapeHtml(getFooterPart(tpl, 1))}" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
          <input type="text" id="tpl-edit-footer-date" placeholder="日期" value="${escapeHtml(getFooterPart(tpl, 2))}" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
        </div>
        <div style="font-size:10px;opacity:0.65;margin-top:4px;">支持占位符：<code>{{company}}</code> <code>{{department}}</code> <code>{{date}}</code></div>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-size:13px;color:#666;margin-bottom:4px;display:block;">效果预览</label>
        <div id="tpl-preview-area" style="border:2px solid #eee;border-radius:8px;padding:12px;background:#fafaf7;max-height:300px;overflow-y:auto;font-size:12px;">
          ${renderTemplatePreview(tpl, previewData)}
        </div>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="tpl-edit-cancel">取消</button>
        <button class="btn btn-outline" id="tpl-edit-export" style="flex-shrink:0;font-size:13px;">导出</button>
        <button class="btn btn-primary btn-block" id="tpl-edit-save">保存 ${isBuiltin ? '保存为我的模板' : '保存修改'}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 实时预览
  const titleInput = overlay.querySelector('#tpl-edit-title');
  const overviewInput = overlay.querySelector('#tpl-edit-overview');
  const footerCo = overlay.querySelector('#tpl-edit-footer-co');
  const footerDept = overlay.querySelector('#tpl-edit-footer-dept');
  const footerDate = overlay.querySelector('#tpl-edit-footer-date');
  const previewArea = overlay.querySelector('#tpl-preview-area');

  function updatePreview() {
    const tempTpl = JSON.parse(JSON.stringify(tpl));
    tempTpl.titleTemplate = titleInput.value;
    tempTpl.overviewTemplate = overviewInput.value;
    tempTpl.footerTemplate = { lines: [footerCo.value, footerDept.value, footerDate.value] };
    previewArea.innerHTML = renderTemplatePreview(tempTpl, previewData);
  }

  titleInput.addEventListener('input', updatePreview);
  overviewInput.addEventListener('input', updatePreview);
  footerCo.addEventListener('input', updatePreview);
  footerDept.addEventListener('input', updatePreview);
  footerDate.addEventListener('input', updatePreview);

  overlay.querySelector('#tpl-edit-cancel').onclick = () => { document.body.removeChild(overlay); onBack(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); onBack(); } });

  // 导出模板
  overlay.querySelector('#tpl-edit-export').onclick = async () => {
    const { getCustomTemplate, exportTemplateAsFile } = await import('./db.js?v=20260711f');
    if (isBuiltin) {
      // 内置模板直接导出当前编辑的 JSON
      exportTemplateAsFile({ id: tpl.id, data: tpl });
    } else {
      const record = await getCustomTemplate(tpl.id);
      if (record) exportTemplateAsFile(record);
      else showToast('模板数据未找到');
    }
  };

  overlay.querySelector('#tpl-edit-save').onclick = async () => {
    const newTpl = JSON.parse(JSON.stringify(tpl));
    newTpl.titleTemplate = titleInput.value.trim();
    newTpl.overviewTemplate = overviewInput.value.trim();
    newTpl.footerTemplate = { lines: [footerCo.value, footerDept.value, footerDate.value] };
    newTpl.name = isBuiltin ? tpl.name + '（自定义）' : tpl.name;
    newTpl.id = isBuiltin ? 'tpl_' + Date.now() : tpl.id;
    newTpl.isBuiltin = false;
    newTpl.source = 'customized';
    newTpl.version = 1;

    const { saveTemplate } = await import('./db.js?v=20260711f');
    const record = await saveTemplate({ ...newTpl });
    refreshCustomTemplate(record.id, newTpl);
    clearTypeInfoCache();
    document.body.removeChild(overlay);
    showToast(`模板"${newTpl.name}"已保存`);
    onBack();
  };
}

/** 从 footerTemplate.lines 提取第 n 个落款部分（用于表单填充） */
function getFooterPart(tpl, index) {
  try {
    const lines = (tpl.footerTemplate && tpl.footerTemplate.lines) || [];
    if (lines[index] !== undefined && lines[index] !== null) {
      return lines[index].trim();
    }
  } catch (e) {}
  // 默认值
  const defaults = ['{{company}}', '    {{department}}', '{{date}}'];
  return defaults[index] || '';
}

/** 构建预览用占位数据 */
function buildPreviewData(tpl) {
  return {
    company: 'XX公司',
    department: 'XX车间',
    date: '2026年7月8日',
    year: '2026',
    month: '7',
    total: '5',
    done: '3',
    remain: '2',
    half: '上半月',
    checkDate1: '2026年7月3日',
    checkDate2: '2026年7月6日',
  };
}

/** 渲染模板预览 HTML */
function renderTemplatePreview(tpl, data) {
  const titleText = replacePreview(tpl.titleTemplate || '', data);
  const overviewText = replacePreview(tpl.overviewTemplate || '', data);
  const footerLines = (tpl.footerTemplate && tpl.footerTemplate.lines)
    ? tpl.footerTemplate.lines.map(l => replacePreview(l, data))
    : [data.company, '    ' + data.department, data.date];

  const columns = tpl.columns || [];
  const headerCells = columns.map(c =>
    `<th style="border:1px solid #ccc;padding:6px 8px;background:#D9E2F3;font-weight:bold;font-size:13px;">${escapeHtml(c.label)}</th>`
  ).join('');

  // 模拟数据行
  const sampleRows = [
    { desc: '灭火器压力不足', before: '📷', after: '📷' },
    { desc: '电线裸露有触电风险', before: '📷', after: '' },
  ];
  const dataRows = sampleRows.map((row, i) => {
    const cells = columns.map((col, ci) => {
      if (col.type === 'number') return `<td style="border:1px solid #eee;padding:4px 8px;text-align:center;">${i + 1}</td>`;
      if (col.type === 'image') return `<td style="border:1px solid #eee;padding:4px 8px;text-align:center;font-size:16px;">${ci === columns.findIndex(c => c.type === 'image') ? row.before : row.after}</td>`;
      if (col.type === 'description') return `<td style="border:1px solid #eee;padding:4px 8px;text-align:left;">${row.desc}</td>`;
      if (col.type === 'remark') return `<td style="border:1px solid #eee;padding:4px 8px;text-align:center;">${row.after ? '已整改' : ''}</td>`;
      return `<td style="border:1px solid #eee;padding:4px 8px;text-align:center;"></td>`;
    });
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  return `
    <div style="margin-bottom:12px;">
      <div style="text-align:center;font-weight:bold;font-size:16px;margin-bottom:6px;">${escapeHtml(titleText)}</div>
      <div style="font-size:12px;line-height:1.6;text-indent:2em;margin-bottom:10px;">${escapeHtml(overviewText)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:12px;">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${dataRows}</tbody>
    </table>
    <div style="text-align:right;font-size:13px;line-height:1.8;">
      ${footerLines.map(l => `<div>${escapeHtml(l)}</div>`).join('')}
    </div>
    ${tpl.hasSignatures && tpl.signatureText ? `<div style="margin-top:8px;font-size:12px;">${escapeHtml(tpl.signatureText)}</div>` : ''}
  `;
}

function replacePreview(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''));
  }
  return result;
}

// ---------- 检查清单面板 ----------

async function showChecklistPanel({ items, reportType, onSave, onLoad }) {
  const checklists = await (await import('./db.js?v=20260711f')).listChecklists().catch(() => []);

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">检查清单</h3>
      <p style="font-size:13px;opacity:0.65;margin-bottom:12px;">常用检查项模板，快速复用，不用每次重新输入</p>

      ${items.length > 0 ? `
        <div style="margin-bottom:16px;">
          <label style="font-size:13px;color:#666;">保存当前 ${items.length} 项为清单</label>
          <div style="display:flex;gap:8px;margin-top:4px;">
            <input type="text" id="cl-name-input" placeholder="清单名称（如：周例行检查）" style="flex:1;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
            <button class="btn btn-primary btn-sm" id="cl-save-btn" style="flex-shrink:0;">保存</button>
          </div>
        </div>
      ` : ''}

      <div>
        <label style="font-size:13px;color:#666;">已保存的清单</label>
        ${checklists.length === 0 ? '<p style="opacity:0.65;font-size:13px;margin-top:4px;">暂无清单</p>' : ''}
        ${checklists.map(cl => `
          <div style="display:flex;align-items:center;gap:8px;padding:10px;border:1px solid #eee;border-radius:8px;margin-top:6px;">
            <div style="flex:1;min-width:0;" data-action="load-checklist" data-id="${cl.id}">
              <div style="font-weight:600;font-size:14px;">${escapeHtml(cl.name)}</div>
              <div style="font-size:12px;opacity:0.65;">${cl.items.length} 项 · ${new Date(cl.updatedAt).toLocaleDateString('zh-CN')}</div>
            </div>
            <button data-action="del-checklist" data-id="${cl.id}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:4px;">删除</button>
          </div>
        `).join('')}
      </div>

      <button class="btn btn-outline btn-block" id="cl-close-btn" style="margin-top:12px;">关闭</button>
    </div>`;

  document.body.appendChild(overlay);

  overlay.querySelector('#cl-close-btn').onclick = () => { document.body.removeChild(overlay); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { document.body.removeChild(overlay); } });

  // 保存清单
  const saveBtn = overlay.querySelector('#cl-save-btn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const name = overlay.querySelector('#cl-name-input').value.trim();
      if (!name) { showToast('请输入清单名称'); return; }
      const descItems = items.filter(i => i.description).map(i => ({ description: i.description }));
      if (descItems.length === 0) { showToast('没有可保存的描述项'); return; }
      await (await import('./db.js?v=20260711f')).saveChecklist(name, descItems);
      document.body.removeChild(overlay);
      showToast(`清单"${name}"已保存`);
    };
  }

  // 加载/删除清单
  overlay.querySelectorAll('[data-action="load-checklist"]').forEach(el => {
    el.style.cursor = 'pointer';
    el.onclick = async () => {
      const cl = checklists.find(c => c.id === el.dataset.id);
      if (cl && cl.items) {
        document.body.removeChild(overlay);
        onLoad(cl.items);
      }
    };
  });

  overlay.querySelectorAll('[data-action="del-checklist"]').forEach(el => {
    el.onclick = async (e) => {
      e.stopPropagation();
      await (await import('./db.js?v=20260711f')).deleteChecklist(el.dataset.id);
      document.body.removeChild(overlay);
      showToast('清单已删除');
    };
  });
}

// ---------- 升级面板 ----------

/**
 * 升级/激活面板
 * @param {Object} opts
 * @param {string} opts.reason - 'limit'|'image-edit'|'upgrade'
 * @param {string} opts.message - 提示信息
 * @param {Object} opts.currentUsage - getUsageThisMonth() 返回值
 * @param {Function} opts.onActivate - 激活回调: (code) => Promise<{success, error?}>
 * @param {Function} [opts.onSettings] - 跳转设置（仅 upgrade 场景）
 */
function showUpgradePanel({ reason, message, currentUsage, onActivate, onSettings }) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';

  const usageText = currentUsage
    ? `本月已用 ${currentUsage.used}/${FREE_MONTHLY_LIMIT} 次`
    : '';

  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <div style="text-align:center;margin-bottom:16px;">
        <div style="font-size:48px;margin-bottom:8px;">${reason === 'limit' ? '' : ''}</div>
        <h3 style="margin-bottom:4px;">${reason === 'image-edit' ? 'AI修图需要Pro版' : '升级到Pro版'}</h3>
        <p style="font-size:14px;color:#666;">${message}</p>
        ${usageText ? `<p style="font-size:13px;color:#c0833c;margin-top:4px;">${usageText}</p>` : ''}
      </div>

      <div style="background:#fafaf7;border-radius:10px;padding:14px;margin-bottom:16px;">
        <h4 style="font-size:14px;margin-bottom:8px;">Pro版权益</h4>
        <div style="font-size:13px;line-height:2;color:#666;">
          <div>无限生成报告（免费版每月${FREE_MONTHLY_LIMIT}次）</div>
          <div>AI智能修图（美化现场照片）</div>
          <div>所有模板功能全开放</div>
          <div>优先技术支持</div>
        </div>
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;margin-bottom:6px;display:block;">请输入激活码</label>
        <div style="display:flex;gap:8px;">
          <input type="text" id="upgrade-code-input" placeholder="RTHX-XXXX-XXXX"
            style="flex:1;padding:10px;border:1px solid #e0dbd2;border-radius:8px;font-size:16px;font-family:monospace;text-align:center;text-transform:uppercase;letter-spacing:1px;"
            maxlength="14" autocomplete="off">
          <button class="btn btn-primary" id="upgrade-activate-btn" style="flex-shrink:0;padding:10px 16px;font-size:15px;">激活</button>
        </div>
        <div id="upgrade-error" style="display:none;color:#c4553d;font-size:12px;margin-top:4px;"></div>
        <div id="upgrade-loading" style="display:none;text-align:center;padding:8px;margin-top:4px;">
          <span class="spinner" style="width:16px;height:16px;margin-right:6px;vertical-align:middle;"></span>
          <span style="font-size:12px;opacity:0.65;">正在验证...</span>
        </div>
      </div>

      <p style="font-size:11px;color:#bbb;text-align:center;margin-bottom:14px;">
        获取激活码请联系开发者 💬
      </p>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="upgrade-cancel-btn">取消</button>
        ${onSettings ? '<button class="btn btn-block" id="upgrade-settings-btn" style="border:1px solid #ccc;background:#fff;color:#666;font-size:14px;">设置</button>' : ''}
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const codeInput = overlay.querySelector('#upgrade-code-input');
  const activateBtn = overlay.querySelector('#upgrade-activate-btn');
  const errorDiv = overlay.querySelector('#upgrade-error');
  const loadingDiv = overlay.querySelector('#upgrade-loading');

  // 取消
  function close() { document.body.removeChild(overlay); }
  overlay.querySelector('#upgrade-cancel-btn').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // 设置按钮
  if (onSettings) {
    overlay.querySelector('#upgrade-settings-btn').onclick = () => {
      document.body.removeChild(overlay);
      onSettings();
    };
  }

  // 输入时清除错误
  codeInput.addEventListener('input', () => {
    errorDiv.style.display = 'none';
    // 自动格式化：4位后插入横线
    let val = codeInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (val.length > 4) val = val.substring(0, 4) + '-' + val.substring(4);
    if (val.length > 9) val = val.substring(0, 9) + '-' + val.substring(9, 13);
    codeInput.value = val.substring(0, 14);
  });

  // 回车激活
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') activateBtn.click();
  });

  // 激活按钮
  if (!activateBtn) {
    console.error('[showUpgradePanel] 激活按钮未找到！');
    return;
  }
  activateBtn.onclick = async () => {
    const code = codeInput.value.trim();
    console.log('[激活] 点击激活，code:', code, 'length:', code.length);
    if (!code || code.length < 12) {
      errorDiv.textContent = '请输入完整的激活码';
      errorDiv.style.display = 'block';
      return;
    }

    // 显示加载
    activateBtn.disabled = true;
    errorDiv.style.display = 'none';
    loadingDiv.style.display = 'block';

    try {
      console.log('[激活] 调用 activateCode...');
      const result = await onActivate(code);
      console.log('[激活] result:', JSON.stringify(result));
      if (result.success) {
        document.body.removeChild(overlay);
        showToast('激活成功！已升级为Pro版');
      } else {
        errorDiv.textContent = result.error || '激活失败，请检查激活码';
        errorDiv.style.display = 'block';
      }
    } catch (e) {
      console.error('[激活] 异常:', e);
      errorDiv.textContent = '验证失败：' + (e.message || '未知错误');
      errorDiv.style.display = 'block';
    } finally {
      activateBtn.disabled = false;
      loadingDiv.style.display = 'none';
    }
  };

  // 自动聚焦
  setTimeout(() => codeInput.focus(), 300);
}

// ---------- 设置面板 ----------

function showSettingsPanel({ onSave }) {
  const presets = getPresets();
  const depts = presets.departments || [];
  const activation = checkActivation();
  const usage = getUsageThisMonth();

  // 激活状态区块 HTML
  let activationHtml = '';
  if (activation.dev) {
    activationHtml = `
      <div style="background:#f0ebe0;border-radius:10px;padding:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-weight:600;font-size:14px;">开发者模式</div>
          <div style="font-size:12px;opacity:0.65;">无限使用 · 全功能开放</div>
        </div>
      </div>`;
  } else if (activation.activated) {
    activationHtml = `
      <div style="background:#e8f5e9;border-radius:10px;padding:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-weight:600;font-size:14px;">Pro版</div>
          <div style="font-size:12px;color:#666;">无限使用 · 全功能开放</div>
        </div>
      </div>`;
  } else {
    const mainRemaining = usage.remaining;
    const graceRemaining = usage.graceRemaining;
    let usageText = '';
    if (mainRemaining > 0) usageText += `本月${FREE_MONTHLY_LIMIT}次（剩余${mainRemaining}）`;
    if (graceRemaining > 0) usageText += `${usageText ? ' + ' : ''}赠送${graceRemaining}次可用`;
    if (!usageText) usageText = `本月${FREE_MONTHLY_LIMIT}次已用完`;
    activationHtml = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-weight:600;font-size:14px;">免费版</div>
          <div style="font-size:12px;color:#c0833c;">${usageText}</div>
        </div>
        <button class="btn btn-sm" id="settings-upgrade-btn" style="background:#ff9800;color:#fff;border:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;">升级</button>
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">设置</h3>

      ${activationHtml}

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">公司名称（落款显示）</label>
        <input type="text" id="settings-company" value="${escapeHtml(presets.company || '')}" placeholder="如：XX公司" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">默认部门/车间</label>
        <input type="text" id="settings-department" value="${escapeHtml(presets.department || '')}" placeholder="如：压榨车间" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-size:13px;color:#666;">我的部门列表（快捷切换）</label>
        <div id="dept-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;margin-bottom:8px;">
          ${depts.map(d => `<span class="dept-tag" style="background:#f0ebe0;padding:4px 10px;border-radius:12px;font-size:13px;cursor:pointer;" data-dept="${escapeHtml(d)}">${escapeHtml(d)} ✕</span>`).join('')}
        </div>
        <div style="display:flex;gap:8px;">
          <input type="text" id="new-dept-input" placeholder="新增部门名称" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
          <button class="btn btn-sm btn-outline" id="add-dept-btn" style="flex-shrink:0;">+ 添加</button>
        </div>
      </div>

      <button class="btn btn-primary btn-block" id="settings-save-btn">保存</button>

      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
        <p style="font-size:11px;opacity:0.65;margin-bottom:8px;">数据备份：防止浏览器清空存储导致数据丢失</p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-outline btn-block" id="settings-export-btn" style="font-size:13px;">导出全部数据</button>
          <button class="btn btn-outline btn-block" id="settings-import-btn" style="font-size:13px;">导入数据恢复</button>
        </div>
      </div>

      <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);">
        <p style="font-size:11px;opacity:0.65;margin-bottom:8px;">清除缓存：AI润色历史、修图指令历史等本地缓存</p>
        <button class="btn btn-outline btn-block" id="settings-clear-history-btn" style="font-size:13px;color:#c4553d;border-color:#e0c0b8;">删除 清除AI历史记录</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 导出数据
  overlay.querySelector('#settings-export-btn').onclick = async () => {
    try {
      const { exportAllDataAsFile } = await import('./db.js?v=20260711f');
      await exportAllDataAsFile();
      showToast('数据已导出，请保存好备份文件');
    } catch (e) {
      showToast('导出失败：' + (e.message || '未知错误'));
    }
  };

  // 清除AI历史记录
  overlay.querySelector('#settings-clear-history-btn').onclick = () => {
    showConfirm({
      title: '确认清除',
      message: '将清除所有AI润色历史和修图指令历史。此操作不可恢复。',
      confirmText: '确认清除',
      cancelText: '取消',
      onConfirm: () => {
        localStorage.removeItem('optimize_history');
        localStorage.removeItem('edit_prompt_history');
        showToast('AI历史记录已清除');
      },
    });
  };

  // 导入数据
  overlay.querySelector('#settings-import-btn').onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      showToast('正在导入...');
      try {
        const { importAllDataFromFile } = await import('./db.js?v=20260711f');
        const result = await importAllDataFromFile(file);
        document.body.removeChild(overlay);
        showToast(`导入完成：${result.drafts}个草稿、${result.templates}个模板、${result.checklists}个清单、${result.reports}条报告`);
        if (onSave) onSave();
      } catch (e) {
        showToast('导入失败：' + (e.message || '文件格式不正确'));
      }
    };
    input.click();
  };

  // 升级按钮 → 弹出升级面板
  const upgradeBtn = overlay.querySelector('#settings-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.onclick = () => {
      document.body.removeChild(overlay);
      showUpgradePanel({
        reason: 'upgrade',
        message: '升级Pro版解锁无限报告 + AI修图功能',
        currentUsage: usage,
        onActivate: async (code) => {
          const result = await activateCode(code);
          if (result.success) {
            // 刷新设置面板
            showSettingsPanel({ onSave });
          }
          return result;
        },
        onSettings: () => {
          showSettingsPanel({ onSave });
        },
      });
    };
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { document.body.removeChild(overlay); }
  });

  // 部门标签点击 → 删除
  overlay.querySelector('#dept-list').addEventListener('click', (e) => {
    const tag = e.target.closest('.dept-tag');
    if (!tag) return;
    const deptName = tag.dataset.dept;
    const idx = depts.indexOf(deptName);
    if (idx !== -1) depts.splice(idx, 1);
    tag.remove();
  });

  // 添加新部门
  overlay.querySelector('#add-dept-btn').onclick = () => {
    const input = overlay.querySelector('#new-dept-input');
    const name = input.value.trim();
    if (!name) return;
    if (depts.includes(name)) { showToast('部门已存在'); return; }
    depts.push(name);
    const tag = document.createElement('span');
    tag.className = 'dept-tag';
    tag.style.cssText = 'background:#f0ebe0;padding:4px 10px;border-radius:12px;font-size:13px;cursor:pointer;';
    tag.dataset.dept = name;
    tag.textContent = name + ' ✕';
    overlay.querySelector('#dept-list').appendChild(tag);
    input.value = '';
  };

  document.getElementById('settings-save-btn').onclick = () => {
    const company = overlay.querySelector('#settings-company').value.trim();
    const department = overlay.querySelector('#settings-department').value.trim();
    savePresets({ company, department, departments: depts });
    document.body.removeChild(overlay);
    showToast('设置已保存');
    if (onSave) onSave();
  };
}

export {
  showToast,
  renderHomePage,
  renderItemList,
  renderItemForm,
  renderOptimizePage,
  showEditModal,
  showImageEditPanel,
  showMergePanel,
  renderGeneratePage,
  showUpgradePanel,
  showImportPanel,
  showTemplateConfirm,
  showManualBuilder,
  clearTypeInfoCache,
};
