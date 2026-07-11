// utils.js — 通用工具函数
// 图片压缩 + 遮罩管理 + Toast 队列

// ========== 图片压缩（统一入口，消除 5 处重复） ==========

/**
 * 压缩图片
 * @param {string} dataUrl - 原始图片 data URL
 * @param {Object} opts
 * @param {number} [opts.maxPx=1200] - 最大宽/高（像素）
 * @param {number} [opts.maxKB=450] - 目标最大体积（KB），0 表示不限制
 * @param {number} [opts.quality=0.85] - 初始 JPEG 质量 (0-1)
 * @param {number} [opts.minQuality=0.3] - 最低质量，低于此不再降
 * @param {string} [opts.format='jpeg'] - 输出格式
 * @returns {Promise<string>} 压缩后的 data URL
 */
function compressImage(dataUrl, opts = {}) {
  const { maxPx = 1200, maxKB = 450, quality = 0.85, minQuality = 0.3, format = 'jpeg' } = opts;
  if (!dataUrl || !dataUrl.startsWith('data:image')) return Promise.resolve(dataUrl);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;

        // 等比缩放
        if (w > maxPx || h > maxPx) {
          const ratio = Math.min(maxPx / w, maxPx / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        // 二分法降质量到目标体积
        if (maxKB > 0) {
          let q = quality;
          let result = canvas.toDataURL(`image/${format}`, q);
          while (result.length > maxKB * 1024 && q > minQuality) {
            q -= 0.1;
            result = canvas.toDataURL(`image/${format}`, q);
          }
          resolve(result);
        } else {
          resolve(canvas.toDataURL(`image/${format}`, quality));
        }
      } catch (e) {
        // 压缩失败返回原图
        console.warn('[compressImage] 失败，返回原图:', e.message);
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}


// ========== 遮罩层管理器（防止多层叠加泄漏） ==========

const overlayStack = [];

/**
 * 注册一个遮罩层。打开新遮罩时自动关闭之前的。
 * @param {HTMLElement} el - 遮罩 DOM 元素
 * @param {Function} [onClose] - 关闭回调（清理用）
 * @returns {Function} 调用它来手动移除遮罩
 */
function registerOverlay(el, onClose) {
  // 关闭之前的遮罩（保留最后一个，即当前这个）
  while (overlayStack.length > 0) {
    const prev = overlayStack.pop();
    try {
      if (prev.el && prev.el.parentNode) {
        prev.el.parentNode.removeChild(prev.el);
      }
      if (prev.onClose) prev.onClose();
    } catch (e) { /* ignore */ }
  }

  overlayStack.push({ el, onClose });

  // 返回一个移除函数
  return () => {
    const idx = overlayStack.findIndex(o => o.el === el);
    if (idx !== -1) overlayStack.splice(idx, 1);
    try {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (e) { /* ignore */ }
    if (onClose) onClose();
  };
}

/**
 * 关闭所有遮罩（用于路由跳转等场景）
 */
function closeAllOverlays() {
  while (overlayStack.length > 0) {
    const item = overlayStack.pop();
    try {
      if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
      if (item.onClose) item.onClose();
    } catch (e) { /* ignore */ }
  }
}


// ========== Toast 队列（防止叠 toast） ==========

let toastQueue = [];
let toastActive = false;
let toastEl = null;
let toastTimer = null;
let toastUndoCleanup = null;

/**
 * 显示 toast。如果有正在显示的 toast，新 toast 排队等前一个消失。
 * @param {string} msg - 消息文字
 * @param {number} [duration=2000] - 显示时长（毫秒）
 * @param {Object} [undoOpts] - 撤回选项 { label, onUndo, onTimeout }
 */
function showToast(msg, duration = 2000, undoOpts) {
  // 相同的消息在队列中就不要重复加了
  if (toastQueue.length > 0 && toastQueue[toastQueue.length - 1].msg === msg) return;
  if (toastActive && toastEl && toastEl.textContent.includes(msg)) return;

  toastQueue.push({ msg, duration, undoOpts });
  if (!toastActive) flushToast();
}

function flushToast() {
  if (toastQueue.length === 0) { toastActive = false; return; }
  toastActive = true;
  const { msg, duration, undoOpts } = toastQueue.shift();

  // 清除上一个 toast 的状态
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastUndoCleanup) { toastUndoCleanup(); toastUndoCleanup = null; }

  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }

  if (undoOpts && undoOpts.onUndo) {
    toastEl.innerHTML = `<span>${msg}</span><button class="toast-undo-btn">${undoOpts.label || '撤回'}</button>`;
    const btn = toastEl.querySelector('.toast-undo-btn');
    let undone = false;
    btn.onclick = () => {
      undone = true;
      toastEl.classList.remove('show');
      if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
      undoOpts.onUndo();
      // 立即处理下一个
      setTimeout(flushToast, 300);
    };
    toastUndoCleanup = () => {
      if (!undone && undoOpts.onTimeout) undoOpts.onTimeout();
    };
  } else {
    toastEl.textContent = msg;
  }

  toastEl.classList.add('show');
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    if (toastUndoCleanup) { toastUndoCleanup(); toastUndoCleanup = null; }
    // 等消失动画结束后处理下一个
    setTimeout(flushToast, 350);
  }, duration);
}

/** 强制清空 toast 队列（页面跳转时用） */
function clearToastQueue() {
  toastQueue = [];
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastUndoCleanup) { toastUndoCleanup(); toastUndoCleanup = null; }
  if (toastEl) { toastEl.classList.remove('show'); }
  toastActive = false;
}


// ========== 确认对话框（复用） ==========

/**
 * 显示确认对话框
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.confirmText='确定']
 * @param {string} [opts.cancelText='取消']
 * @param {Function} [opts.onConfirm]
 * @param {Function} [opts.onCancel]
 */
function showConfirm(opts = {}) {
  const { title, message, confirmText = '确定', cancelText = '取消', onConfirm, onCancel } = opts;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:70;display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:85%;max-width:360px;border-radius:16px;padding:24px;text-align:center;">
      <h3 style="margin-bottom:10px;">${title}</h3>
      <p style="font-size:14px;color:#666;margin-bottom:18px;">${message}</p>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="_cfm-cancel">${cancelText}</button>
        <button class="btn btn-primary btn-block" id="_cfm-ok">${confirmText}</button>
      </div>
    </div>`;

  const remove = registerOverlay(overlay);

  overlay.querySelector('#_cfm-cancel').onclick = () => {
    remove();
    if (onCancel) onCancel();
  };
  overlay.querySelector('#_cfm-ok').onclick = () => {
    remove();
    if (onConfirm) onConfirm();
  };

  document.body.appendChild(overlay);
}


// ========== 百度统计 SPA 追踪 ==========

/**
 * 上报单页应用的页面切换（百度统计 _trackPageview）
 * @param {string} path - 页面路径，如 '/home' '/item-list' '/generate'
 */
function trackPage(path) {
  try {
    if (window._hmt) {
      window._hmt.push(['_trackPageview', '/inspection-tool-pro' + path]);
    }
  } catch (e) { /* 统计失败不影响主流程 */ }
}

// ========== HTML 转义 ==========

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}


export { compressImage, registerOverlay, closeAllOverlays, showToast, clearToastQueue, showConfirm, escapeHtml, trackPage };
