// camera-voice.js — 拍照 + 语音识别 + 图片压缩

// ---------- 拍照 ----------

function takePhoto() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';

    input.onchange = () => {
      const file = input.files[0];
      if (!file) return reject(new Error('未选择照片'));
      const reader = new FileReader();
      reader.onload = () => {
        // 拍照后立即压缩到合理大小（节省 IndexedDB 存储空间）
        compressForStorage(reader.result).then(resolve).catch(() => resolve(reader.result));
      };
      reader.onerror = () => reject(new Error('读取照片失败'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

/** 存储压缩：限制宽度 1200px，质量 0.8，约 300-500KB */
function compressForStorage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX_W = 1200;
      let w = img.width, h = img.height;
      if (w > MAX_W) {
        const ratio = MAX_W / w;
        w = MAX_W;
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = dataUrl;
  });
}

// ---------- 语音识别 ----------

function startVoiceRecognition({ onResult, onInterim, onEnd, onError }) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    onError(new Error('当前浏览器不支持语音识别。请使用 Safari 或 Chrome 浏览器打开本页面。\n\n提示：微信内置浏览器不支持语音功能，请点击右上角「在浏览器中打开」。'));
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let finalText = '', interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    if (finalText) onResult(finalText);
    if (interimText) onInterim(interimText);
  };

  recognition.onerror = (event) => {
    switch (event.error) {
      case 'not-allowed':
        onError(new Error('麦克风权限被拒绝。请在手机设置 → Safari/浏览器 → 允许麦克风权限。'));
        break;
      case 'no-speech':
        onError(new Error('未检测到语音，请靠近话筒再试一次。'));
        break;
      case 'network':
        onError(new Error('语音识别需要网络连接，请检查网络后重试。'));
        break;
      case 'aborted':
        break;
      default:
        onError(new Error(`语音识别失败(${event.error})。请改用文字输入，或在 Safari 浏览器中打开。`));
    }
  };

  recognition.onend = () => onEnd();
  recognition.start();
  return recognition;
}

export { takePhoto, compressForStorage, startVoiceRecognition };
