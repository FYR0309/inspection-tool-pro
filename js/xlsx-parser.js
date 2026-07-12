// xlsx-parser.js — Excel 模板解析器
// 从 .xlsx 文件中提取表格结构、样式，转换为模板 JSON
// 依赖：xlsx-js-style（全局 XLSX）、JSZip（全局）
// 与 docx-parser.js 共享列类型识别逻辑

import { DOUBAO_API_URL, DOUBAO_API_KEY, DOUBAO_MODEL } from './config.js';

// XLSX 列类型关键词（不同于 DOCX：没有"照片"，有"日期""数字"）
const XLSX_TYPE_KEYWORDS = {
  number:      ['序号', '编号', 'No.', '项次', '检查序号', '隐患编号', '问题编号', 'NO', 'serial', '#'],
  description: ['问题', '描述', '隐患', '检查发现', '不符合', '存在问题', '检查情况',
                '检查内容', '检查项目', '具体描述', '现象', '情况', '不合格项', '检查事项',
                '区域', '位置', '地点', '巡检区域', '检查部位'],
  date:        ['日期', '时间', '检查日期', '整改期限', '完成时间', '期限', '记录日期', '巡检日期'],
  number_val:  ['数量', '次数', '件数', '个数', '分值', '得分', '评分', '温度', '压力', '读数'],
};

/** 根据列头文字猜测列类型 */
function guessXlsxColumnType(headerText) {
  const text = headerText.trim();
  for (const [type, keywords] of Object.entries(XLSX_TYPE_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return type;
    }
  }
  return null;
}

/** 映射关键词类型到模板列类型 */
function mapToColumnType(keywordType, index) {
  switch (keywordType) {
    case 'number':      return { type: 'number', field: '_index' };
    case 'description': return { type: 'description', field: 'description' };
    case 'date':        return { type: 'date', field: 'date_' + index };
    case 'number_val':  return { type: 'number_val', field: 'num_' + index };
    default:            return { type: 'text', field: 'text_' + index };
  }
}

// ---------- Sheet 检测 ----------

/**
 * 检测哪些 Sheet 包含数据
 * @returns {Array<{name: string, index: number, rowCount: number, colCount: number, hasHeader: boolean}>}
 */
function detectSheets(workbook) {
  const sheets = [];
  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const name = workbook.SheetNames[i];
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;

    // 计算有效行数和列数
    const ref = sheet['!ref'];
    if (!ref) { sheets.push({ name, index: i, rowCount: 0, colCount: 0, hasHeader: false }); continue; }

    const range = XLSX.utils.decode_range(ref);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;

    // 统计非空单元格数
    let nonEmptyCells = 0;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
          nonEmptyCells++;
        }
      }
    }

    // 检测第一行是否像表头（有文字内容的单元格比例 > 50%）
    let headerCells = 0, totalCells = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      totalCells++;
      const addr = XLSX.utils.encode_cell({ r: range.s.r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
        headerCells++;
      }
    }
    const hasHeader = totalCells > 0 && (headerCells / totalCells) > 0.4;

    sheets.push({ name, index: i, rowCount, colCount, nonEmptyCells, hasHeader });
  }
  return sheets;
}

/**
 * 决定使用哪个 Sheet
 * @returns {{ auto: boolean, sheetName?: string, sheets?: Array, message?: string }}
 */
function selectSheet(workbook) {
  const sheets = detectSheets(workbook);

  const sheetsWithData = sheets.filter(s => s.nonEmptyCells > 2);

  if (sheetsWithData.length === 0) {
    // 全部空，用第一个
    return { auto: true, sheetName: sheets[0]?.name || workbook.SheetNames[0] };
  }

  if (sheetsWithData.length === 1) {
    return { auto: true, sheetName: sheetsWithData[0].name };
  }

  // 多个 Sheet 都有数据，需要用户选择
  return {
    auto: false,
    sheets: sheetsWithData,
    message: `检测到 ${sheetsWithData.length} 个工作表都包含数据`,
  };
}

// ---------- 数据区域检测 ----------

/**
 * 从 Sheet 中检测数据区域
 * @returns {{ headerRow: number, dataStart: number, dataEnd: number, colStart: number, colEnd: number }}
 */
function detectDataRegion(sheet) {
  const ref = sheet['!ref'];
  if (!ref) return { headerRow: 0, dataStart: 1, dataEnd: 0, colStart: 0, colEnd: 0 };

  const range = XLSX.utils.decode_range(ref);

  // 找表头行：第一行非空比例 > 40% 的行
  let headerRow = range.s.r;
  let bestRatio = 0;

  // 检查前 3 行，找到最像表头的
  for (let r = range.s.r; r <= Math.min(range.s.r + 2, range.e.r); r++) {
    let filled = 0, total = 0;
    for (let c = range.s.c; c <= range.e.c; c++) {
      total++;
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
        filled++;
      }
    }
    const ratio = total > 0 ? filled / total : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      headerRow = r;
    }
  }

  // 数据开始行 = 表头下一行
  const dataStart = headerRow + 1;

  // 数据结束行：找到连续有数据的最后一行（允许有一行空行间隔）
  let dataEnd = range.e.r;
  let emptyCount = 0;
  for (let r = dataStart; r <= range.e.r; r++) {
    let hasData = false;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
        hasData = true;
        break;
      }
    }
    if (!hasData) {
      emptyCount++;
      if (emptyCount >= 3) { dataEnd = r - 3; break; }
    } else {
      emptyCount = 0;
    }
  }

  return { headerRow, dataStart, dataEnd, colStart: range.s.c, colEnd: range.e.c };
}

// ---------- 主解析函数 ----------

/**
 * 解析 .xlsx 文件，返回模板 JSON
 * @param {File|ArrayBuffer} file - .xlsx 文件
 * @param {string} [sheetName] - 指定 Sheet（如果之前选了）
 * @returns {Promise<Object>} { success, template?, sheets?, error? }
 */
async function parseXlsxTemplate(file, sheetName) {
  let buffer;
  if (file instanceof ArrayBuffer) {
    buffer = file;
  } else {
    buffer = await file.arrayBuffer();
  }

  // 1. 读取 workbook
  let workbook;
  try {
    workbook = XLSX.read(new Uint8Array(buffer), { type: 'array', cellStyles: true });
  } catch (e) {
    return { success: false, error: '无法解析 .xlsx 文件，请确认文件格式正确' };
  }

  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { success: false, error: '文件中未找到工作表' };
  }

  // 2. Sheet 选择
  if (!sheetName) {
    const selection = selectSheet(workbook);
    if (!selection.auto) {
      return {
        success: true,
        needsSheetSelection: true,
        sheets: selection.sheets,
        message: selection.message,
        _workbook: workbook, // 暂存，选完 Sheet 后再解析
        _buffer: buffer,     // 传递 buffer 避免 File 重复读取
      };
    }
    sheetName = selection.sheetName;
  }

  // 3. 解析选定的 Sheet
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return { success: false, error: `未找到工作表 "${sheetName}"` };
  }

  const region = detectDataRegion(sheet);
  if (region.dataEnd <= region.dataStart) {
    return { success: false, error: '未检测到数据行，请确认工作表包含表格数据' };
  }

  // 4. 提取列头
  const headers = [];
  for (let c = region.colStart; c <= region.colEnd; c++) {
    const addr = XLSX.utils.encode_cell({ r: region.headerRow, c });
    const cell = sheet[addr];
    const text = cell ? String(cell.v || '').trim() : '';
    headers.push({ index: c, label: text, colLetter: XLSX.utils.encode_col(c) });
  }

  // 过滤全空列
  const validHeaders = headers.filter(h => h.label.length > 0);
  if (validHeaders.length === 0) {
    return { success: false, error: '表头行为空，无法识别列结构' };
  }

  // 5. 列类型识别
  const unknowns = [];
  const columns = validHeaders.map((header, i) => {
    const guessed = guessXlsxColumnType(header.label);
    const mapped = mapToColumnType(guessed, i);

    if (!guessed) {
      unknowns.push({ index: i, header: header.label, guessedType: null });
    }

    return {
      label: header.label,
      field: mapped.field,
      type: mapped.type,
      colLetter: header.colLetter,
      originalIndex: header.index,
    };
  });

  // 6. 提取表头样式（用于模板预览）
  let headerStyle = null;
  try {
    const firstHeaderAddr = XLSX.utils.encode_cell({ r: region.headerRow, c: validHeaders[0].originalIndex });
    const firstHeaderCell = sheet[firstHeaderAddr];
    if (firstHeaderCell && firstHeaderCell.s) {
      headerStyle = firstHeaderCell.s;
    }
  } catch (e) { /* ignore */ }

  // 7. 组装模板 JSON
  const templateName = sheetName !== workbook.SheetNames[0]
    ? sheetName
    : (workbook.SheetNames[0] || '导入模板') + '_' + new Date().toISOString().slice(0, 10);

  // 获取 Sheet 索引（用于克隆时定位 sheetN.xml）
  const wbSheets = workbook.SheetNames;
  const sheetIndex = wbSheets.indexOf(sheetName);

  const template = {
    id: 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: templateName,
    industry: '',
    description: '',
    overviewType: 'xlsx',

    sourceFormat: 'xlsx',

    titleTemplate: '',
    overviewTemplate: '',

    sheetName,
    sheetIndex: sheetIndex >= 0 ? sheetIndex : 0,
    // 存储 XML 行号（1-indexed，与 XLSX 内部一致）
    dataRegion: {
      headerRow: region.headerRow + 1,   // XML 行号（1-indexed）
      dataStart: region.dataStart + 1,   // XML 行号（1-indexed）
      dataEnd: region.dataEnd + 1,       // XML 行号（1-indexed）
      colStart: region.colStart,         // 0-indexed
      colEnd: region.colEnd,             // 0-indexed
    },

    columns,

    columnStyles: {
      header: headerStyle ? { font: headerStyle.font, fill: headerStyle.fill } : {},
    },

    hasSignatures: false,
    signatureText: '',

    footerTemplate: { lines: [] },

    aiPromptTag: '',
  };

  return {
    success: true,
    template,
    unknowns,
    _buffer: buffer,  // 返回 buffer 避免 File 重复读取
    sheetInfo: {
      name: sheetName,
      headerRow: region.headerRow,
      dataRows: region.dataEnd - region.dataStart + 1,
      columns: columns.length,
    },
  };
}

/** AI 辅助识别未匹配的列 */
async function aiGuessXlsxColumns(unknowns) {
  if (!unknowns || unknowns.length === 0) return unknowns;

  const headersList = unknowns.map(u => u.header).join('、');
  const prompt = `你是一个检查表格模板分析助手。以下是一个 Excel 检查表中未识别的列名，请判断每个列的类型。

列名：${headersList}

类型选项（选最匹配的）：
- number（序号/编号列）
- description（问题描述/检查内容列）
- text（普通文字列）
- date（日期列）
- number_val（数字/数值列）

请严格按JSON格式输出，不要加其他内容：
{"results": [{"header": "列名", "type": "类型"}]}`;

  try {
    const response = await fetch(DOUBAO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DOUBAO_API_KEY}`,
      },
      body: JSON.stringify({
        model: DOUBAO_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.warn('[AI XLSX列识别] API 返回错误:', response.status);
      return unknowns;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const results = parsed.results || [];
      return unknowns.map(u => {
        const aiResult = results.find(r => r.header === u.header);
        return aiResult ? { ...u, guessedType: aiResult.type } : u;
      });
    }
  } catch (e) {
    console.warn('[AI XLSX列识别] 调用失败:', e.message);
  }

  return unknowns;
}

export { parseXlsxTemplate, aiGuessXlsxColumns, selectSheet, detectSheets, detectDataRegion, guessXlsxColumnType };
