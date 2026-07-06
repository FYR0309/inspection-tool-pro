// docx-parser.js — Word 模板解析器
// 从 .docx 文件中提取表格结构、样式，转换为模板 JSON
// 依赖：JSZip（全局）、DOMParser（浏览器内置）
// 三阶段识别：XML结构提取 → 关键词匹配 → AI兜底

const TYPE_KEYWORDS = {
  number:   ['序号', '编号', 'No.', '项次', '检查序号', '隐患编号', '问题编号', 'NO', 'serial'],
  image:    ['照片', '图片', '影像', '附图', '佐证', '截图', '图像', 'photo', 'image'],
  description: ['问题', '描述', '隐患', '检查发现', '不符合', '存在问题', '检查情况',
                '检查内容', '检查项目', '具体描述', '现象', '情况', '不合格项', '检查事项'],
  remark:   ['备注', '说明', '注', '整改要求', '整改建议', '整改措施', '备注说明', 'remark'],
  department: ['部门', '车间', '单位', '责任部门', '所属部门', '科室', '区域'],
  riskLevel: ['风险', '等级', '严重', '类别', '隐患等级', '风险等级', '分级'],
  date:     ['日期', '时间', '检查日期', '整改期限', '完成时间', '期限'],
  person:   ['责任人', '检查人', '负责人', '责任', '整改人', '签字', '检查人员'],
};

/** 根据列头文字猜测列类型 */
function guessColumnType(headerText) {
  const text = headerText.trim();
  for (const [type, keywords] of Object.entries(TYPE_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) return type;
    }
  }
  return null;
}

/** 判断图片列是"整改前"还是"整改后" */
function guessImageSubtype(headerText, existingImageCount) {
  const text = headerText.trim();
  if (text.includes('前') || text.includes('before')) return 'beforePhoto';
  if (text.includes('后') || text.includes('after')) return 'afterPhoto';
  // 第一个图片列默认是"前"，第二个是"后"
  return existingImageCount === 0 ? 'beforePhoto' : 'afterPhoto';
}

// ---------- XML 提取 ----------

/** 从 document.xml 提取页边距 */
function extractPageMargins(doc) {
  const sectPr = doc.querySelector('w|sectPr, sectPr');
  if (!sectPr) return null;
  const pgMar = sectPr.querySelector('w|pgMar, pgMar');
  if (!pgMar) return null;
  return {
    top: parseInt(pgMar.getAttribute('w:top') || pgMar.getAttribute('top') || '1213'),
    bottom: parseInt(pgMar.getAttribute('w:bottom') || pgMar.getAttribute('bottom') || '1440'),
    left: parseInt(pgMar.getAttribute('w:left') || pgMar.getAttribute('left') || '1123'),
    right: parseInt(pgMar.getAttribute('w:right') || pgMar.getAttribute('right') || '1123'),
  };
}

/** 从 document.xml 提取表格结构 */
function extractTableStructure(doc) {
  // 找第一个表格
  const tbl = doc.querySelector('w|tbl, tbl');
  if (!tbl) return null;

  // 提取列宽
  const gridCols = tbl.querySelectorAll('w|gridCol, gridCol');
  const colWidths = Array.from(gridCols).map(c =>
    parseInt(c.getAttribute('w:w') || c.getAttribute('w') || '1800')
  );

  // 提取表格总宽
  const tblPr = tbl.querySelector('w|tblPr, tblPr');
  const tblW = tblPr ? tblPr.querySelector('w|tblW, tblW') : null;
  const tableWidth = tblW
    ? parseInt(tblW.getAttribute('w:w') || tblW.getAttribute('w') || '9207')
    : colWidths.reduce((a, b) => a + b, 0);

  // 提取表格行
  const rows = tbl.querySelectorAll('w|tr, tr');
  if (rows.length === 0) return null;

  // 找表头行（含 tblHeader 的第一行）或第一行
  let headerRow = null;
  for (const row of rows) {
    const trPr = row.querySelector('w|trPr, trPr');
    if (trPr && trPr.querySelector('w|tblHeader, tblHeader')) {
      headerRow = row;
      break;
    }
  }
  if (!headerRow) headerRow = rows[0];

  // 提取列头文字
  const cells = headerRow.querySelectorAll('w|tc, tc');
  const headers = Array.from(cells).map(cell => {
    const texts = cell.querySelectorAll('w|t, t');
    return Array.from(texts).map(t => t.textContent || '').join('');
  });

  // 提取表头样式
  let headerFont = '宋体', headerSize = 24;
  const firstRun = headerRow.querySelector('w|rPr, rPr');
  if (firstRun) {
    const rFonts = firstRun.querySelector('w|rFonts, rFonts');
    if (rFonts) {
      headerFont = rFonts.getAttribute('w:eastAsia') || rFonts.getAttribute('eastAsia') || '宋体';
    }
    const sz = firstRun.querySelector('w|sz, sz');
    if (sz) headerSize = parseInt(sz.getAttribute('w:val') || sz.getAttribute('val') || '24');
  }

  return { headers, colWidths, tableWidth, headerFont, headerSize };
}

/** 提取签名行 */
function extractSignature(doc) {
  const paragraphs = doc.querySelectorAll('w|p, p');
  for (const p of paragraphs) {
    const text = p.textContent || '';
    if (text.includes('编制') || text.includes('审核') || text.includes('批准')) {
      return text.trim();
    }
  }
  return null;
}

/** 提取标题文字（表格前第一个有意义的短段落） */
function extractTitle(doc) {
  const paragraphs = doc.querySelectorAll('w|p, p');
  for (const p of paragraphs) {
    const text = (p.textContent || '').trim();
    // 跳过空段落和太长的段落（可能是正文）
    if (text.length > 2 && text.length < 60) return text;
  }
  return null;
}

/** 提取标题样式 */
function extractTitleStyle(doc) {
  const paragraphs = doc.querySelectorAll('w|p, p');
  for (const p of paragraphs) {
    const text = (p.textContent || '').trim();
    if (text.length > 2 && text.length < 60) {
      const rPr = p.querySelector('w|rPr, rPr');
      if (rPr) {
        const rFonts = rPr.querySelector('w|rFonts, rFonts');
        const sz = rPr.querySelector('w|sz, sz');
        const b = rPr.querySelector('w|b, b');
        return {
          font: rFonts ? (rFonts.getAttribute('w:eastAsia') || rFonts.getAttribute('eastAsia') || '宋体') : '宋体',
          size: sz ? parseInt(sz.getAttribute('w:val') || sz.getAttribute('val') || '36') : 36,
          bold: !!b,
        };
      }
      break;
    }
  }
  return null;
}

// ---------- 主函数 ----------

/** 解析 .docx 文件，返回模板 JSON */
async function parseDocxTemplate(file) {
  const warnings = [];
  const unknowns = [];

  // 1. 解压 ZIP
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    return { success: false, error: '无法解析文件，请确认是 .docx 格式' };
  }

  // 2. 读取 document.xml
  const docXml = await zip.file('word/document.xml')?.async('text');
  if (!docXml) {
    return { success: false, error: '文件中未找到 document.xml，可能是加密或损坏的文档' };
  }

  // 3. 解析 XML
  const parser = new DOMParser();
  const doc = parser.parseFromString(docXml, 'text/xml');

  // 检查解析错误
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    return { success: false, error: 'XML 解析失败' };
  }

  // 4. 提取各部分
  const margins = extractPageMargins(doc);
  const tableInfo = extractTableStructure(doc);
  if (!tableInfo) {
    return { success: false, error: '未检测到表格。是否手动创建模板？' };
  }

  const titleText = extractTitle(doc);
  const titleStyle = extractTitleStyle(doc);
  const signatureText = extractSignature(doc);

  // 5. 列类型识别（阶段1+2：关键词匹配）
  let imageCount = 0;
  const columns = tableInfo.headers.map((header, i) => {
    const colType = guessColumnType(header);
    let field, type;

    const width = tableInfo.colWidths[i] || 1800;

    if (colType) {
      switch (colType) {
        case 'number':
          type = 'number';
          field = '_index';
          break;
        case 'image':
          type = 'image';
          field = guessImageSubtype(header, imageCount);
          imageCount++;
          break;
        case 'description':
          type = 'description';
          field = 'description';
          break;
        case 'remark':
          type = 'remark';
          field = '_remark';
          break;
        case 'department':
          type = 'text';
          field = 'department';
          break;
        default:
          type = 'text';
          field = colType;
      }
    } else {
      // 宽度小于 700twips 的很可能是序号列
      if (width < 700) {
        type = 'number';
        field = '_index';
      } else {
        type = 'text';
        field = 'field_' + i;
        unknowns.push({ index: i, header, guessedType: null });
      }
    }

    return { label: header, field, type, width };
  });

  // 6. 组装模板 JSON
  const templateName = titleText ? `从docx导入：${titleText}` : `导入模板_${new Date().toISOString().slice(0, 10)}`;

  const template = {
    id: 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: templateName,
    industry: '',
    description: '',
    overviewType: 'generic',

    page: {
      margins: margins || { top: 1213, bottom: 1440, left: 1123, right: 1123 },
      tableWidth: tableInfo.tableWidth,
    },

    title: {
      font: titleStyle?.font || '宋体',
      size: titleStyle?.size || 36,
      bold: titleStyle?.bold !== false,
      alignment: 'center',
      spacing: { before: 242, after: 0, line: 400 },
    },

    overview: {
      font: '宋体',
      size: 24,
      alignment: 'justified',
      spacing: { before: 242, after: 120, line: 400 },
      firstLineIndent: 560,
      leftIndent: 120,
    },

    columns,

    columnStyles: {
      header: { font: tableInfo.headerFont, size: tableInfo.headerSize, bold: true, background: 'D9E2F3' },
      number: { font: '宋体', size: 28, alignment: 'center' },
      text: { font: '宋体', size: 28, alignment: 'center' },
      description: { font: '宋体', size: 22, alignment: 'left' },
      remark: { font: '宋体', size: 20, alignment: 'center' },
      image: { displayWidth: 192 },
    },

    cellMargins: { top: 0, bottom: 0, left: 108, right: 108 },
    rowHeight: { header: 90, data: 3400 },

    hasSignatures: !!signatureText,
    signatureText: signatureText || '',

    footer: { font: '宋体', size: 28, spacing: { after: 200 } },

    aiPromptTag: '影响',

    variables: {
      company: { label: '公司名称', default: '', editable: true },
      department: { label: '部门', default: '', editable: true },
    },
  };

  return {
    success: true,
    template,
    warnings,
    unknowns,
  };
}

/** AI 辅助识别未匹配的列（阶段3：豆包 API） */
async function aiGuessColumns(unknowns) {
  if (!unknowns || unknowns.length === 0) return unknowns;

  const headersList = unknowns.map(u => u.header).join('、');
  const prompt = `你是一个安全检查报告模板分析助手。以下是一个报告表格中未识别的列名，请判断每个列的类型。

列名：${headersList}

类型选项（选最匹配的）：
- number（序号/编号列）
- description（问题描述/检查内容列）
- image（照片/图片列）
- remark（备注/说明列）
- department（部门/车间列）
- riskLevel（风险等级列）
- date（日期列）
- person（责任人列）
- text（其他普通文字列）

请严格按JSON格式输出，不要加其他内容：
{"results": [{"header": "列名", "type": "类型"}]}`;

  try {
    const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ark-4b152d9d-0ad1-4e65-838f-a52f264ff4ea-12064',
      },
      body: JSON.stringify({
        model: 'ep-20260616232549-wr6bn',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      console.warn('[AI列识别] API 返回错误:', response.status);
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
    console.warn('[AI列识别] 调用失败:', e.message);
  }

  return unknowns;
}

export { parseDocxTemplate, aiGuessColumns, guessColumnType };
