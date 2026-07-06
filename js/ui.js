// ui.js — 所有页面视图的渲染函数

import { getPresets, savePresets, getTodayStr } from './db.js?v=20260701f';
import { callImageEdit, callOptimizePrompt } from './ai.js?v=20260701f';
import { getTemplate, listTemplates } from '../templates/templates.js';

const pageContainer = document.getElementById('page-container');

// ---------- 固定信息 ----------
const FIXED_COMPANY = '广西糖业集团红河制糖有限公司';
const FIXED_DEPARTMENT = '压榨车间';

// ---------- 模板信息辅助 ----------

/** 默认图标（行业 → 图标映射） */
const INDUSTRY_ICONS = {
  '制造业': '🏭',
  '化工': '🧪',
  '建筑': '🏗️',
  '仓储': '📦',
  '餐饮': '🍽️',
  '消防': '🧯',
  '电力': '⚡',
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
        icon: INDUSTRY_ICONS[t.industry] || '📄',
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
      safety: { id: 'safety', name: '安全自查报告', industry: '制造业', description: '车间安全自检自查整改', icon: '🛡️', shortName: '安全', color: '#c0833c' },
      '5s': { id: '5s', name: '现场管理自查报告', industry: '制造业', description: '5S 现场检查通报', icon: '📋', shortName: '5S', color: '#d4952b' },
      company: { id: 'company', name: '公司现场检查整改报告', industry: '制造业', description: '公司检查组检查后整改', icon: '🏭', shortName: '公司', color: '#7b6db5' },
    };
  }
  return _typeInfoCache;
}

function getIndustryColor(industry) {
  const colors = { '制造业': '#c0833c', '化工': '#4a90d9', '建筑': '#e07030', '仓储': '#5a8a6a', '餐饮': '#d45060', '消防': '#c0392b', '电力': '#d4a017' };
  return colors[industry] || '#888';
}

/** 获取模板中照片列的标签 */
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

function showToast(msg, duration = 2000, undoOpts) {
  // 清除之前的定时器
  if (window._toastTimer) { clearTimeout(window._toastTimer); window._toastTimer = null; }
  // 清除之前的撤回回调
  if (window._toastUndoCleanup) { window._toastUndoCleanup(); window._toastUndoCleanup = null; }

  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }

  if (undoOpts && undoOpts.onUndo) {
    // 带撤回按钮的 toast
    toast.innerHTML = `<span>${msg}</span><button class="toast-undo-btn">${undoOpts.label || '撤回'}</button>`;
    const btn = toast.querySelector('.toast-undo-btn');
    let undone = false;
    btn.onclick = () => {
      undone = true;
      toast.classList.remove('show');
      if (window._toastTimer) { clearTimeout(window._toastTimer); window._toastTimer = null; }
      undoOpts.onUndo();
    };
    // 超时后执行清理回调（如真正删除）
    window._toastUndoCleanup = () => {
      if (!undone && undoOpts.onTimeout) undoOpts.onTimeout();
    };
    toast.classList.add('show');
    window._toastTimer = setTimeout(() => {
      toast.classList.remove('show');
      if (window._toastUndoCleanup) { window._toastUndoCleanup(); window._toastUndoCleanup = null; }
    }, duration);
  } else {
    // 普通 toast
    toast.textContent = msg;
    toast.classList.add('show');
    window._toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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

function renderHistoryTags(key, onClick) {
  const list = getHistory(key);
  if (!list.length) return '';
  return `<div class="history-tags">📝 ${list.map((h, i) =>
    `<button class="history-tag" data-history="${escapeHtml(h)}">${escapeHtml(h.length > 18 ? h.slice(0, 18) + '…' : h)}</button>`
  ).join(' ')}</div>`;
}

// ---------- 首页 ----------

function renderHomePage({ presets, drafts, onSelectType }) {
  const today = getTodayStr();

  // 从模板列表动态生成类型卡片
  const typeInfo = getTypeInfo();
  const typeCards = Object.values(typeInfo).map(t => ({
    type: t.id,
    icon: t.icon,
    title: t.name,
    desc: t.description,
  }));

  let draftsHtml = '';
  if (drafts && drafts.length > 0) {
    draftsHtml = `
      <div style="margin-top:16px;">
        <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;">📝 草稿箱 (${drafts.length}/6)</h3>
        ${drafts.map(d => {
          const info = typeInfo[d.type] || { shortName: d.type || '未知', color: '#ccc', name: d.type || '未知' };
          return `
          <div class="card draft-card" style="display:flex;align-items:center;gap:10px;border-left:4px solid ${info.color};">
            <span style="background:${info.color};color:#fff;font-size:10px;padding:2px 8px;border-radius:10px;flex-shrink:0;">${info.shortName}</span>
            <div style="flex:1;min-width:0;" data-action="resume" data-id="${d.id}" data-type="${d.type}">
              <div style="font-weight:600;font-size:14px;">${info.name}</div>
              <div style="font-size:12px;color:#999;">${d.data?.items?.length || 0} 条记录 · ${new Date(d.updatedAt).toLocaleDateString('zh-CN')}</div>
            </div>
            <button class="draft-delete-btn" data-action="delete-draft" data-id="${d.id}" style="background:none;border:none;font-size:18px;cursor:pointer;padding:6px 8px;color:#ccc;flex-shrink:0;" title="删除草稿">🗑️</button>
          </div>
        `}).join('')}
      </div>
    `;
  }

  pageContainer.innerHTML = `
    <div class="page active" id="home-page">
      <h2 style="font-size:22px;margin-bottom:4px;">安全检查报告</h2>
      <p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px;">选择检查类型开始</p>

      <div class="presets-bar">
        🏢 ${escapeHtml(FIXED_COMPANY)} · 👤 ${escapeHtml(FIXED_DEPARTMENT)} · 📅 ${today}
      </div>

      <div style="font-size:11px;color:#999;margin:10px 0;text-align:center;">—— 选择报告类型 ——</div>

      ${typeCards.map(c => `
        <div class="card card-type-${c.type}" style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:28px;flex-shrink:0;">${c.icon}</span>
          <div style="flex:1;min-width:0;" data-action="select-type" data-type="${c.type}">
            <div class="card-title">${c.title}</div>
            <div class="card-desc">${c.desc}</div>
          </div>
          <button class="type-import-btn" data-action="import-file-type" data-type="${c.type}" style="background:none;border:none;font-size:22px;cursor:pointer;padding:10px;flex-shrink:0;border-radius:50%;transition:background 0.2s;" title="导入文件到此类型">📥</button>
        </div>
      `).join('')}

      ${draftsHtml}
    </div>
  `;

  document.getElementById('home-page').addEventListener('click', (e) => {
    // 删除草稿按钮（撤回模式：立即隐藏 + toast 撤回）
    const delBtn = e.target.closest('[data-action="delete-draft"]');
    if (delBtn) {
      e.stopPropagation();
      const draftId = delBtn.dataset.id;
      const deletedDraft = drafts.find(d => d.id === draftId);
      if (!deletedDraft) return;

      // 立即从显示中移除
      const remaining = drafts.filter(d => d.id !== draftId);
      renderHomePage({ drafts: remaining, onSelectType });

      // 显示撤回 toast
      showToast('草稿已删除', 5000, {
        label: '撤回',
        onUndo: () => {
          // 恢复：重新读取（草稿还在 IndexedDB 中）
          import('./db.js?v=20260701f').then(({ listDrafts }) => {
            listDrafts().then(newDrafts => {
              renderHomePage({ drafts: newDrafts, onSelectType });
            });
          });
        },
        onTimeout: () => {
          // 超时后真正删除
          import('./db.js?v=20260701f').then(({ deleteDraft }) => {
            deleteDraft(draftId).catch(() => {});
          });
        },
      });
      return;
    }

    // 导入文件到指定类型（卡片上的 📥 按钮）
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
  });
}

// ---------- 条目列表页 ----------

function renderItemList({ reportType, items, headerInfo, onAdd, onEdit, onDelete, onGenerate, onBack }) {
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
        <span>📋 ${items.length} 个问题项（📷 ${photoCount} 张照片）</span>
        <span>${doneLabel}</span>
      </div>

      <div id="items-container">
        ${items.length === 0 ? `
          <div style="text-align:center;padding:60px 20px;color:var(--text-secondary);">
            <div style="font-size:48px;margin-bottom:12px;">📸</div>
            <p>还没有添加问题项</p>
            <p style="font-size:13px;">点击下方按钮开始拍照记录</p>
          </div>
        ` : items.map((item, i) => `
          <div class="item-row" data-action="edit" data-index="${i}">
            <div class="thumb">
              ${item.beforePhoto ? `<img src="${item.beforePhoto}" alt="整改前">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:20px;color:#999;">📷</div>'}
            </div>
            <div class="info">
              <div class="desc">${escapeHtml(item.description || '(未填写描述)')}</div>
              <div class="meta">
                ${item.beforePhoto ? '📷前' : '⭕无前'} ·
                ${item.afterPhoto ? '📷后' : '⭕无后'} ·
                ${item.afterPhoto ? '✓已整改' : '待整改'}
              </div>
            </div>
            <button style="background:none;border:none;font-size:18px;cursor:pointer;padding:4px;" data-action="delete" data-index="${i}">🗑️</button>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="bottom-bar">
      <button class="btn btn-primary btn-block" id="add-item-btn" style="font-size:18px;">+ 新增问题项</button>
      ${items.length > 0 ? `
        <button class="btn btn-success" id="generate-btn" style="flex-shrink:0;">📄 生成报告</button>
      ` : ''}
    </div>
  `;

  document.getElementById('list-back').onclick = onBack;
  document.getElementById('add-item-btn').onclick = onAdd;
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
            ? `<img src="${beforePhoto}" alt="${photoLabels.before}"><div style="position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:4px;">${photoLabels.before} ✓</div><button class="slot-edit-btn" data-slot="slot-before">✨ 修图</button>`
            : `<span class="slot-icon">🖼️</span><span class="slot-label">${photoLabels.before}照片</span>`}
          <button class="slot-camera-btn" data-slot="slot-before" style="position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:16px;line-height:32px;text-align:center;cursor:pointer;padding:0;z-index:5;">📷</button>
        </div>
        <div class="photo-slot ${afterPhoto ? 'has-photo' : ''}" id="slot-after" style="position:relative;">
          ${afterPhoto
            ? `<img src="${afterPhoto}" alt="${photoLabels.after}"><div style="position:absolute;bottom:4px;left:4px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:2px 6px;border-radius:4px;">${photoLabels.after} ✓</div><button class="slot-edit-btn" data-slot="slot-after">✨ 修图</button>`
            : `<span class="slot-icon">🖼️</span><span class="slot-label">${photoLabels.after}照片<br><small>(选填，上传=已整改)</small></span>`}
          <button class="slot-camera-btn" data-slot="slot-after" style="position:absolute;top:6px;right:6px;width:32px;height:32px;border-radius:50%;border:none;background:rgba(0,0,0,0.5);color:#fff;font-size:16px;line-height:32px;text-align:center;cursor:pointer;padding:0;z-index:5;">📷</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" style="display:flex;align-items:center;justify-content:space-between;">
          <span>${descLabel}</span>
          <button class="btn btn-purple btn-sm" id="optimize-btn-inline" ${!desc.trim() ? 'disabled' : ''} style="${!desc.trim() ? 'opacity:0.5;' : ''}">✨ AI润色</button>
        </label>
        <textarea class="form-input" id="item-desc" placeholder="点击下方按钮语音输入或直接打字...">${escapeHtml(desc)}</textarea>
        ${renderHistoryTags('optimize_history')}
      </div>

      <div style="display:flex;gap:10px;margin-bottom:14px;">
        <button class="btn btn-primary btn-block" id="voice-btn">🎤 语音输入</button>
        <button class="btn btn-outline btn-block" id="text-focus-btn">✏️ 文字输入</button>
      </div>

      <div id="voice-status" style="display:none;text-align:center;padding:12px;background:#fdf3e0;border-radius:10px;margin-bottom:10px;">
        <span class="spinner" style="margin-right:8px;vertical-align:middle;"></span>
        <span id="voice-text" style="font-size:14px;">正在聆听...</span>
      </div>

      <button class="btn btn-success btn-block" id="save-item-btn">💾 保存</button>
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

    // ✨ 修图按钮 → AI 修图面板
    const editBtn = slot.querySelector('.slot-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentPhoto = slotId === 'slot-before' ? beforePhoto : afterPhoto;
        if (!currentPhoto) return;
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

  document.getElementById('item-back').onclick = onCancel;
  document.getElementById('text-focus-btn').onclick = () => document.getElementById('item-desc').focus();

  document.getElementById('voice-btn').onclick = async () => {
    const statusDiv = document.getElementById('voice-status');
    const voiceText = document.getElementById('voice-text');
    statusDiv.style.display = 'block';
    voiceText.textContent = '正在聆听...';
    const { startVoiceRecognition } = await import('./camera-voice.js?v=20260701f');
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
  pageContainer.innerHTML = `
    <div class="page active" id="optimize-page">
      <div class="nav-bar">
        <button class="back-btn" id="optimize-back">←</button>
        <span class="title">AI 润色结果</span>
      </div>
      <div style="background:#fafaf7;border-radius:10px;padding:12px;margin-bottom:14px;margin-top:10px;">
        <div style="font-size:11px;color:var(--text-secondary);margin-bottom:4px;">📝 原始描述：</div>
        <div style="font-size:14px;">${escapeHtml(text)}</div>
        <div style="font-size:11px;color:var(--primary);margin-top:6px;">
          ${reportType === 'safety' ? '🛡️ 安全类 — 附加风险描述(≤15字)' : '📋 现场类 — 附加影响说明(≤15字)'}
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
          <button class="btn btn-warning btn-block" id="edit-selected-btn" disabled>✏️ 编辑修改</button>
          <button class="btn btn-purple btn-block" id="retry-btn">🔄 换一批</button>
        </div>
        <button class="btn" id="use-original-btn" style="width:100%;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #999;background:#fff;color:#666;font-size:14px;">📋 直接使用原文（不用 AI 结果）</button>
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
  { label: '🔆 调亮', prompt: '调亮图片，增强光线，让画面更清晰明亮' },
  { label: '💧 去水印', prompt: '去掉图片上的水印和日期文字' },
  { label: '✨ 增强清晰度', prompt: '提高图片清晰度和细节，去噪，锐化' },
  { label: '🎨 校正颜色', prompt: '校正图片颜色，让色彩自然真实' },
  { label: '📐 裁剪杂乱', prompt: '去掉图片边缘杂乱无关的物体和背景' },
  { label: '🔍 突出主体', prompt: '虚化背景，突出画面主体' },
];

function showImageEditPanel(slotId, imageDataUrl, onConfirm, reportType) {
  const photoLabels = getPhotoLabels(reportType);
  const slotLabel = slotId === 'slot-before' ? photoLabels.before : photoLabels.after;

  const overlay = document.createElement('div');
  overlay.className = 'edit-panel-overlay';
  overlay.innerHTML = `
    <div class="edit-panel">
      <div class="edit-panel-header">
        <span class="edit-panel-title">✨ AI 修图 — ${slotLabel}照片</span>
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
            <span>✏️ 修改指令</span>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-primary btn-sm" id="edit-voice-btn" style="padding:6px 10px;font-size:15px;">🎤</button>
              <button class="btn btn-purple btn-sm" id="edit-optimize-btn" disabled style="opacity:0.5;">✨ 润色</button>
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
          <button class="btn btn-purple btn-block" id="edit-panel-submit" disabled>🎨 开始修图</button>
        </div>

        <!-- 加载状态 -->
        <div id="edit-panel-loading" style="display:none;text-align:center;padding:24px;">
          <span class="spinner" style="width:32px;height:32px;"></span>
          <p id="edit-progress-text" style="margin-top:12px;color:var(--text-secondary);font-size:14px;">正在准备...</p>
        </div>

        <!-- 结果预览 -->
        <div id="edit-panel-result" style="display:none;">
          <div class="edit-panel-label">✅ 修图结果</div>
          <div class="edit-panel-preview" id="edit-result-preview" style="border:2px solid var(--success);"></div>
          <div style="display:flex;gap:10px;margin-top:10px;">
            <button class="btn btn-outline btn-block" id="edit-retry-btn">🔄 重试</button>
            <button class="btn btn-success btn-block" id="edit-use-btn">✅ 使用此图</button>
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

  // 🎤 语音输入修图指令
  const editVoiceBtn = overlay.querySelector('#edit-voice-btn');
  const editVoiceStatus = overlay.querySelector('#edit-voice-status');
  const editVoiceText = overlay.querySelector('#edit-voice-text');
  editVoiceBtn.onclick = async () => {
    editVoiceStatus.style.display = 'block';
    editVoiceText.textContent = '正在聆听...';
    try {
      const { startVoiceRecognition } = await import('./camera-voice.js?v=20260701f');
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

  // ✨ AI 润色修图指令
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
      optimizePromptBtn.textContent = '✨ 润色';
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
          <div style="font-size:32px;margin-bottom:8px;">😞</div>
          <div style="font-size:14px;">${escapeHtml(err.message || '网络异常，请检查网络后重试')}</div>
        </div>`;
      resultDiv.querySelector('#edit-use-btn').style.display = 'none';
      resultDiv.querySelector('#edit-retry-btn').textContent = '🔙 返回修改';
      resultDiv.querySelector('#edit-retry-btn').onclick = () => {
        previewArea.style.display = 'block';
        quickPromptsDiv.style.display = 'flex';
        actionBtns.style.display = 'flex';
        loadingDiv.style.display = 'none';
        resultDiv.style.display = 'none';
        resultDiv.querySelector('#edit-use-btn').style.display = '';
        resultDiv.querySelector('#edit-retry-btn').textContent = '🔄 重试';
      };
    }
  };
}

// ---------- 生成确认页 ----------

function renderGeneratePage({ reportType, headerInfo, items, onConfirm, onBack, onEditDate, onEditInspectionDate, onToggleHalfMonth }) {
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
      <div style="margin-top:10px;background:#fdf7f0;border-radius:8px;padding:10px;">
        <div style="font-size:11px;color:var(--primary);margin-bottom:4px;">📝 标题预览：</div>
        <div style="font-size:13px;font-weight:600;">${d.getFullYear()}年${d.getMonth()+1}月${FIXED_DEPARTMENT}5S现场检查通报（${halfLabel}）</div>
        <div style="margin-top:8px;">
          <button class="btn btn-sm ${h.halfMonth === 'first' ? 'btn-primary' : 'btn-outline'}" id="hm-first" style="margin-right:8px;">📅 上半月</button>
          <button class="btn btn-sm ${h.halfMonth === 'second' ? 'btn-primary' : 'btn-outline'}" id="hm-second">📅 下半月</button>
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
          <div style="font-weight:600;margin-bottom:8px;">📄 ${typeName}</div>
          <div style="font-size:13px;line-height:2;color:var(--text-secondary);">
            公司：${escapeHtml(FIXED_COMPANY)}<br>
            部门：${escapeHtml(FIXED_DEPARTMENT)}<br>
            问题数：${items.length} · 已整改：${doneCount}
          </div>
          <div style="margin-top:10px;">
            <label style="font-size:13px;color:var(--text-secondary);">🔍 检查日期：</label>
            <input type="date" class="form-input" id="inspection-date" value="${h.inspectionDate || h.date || getTodayStr()}" style="width:auto;display:inline-block;">
            <div style="font-size:10px;color:#999;margin-top:2px;">用于确定检查区间（报告概述中的日期）</div>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:13px;color:var(--text-secondary);">✍️ 落款日期：</label>
            <input type="date" class="form-input" id="sig-date" value="${h.date || getTodayStr()}" style="width:auto;display:inline-block;">
          </div>
          ${halfMonthPreviewHtml}
        </div>
      </div>

      <div style="margin-top:16px;">
        <h3 style="font-size:14px;color:var(--text-secondary);margin-bottom:8px;">📋 报告预览（${items.length}项）</h3>
        ${items.map((item, i) => `
          <div style="display:flex;gap:8px;align-items:center;font-size:13px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="font-weight:600;min-width:24px;">#${i + 1}</span>
            <span style="flex:1;">${escapeHtml(item.description || '(无描述)')}</span>
            <span style="font-size:11px;${item.afterPhoto ? 'color:var(--success);' : 'color:var(--warning);'}">${item.afterPhoto ? '✓已整改' : '待整改'}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="bottom-bar">
      <button class="btn btn-success btn-block" id="download-btn">📥 下载 Word</button>
      <button class="btn btn-wechat btn-block" id="share-btn">💬 分享</button>
    </div>
  `;

  document.getElementById('generate-back').onclick = onBack;
  document.getElementById('download-btn').onclick = () => onConfirm('download');
  document.getElementById('share-btn').onclick = () => onConfirm('share');

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
            <div style="font-size:12px;color:#999;">${d.data?.items?.length || 0} 条 · ${new Date(d.updatedAt).toLocaleDateString('zh-CN')}</div>
          </div>
        </div>
      </div>`;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:50;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:4px;">📥 导入预览</h3>
      <p style="font-size:13px;color:#999;margin-bottom:4px;">识别到 <strong>${parsed.items.length}</strong> 条问题 · 类型：<span style="color:var(--primary);font-weight:600;">${currentTypeInfo.icon} ${currentTypeInfo.name}</span></p>

      <p style="font-size:13px;color:#999;margin-bottom:8px;">选择导入目标：</p>

      ${sameTypeDrafts.length > 0 ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;margin-top:4px;">📂 同类型草稿</p>
        ${sameTypeDrafts.map(d => draftHtml(d, true)).join('')}
      ` : ''}

      ${otherDrafts.length > 0 ? `
        <p style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;margin-top:4px;">📂 其他类型草稿</p>
        ${otherDrafts.map(d => draftHtml(d, false)).join('')}
      ` : ''}

      ${sameTypeDrafts.length === 0 && otherDrafts.length === 0 ? `
        <div style="text-align:center;padding:16px;color:#999;font-size:13px;">暂无草稿</div>
      ` : ''}

      <div class="merge-option" data-target="new" style="border:1px solid #e0dbd2;border-radius:10px;padding:12px;margin-bottom:14px;margin-top:6px;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="border:1px solid #ccc;color:#ccc;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;">○</span>
          <div>
            <div style="font-weight:600;font-size:14px;">✨ 创建新草稿</div>
            <div style="font-size:12px;color:#999;">不合并，单独保存</div>
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

export {
  showToast, FIXED_COMPANY, FIXED_DEPARTMENT,
  renderHomePage,
  renderItemList,
  renderItemForm,
  renderOptimizePage,
  showEditModal,
  showImageEditPanel,
  showMergePanel,
  renderGeneratePage,
};
