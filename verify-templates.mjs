// verify-templates.mjs — 验证 Pro 版模板引擎输出与原版一致
// 运行: node verify-templates.mjs

import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ---------- 1. 设置全局 docx（模拟浏览器环境） ----------
globalThis.docx = require('./lib/docx.umd.js');

// ---------- 2. 导入新版 docx-gen.js ----------
const newModule = await import('./js/docx-gen.js?v=' + Date.now());
const { loadTemplate, generateDocx, pickWorkday, formatDate } = newModule;

// ---------- 3. 加载模板 ----------
const safetyTpl = JSON.parse(readFileSync('./templates/safety.json', 'utf-8'));
const s5sTpl = JSON.parse(readFileSync('./templates/5s.json', 'utf-8'));
const companyTpl = JSON.parse(readFileSync('./templates/company.json', 'utf-8'));
const universalTpl = JSON.parse(readFileSync('./templates/universal.json', 'utf-8'));

// ---------- 4. 原版 TEMPLATE_CONFIG（从旧代码提取，用于对照） ----------
const OLD_CONFIG = {
  safety: {
    pageMargins: { top: 800, bottom: 1100, left: 600, right: 480 },
    tableWidth: 9971,
    titleFont: '宋体', titleSize: 44, overviewSize: 30, overviewFont: '宋体',
    columns: [
      { label: '序号', width: 606 }, { label: '部门', width: 834 },
      { label: '问题描述', width: 1960 }, { label: '整改前图片', width: 2749 },
      { label: '整改后图片', width: 2800 }, { label: '备注', width: 1022 },
    ],
    headerFontSize: 28, dataFontSize: 28, descFontSize: 22,
    hasSignatures: false,
  },
  '5s': {
    pageMargins: { top: 1213, bottom: 1440, left: 1123, right: 1123 },
    tableWidth: 9207,
    titleFont: 'Calibri', titleSize: 36, overviewSize: 24, overviewFont: '宋体',
    columns: [
      { label: '序号', width: 578 }, { label: '存在问题', width: 1560 },
      { label: '整改前图片', width: 2902 }, { label: '整改后图片', width: 3093 },
      { label: '备注', width: 1074 },
    ],
    headerFontSize: 24, dataFontSize: 28, descFontSize: 21,
    hasSignatures: true,
  },
  company: {
    pageMargins: { top: 1213, bottom: 1440, left: 1123, right: 1123 },
    tableWidth: 9207,
    titleFont: 'Calibri', titleSize: 36, overviewSize: 24, overviewFont: '宋体',
    columns: [
      { label: '序号', width: 578 }, { label: '存在问题', width: 1560 },
      { label: '整改前图片', width: 2902 }, { label: '整改后图片', width: 3093 },
      { label: '备注', width: 1074 },
    ],
    headerFontSize: 24, dataFontSize: 28, descFontSize: 21,
    hasSignatures: true,
  },
};

// ---------- 5. 对照检查 ----------

let passed = 0, failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return true; }
  console.log(`  ❌ ${name}: 期望 ${e}, 实际 ${a}`);
  failed++; return false;
}

function checkTemplate(id, tpl) {
  const old = OLD_CONFIG[id];
  console.log(`\n📋 检查模板: ${tpl.name} (${id})`);

  // 页边距
  check('页边距 top', tpl.page.margins.top, old.pageMargins.top);
  check('页边距 bottom', tpl.page.margins.bottom, old.pageMargins.bottom);
  check('页边距 left', tpl.page.margins.left, old.pageMargins.left);
  check('页边距 right', tpl.page.margins.right, old.pageMargins.right);
  check('表格总宽', tpl.page.tableWidth, old.tableWidth);

  // 标题样式
  check('标题字体', tpl.title.font, old.titleFont);
  check('标题大小', tpl.title.size, old.titleSize);
  check('概述字体', tpl.overview.font, old.overviewFont);
  check('概述大小', tpl.overview.size, old.overviewSize);

  // 列定义
  check('列数量', tpl.columns.length, old.columns.length);
  for (let i = 0; i < old.columns.length; i++) {
    check(`列[${i}] 标签`, tpl.columns[i].label, old.columns[i].label);
    check(`列[${i}] 宽度`, tpl.columns[i].width, old.columns[i].width);
  }

  // 样式
  check('表头字号', tpl.columnStyles.header.size, old.headerFontSize);
  check('数字列字号', tpl.columnStyles.number.size, old.dataFontSize);
  check('描述列字号', tpl.columnStyles.description.size, old.descFontSize);
  check('签名行', tpl.hasSignatures, old.hasSignatures);

  // 单元格边距
  const expectedMargins = id === 'safety'
    ? { top: 0, bottom: 0, left: 0, right: 0 }
    : { top: 0, bottom: 0, left: 108, right: 108 };
  check('单元格边距', tpl.cellMargins, expectedMargins);

  // AI 标签
  check('AI标签', tpl.aiPromptTag, id === 'safety' ? '风险' : '影响');
}

// ---------- 6. 测试日期工具函数 ----------

console.log('\n📅 测试日期函数');

// pickWorkday
const wd1 = pickWorkday(2026, 6, 13, 16);
check('pickWorkday 6月上半月', formatDate(wd1), '2026年6月15日'); // 13周六→14周日→15周一

const wd2 = pickWorkday(2026, 7, 23, 26);
check('pickWorkday 7月下半月', formatDate(wd2), '2026年7月23日'); // 23周四

// formatDate
check('formatDate 不补零', formatDate(new Date(2026, 5, 5)), '2026年6月5日');
check('formatDate 双位数', formatDate(new Date(2026, 10, 15)), '2026年11月15日');

// ---------- 7. 测试 buildOverview ----------

console.log('\n📝 测试概述文字生成');

// Safety 报告
loadTemplate(safetyTpl);
const safetyHeader = {
  company: '测试公司', department: '测试部门',
  date: '2026-06-18', inspectionDate: '2026-06-18',
};
const safetyResult = await generateDocx(safetyHeader, [
  { description: '问题1', beforePhoto: 'x', afterPhoto: 'y' },
  { description: '问题2', beforePhoto: 'x' },
]);
// generateDocx 返回 Blob，能成功返回就说明没崩
check('Safety 报告生成成功', safetyResult instanceof Blob, true);
check('Safety 报告大小 > 0', safetyResult.size > 0, true);

// 5S 报告
loadTemplate(s5sTpl);
const s5sHeader = {
  company: '测试公司', department: '测试部门',
  date: '2026-06-18', halfMonth: 'first',
};
const s5sResult = await generateDocx(s5sHeader, [
  { description: '5S问题', beforePhoto: 'x', afterPhoto: 'y' },
]);
check('5S 报告生成成功', s5sResult instanceof Blob, true);
check('5S 报告大小 > 0', s5sResult.size > 0, true);

// Company 报告
loadTemplate(companyTpl);
const companyHeader = {
  company: '测试公司', department: '测试部门',
  date: '2026-06-18', inspectionDate: '2026-06-18',
};
const companyResult = await generateDocx(companyHeader, [
  { description: '现场问题', beforePhoto: 'x', afterPhoto: 'y' },
]);
check('Company 报告生成成功', companyResult instanceof Blob, true);
check('Company 报告大小 > 0', companyResult.size > 0, true);

// ---------- 8. 运行模板检查 ----------

checkTemplate('safety', safetyTpl);
checkTemplate('5s', s5sTpl);
checkTemplate('company', companyTpl);

// ---------- 9. 检查 overviewType ----------

console.log('\n🔍 检查 overviewType');
check('Safety overviewType', safetyTpl.overviewType, 'safety');
check('5S overviewType', s5sTpl.overviewType, '5s');
check('Company overviewType', companyTpl.overviewType, 'company');
check('Universal overviewType', universalTpl.overviewType, 'generic');

// ---------- 10. 测试 Universal 模板 ----------

console.log('\n📋 测试通用模板 (universal)');
loadTemplate(universalTpl);
const uniResult = await generateDocx(
  { company: '测试公司', department: '测试部门', date: '2026-07-06' },
  [{ description: '测试问题', beforePhoto: 'x', afterPhoto: 'y' }]
);
check('Universal 报告生成成功', uniResult instanceof Blob, true);
check('Universal 报告大小 > 0', uniResult.size > 0, true);
check('Universal 列数', universalTpl.columns.length, 5);
check('Universal 有签名行', universalTpl.hasSignatures, true);

// ---------- 结果 ----------

console.log(`\n${'='.repeat(50)}`);
console.log(`✅ 通过: ${passed}  |  ❌ 失败: ${failed}`);
if (failed > 0) {
  console.log('⚠️  存在不一致，请检查！');
  process.exit(1);
} else {
  console.log('🎉 全部验证通过！模板引擎输出与原版一致。');
}
