// xlsx-parser.js — Excel 模板解析器
// 从 .xlsx 文件中提取表格结构、样式，转换为模板 JSON
// 依赖：xlsx-js-style（全局 XLSX）、JSZip（全局）
// 与 docx-parser.js 共享列类型识别逻辑

import { DOUBAO_API_URL, DOUBAO_API_KEY, DOUBAO_MODEL } from './config.js';

// XLSX 列类型关键词（不同于 DOCX：没有"照片"，有"日期""数字"）
// 匹配规则：从左到右扫描，第一个包含关键词的类型即命中
// text 是新增类型——列头匹配到文字类关键词时显式标记为 text（而非"未识别"）
const XLSX_TYPE_KEYWORDS = {
  number:      ['序号', '编号', 'No.', '项次', '检查序号', '隐患编号', '问题编号', 'NO', 'serial', '#'],
  description: ['问题', '描述', '隐患', '检查发现', '不符合', '存在问题', '检查情况',
                '检查内容', '检查项目', '具体描述', '现象', '情况', '不合格项', '检查事项',
                '区域', '位置', '地点', '巡检区域', '检查部位',
                '名称', '内容', '鉴定', '检修', '验收', '整改',
                '修理', '维修', '材料', '结果', '部件', '资产', '存放'],
  date:        ['日期', '时间', '检查日期', '整改期限', '完成时间', '期限', '记录日期', '巡检日期',
                '出厂时间', '使用时间'],
  number_val:  ['数量', '次数', '件数', '个数', '分值', '得分', '评分', '温度', '压力', '读数',
                '单价', '金额', '台套', '功率'],
  text:        ['规格', '型号', '厂家', '备注', '单位', '部门', '车间', '工段', '编制'],
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
    case 'text':        return { type: 'text', field: 'text_' + index };
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

    // 检测是否像表头：前 15 行中找一行填充率 > 40% 且内容多样的行
    let hasHeader = false;
    const totalCols = range.e.c - range.s.c + 1;
    const maxScan = Math.min(range.s.r + 15, range.e.r);
    for (let r = range.s.r; r <= maxScan; r++) {
      let filled = 0;
      const uniqueValues = new Set();
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = sheet[addr];
        if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
          filled++;
          uniqueValues.add(String(cell.v).trim());
        }
      }
      const ratio = totalCols > 0 ? filled / totalCols : 0;
      const diversity = filled > 0 ? uniqueValues.size / filled : 0;
      // 合格表头：填充率 ≥ 35%，多样性 ≥ 40%（排除合并标题行）
      if (ratio >= 0.35 && diversity >= 0.4) { hasHeader = true; break; }
      // 也接受填充率 ≥ 55% 的行（可能是简单表格只有 3-5 列）
      if (ratio >= 0.55 && diversity >= 0.3) { hasHeader = true; break; }
    }

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

  // 过滤掉明显的非数据 Sheet（合并日志、目录等）
  const skipNames = ['报告', '目录', '索引', 'readme', '说明', '汇总'];
  let sheetsWithData = sheets.filter(s =>
    s.nonEmptyCells > 2 && s.colCount >= 2 &&
    !skipNames.some(kw => s.name.toLowerCase().includes(kw.toLowerCase()))
  );

  // 降级：如果过滤后没了，回退到所有有数据的 Sheet
  if (sheetsWithData.length === 0) {
    sheetsWithData = sheets.filter(s => s.nonEmptyCells > 2);
  }

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
 * 从 Sheet 中检测数据区域。
 * 能自动跳过合并标题行（如公司名称跨所有列合并），找到真正的列名表头。
 * @returns {{ headerRow: number, dataStart: number, dataEnd: number, colStart: number, colEnd: number }}
 */
function detectDataRegion(sheet) {
  const ref = sheet['!ref'];
  if (!ref) return { headerRow: 0, dataStart: 1, dataEnd: 0, colStart: 0, colEnd: 0 };

  const range = XLSX.utils.decode_range(ref);
  const totalCols = range.e.c - range.s.c + 1;

  /**
   * 收集一行的填充信息：填充比例 + 内容多样性
   * 合并标题行（公司名称）特征：高填充率、低多样性（所有格的值相同）
   * 真实表头特征：高填充率、高多样性（每列文字不同）
   */
  function rowInfo(r) {
    let filled = 0;
    const uniqueValues = new Set();
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') {
        filled++;
        uniqueValues.add(String(cell.v).trim());
      }
    }
    const ratio = totalCols > 0 ? filled / totalCols : 0;
    const diversity = filled > 0 ? uniqueValues.size / filled : 0;
    return { filled, ratio, diversity, uniqueCount: uniqueValues.size };
  }

  /**
   * 判断一行是否像数据行（非表头）：首列为纯数字序号
   * 中文企业模板的典型特征：数据行首列是 "1", "2", "3"..., 表头行是 "序号"
   */
  function looksLikeDataRow(r) {
    const addr = XLSX.utils.encode_cell({ r, c: range.s.c });
    const cell = sheet[addr];
    if (cell && cell.v !== undefined && cell.v !== null) {
      const v = String(cell.v).trim();
      // 纯整数（含公式产生的数字）→ 序号 → 数据行
      if (/^\d+$/.test(v)) return true;
    }
    return false;
  }

  // 找到真正的表头行：扫 15 行，跳过标题行和数据行
  let headerRow = range.s.r;
  let bestRatio = 0;
  let bestRow = range.s.r;
  const maxScan = Math.min(range.s.r + 15, range.e.r);

  for (let r = range.s.r; r <= maxScan; r++) {
    const info = rowInfo(r);

    // 跳过合并标题行：填充率 > 30% 但多样性 < 25%（所有格文字几乎一样）
    if (info.ratio > 0.3 && info.diversity < 0.25 && info.filled > 2) continue;

    // 跳过单格填满宽表：标题文字合并但库未展开合并格值（只有 A1 有值）
    if (info.filled === 1 && totalCols > 5 && info.ratio < 0.1) continue;

    // 跳过数据行：首列为纯数字序号（如 "1", "2", "4"），避免和表头混淆
    if (looksLikeDataRow(r)) continue;

    if (info.ratio > bestRatio) {
      bestRatio = info.ratio;
      bestRow = r;
    }

    // 找到合格表头（填充率 ≥ 35% 且多样性 ≥ 40%）→ 立即停止
    if (info.ratio >= 0.35 && info.diversity >= 0.4) {
      bestRow = r;
      break;
    }
  }

  headerRow = bestRow;

  // 数据开始行 = 表头下一行
  const dataStart = headerRow + 1;

  // 数据结束行：找到连续有数据的最后一行（允许一行空行间隔）
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
