// app.js — 应用主入口：全局状态、页面路由、事件协调

import { saveDraft, getDraft, deleteDraft, listDrafts, getBackupInfo, getPresets, savePresets, getTodayStr, migrateFromV1 } from './db.js?v=20260711b';
import { generateDocx, loadTemplate, buildOverview } from './docx-gen.js?v=20260711b';
import { getTemplate, loadCustomTemplates } from '../templates/templates.js';
import { callDoubaoOptimize } from './ai.js?v=20260711b';
import { checkActivation, canGenerateReport, incrementUsage, activateCode, getUsageThisMonth, isFeatureAllowed } from './activate.js?v=20260711b';
import {
  showToast,
  renderHomePage,
  renderItemList,
  renderItemForm,
  renderOptimizePage,
  showEditModal,
  showMergePanel,
  renderGeneratePage,
  showUpgradePanel,
} from './ui.js?v=20260711b';

// ---------- 全局状态 ----------
const state = {
  reportType: null,
  items: [],
  currentDraftId: null,  // 当前编辑的草稿 ID
  headerInfo: {
    company: getPresets().company,
    department: getPresets().department,
    date: getTodayStr(),           // 落款日期
    inspectionDate: getTodayStr(), // 检查日期
    halfMonth: null, // 'first' | 'second' — 仅 5S 使用
  },
  currentPage: 'home',
  activation: { activated: false },  // 激活状态
};

window._showToast = showToast;

// ---------- 辅助：保存草稿（自动传入 currentDraftId 避免重复）----------

function saveDraftWithId() {
  if (!state.reportType || state.items.length === 0) return Promise.resolve();
  return saveDraft(state.reportType, {
    items: state.items,
    headerInfo: state.headerInfo,
  }, state.currentDraftId).then(newId => {
    state.currentDraftId = newId;
    return newId;
  }).catch(e => { console.error('保存草稿失败:', e); });
}

// ---------- 导入处理 ----------

async function handleImportDocx(file, reportType) {
  showToast('正在解析文件...');

  let parsed;
  try {
    const { parseDocx } = await import('./importer.js?v=20260711b');
    parsed = await parseDocx(file);
  } catch (e) {
    showToast(e.message || '文件解析失败，请确认是工具生成的报告');
    return;
  }

  const drafts = await listDrafts();

  showMergePanel({
    parsed,
    drafts,
    reportType,
    onConfirm: async (targetDraftId) => {
      state.reportType = reportType;

      if (targetDraftId) {
        const existing = await getDraft(targetDraftId);
        if (existing) {
          state.items = [...(existing.items || []), ...parsed.items];
          state.headerInfo = existing.headerInfo || {
            company: getPresets().company, department: getPresets().department,
            date: getTodayStr(), inspectionDate: getTodayStr(),
            halfMonth: reportType === '5s' ? 'first' : null,
          };
          state.currentDraftId = targetDraftId;
        }
      } else {
        state.items = parsed.items;
        state.headerInfo = {
          company: getPresets().company, department: getPresets().department,
          date: getTodayStr(), inspectionDate: getTodayStr(),
          halfMonth: reportType === '5s' ? 'first' : null,
        };
        state.currentDraftId = null;
      }

      // 保存草稿（首次保存 currentDraftId 为 null 会新建；合并时传入已有 ID 会更新）
      await saveDraftWithId();

      showToast(`已导入 ${parsed.items.length} 条`);
      showItemList();
    },
    onCancel: () => {},
  });
}

async function handleImportPhoto(file, reportType) {
  showToast('正在识别照片...');

  let result;
  try {
    const { parsePhoto } = await import('./importer.js?v=20260711b');
    result = await parsePhoto(file);
  } catch (e) {
    showToast('照片处理失败，请重试');
    return;
  }

  const items = [{
    description: result.description,
    beforePhoto: result.photo,
    afterPhoto: '',
    status: '待整改',
  }];

  const drafts = await listDrafts();

  showMergePanel({
    parsed: { items },
    drafts,
    reportType,
    onConfirm: async (targetDraftId) => {
      state.reportType = reportType;

      if (targetDraftId) {
        const existing = await getDraft(targetDraftId);
        if (existing) {
          state.items = [...(existing.items || []), ...items];
          state.headerInfo = existing.headerInfo || {
            company: getPresets().company, department: getPresets().department,
            date: getTodayStr(), inspectionDate: getTodayStr(),
            halfMonth: reportType === '5s' ? 'first' : null,
          };
          state.currentDraftId = targetDraftId;
        }
      } else {
        state.items = items;
        state.headerInfo = {
          company: getPresets().company, department: getPresets().department,
          date: getTodayStr(), inspectionDate: getTodayStr(),
          halfMonth: reportType === '5s' ? 'first' : null,
        };
        state.currentDraftId = null;
      }

      await saveDraftWithId();

      const descPreview = result.description.length > 20
        ? result.description.substring(0, 20) + '...'
        : result.description;
      showToast(`已导入照片：${descPreview}`);
      showItemList();
    },
    onCancel: () => {},
  });
}

// ---------- 首页 ----------

function showHome() {
  // v1 → v2 迁移（首次运行时执行）
  migrateFromV1().then(() => {
    listDrafts().then(drafts => {
      renderHomePage({ drafts, onSelectType: handleTypeSelection });
      // 检测数据丢失：数据库空了但备份显示之前有数据
      checkDataLoss(drafts);
    });
  }).catch(() => {
    listDrafts().then(drafts => {
      renderHomePage({ drafts, onSelectType: handleTypeSelection });
      checkDataLoss(drafts);
    });
  });
}

function checkDataLoss(drafts) {
  if (drafts.length > 0) return; // 有草稿，正常
  const backup = getBackupInfo();
  if (!backup || backup.drafts.length === 0) return; // 从来没有过草稿，正常
  // 数据库空了但之前有草稿 → 可能被浏览器清空了
  const daysAgo = Math.floor((Date.now() - backup.time) / 86400000);
  showToast(`⚠️ 草稿数据丢失（${daysAgo}天前有${backup.drafts.length}条备份）`, 6000);
}

function handleTypeSelection(type, resume, draftId, file, importReportType) {
  // 处理导入 .docx（用户已通过卡片 📥 按钮指定了报告类型）
  if (type === '__import_docx__' && file) {
    handleImportDocx(file, importReportType);
    return;
  }
  // 处理导入照片（用户已通过卡片 📥 按钮指定了报告类型）
  if (type === '__import_photo__' && file) {
    handleImportPhoto(file, importReportType);
    return;
  }

  state.reportType = type;

  const defaults = {
    company: getPresets().company,
    department: getPresets().department,
    date: getTodayStr(),
    inspectionDate: getTodayStr(),
    halfMonth: type === '5s' ? 'first' : null,
  };

  if (resume && draftId) {
    getDraft(draftId).then(draftData => {
      if (draftData) {
        state.items = draftData.items || [];
        state.headerInfo = { ...defaults, ...draftData.headerInfo };
        state.currentDraftId = draftId;
      }
      showItemList();
    });
  } else {
    state.items = [];
    state.headerInfo = defaults;
    state.currentDraftId = null;
    showItemList();
  }
}

// ---------- 条目列表 ----------

function showItemList() {
  renderItemList({
    reportType: state.reportType,
    items: state.items,
    headerInfo: state.headerInfo,
    onAdd: (prefill) => {
      // 如果是检查清单预填（有描述且非编辑），直接添加
      if (prefill && prefill.description && !prefill._isEdit) {
        state.items.push({
          description: prefill.description,
          beforePhoto: '',
          afterPhoto: '',
          status: '待整改',
        });
        saveDraftWithId().then(() => showItemList());
        return;
      }
      showItemForm(undefined, null, prefill);
    },
    onEdit: (index) => showItemForm(index),
    onDelete: (index) => {
      const deletedItem = state.items[index];
      state.items.splice(index, 1);
      saveDraftWithId();
      showItemList();

      showToast('条目已删除', 5000, {
        label: '撤回',
        onUndo: () => {
          state.items.splice(index, 0, deletedItem);
          saveDraftWithId();
          showItemList();
        },
      });
    },
    onGenerate: () => {
      if (state.items.length === 0) {
        showToast('请至少添加一条问题记录');
        return;
      }
      showGeneratePage();
    },
    onBack: () => {
      saveDraftWithId().then(() => showHome());
    },
  });
}

// ---------- 新增/编辑条目 ----------

function showItemForm(editIndex, photoOverride, prefill) {
  const item = editIndex !== undefined ? state.items[editIndex]
    : (prefill ? { description: prefill.description || '', beforePhoto: '', afterPhoto: '', status: '待整改' } : null);

  renderItemForm({
    item,
    index: editIndex,
    reportType: state.reportType,
    photoOverride,
    onSave: (savedItem, idx) => {
      if (idx !== undefined) {
        state.items[idx] = savedItem;
      } else {
        state.items.push(savedItem);
      }
      saveDraftWithId().then(() => showItemList());
    },
    onCancel: () => showItemList(),
    onOptimize: (text) => showOptimizePage(text, editIndex),
  });
}

// ---------- AI 润色 ----------

async function showOptimizePage(text, editIndex) {
  // 暂存当前表单照片，防止返回时丢失
  const photoOverride = {
    beforePhoto: window._formBeforePhoto,
    afterPhoto: window._formAfterPhoto,
  };

  // 创建 AbortController，用于取消请求
  const abortController = new AbortController();
  let cancelled = false;

  // 加载态
  renderOptimizePage({
    text,
    reportType: state.reportType,
    options: [],
    loading: true,
    onSelect: () => {}, onEdit: () => {}, onRetry: () => {},
    onUseOriginal: () => {}, onBack: () => {},
    onCancel: () => {
      cancelled = true;
      abortController.abort();
      showItemForm(editIndex, photoOverride);
    },
  });

  try {
    // 从模板读取 aiPromptTag
    let aiPromptTag = '影响';
    try { const tpl = getTemplate(state.reportType); if (tpl.aiPromptTag) aiPromptTag = tpl.aiPromptTag; } catch (e) {}
    const options = await callDoubaoOptimize(text, state.reportType, abortController.signal, aiPromptTag);

    if (cancelled) return; // 已取消，不渲染结果

    renderOptimizePage({
      text,
      reportType: state.reportType,
      options,
      loading: false,
      onSelect: (selectedText) => {
        window._optimizedText = selectedText;
        showItemForm(editIndex, photoOverride);
        setTimeout(() => {
          const descEl = document.getElementById('item-desc');
          if (descEl && window._optimizedText) {
            descEl.value = window._optimizedText;
            descEl.dispatchEvent(new Event('input'));
            delete window._optimizedText;
          }
        }, 100);
      },
      onEdit: (selectedText) => {
        showEditModal(selectedText, (editedText) => {
          window._optimizedText = editedText;
          showItemForm(editIndex, photoOverride);
          setTimeout(() => {
            const descEl = document.getElementById('item-desc');
            if (descEl && window._optimizedText) {
              descEl.value = window._optimizedText;
              delete window._optimizedText;
            }
          }, 100);
        });
      },
      onRetry: () => showOptimizePage(text, editIndex),
      onUseOriginal: (originalText) => {
        // 直接用原文，等同选择了原文
        window._optimizedText = originalText;
        showItemForm(editIndex, photoOverride);
        setTimeout(() => {
          const descEl = document.getElementById('item-desc');
          if (descEl && window._optimizedText) {
            descEl.value = window._optimizedText;
            descEl.dispatchEvent(new Event('input'));
            delete window._optimizedText;
          }
        }, 100);
      },
      onCancel: () => {
        cancelled = true;
        abortController.abort();
        showItemForm(editIndex, photoOverride);
      },
      onBack: () => showItemForm(editIndex, photoOverride),
    });
  } catch (e) {
    if (e.name === 'AbortError' || cancelled) {
      // 用户主动取消，静默返回
      return;
    }
    showToast('网络异常，请检查网络后重试');
    showItemForm(editIndex, photoOverride);
  }
}

// ---------- 生成报告 ----------

async function showGeneratePage() {
  // 预计算概述文字供编辑
  let preOverview = { titleText: '', overviewText: '' };
  try {
    const tpl = getTemplate(state.reportType);
    loadTemplate(tpl);
    const total = state.items.length;
    const done = state.items.filter(i => i.afterPhoto).length;
    const { buildOverview } = await import('./docx-gen.js?v=20260711b');
    preOverview = buildOverview(state.headerInfo, total, done, total - done);
  } catch (e) { /* 使用空值 */ }

  renderGeneratePage({
    reportType: state.reportType,
    headerInfo: state.headerInfo,
    items: state.items,
    preTitle: preOverview.titleText,
    preOverview: preOverview.overviewText,
    onConfirm: async (action, editedTitle, editedOverview) => {
      // 检查是否可以生成报告
      if (!state.activation.activated) {
        const canGen = canGenerateReport();
        if (!canGen.allowed) {
          showUpgradePanel({
            reason: 'limit',
            message: canGen.message,
            currentUsage: getUsageThisMonth(),
            onActivate: async (code) => {
              const result = await activateCode(code);
              if (result.success) {
                state.activation = checkActivation();
                showToast('激活成功！已升级为Pro版');
                showGeneratePage();  // 刷新生成页
              } else {
                return { success: false, error: result.error };
              }
              return { success: true };
            },
          });
          return;
        }
      }
      showToast('正在生成报告...');

      try {
        // 加载模板 → 生成报告
        const template = getTemplate(state.reportType);
        let blob;

        // 尝试使用克隆引擎（方案B：100%保留原格式）
        try {
          const { loadOriginalTemplate, cloneTemplateDocx } = await import('./docx-template-cloner.js');
          const originalBuffer = await loadOriginalTemplate(state.reportType);
          if (originalBuffer) {
            blob = await cloneTemplateDocx(originalBuffer, state.items, template);
          }
        } catch (e) {
          console.warn('克隆引擎不可用，降级为再生模式:', e.message);
        }

        // 降级：使用 docx-gen.js 再生模式
        if (!blob) {
          loadTemplate(template);
          const customOv = editedTitle || editedOverview ? { titleText: editedTitle, overviewText: editedOverview } : null;
          blob = await generateDocx(state.headerInfo, state.items, customOv);
        }

        const fileName = `${template.name}_${state.headerInfo.date}.docx`;

        // 先下载到手机
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // 递增用量计数
        if (!state.activation.activated) {
          incrementUsage();
          state.activation = checkActivation();  // 刷新激活状态（可能用完额度）
        }

        // 保存报告历史
        try {
          const { saveReport } = await import('./db.js?v=20260711b');
          await saveReport({
            type: state.reportType,
            typeName: template.name,
            items: state.items,
            headerInfo: state.headerInfo,
          });
        } catch (e) { /* 历史保存失败不影响主流程 */ }

        if (action === 'share') {
          // 微信内置浏览器不支持文件分享，先下载再提示
          if (navigator.share && navigator.canShare && navigator.canShare({ url: window.location.href })) {
            try {
              await navigator.share({
                title: '整改报告',
                text: `${labels[state.reportType]}已生成，文件已保存到手机。`,
                url: window.location.href,
              });
            } catch (e) {
              // 用户取消，不提示错误
            }
          }
          showToast('报告已保存到下载，请从微信中发送文件');
        } else {
          showToast('报告已下载');
        }

        // 生成后保留草稿，不清除历史
        state.items = [];

        setTimeout(() => showHome(), 500);

      } catch (e) {
        console.error('生成报告失败:', e);
        showToast('生成报告失败，请重试');
      }
    },
    onBack: () => showItemList(),
    onEditDate: (newDate) => {
      state.headerInfo.date = newDate;
      showGeneratePage();
    },
    onEditInspectionDate: (newDate) => {
      state.headerInfo.inspectionDate = newDate;
      showGeneratePage();
    },
    onToggleHalfMonth: (half) => {
      state.headerInfo.halfMonth = half;
      showGeneratePage();
    },
  });
}

// ---------- 错误边界 ----------

window.addEventListener('error', (e) => {
  console.error('应用错误:', e.error || e.message);
  // 防止白屏：显示友好提示
  const container = document.getElementById('page-container');
  if (container && !container.textContent.trim()) {
    container.innerHTML = `
      <div style="text-align:center;padding:60px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">😵</div>
        <p style="font-size:16px;font-weight:600;">出了点问题</p>
        <p style="font-size:13px;color:#999;margin-bottom:16px;">请刷新页面重试</p>
        <button class="btn btn-primary" onclick="location.reload()" style="font-size:14px;">🔄 刷新页面</button>
        <p style="font-size:11px;color:#ccc;margin-top:12px;">如果问题持续出现，请清理浏览器缓存</p>
      </div>`;
  }
});

// 未处理的 Promise 拒绝
window.addEventListener('unhandledrejection', (e) => {
  console.error('未处理的Promise错误:', e.reason);
});

// ---------- 启动 ----------

async function init() {
  state.headerInfo.date = getTodayStr();
  // 加载激活状态
  state.activation = checkActivation();
  // 加载自定义模板（从 IndexedDB）
  await loadCustomTemplates();
  showHome();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
