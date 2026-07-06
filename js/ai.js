// ai.js — 直接调用 AI API（无需后端代理）

const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DOUBAO_API_KEY = 'ark-4b152d9d-0ad1-4e65-838f-a52f264ff4ea-12064';
const DOUBAO_MODEL = 'ep-20260616232549-wr6bn';

// 火山方舟图片编辑 API (images/generations)
// 使用 Seedream 4.5 图生图，单独 API Key 授权
const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const IMAGE_EDIT_MODEL = 'ep-20260619024752-vbxk7';  // 必须用 endpoint ID，不能用模型名
const IMAGE_API_KEY = 'ark-a5912081-882c-4cbf-917b-e9cac733f0d8-894c4';

function buildPrompt(text, reportType) {
  const typeLabel = reportType === 'safety' ? '安全检查' : '现场管理';

  let extraInstruction = '';
  if (reportType === 'safety') {
    extraInstruction = '在每条润色后的文字末尾，用逗号自然衔接，直接说明存在什么风险或隐患或危险（不要用"风险："等标签），不超过15个汉字。例如"…，存在火灾隐患"、"…，有触电危险"';
  } else {
    extraInstruction = '在每条润色后的文字末尾，用逗号自然衔接，直接说明带来的影响或后果（不要用"影响："等标签），不超过15个汉字。例如"…，影响现场整洁"、"…，降低工作效率"';
  }

  return `你是一个专业的工厂安全/现场管理文档撰写助手。请将以下口语化的问题描述优化为规范的整改报告书面语言。

原始描述：${text}
报告类型：${typeLabel}

要求：
1. 将口语转为正式书面语，修正错别字和语病
2. 保持原意，不添加不存在的问题细节
3. ${extraInstruction}
4. 生成3个表达风格略有不同的版本（可以详略不同、措辞不同），以JSON数组格式输出

请严格按以下JSON格式输出，不要输出其他内容：
{"options": ["版本1的完整文字", "版本2的完整文字", "版本3的完整文字"]}`;
}

/**
 * 调用豆包 API 优化文字
 * @param {string} text - 原始描述
 * @param {string} reportType - 'safety' | '5s' | 'company'
 * @returns {Promise<string[]>} 3个优化后的选项
 */
async function callDoubaoOptimize(text, reportType, signal) {
  const response = await fetch(DOUBAO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DOUBAO_API_KEY}`
    },
    signal,
    body: JSON.stringify({
      model: DOUBAO_MODEL,
      messages: [
        { role: 'user', content: buildPrompt(text, reportType) }
      ],
      temperature: 0.8,
      max_tokens: 2000
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`豆包 API 返回错误 ${response.status}: ${errText}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || '';

  // 解析 JSON
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        const lines = content.split('\n').filter(l => l.trim());
        parsed = { options: lines.slice(0, 3) };
      }
    } else {
      parsed = { options: [content] };
    }
  }

  const options = (parsed.options || []).slice(0, 3);
  if (options.length === 0) {
    options.push(content.trim());
  }
  while (options.length < 3) {
    options.push(options[0] || content.trim());
  }

  return options;
}

// ---------- 浏览器端图片压缩 ----------

function compressImageBrowser(dataUrl, maxPx = 1024, maxKB = 500) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          const ratio = Math.min(maxPx / w, maxPx / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        let quality = 0.85;
        let result = canvas.toDataURL('image/jpeg', quality);
        while (result.length > maxKB * 1024 && quality > 0.3) {
          quality -= 0.1;
          result = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(result);
      } catch (e) {
        reject(new Error('图片压缩失败'));
      }
    };
    img.onerror = () => reject(new Error('图片加载失败，请重试'));
    img.src = dataUrl;
  });
}

// ---------- 火山方舟 图生图 ----------

/**
 * 调用火山方舟 images/generations API（Seedream 图生图）
 * 和豆包 AI 润色是同一平台，已验证手机可直连
 * @param {string} imageDataUrl - base64 图片
 * @param {string} prompt - 修改指令
 * @param {function} [onProgress] - 进度回调 (msg: string)
 * @returns {Promise<{success: boolean, image?: string, error?: string}>}
 */
async function callImageEdit(imageDataUrl, prompt, onProgress) {
  const report = (msg) => { console.log('[修图]', msg); if (onProgress) onProgress(msg); };

  try {
    // 1. 压缩图片
    report('正在压缩图片...');
    let compressed;
    try {
      compressed = await compressImageBrowser(imageDataUrl, 1024, 450);
    } catch (e) {
      console.warn('[修图] 压缩失败，使用原图:', e.message);
      compressed = imageDataUrl;
    }

    // 2. 调用火山方舟 images/generations（同步返回，无需轮询）
    report('AI 正在修图（约10-30秒）...');

    let response;
    try {
      response = await fetch(`${ARK_BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${IMAGE_API_KEY}`,
        },
        body: JSON.stringify({
          model: IMAGE_EDIT_MODEL,
          prompt: prompt.trim(),
          image: [compressed],                // 必须是数组！即使是单张图片
          size: '2K',
          response_format: 'b64_json',        // 直接返回 base64，无需下载
          watermark: false,                   // 不要水印
          sequential_image_generation: 'disabled',  // 单图编辑模式
        }),
        signal: (typeof AbortSignal.timeout === 'function')
          ? AbortSignal.timeout(120000)
          : null,
      });
    } catch (e) {
      if (e.name === 'TimeoutError') {
        throw new Error('修图超时（2分钟），请检查网络后重试');
      }
      throw new Error('网络连接失败，请检查网络后重试');
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[修图] API 错误:', response.status, errText);

      // 尝试解析错误详情
      let errMsg = '';
      try { const errJson = JSON.parse(errText); errMsg = errJson.error?.message || errJson.error?.code || ''; } catch {}
      if (errMsg) console.error('[修图] 错误详情:', errMsg);

      // 给出具体错误提示（带原始响应用于排查）
      if (response.status === 400) {
        throw new Error(errMsg || errText.slice(0, 200) || '请求格式错误');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('API Key 无权访问图片模型，可能需要开通服务');
      }
      if (response.status === 429) {
        throw new Error('请求太频繁，请稍后重试');
      }
      if (response.status >= 500) {
        throw new Error('AI 服务繁忙，请稍后重试');
      }
      throw new Error(`修图失败(${response.status})，请稍后重试`);
    }

    const result = await response.json();

    // 3. 提取结果图片
    if (result.data && result.data[0]) {
      const item = result.data[0];
      let resultImage;

      // 调试日志：打印响应结构，方便排查
      console.log('[修图] 响应 data[0] keys:', Object.keys(item).join(', '));
      if (item.b64_json) {
        console.log('[修图] b64_json 长度:', item.b64_json.length);
      }
      if (item.url) {
        console.log('[修图] url:', item.url.substring(0, 100));
      }

      if (item.b64_json && item.b64_json.length > 100) {
        // 直接拿到 base64，立即可用
        resultImage = 'data:image/jpeg;base64,' + item.b64_json;
        console.log('[修图] 完成（base64），大小:', (item.b64_json.length / 1024).toFixed(0) + 'KB');
      } else if (item.url) {
        // 备用：下载 URL。火山 CDN 在部分手机网络可能不通，尝试多种方式
        report('正在下载结果...');
        let blob = null;

        // 方式1: fetch 直连
        try {
          const imgRes = await fetch(item.url);
          if (imgRes.ok) {
            blob = await imgRes.blob();
          }
        } catch (e) {
          console.warn('[修图] fetch 下载失败:', e.message);
        }

        // 方式2: Image 元素加载 + Canvas 导出（绕过 CORS 限制）
        if (!blob) {
          console.log('[修图] 尝试 Image+Canvas 方式...');
          try {
            blob = await new Promise((resolve, reject) => {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob((b) => {
                  if (b) resolve(b);
                  else reject(new Error('Canvas toBlob 失败'));
                }, 'image/jpeg', 0.9);
              };
              img.onerror = () => reject(new Error('Image 加载失败'));
              img.src = item.url;
            });
          } catch (e) {
            console.warn('[修图] Image+Canvas 也失败:', e.message);
          }
        }

        if (!blob) {
          throw new Error('下载结果失败：CDN 不可达，请刷新页面后重试（新版本已修复此问题）');
        }

        resultImage = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(blob);
        });
        console.log('[修图] 完成（URL下载），大小:', (blob.size / 1024).toFixed(0) + 'KB');
      } else {
        console.error('[修图] 响应无有效图片数据:', JSON.stringify(item).substring(0, 200));
        throw new Error('修图完成但未返回图片');
      }

      return { success: true, image: resultImage };
    }

    console.error('[修图] 响应无 data 数组:', JSON.stringify(result).substring(0, 200));
    throw new Error('修图完成但未返回图片');

  } catch (e) {
    console.error('[修图] 异常:', e.message);
    throw e;
  }
}

// ---------- 优化修图指令 ----------

/**
 * 调用豆包 API 将粗糙的修图指令扩展为详细的专业提示词
 * @param {string} roughPrompt - 用户输入的简短指令
 * @returns {Promise<string>} 优化后的详细提示词
 */
async function callOptimizePrompt(roughPrompt) {
  const response = await fetch(DOUBAO_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DOUBAO_API_KEY}`
    },
    body: JSON.stringify({
      model: DOUBAO_MODEL,
      messages: [
        {
          role: 'user',
          content: `你是一个专业的图片编辑指令优化助手。请将用户简短、口语化的修图指令扩展为详细、专业的图片编辑提示词（中文）。

要求：
1. 补充细节描述（光线、色彩、清晰度、构图等）
2. 保持原意，不添加用户没提到的修改内容
3. 输出控制在50字以内，简洁有效
4. 只输出优化后的提示词，不要加任何解释

用户指令：${roughPrompt}

优化后的提示词：`
        }
      ],
      temperature: 0.7,
      max_tokens: 200
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('[优化指令] API 错误:', response.status, errText);
    throw new Error('AI 优化失败，请稍后重试');
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || '';
  return content.trim() || roughPrompt;
}

export { callDoubaoOptimize, callImageEdit, callOptimizePrompt };
