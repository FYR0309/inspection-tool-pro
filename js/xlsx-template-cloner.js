// xlsx-template-cloner.js — XLSX 模板克隆引擎
// 从原始 .xlsx 模板克隆，插入数据行，100% 保留原格式
// 依赖：JSZip（全局）
//
// 使用方式：
//   1. 导入模板时：storeOriginalXlsxTemplate(file) → 存 ArrayBuffer 到 IndexedDB
//   2. 生成报告时：loadOriginalXlsxTemplate(id) → 取回 ArrayBuffer
//   3. cloneTemplateXlsx(buffer, items, templateConfig) → 填充数据 → 下载

// ---------- 模板存储（在 IndexedDB 中存原始 .xlsx）----------

/** 将原始 .xlsx 模板文件存入 IndexedDB */
async function storeOriginalXlsxTemplate(templateId, file) {
  let buffer;
  if (file instanceof ArrayBuffer) {
    buffer = file;
  } else if (file.arrayBuffer) {
    buffer = await file.arrayBuffer();
  } else {
    throw new Error('无法读取文件');
  }
  const fileName = file.name || 'template.xlsx';
  const { saveTemplate } = await import('./db.js?v=20260712a');
  const base64 = arrayBufferToBase64(buffer);
  await saveTemplate({
    id: templateId + '_original_xlsx',
    name: '_original_xlsx_' + templateId,
    source: 'xlsx-original',
    isBuiltin: false,
    data: { xlsxBase64: base64, fileName },
  });
}

/** 从 IndexedDB 取回原始 .xlsx */
async function loadOriginalXlsxTemplate(templateId) {
  const { getCustomTemplate } = await import('./db.js?v=20260712a');
  const record = await getCustomTemplate(templateId + '_original_xlsx');
  if (!record || !record.data || !record.data.xlsxBase64) return null;
  return base64ToArrayBuffer(record.data.xlsxBase64);
}

/** 删除原始 .xlsx 存储 */
async function deleteOriginalXlsxTemplate(templateId) {
  const { deleteTemplate } = await import('./db.js?v=20260712a');
  try { await deleteTemplate(templateId + '_original_xlsx'); } catch (e) { /* ignore */ }
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

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 列索引（0-based）→ 列字母（A, B, ..., Z, AA, AB, ...） */
function encodeCol(n) {
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

// ---------- 核心：克隆 XLSX 并填充数据 ----------

/**
 * 克隆原始 .xlsx 模板，插入数据行
 * @param {ArrayBuffer} originalBuffer - 原始 .xlsx 文件
 * @param {Array} items - 数据行 [{description, ...}]
 * @param {Object} templateConfig - 模板配置（列定义、数据区域等）
 * @returns {Promise<Blob>} 新的 .xlsx Blob
 */
async function cloneTemplateXlsx(originalBuffer, items, templateConfig) {
  const zip = await JSZip.loadAsync(originalBuffer);

  // 1. 找到目标 Sheet 的 XML 文件
  const sheetPath = findSheetPath(zip, templateConfig);
  if (!sheetPath) throw new Error('模板中未找到工作表');

  let sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error(`无法读取工作表: ${sheetPath}`);

  // 2. 解析数据区域
  const region = templateConfig.dataRegion;
  const columns = templateConfig.columns || [];

  // 3. 提取模板行（第一个数据行的 XML）
  const templateRow = extractTemplateRow(sheetXml, region);
  if (!templateRow) throw new Error('模板中未找到数据行');

  // 4. 删除旧的数据行（保留表头）
  sheetXml = removeDataRows(sheetXml, region);

  // 5. 构建新的数据行
  const newRowsXml = buildDataRows(items, templateRow, columns, region);

  // 6. 插入新数据行（在表头之后）
  sheetXml = insertDataRows(sheetXml, region.headerRow, newRowsXml);

  // 7. 更新合并单元格范围
  sheetXml = updateMergedCells(sheetXml, region, items.length);

  // 8. 写回 ZIP
  zip.file(sheetPath, sheetXml);

  // 9. 生成 Blob
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return blob;
}

// ---------- Sheet 路径查找 ----------

/** 在 XLSX ZIP 中找到指定 Sheet 的路径 */
function findSheetPath(zip, templateConfig) {
  const sheetIndex = templateConfig.sheetIndex;
  if (sheetIndex !== undefined) {
    // XLSX 内部文件名是 xl/worksheets/sheetN.xml（N 从 1 开始）
    const path = `xl/worksheets/sheet${sheetIndex + 1}.xml`;
    if (zip.file(path)) return path;
  }

  // 降级：尝试 sheet1
  if (zip.file('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';

  // 最后尝试按名称匹配
  const sheetName = templateConfig.sheetName || 'Sheet1';
  const namePath = `xl/worksheets/${sheetName.toLowerCase()}.xml`;
  if (zip.file(namePath)) return namePath;

  return 'xl/worksheets/sheet1.xml';
}

// ---------- 提取模板行 ----------

/** 从 sheet XML 中提取第一个数据行 */
function extractTemplateRow(sheetXml, region) {
  const dataStart = region.dataStart;
  // 行号在 XML 中以 r="N" 形式表示
  const rowRe = new RegExp(`<row r="${dataStart}"[^>]*>[\\s\\S]*?<\\/row>`);
  const match = sheetXml.match(rowRe);
  return match ? match[0] : null;
}

// ---------- 删除旧数据行 ----------

function removeDataRows(sheetXml, region) {
  // 删除 dataStart 到 dataEnd 之间的行
  // 使用正则匹配 <row r="N" ...>...</row>
  const dataStart = region.dataStart;
  const dataEnd = region.dataEnd;

  // 收集需要删除的行号范围
  const rowPattern = /<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g;
  let result = sheetXml;
  let match;
  const rowsToRemove = [];

  while ((match = rowPattern.exec(sheetXml)) !== null) {
    const rowNum = parseInt(match[1]);
    if (rowNum >= dataStart && rowNum <= dataEnd) {
      rowsToRemove.push({ xml: match[0], index: match.index, endIndex: match.index + match[0].length });
    }
  }

  // 从后往前删除
  for (let i = rowsToRemove.length - 1; i >= 0; i--) {
    const r = rowsToRemove[i];
    result = result.substring(0, r.index) + result.substring(r.endIndex);
  }

  return result;
}

// ---------- 构建数据行 ----------

function buildDataRows(items, templateRow, columns, region) {
  const rows = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const rowNum = region.dataStart + i; // dataStart 是 1-indexed XML 行号
    let rowXml = templateRow.replace(/r="\d+"/, `r="${rowNum}"`);

    // 替换每个单元格
    for (let ci = 0; ci < columns.length; ci++) {
      const col = columns[ci];
      const colLetter = col.colLetter || encodeCol(ci);
      const cellRef = colLetter + rowNum;

      // 在模板行中找到对应列的单元格
      const cellPattern = new RegExp(
        `<c r="${colLetter}\\d+"[^>]*>[\\s\\S]*?<\\/c>`,
        'g'
      );

      // 按顺序匹配（避免列字母重叠问题如 A 和 AA）
      const allMatches = [];
      let cm;
      const globalPattern = /<c r="([A-Z]+)\d+"[^>]*>[\s\S]*?<\/c>/g;
      while ((cm = globalPattern.exec(templateRow)) !== null) {
        allMatches.push({ col: cm[1], full: cm[0], index: cm.index });
      }

      const matchingCell = allMatches.find(m => m.col === colLetter);

      if (matchingCell) {
        const newCell = buildCellXml(matchingCell.full, col, item, colLetter, rowNum, i);
        rowXml = rowXml.replace(matchingCell.full, newCell);
      }
    }

    rows.push(rowXml);
  }

  return rows.join('\n');
}

/** 构建单个单元格 XML */
function buildCellXml(originalCell, col, item, colLetter, rowNum, itemIndex) {
  const ref = `${colLetter}${rowNum}`;
  const styleMatch = originalCell.match(/s="(\d+)"/);
  const styleAttr = styleMatch ? ` s="${styleMatch[1]}"` : '';

  let value;
  switch (col.type) {
    case 'number':
      value = String(itemIndex + 1); // 序号：1, 2, 3...
      break;
    case 'description':
      value = item.description || '';
      break;
    case 'date':
      value = item[col.field] || '';
      break;
    case 'number_val':
      value = item[col.field] !== undefined ? String(item[col.field]) : '';
      break;
    case 'text':
    default:
      value = (col.field && item[col.field]) ? String(item[col.field]) : '';
      break;
  }

  // 使用 inline string，不污染共享字符串表
  return `<c r="${ref}" t="inlineStr"${styleAttr}><is><t>${escapeXml(value)}</t></is></c>`;
}

// ---------- 插入数据行 ----------

function insertDataRows(sheetXml, headerRow, newRowsXml) {
  // 在表头行后面插入数据行
  const headerRowPattern = new RegExp(`(<row r="${headerRow}"[^>]*>[\\s\\S]*?<\\/row>)`);
  const match = sheetXml.match(headerRowPattern);

  if (match) {
    const insertPos = match.index + match[0].length;
    return sheetXml.substring(0, insertPos) + '\n' + newRowsXml + sheetXml.substring(insertPos);
  }

  // 如果找不到表头行，尝试在 <sheetData> 之后插入
  const sheetDataMatch = sheetXml.match(/<sheetData>/);
  if (sheetDataMatch) {
    const insertPos = sheetDataMatch.index + '<sheetData>'.length;
    return sheetXml.substring(0, insertPos) + '\n' + newRowsXml + sheetXml.substring(insertPos);
  }

  return sheetXml;
}

// ---------- 更新合并单元格 ----------

function updateMergedCells(sheetXml, region, itemCount) {
  // 合并单元格范围如：<mergeCell ref="A3:A5"/>
  // 如果数据行数变了，合并范围需要调整
  // 简单策略：移除原有的数据区域合并（保留表头合并），用户模板通常不会有数据区合并

  const mergeCellsMatch = sheetXml.match(/<mergeCells>[\s\S]*?<\/mergeCells>/);
  if (!mergeCellsMatch) return sheetXml;

  // 检查是否有合并范围覆盖到数据行
  let needsUpdate = false;
  const oldMergeCells = mergeCellsMatch[0];
  const newMerges = [];
  const mergeRe = /<mergeCell ref="([^"]+)"/g;
  let m;
  while ((m = mergeRe.exec(oldMergeCells)) !== null) {
    const ref = m[1];
    const parts = ref.split(':');
    if (parts.length === 2) {
      const startRow = parseInt(parts[0].replace(/[A-Z]+/, ''));
      const endRow = parseInt(parts[1].replace(/[A-Z]+/, ''));
      if (startRow >= region.dataStart) {
        // 数据区域的合并 → 移除（数据行数变了，合并没意义）
        needsUpdate = true;
        continue;
      }
    }
    newMerges.push(m[0]);
  }

  if (needsUpdate) {
    if (newMerges.length > 0) {
      const newMergeCells = '<mergeCells count="' + newMerges.length + '">\n  ' + newMerges.join('\n  ') + '\n</mergeCells>';
      sheetXml = sheetXml.replace(mergeCellsMatch[0], newMergeCells);
    } else {
      sheetXml = sheetXml.replace(mergeCellsMatch[0], '');
    }
  }

  return sheetXml;
}

export {
  storeOriginalXlsxTemplate,
  loadOriginalXlsxTemplate,
  deleteOriginalXlsxTemplate,
  cloneTemplateXlsx,
};
