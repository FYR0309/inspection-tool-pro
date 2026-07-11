// docx-gen.js — Word 文档生成引擎（模板驱动）
// 依赖全局 docx 对象，通过 JSON 模板配置报告格式

import { compressImage } from './utils.js?v=20260711f';

const { Document, Packer, Paragraph, Table, TableRow, TableCell,
        ImageRun, TextRun, AlignmentType, WidthType, BorderStyle,
        ShadingType, convertInchesToTwip, HeightRule } = docx;

// ---------- 当前模板 ----------

let currentTemplate = null;

/** 加载模板 JSON 对象，自动处理版本兼容 */
function loadTemplate(templateJson) {
  // v1 模板兼容：无 titleTemplate 时从 overviewType 推断
  if (!templateJson.version || templateJson.version < 1) {
    templateJson.version = 1;
  }
  // 确保变量 editable 默认为 true（Pro 版客户可自由编辑）
  if (templateJson.variables) {
    for (const [key, v] of Object.entries(templateJson.variables)) {
      if (v.editable === undefined) v.editable = true;
      if (v.default === '广西糖业集团红河制糖有限公司') v.default = '';
      if (v.default === '压榨车间') v.default = '';
    }
  }
  // footerTemplate 兜底
  if (!templateJson.footerTemplate) {
    templateJson.footerTemplate = {
      lines: ['{{company}}', '    {{department}}', '{{date}}']
    };
  }
  currentTemplate = templateJson;
}

/** 获取当前模板（便捷访问） */
function t() {
  if (!currentTemplate) throw new Error('模板未加载，请先调用 loadTemplate()');
  return currentTemplate;
}

// ---------- 图片压缩 ----------

function compressImageForDocx(dataUrl) {
  return compressImage(dataUrl, { maxPx: 1000, maxKB: 450, quality: 0.85 });
}

// ---------- 工具 ----------

function base64ToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 统一边框 — sz=4 (0.5pt) */
function cellBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    left: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    right: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
  };
}

// ---------- 样式查找 ----------

/** 从模板中获取指定列类型的样式 */
function colStyle(colType) {
  const styles = t().columnStyles;
  // 合并 text 样式作为默认值
  return { ...styles.text, ...(styles[colType] || {}) };
}

/** 判断是否使用紧凑边距（安全模板全0） */
function cellMargins() {
  return t().cellMargins || { top: 0, bottom: 0, left: 0, right: 0 };
}

// ---------- 单元格 ----------

function textCell(text, colType, widthTwips, overrides = {}) {
  const style = colStyle(colType);
  const fontSize = overrides.fontSize || style.size || 28;
  const font = overrides.font || style.font || '宋体';
  const align = overrides.align || style.alignment || 'center';

  return new TableCell({
    width: { size: widthTwips, type: WidthType.DXA },
    borders: cellBorder(),
    margins: cellMargins(),
    children: [
      new Paragraph({
        children: [new TextRun({
          text: String(text || ''),
          size: fontSize,
          font: font,
          bold: overrides.bold || false,
        })],
        alignment: align === 'center' ? AlignmentType.CENTER
                 : align === 'left' ? AlignmentType.LEFT
                 : align === 'right' ? AlignmentType.RIGHT
                 : AlignmentType.JUSTIFIED,
        spacing: { before: 0, after: 0, line: 240 },
      }),
    ],
    verticalAlign: 'center',
  });
}

function imageCell(dataUrl, widthTwips) {
  const tmpl = t();
  const imgWidth = (tmpl.columnStyles.image && tmpl.columnStyles.image.displayWidth) || 192;
  const children = [];

  if (dataUrl && dataUrl.startsWith('data:image')) {
    try {
      children.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: base64ToBytes(dataUrl),
              transformation: { width: imgWidth, height: imgWidth },
              type: 'jpg',
            }),
          ],
          alignment: AlignmentType.CENTER,
        })
      );
    } catch (e) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: '(图片错误)', size: 14, italics: true })],
          alignment: AlignmentType.CENTER,
        })
      );
    }
  }

  return new TableCell({
    width: { size: widthTwips, type: WidthType.DXA },
    borders: cellBorder(),
    margins: cellMargins(),
    children: children.length > 0 ? children : [new Paragraph({ children: [] })],
    verticalAlign: 'center',
  });
}

// ---------- 行 ----------

function headerRow() {
  const tmpl = t();
  const hStyle = tmpl.columnStyles.header;
  const margins = cellMargins();

  return new TableRow({
    height: { value: tmpl.rowHeight.header, rule: HeightRule.AT_LEAST },
    tableHeader: true,
    children: tmpl.columns.map(col =>
      new TableCell({
        width: { size: col.width, type: WidthType.DXA },
        borders: cellBorder(),
        shading: { type: ShadingType.SOLID, color: hStyle.background || 'D9E2F3' },
        margins: margins,
        children: [
          new Paragraph({
            children: [new TextRun({
              text: col.label,
              size: hStyle.size || 24,
              font: hStyle.font || '宋体',
              bold: hStyle.bold !== false,
            })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 0, line: 240 },
          }),
        ],
        verticalAlign: 'center',
      })
    ),
  });
}

async function dataRow(index, item) {
  const tmpl = t();
  const cells = [];
  const margins = cellMargins();

  for (const col of tmpl.columns) {
    switch (col.type) {
      case 'number':
        cells.push(textCell(index, 'number', col.width, { margins }));
        break;

      case 'text':
        cells.push(textCell(item[col.field] || '', 'text', col.width, { margins }));
        break;

      case 'description':
        cells.push(textCell(item[col.field] || '', 'description', col.width, {
          align: 'left',
          margins,
        }));
        break;

      case 'image': {
        let compressed = item[col.field];
        if (compressed && compressed.startsWith('data:image')) {
          try { compressed = await compressImageForDocx(compressed); } catch(e) {}
        }
        cells.push(imageCell(compressed, col.width));
        break;
      }

      case 'remark':
        // 有整改后照片时自动填"已整改"
        cells.push(textCell(item.afterPhoto ? '已整改' : '', 'remark', col.width, { margins }));
        break;

      default:
        // 未知类型当普通文本处理
        cells.push(textCell(item[col.field] || '', 'text', col.width, { margins }));
    }
  }

  return new TableRow({
    height: { value: tmpl.rowHeight.data, rule: HeightRule.AT_LEAST },
    children: cells,
  });
}

// ---------- 日期 ----------

function pickWorkday(year, month, startDay, endDay) {
  for (let d = startDay; d <= endDay; d++) {
    const date = new Date(year, month - 1, d);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) return date;
  }
  return new Date(year, month - 1, endDay);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${y}年${m}月${d}日`;
}

// ---------- 概述文字生成（占位符模板 + overviewType 兜底） ----------

/**
 * 替换模板中的占位符
 * 支持: {{company}} {{department}} {{date}} {{total}} {{done}} {{remain}}
 *       {{year}} {{month}} {{half}} {{checkDate1}} {{checkDate2}}
 */
function replacePlaceholders(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value ?? ''));
  }
  return result;
}

function buildOverview(header, totalItems, completedItems, unfinishedItems) {
  const tmpl = t();
  const { company, department, date: sigDate, inspectionDate, halfMonth } = header;
  const inspectDateObj = inspectionDate ? new Date(inspectionDate) : (sigDate ? new Date(sigDate) : new Date());
  const year = inspectDateObj.getFullYear();
  const month = inspectDateObj.getMonth() + 1;

  // 通用占位符变量
  const placeholderVars = {
    company: company || '',
    department: department || '检查部门',
    date: sigDate ? formatDate(new Date(sigDate)) : formatDate(new Date()),
    year: String(year),
    month: String(month),
    total: String(totalItems),
    done: String(completedItems),
    remain: String(unfinishedItems),
    half: halfMonth === 'first' ? '上半月' : '下半月',
    checkDate1: '',
    checkDate2: '',
  };

  // 计算检查日期（根据 overviewType）
  switch (tmpl.overviewType) {
    case 'safety':
      placeholderVars.checkDate1 = formatDate(pickWorkday(year, month, inspectDateObj.getDate() - 10, inspectDateObj.getDate() - 8));
      placeholderVars.checkDate2 = formatDate(pickWorkday(year, month, inspectDateObj.getDate() - 3, inspectDateObj.getDate() - 1));
      break;
    case '5s': {
      const startD = halfMonth === 'first' ? 13 : 23;
      const endD = halfMonth === 'first' ? 16 : 26;
      placeholderVars.checkDate1 = formatDate(pickWorkday(year, month, startD, endD));
      break;
    }
    case 'company':
      placeholderVars.checkDate1 = formatDate(pickWorkday(year, month, inspectDateObj.getDate() - 5, inspectDateObj.getDate() - 1));
      break;
    default:
      // generic: 不计算特定日期
      placeholderVars.checkDate1 = placeholderVars.date;
      placeholderVars.checkDate2 = placeholderVars.date;
  }

  // 优先使用模板中的 titleTemplate / overviewTemplate
  let titleText, overviewText;

  if (tmpl.titleTemplate) {
    titleText = replacePlaceholders(tmpl.titleTemplate, placeholderVars);
  } else {
    // 兜底：用旧的硬编码逻辑（兼容无 titleTemplate 的旧模板）
    switch (tmpl.overviewType) {
      case 'safety': titleText = '安全自检自查整改报告'; break;
      case '5s': titleText = `${year}年${month}月${department}5S现场检查通报（${placeholderVars.half}）`; break;
      case 'company': titleText = `${department}现场整改报告`; break;
      default: titleText = `${department || '检查部门'}检查报告`;
    }
  }

  if (tmpl.overviewTemplate) {
    overviewText = replacePlaceholders(tmpl.overviewTemplate, placeholderVars);
  } else {
    // 兜底：硬编码概述
    switch (tmpl.overviewType) {
      case 'safety':
        overviewText = `根据公司安全管理要求，我车间（部门）分别与${placeholderVars.checkDate1}、${placeholderVars.checkDate2}开展安全自检自查工作，其中提出了（${totalItems}）个整改项，并已整改完成（${completedItems}）项，未能完成整改（${unfinishedItems}）项。`;
        break;
      case '5s':
        overviewText = `根据红糖发（2022）22号关于印发《广西糖业集团红河制糖有限公司5S现场管理》相关要求，车间组织相关人员于${placeholderVars.checkDate1}对本车间进行${placeholderVars.half}现场检查，现将检查情况反馈如下：本次检查需要整改的共${totalItems}项，其中已整改完成${completedItems}项，未完成整改${unfinishedItems}项。`;
        break;
      case 'company':
        overviewText = `${placeholderVars.checkDate1}公司现场检查小组对我车间进行现场检查，提出${totalItems}个整改项，已整改完成${completedItems}项，未完成${unfinishedItems}项，附整改前后对比照片。`;
        break;
      default:
        overviewText = `本次共检查出${totalItems}项问题，已完成整改${completedItems}项，剩余${unfinishedItems}项待跟进。`;
    }
  }

  return { titleText, overviewText };
}

// ---------- 主函数 ----------

async function generateDocx(header, items, customOverview = null) {
  const tmpl = t();
  const { company, department, date: sigDate } = header;

  const totalItems = items.length;
  const completedItems = items.filter(i => i.afterPhoto).length;
  const unfinishedItems = totalItems - completedItems;

  const sigDateObj = sigDate ? new Date(sigDate) : new Date();

  // 生成标题和概述文字（用户可覆盖）
  const built = buildOverview(header, totalItems, completedItems, unfinishedItems);
  const titleText = customOverview?.titleText || built.titleText;
  const overviewText = customOverview?.overviewText || built.overviewText;

  // --- 构建表格 ---
  const rows = [headerRow()];
  for (let i = 0; i < items.length; i++) {
    rows.push(await dataRow(i + 1, items[i]));
  }

  const table = new Table({
    rows,
    width: { size: tmpl.page.tableWidth, type: WidthType.DXA },
    columnWidths: tmpl.columns.map(c => c.width),
  });

  // --- 构建文档 ---
  const titleCfg = tmpl.title;
  const overviewCfg = tmpl.overview;
  const footerCfg = tmpl.footer;
  const pm = tmpl.page.margins;

  const sectionChildren = [
    // 标题
    new Paragraph({
      children: [new TextRun({
        text: titleText,
        size: titleCfg.size,
        font: titleCfg.font,
        bold: titleCfg.bold,
      })],
      alignment: titleCfg.alignment === 'center' ? AlignmentType.CENTER
               : titleCfg.alignment === 'left' ? AlignmentType.LEFT
               : titleCfg.alignment === 'right' ? AlignmentType.RIGHT
               : AlignmentType.JUSTIFIED,
      spacing: titleCfg.spacing || { before: 242, after: 0, line: 400 },
    }),
    // 概述
    new Paragraph({
      children: [new TextRun({
        text: overviewText,
        size: overviewCfg.size,
        font: overviewCfg.font,
      })],
      alignment: overviewCfg.alignment === 'justified' ? AlignmentType.JUSTIFIED
               : overviewCfg.alignment === 'center' ? AlignmentType.CENTER
               : overviewCfg.alignment === 'left' ? AlignmentType.LEFT
               : AlignmentType.RIGHT,
      spacing: overviewCfg.spacing || { before: 242, after: 120, line: 400 },
      indent: overviewCfg.firstLineIndent ? { firstLine: overviewCfg.firstLineIndent, left: overviewCfg.leftIndent || 0 } : undefined,
    }),
    // 表格
    table,
    // 表格后空行
    new Paragraph({ children: [], spacing: { after: 100 } }),
  ];

  // 落款：优先使用 footerTemplate，兜底用硬编码格式
  const footerLines = (tmpl.footerTemplate && tmpl.footerTemplate.lines)
    ? tmpl.footerTemplate.lines
    : [company, `    ${department}`, formatDate(sigDateObj)];

  const footerVars = {
    company: company || '',
    department: department || '',
    date: formatDate(sigDateObj),
  };

  footerLines.forEach((line, i) => {
    const text = replacePlaceholders(line, footerVars);
    const isLast = i === footerLines.length - 1;
    sectionChildren.push(
      new Paragraph({
        children: [new TextRun({
          text,
          size: footerCfg.size || 28,
          font: footerCfg.font || '宋体',
        })],
        alignment: AlignmentType.RIGHT,
        spacing: { before: 0, after: isLast ? (footerCfg.spacing ? footerCfg.spacing.after : 200) : 0 },
      })
    );
  });

  // 签名行
  if (tmpl.hasSignatures && tmpl.signatureText) {
    sectionChildren.push(
      new Paragraph({
        children: [new TextRun({
          text: tmpl.signatureText,
          size: footerCfg.size || 28,
          font: footerCfg.font || '宋体',
        })],
        spacing: { before: 0, after: 0 },
      })
    );
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: pm.top,
            bottom: pm.bottom,
            left: pm.left,
            right: pm.right,
          },
        },
      },
      children: sectionChildren,
    }],
  });

  return await Packer.toBlob(doc);
}

export { generateDocx, loadTemplate, buildOverview, pickWorkday, formatDate };
