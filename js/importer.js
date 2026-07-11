// importer.js — .docx 导入解析 + 照片 OCR
// 依赖全局 JSZip 对象（index.html 中引入）

import { DOUBAO_API_URL, DOUBAO_API_KEY, DOUBAO_MODEL } from './config.js?v=20260711g';
import { compressImage } from './utils.js?v=20260711g';

/**
 * 解析 .docx 文件，提取问题条目
 * 支持本工具生成的格式，也尝试通用解析（按模板列结构）
 * @param {File} file — .docx 文件
 * @returns {Promise<{items: Array}>}
 */
async function parseDocx(file) {
  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) {
    throw new Error('无法读取文档内容，请确认是有效的 .docx 文件');
  }

  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(docXml, 'text/xml');

  const parseError = xmlDoc.querySelector('parsererror');
  if (parseError) {
    throw new Error('文档 XML 解析失败，文件可能已损坏');
  }

  const rows = xmlDoc.querySelectorAll('w\\:tbl w\\:tr, tbl tr');
  if (rows.length < 2) {
    throw new Error('未在文档中找到问题条目。仅支持本工具生成的报告格式');
  }

  // 提取图片关系映射 (rId → media/imageN.jpeg)
  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  const imageMap = {};
  if (relsXml) {
    const relsDoc = parser.parseFromString(relsXml, 'text/xml');
    const relationships = relsDoc.querySelectorAll('Relationship');
    relationships.forEach(rel => {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (target && target.startsWith('media/')) {
        imageMap[id] = target;
      }
    });
  }

  // 逐行解析（跳过表头第一行）
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const cells = row.querySelectorAll('w\\:tc, tc');

    const item = {
      description: '',
      beforePhoto: '',
      afterPhoto: '',
      status: '待整改',
    };

    const cellCount = cells.length;

    if (cellCount >= 5) {
      // 通用解析：前几列找文字描述，后几列找图片
      // 尝试识别列结构
      const texts = [];
      const images = [];
      for (const cell of cells) {
        const text = extractCellText(cell);
        const img = await extractCellImage(cell, zip, imageMap);
        if (img) images.push(img);
        if (text) texts.push(text);
      }
      // 最长的文字当描述
      if (texts.length > 0) {
        item.description = texts.reduce((a, b) => a.length >= b.length ? a : b);
      }
      // 前两张图片分别当作整改前/后
      if (images.length >= 2) {
        item.beforePhoto = images[0];
        item.afterPhoto = images[1];
      } else if (images.length === 1) {
        item.beforePhoto = images[0];
      }
      // 检查是否已整改
      const allText = Array.from(cells).map(c => extractCellText(c)).join('');
      if (allText.includes('已整改')) item.status = '已整改';
    } else {
      continue;
    }

    if (!item.description && !item.beforePhoto && !item.afterPhoto) continue;
    items.push(item);
  }

  if (items.length === 0) {
    throw new Error('未从文档中提取到问题条目');
  }

  return { items };
}

function extractCellText(cell) {
  if (!cell) return '';
  const texts = cell.querySelectorAll('w\\:t, t');
  return Array.from(texts).map(t => t.textContent || '').join('').trim();
}

async function extractCellImage(cell, zip, imageMap) {
  if (!cell) return '';

  const blips = cell.querySelectorAll('a\\:blip, blip');
  for (const blip of blips) {
    const embed = blip.getAttribute('r:embed') || blip.getAttribute('embed');
    if (!embed) continue;

    const mediaPath = imageMap[embed];
    if (!mediaPath) continue;

    const imageFile = zip.file('word/' + mediaPath);
    if (!imageFile) continue;

    const imageData = await imageFile.async('base64');
    const ext = mediaPath.split('.').pop().toLowerCase();
    const mimeMap = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', bmp: 'bmp', webp: 'webp' };
    const mime = mimeMap[ext] || 'jpeg';

    return `data:image/${mime};base64,${imageData}`;
  }

  return '';
}

// ---------- 照片 OCR ----------

async function parsePhoto(photo) {
  let dataUrl;
  if (photo instanceof File) {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(photo);
    });
  } else {
    dataUrl = photo;
  }

  const compressed = await compressImageForOCR(dataUrl);
  const base64Data = compressed.split(',')[1] || compressed;

  try {
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
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${base64Data}` }
              },
              {
                type: 'text',
                text: '请识别这张安全检查照片中的问题，用简洁的整改报告书面语言描述。只输出一句话的问题描述，不要加序号、标签或解释。'
              }
            ]
          }
        ],
        temperature: 0.3,
        max_tokens: 300
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('[OCR] API 错误:', response.status, errText.substring(0, 200));
      if (response.status === 400) {
        console.warn('[OCR] 模型可能不支持视觉，降级为纯图片导入');
        return { description: '（请手动填写问题描述）', photo: dataUrl };
      }
      throw new Error(`AI 识别失败(${response.status})`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    const description = content.trim();

    return {
      description: description || '（AI 未能识别，请手动描述）',
      photo: dataUrl,
    };
  } catch (e) {
    console.warn('[OCR] 请求异常，降级为纯图片导入:', e.message);
    return { description: '（请手动填写问题描述）', photo: dataUrl };
  }
}

function compressImageForOCR(dataUrl, maxKB = 800) {
  return compressImage(dataUrl, { maxPx: 1500, maxKB, quality: 0.9 });
}

export { parseDocx, parsePhoto };
