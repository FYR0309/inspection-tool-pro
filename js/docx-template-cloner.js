// docx-template-cloner.js — 模板克隆引擎（方案B）
// 从原始 .docx 模板克隆，插入数据行，100% 保留原格式
// 依赖：JSZip（全局）、DOMParser（浏览器内置）
//
// 使用方式：
//   1. 导入模板时：storeOriginalTemplate(file) → 存 ArrayBuffer 到 IndexedDB
//   2. 生成报告时：loadOriginalTemplate(id) → 取回 ArrayBuffer
//   3. cloneTemplateDocx(buffer, items, imageMap) → 插入数据 → 下载

// ---------- OOXML 命名空间 ----------

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

// ---------- 模板存储（在 IndexedDB 中存原始 .docx）----------

/** 将原始 .docx 模板文件存入 IndexedDB */
async function storeOriginalTemplate(templateId, file) {
  const buffer = await file.arrayBuffer();
  const { saveTemplate } = await import('./db.js?v=20260701f');
  // 以 base64 存储（IndexedDB 不能直接存 ArrayBuffer 的某些情况）
  const base64 = arrayBufferToBase64(buffer);
  await saveTemplate({
    id: templateId + '_original',
    name: '_original_docx_' + templateId,
    source: 'docx-original',
    isBuiltin: false,
    data: { docxBase64: base64, fileName: file.name },
  });
}

/** 从 IndexedDB 取回原始 .docx */
async function loadOriginalTemplate(templateId) {
  const { getCustomTemplate } = await import('./db.js?v=20260701f');
  const record = await getCustomTemplate(templateId + '_original');
  if (!record || !record.data || !record.data.docxBase64) return null;
  return base64ToArrayBuffer(record.data.docxBase64);
}

/** 删除原始 .docx 存储 */
async function deleteOriginalTemplate(templateId) {
  const { deleteTemplate } = await import('./db.js?v=20260701f');
  try { await deleteTemplate(templateId + '_original'); } catch (e) { /* ignore */ }
}

// ---------- 工具函数 ----------

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.split(',')[1];
}

/** 图片 data URL → 压缩后的 JPEG base64（用于嵌入 docx） */
function compressImageForDocx(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX = 1000;
      let w = img.width, h = img.height;
      if (w > MAX || h > MAX) {
        const r = Math.min(MAX / w, MAX / h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      let q = 0.85;
      let result = canvas.toDataURL('image/jpeg', q);
      while (result.length > 450 * 1024 && q > 0.3) {
        q -= 0.1;
        result = canvas.toDataURL('image/jpeg', q);
      }
      resolve(result);
    };
    img.src = dataUrl;
  });
}

// ---------- 核心：克隆文档并插入数据 ----------

/**
 * 克隆原始 .docx 模板，插入数据行
 * @param {ArrayBuffer} originalBuffer - 原始 .docx 文件
 * @param {Array} items - 数据行 [{description, beforePhoto, afterPhoto, ...}]
 * @param {Object} templateConfig - 模板配置（列定义等）
 * @returns {Promise<Blob>} 新的 .docx Blob
 */
async function cloneTemplateDocx(originalBuffer, items, templateConfig) {
  const zip = await JSZip.loadAsync(originalBuffer);

  // 1. 读取并修改 document.xml
  let docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error('模板文件缺少 document.xml');

  // 2. 找到表格和数据行模板
  const { tableStart, tableEnd, headerRowEnd, templateRow, colWidths } = findTableInfo(docXml);
  if (!templateRow) throw new Error('模板中未找到数据行');

  // 3. 处理图片：压缩 + 加入 ZIP
  const imageInfos = await prepareImages(items, templateConfig, zip);

  // 4. 构建新的数据行 XML
  const newRowsXml = buildDataRows(items, templateRow, templateConfig, imageInfos);

  // 5. 替换文档中的表格内容
  const beforeTable = docXml.substring(0, tableStart);
  const afterTable = docXml.substring(tableEnd);
  const headerSection = docXml.substring(tableStart, headerRowEnd);
  docXml = beforeTable + headerSection + newRowsXml + afterTable;

  // 6. 更新关系文件（新增图片引用）
  await updateRelations(zip, imageInfos);

  // 7. 更新 [Content_Types].xml
  await updateContentTypes(zip, imageInfos);

  // 8. 更新 docXml 到 ZIP
  zip.file('word/document.xml', docXml);

  // 9. 生成 Blob
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  return blob;
}

// ---------- 表格信息提取 ----------

/** 在 document.xml 字符串中定位表格和模板行 */
function findTableInfo(xml) {
  // 找 <w:tbl 开始和 </w:tbl> 结束
  const tblStart = xml.indexOf('<w:tbl');
  if (tblStart === -1) return {};

  // 找表格结束（嵌套表格不处理，简单找下一个 </w:tbl>）
  const tblEndTag = xml.indexOf('</w:tbl>', tblStart);
  if (tblEndTag === -1) return {};
  const tableEnd = tblEndTag + '</w:tbl>'.length;

  // 在表格内找所有 <w:tr
  const tableXml = xml.substring(tblStart, tableEnd);
  const trMatches = [...tableXml.matchAll(/<w:tr[\s>]/g)];
  if (trMatches.length < 2) return {};

  const firstTrStart = tblStart + trMatches[0].index;
  const secondTrStart = tblStart + trMatches[1].index;

  // 表头行是第一行，数据模板是第二行
  const headerRowEnd = secondTrStart;

  // 找数据模板行的结束
  const templateRowXml = tableXml.substring(trMatches[1].index);
  const templateRowEndTag = templateRowXml.indexOf('</w:tr>');
  const templateRow = templateRowXml.substring(0, templateRowEndTag + '</w:tr>'.length);

  // 提取列宽
  const colWidths = [];
  const gridColRe = /<w:gridCol[^>]*w:w="(\d+)"[^>]*\/>/g;
  let m;
  while ((m = gridColRe.exec(tableXml)) !== null) {
    colWidths.push(parseInt(m[1]));
  }

  return { tableStart: tblStart, tableEnd, headerRowEnd, templateRow, colWidths };
}

// ---------- 图片准备 ----------

async function prepareImages(items, templateConfig, zip) {
  const infos = [];
  const imageCols = (templateConfig.columns || []).filter(c => c.type === 'image');

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    for (let j = 0; j < imageCols.length; j++) {
      const col = imageCols[j];
      const dataUrl = item[col.field];
      if (!dataUrl || !dataUrl.startsWith('data:image')) continue;

      const compressed = await compressImageForDocx(dataUrl);
      const base64 = dataUrlToBase64(compressed);
      const imageName = `image_r${i}_c${j}.jpg`;

      // 加入 ZIP
      zip.file('word/media/' + imageName, base64, { base64: true });

      // 生成 rId
      const rId = 'rId_img_' + (i * imageCols.length + j + 100);

      infos.push({
        rowIndex: i,
        colIndex: templateConfig.columns.indexOf(col),
        imageName,
        rId,
        base64,
      });
    }
  }
  return infos;
}

// ---------- 构建数据行 XML ----------

function buildDataRows(items, templateRow, templateConfig, imageInfos) {
  const columns = templateConfig.columns || [];
  const rows = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let rowXml = templateRow;

    // 找到所有单元格
    const cells = extractCells(rowXml);
    if (cells.length === 0) { rows.push(rowXml); continue; }

    // 处理每个单元格
    const newCells = cells.map((cellXml, ci) => {
      if (ci >= columns.length) return cellXml;
      const col = columns[ci];
      const rowImages = imageInfos.filter(im => im.rowIndex === i && im.colIndex === ci);

      if (col.type === 'number') {
        return replaceCellText(cellXml, String(i + 1));
      } else if (col.type === 'image' && rowImages.length > 0) {
        return replaceCellWithImage(cellXml, rowImages[0]);
      } else if (col.type === 'remark') {
        const text = item.afterPhoto ? '已整改' : '';
        return replaceCellText(cellXml, text);
      } else {
        const text = (col.field && item[col.field]) ? String(item[col.field]) : '';
        return replaceCellText(cellXml, text);
      }
    });

    // 重建行 XML
    let result = rowXml;
    for (let ci = 0; ci < cells.length; ci++) {
      result = result.replace(cells[ci], newCells[ci]);
    }
    rows.push(result);
  }

  return rows.join('');
}

/** 从行 XML 中提取各个 <w:tc>...</w:tc> */
function extractCells(rowXml) {
  const cells = [];
  const re = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
  let m;
  while ((m = re.exec(rowXml)) !== null) {
    cells.push(m[0]);
  }
  return cells;
}

/** 替换单元格中的所有 <w:t> 文字 */
function replaceCellText(cellXml, newText) {
  // 替换所有 <w:t>...</w:t> 和 <w:t xml:space="preserve">...</w:t> 中的文本
  return cellXml.replace(/(<w:t[^>]*>)[^<]*(<\/w:t>)/g, `$1${escapeXml(newText)}$2`);
}

/** 在单元格中替换/插入图片 */
function replaceCellWithImage(cellXml, imageInfo) {
  // 移除单元格中已有的段落内容，替换为一个带图片的段落
  const imgWidth = 192; // displayWidth in EMU-like units (actually we use pixels * 9525)
  const imgWidthEmu = imgWidth * 9525;
  const imgHeightEmu = imgWidth * 9525;
  const drawingId = imageInfo.rowIndex * 100 + imageInfo.colIndex + 1;

  // 移除已有 <w:p> 内容，保留第一个段落结构
  const firstParaEnd = cellXml.indexOf('</w:p>');
  let prefix = '';
  let suffix = '';
  if (firstParaEnd !== -1) {
    prefix = cellXml.substring(0, firstParaEnd + '</w:p>'.length);
    suffix = cellXml.substring(firstParaEnd + '</w:p>'.length);
  } else {
    // 无段落，整个替换
    prefix = '<w:tc><w:tcPr><w:tcW w:w="2800" w:type="dxa"/></w:tcPr>';
    suffix = '</w:tc>';
  }

  // 构建图片段落
  const imagePara = `
<w:p>
  <w:pPr>
    <w:jc w:val="center"/>
  </w:pPr>
  <w:r>
    <w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${imgWidthEmu}" cy="${imgHeightEmu}"/>
        <wp:docPr id="${drawingId}" name="Picture ${drawingId}"/>
        <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:nvPicPr>
                <pic:cNvPr id="${drawingId}" name="Picture ${drawingId}"/>
                <pic:cNvPicPr/>
              </pic:nvPicPr>
              <pic:blipFill>
                <a:blip r:embed="${imageInfo.rId}"/>
                <a:stretch>
                  <a:fillRect/>
                </a:stretch>
              </pic:blipFill>
              <pic:spPr>
                <a:xfrm>
                  <a:off x="0" y="0"/>
                  <a:ext cx="${imgWidthEmu}" cy="${imgHeightEmu}"/>
                </a:xfrm>
                <a:prstGeom prst="rect">
                  <a:avLst/>
                </a:prstGeom>
              </pic:spPr>
            </pic:pic>
          </a:graphicData>
        </a:graphic>
      </wp:inline>
    </w:drawing>
  </w:r>
</w:p>`;

  return prefix + imagePara + suffix;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- 关系文件更新 ----------

async function updateRelations(zip, imageInfos) {
  if (imageInfos.length === 0) return;

  let relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string');
  if (!relsXml) {
    relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  }

  const insertPos = relsXml.lastIndexOf('</Relationships>');
  if (insertPos === -1) return;

  let newRels = '';
  for (const info of imageInfos) {
    newRels += `\n  <Relationship Id="${info.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${info.imageName}"/>`;
  }

  relsXml = relsXml.substring(0, insertPos) + newRels + '\n' + relsXml.substring(insertPos);
  zip.file('word/_rels/document.xml.rels', relsXml);
}

// ---------- Content Types 更新 ----------

async function updateContentTypes(zip, imageInfos) {
  if (imageInfos.length === 0) return;

  let typesXml = await zip.file('[Content_Types].xml')?.async('string');
  if (!typesXml) return;

  // 确保有 jpeg 类型的 Default
  if (!typesXml.includes('Extension="jpeg"') && !typesXml.includes('Extension="jpg"')) {
    const insertPos = typesXml.lastIndexOf('</Types>');
    if (insertPos !== -1) {
      typesXml = typesXml.substring(0, insertPos)
        + '\n  <Default Extension="jpeg" ContentType="image/jpeg"/>'
        + '\n' + typesXml.substring(insertPos);
    }
  }

  zip.file('[Content_Types].xml', typesXml);
}

export { storeOriginalTemplate, loadOriginalTemplate, deleteOriginalTemplate, cloneTemplateDocx };
