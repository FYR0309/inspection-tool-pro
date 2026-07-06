# 模板导入系统 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让安全检查工具 Pro 支持三种模板来源（内置通用模板、导入 .docx 自动识别、导入/导出 .json），实现多行业报告生成。

**Architecture:** 新增 docx-parser.js 解析 Word 模板 XML，db.js 加模板存储，UI 加导入面板和确认页。导入的模板和内置模板在 docx-gen.js 层面完全平等。

**Tech Stack:** JSZip (CDN), DOMParser (浏览器内置), IndexedDB, docx.js, 豆包 API (AI列识别可选)

---

### Task 1: 下载 JSZip

**Files:**
- Create: `lib/jszip.min.js`

- [ ] **Step 1: 下载 JSZip UMD 版本**

`index.html` 已引用 `<script src="lib/jszip.min.js"></script>`，但文件不存在。

```bash
curl -o lib/jszip.min.js https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
```

- [ ] **Step 2: 验证文件**

```bash
ls -la lib/jszip.min.js
```
期望：文件存在，约 100KB

- [ ] **Step 3: 提交**

```bash
git add lib/jszip.min.js
git commit -m "添加 JSZip CDN 本地副本"
```

---

### Task 2: 升级 db.js — v3 加模板存储

**Files:**
- Modify: `js/db.js` (全文)

- [ ] **Step 1: 更新版本号和常量**

定位到文件顶部：

```javascript
// db.js — IndexedDB 草稿存储 + localStorage 预设 + 模板管理
// v3: 新增 templates store

const DB_NAME = 'inspection-tool-pro';  // 改名，避免和免费版数据冲突
const DB_VERSION = 3;
const STORE_NAME = 'drafts';
const TEMPLATE_STORE = 'templates';     // 新增
const MAX_DRAFTS = 6;
```

- [ ] **Step 2: 在 openDB() 里加 templates store**

在 `req.onupgradeneeded` 回调的 `if (oldVersion < 3)` 分支里：

```javascript
if (oldVersion < 3) {
  if (!db.objectStoreNames.contains(TEMPLATE_STORE)) {
    db.createObjectStore(TEMPLATE_STORE, { keyPath: 'id' });
  }
}
```

- [ ] **Step 3: 新增模板 ID 生成函数**

在 `generateId()` 函数后面添加：

```javascript
function generateTemplateId() {
  return 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}
```

- [ ] **Step 4: 新增模板 CRUD 方法**

在文件末尾（`export` 语句之前）添加：

```javascript
// ---------- 模板管理 ----------

async function saveTemplate(templateData) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readwrite');
  const store = tx.objectStore(TEMPLATE_STORE);

  const record = {
    id: templateData.id || generateTemplateId(),
    name: templateData.name,
    industry: templateData.industry || '通用',
    description: templateData.description || '',
    source: templateData.source || 'imported',
    isBuiltin: templateData.isBuiltin || false,
    data: templateData.data || templateData,  // templateData 本身就是模板 JSON
    createdAt: templateData.createdAt || new Date().toISOString().slice(0, 10),
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  store.put(record);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(record);
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function deleteTemplate(id) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readwrite');
  const store = tx.objectStore(TEMPLATE_STORE);
  store.delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function getCustomTemplate(id) {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readonly');
  const store = tx.objectStore(TEMPLATE_STORE);
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function listCustomTemplates() {
  const db = await openDB();
  const tx = db.transaction(TEMPLATE_STORE, 'readonly');
  const store = tx.objectStore(TEMPLATE_STORE);
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result = req.result || [];
      result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      resolve(result);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

/** 将模板导出为 .json 文件下载 */
function exportTemplateAsFile(templateRecord) {
  const jsonStr = JSON.stringify(templateRecord.data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${templateRecord.name}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: 更新 export 语句**

```javascript
export { saveDraft, getDraft, deleteDraft, listDrafts, getBackupInfo, getPresets, savePresets, getTodayStr, MAX_DRAFTS, migrateFromV1, saveTemplate, deleteTemplate, getCustomTemplate, listCustomTemplates, exportTemplateAsFile };
```

- [ ] **Step 6: 提交**

```bash
git add js/db.js
git commit -m "db.js v3: 新增模板存储和CRUD，数据库更名为 inspection-tool-pro"
```

---

### Task 3: 创建万能通用模板

**Files:**
- Create: `templates/universal.json`

- [ ] **Step 1: 写 universal.json**

```json
{
  "id": "universal",
  "name": "通用检查报告",
  "industry": "通用",
  "description": "适用于任何检查场景的通用模板",
  "overviewType": "generic",

  "page": {
    "margins": { "top": 1213, "bottom": 1440, "left": 1123, "right": 1123 },
    "tableWidth": 9207
  },

  "title": {
    "font": "宋体",
    "size": 36,
    "bold": true,
    "alignment": "center",
    "spacing": { "before": 242, "after": 0, "line": 400 }
  },

  "overview": {
    "font": "宋体",
    "size": 24,
    "alignment": "justified",
    "spacing": { "before": 242, "after": 120, "line": 400 },
    "firstLineIndent": 560,
    "leftIndent": 120
  },

  "columns": [
    { "label": "序号", "field": "_index", "type": "number", "width": 600 },
    { "label": "检查项目", "field": "description", "type": "description", "width": 2000 },
    { "label": "检查情况", "field": "beforePhoto", "type": "image", "width": 2800 },
    { "label": "整改情况", "field": "afterPhoto", "type": "image", "width": 2800 },
    { "label": "备注", "field": "_remark", "type": "remark", "width": 1000 }
  ],

  "columnStyles": {
    "header": { "font": "宋体", "size": 24, "bold": true, "background": "D9E2F3" },
    "number": { "font": "宋体", "size": 28, "alignment": "center" },
    "text": { "font": "宋体", "size": 28, "alignment": "center" },
    "description": { "font": "宋体", "size": 22, "alignment": "left" },
    "remark": { "font": "宋体", "size": 20, "alignment": "center" },
    "image": { "displayWidth": 192 }
  },

  "cellMargins": { "top": 0, "bottom": 0, "left": 108, "right": 108 },
  "rowHeight": { "header": 90, "data": 3400 },

  "hasSignatures": true,
  "signatureText": "编制：               审核：                 批准：",

  "footer": {
    "font": "宋体",
    "size": 28,
    "spacing": { "after": 200 }
  },

  "aiPromptTag": "影响",

  "variables": {
    "company": {
      "label": "公司名称",
      "default": "",
      "editable": true
    },
    "department": {
      "label": "部门",
      "default": "",
      "editable": true
    }
  }
}
```

- [ ] **Step 2: 注册到 templates.js（在 Task 4 统一做）**

- [ ] **Step 3: 提交**

```bash
git add templates/universal.json
git commit -m "添加万能通用模板 universal.json"
```

---

### Task 4: 更新 templates.js — 合并内置和自定义模板

**Files:**
- Modify: `templates/templates.js` (全文重写)

- [ ] **Step 1: 重写 templates.js**

```javascript
// templates.js — 模板注册表（内置 + 自定义）
import safety from './safety.json' with { type: 'json' };
import s5s from './5s.json' with { type: 'json' };
import company from './company.json' with { type: 'json' };
import universal from './universal.json' with { type: 'json' };

/** 所有内置模板 */
const builtinTemplates = {
  safety,
  '5s': s5s,
  company,
  universal,
};

/** 内置模板 ID 集合，用于判断是否可删除 */
const BUILTIN_IDS = new Set(Object.keys(builtinTemplates));

/** 自定义模板缓存（从 IndexedDB 加载） */
let customTemplates = {};

/** 加载自定义模板（app.js 初始化时调用） */
async function loadCustomTemplates() {
  try {
    const { listCustomTemplates } = await import('../js/db.js');
    const records = await listCustomTemplates();
    customTemplates = {};
    records.forEach(r => {
      customTemplates[r.id] = r.data;
    });
  } catch (e) {
    console.warn('加载自定义模板失败:', e);
    customTemplates = {};
  }
}

/** 刷新单个自定义模板（保存后调用） */
function refreshCustomTemplate(id, data) {
  customTemplates[id] = data;
}

/** 移除自定义模板（删除后调用） */
function removeCustomTemplate(id) {
  delete customTemplates[id];
}

/** 按 id 获取模板（内置优先，再查自定义） */
function getTemplate(id) {
  const t = builtinTemplates[id] || customTemplates[id];
  if (!t) throw new Error(`未找到模板: ${id}`);
  return JSON.parse(JSON.stringify(t));
}

/** 获取全部模板列表 */
function listTemplates() {
  const builtin = Object.values(builtinTemplates).map(t => ({
    id: t.id,
    name: t.name,
    industry: t.industry,
    description: t.description,
    isBuiltin: true,
  }));
  const custom = Object.values(customTemplates).map(t => ({
    id: t.id,
    name: t.name,
    industry: t.industry,
    description: t.description,
    isBuiltin: false,
  }));
  return [...builtin, ...custom];
}

/** 检查模板是否为内置 */
function isBuiltinTemplate(id) {
  return BUILTIN_IDS.has(id);
}

export { getTemplate, listTemplates, loadCustomTemplates, refreshCustomTemplate, removeCustomTemplate, isBuiltinTemplate };
```

- [ ] **Step 2: 提交**

```bash
git add templates/templates.js
git commit -m "templates.js 支持自定义模板：合并内置+IndexedDB，导出刷新/移除方法"
```

---

### Task 5: 创建 docx-parser.js — Word 模板解析器

**Files:**
- Create: `js/docx-parser.js`

- [ ] **Step 1: 写 docx-parser.js 完整代码**

```javascript
// docx-parser.js — Word 模板解析器
// 从 .docx 文件中提取表格结构、样式，转换为模板 JSON
// 依赖：JSZip（全局）、DOMParser（浏览器内置）

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

/** 从 XML 提取页边距 */
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

/** 从 XML 提取表格列头文字和宽度 */
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

/** 提取标题文字 */
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
    }
  }
  return null;
}

/** 主函数：解析 .docx 文件 */
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
    return { success: false, error: '文件中未找到 document.xml' };
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
    return { success: false, error: '未检测到表格，是否手动创建模板？' };
  }

  const titleText = extractTitle(doc);
  const titleStyle = extractTitleStyle(doc);
  const signatureText = extractSignature(doc);

  // 5. 列类型识别
  let imageCount = 0;
  const columns = tableInfo.headers.map((header, i) => {
    const colType = guessColumnType(header);
    let field, type, width;

    width = tableInfo.colWidths[i] || 1800;
    // 宽度太小的列可能是序号列
    if (width < 700 && !colType) type = 'number';

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
      // 未识别的列
      type = 'text';
      field = 'field_' + i;
      unknowns.push({ index: i, header, guessedType: null });
    }

    return { label: header, field, type, width };
  });

  // 6. 组装模板 JSON
  const templateName = titleText ? `从docx导入：${titleText}` : `导入模板_${Date.now()}`;

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

/** AI 辅助识别未匹配的列（调用豆包） */
async function aiGuessColumns(unknowns, callDoubaoOptimize) {
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
    console.warn('AI列识别失败:', e);
  }

  return unknowns;
}

export { parseDocxTemplate, aiGuessColumns, guessColumnType };
```

- [ ] **Step 2: 提交**

```bash
git add js/docx-parser.js
git commit -m "新增 docx-parser.js: Word模板解析，XML提取+关键词+AI三阶段识别"
```

---

### Task 6: 更新 index.html 标题 + 确认 JSZip

**Files:**
- Modify: `index.html:11`

- [ ] **Step 1: 改标题**

```html
<title>安全检查报告工具 Pro</title>
```

- [ ] **Step 2: 确认 JSZip 脚本标签已存在且路径正确**

```html
<script src="lib/jszip.min.js"></script>
```

- [ ] **Step 3: 提交**

```bash
git add index.html
git commit -m "index.html 标题改为 Pro 版，JSZip 已就位"
```

---

### Task 7: UI — 导入面板 + 首页模板区

**Files:**
- Modify: `js/ui.js`

- [ ] **Step 1: 更新 import 语句**

在文件顶部 import 区域添加：

```javascript
import { getTemplate, listTemplates, loadCustomTemplates, refreshCustomTemplate, removeCustomTemplate, isBuiltinTemplate } from '../templates/templates.js';
import { parseDocxTemplate, aiGuessColumns } from './docx-parser.js';
```

- [ ] **Step 2: 在 `getTypeInfo()` 后面添加模板管理辅助函数**

```javascript
/** 清除类型信息缓存（模板变更后调用） */
function clearTypeInfoCache() {
  _typeInfoCache = null;
}
```

- [ ] **Step 3: 重写 `renderHomePage` — 分组显示内置和自定义模板**

把首页模板区域改为分组显示。找 `<div style="font-size:11px...选择报告类型...">` 那一段，替换为：

```javascript
  // 分组模板：内置 / 自定义
  const typeInfo = getTypeInfo();
  const allTemplates = Object.values(typeInfo);
  const builtinCards = allTemplates.filter(t => t.isBuiltin !== false);
  const customCards = allTemplates.filter(t => t.isBuiltin === false);

  function templateCardHtml(t) {
    return `
      <div class="card card-type-${t.id}" style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:28px;flex-shrink:0;">${t.icon}</span>
        <div style="flex:1;min-width:0;" data-action="select-type" data-type="${t.id}">
          <div class="card-title">${t.name}</div>
          <div class="card-desc">${t.desc || t.description || ''}</div>
        </div>
        ${!t.isBuiltin ? `
          <button class="tpl-export-btn" data-action="export-template" data-id="${t.id}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:6px;" title="导出模板">📤</button>
          <button class="tpl-delete-btn" data-action="delete-template" data-id="${t.id}" style="background:none;border:none;font-size:16px;cursor:pointer;padding:6px;" title="删除模板">🗑️</button>
        ` : ''}
      </div>`;
  }

  // ... 在 pageContainer.innerHTML 中：
  // 内置模板区
  ${builtinCards.length > 0 ? `
    <div style="font-size:11px;color:#999;margin:10px 0;text-align:center;">—— 📦 内置模板 ——</div>
    ${builtinCards.map(templateCardHtml).join('')}
  ` : ''}

  // 自定义模板区
  ${customCards.length > 0 ? `
    <div style="font-size:11px;color:#999;margin:16px 0 10px;text-align:center;">—— 📥 我的模板 ——</div>
    ${customCards.map(templateCardHtml).join('')}
  ` : ''}

  // 导入按钮
  <div style="text-align:center;margin-top:12px;">
    <button class="btn btn-outline" id="import-template-btn" style="width:100%;">📥 导入模板（.docx / .json）</button>
  </div>
```

- [ ] **Step 4: 在事件绑定中添加新按钮的处理**

在 `document.getElementById('home-page').addEventListener('click', ...)` 中，现有的 `action` 检查之后添加：

```javascript
    // 模板导出
    if (action === 'export-template') {
      e.stopPropagation();
      const tplId = card.dataset.id;
      import('./db.js?v=20260701f').then(({ getCustomTemplate, exportTemplateAsFile }) => {
        getCustomTemplate(tplId).then(record => {
          if (record) exportTemplateAsFile(record);
        });
      });
      return;
    }

    // 模板删除
    if (action === 'delete-template') {
      e.stopPropagation();
      const tplId = card.dataset.id;
      import('./db.js?v=20260701f').then(({ deleteTemplate }) => {
        deleteTemplate(tplId).then(() => {
          removeCustomTemplate(tplId);
          clearTypeInfoCache();
          // 重新渲染首页
          import('./db.js?v=20260701f').then(({ listDrafts }) => {
            listDrafts().then(newDrafts => {
              renderHomePage({ drafts: newDrafts, onSelectType });
            });
          });
          showToast('模板已删除');
        });
      });
      return;
    }
```

- [ ] **Step 5: 在页面事件中添加导入按钮事件**

需要在 `pageContainer.addEventListener` 级别或 `home-page` 事件处理中绑定 `import-template-btn`：

```javascript
  // 导入按钮事件（延迟绑定，因为按钮在 innerHTML 中）
  setTimeout(() => {
    const importBtn = document.getElementById('import-template-btn');
    if (importBtn) {
      importBtn.onclick = () => showImportPanel({ onSelectType, onBack: () => import('./db.js?v=20260701f').then(({ listDrafts }) => listDrafts().then(d => renderHomePage({ drafts: d, onSelectType }))) });
    }
  }, 0);
```

- [ ] **Step 6: 提交**

```bash
git add js/ui.js
git commit -m "首页分组显示内置/自定义模板，加导出/删除/导入按钮"
```

---

### Task 8: UI — 导入面板

**Files:**
- Modify: `js/ui.js` (追加新函数)

- [ ] **Step 1: 添加 `showImportPanel` 函数**

```javascript
function showImportPanel({ onSelectType, onBack }) {
  const overlay = document.createElement('div');
  overlay.id = 'import-panel-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">📥 导入模板</h3>
      <p style="font-size:13px;color:#999;margin-bottom:12px;">支持 .json（模板文件）和 .docx（Word模板自动识别）</p>

      <div id="import-drop-zone" style="border:2px dashed #ccc;border-radius:12px;padding:40px 20px;text-align:center;cursor:pointer;margin-bottom:12px;">
        <div style="font-size:40px;margin-bottom:8px;">📂</div>
        <div style="font-size:14px;color:#666;">点击选择文件或拖拽到此处</div>
        <input type="file" id="import-file-input" accept=".json,.docx" style="display:none;">
      </div>

      <div id="import-status" style="display:none;text-align:center;padding:12px;background:#fdf3e0;border-radius:10px;margin-bottom:10px;">
        <span class="spinner" style="margin-right:8px;vertical-align:middle;"></span>
        <span id="import-status-text">正在解析...</span>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="import-cancel-btn">取消</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 事件绑定
  document.getElementById('import-cancel-btn').onclick = () => {
    document.body.removeChild(overlay);
    onBack();
  };

  const dropZone = document.getElementById('import-drop-zone');
  const fileInput = document.getElementById('import-file-input');

  dropZone.onclick = () => fileInput.click();

  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.style.borderColor = '#4a90d9'; };
  dropZone.ondragleave = () => { dropZone.style.borderColor = '#ccc'; };
  dropZone.ondrop = (e) => { e.preventDefault(); dropZone.style.borderColor = '#ccc'; handleFile(e.dataTransfer.files[0]); };

  fileInput.onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };

  async function handleFile(file) {
    const statusDiv = document.getElementById('import-status');
    const statusText = document.getElementById('import-status-text');
    statusDiv.style.display = 'block';

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'json') {
      // JSON 直接导入
      statusText.textContent = '正在导入 JSON 模板...';
      try {
        const text = await file.text();
        const tpl = JSON.parse(text);
        if (!tpl.id || !tpl.columns) throw new Error('格式不正确');

        const { saveTemplate } = await import('./db.js?v=20260701f');
        const record = await saveTemplate({ ...tpl, source: 'imported', isBuiltin: false });
        refreshCustomTemplate(record.id, tpl);
        clearTypeInfoCache();

        document.body.removeChild(overlay);
        showToast(`模板"${tpl.name}"导入成功`);
        onBack();
      } catch (e) {
        statusText.textContent = '导入失败：' + (e.message || 'JSON 格式不正确');
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
      }
    } else if (ext === 'docx') {
      // DOCX 自动识别
      statusText.textContent = '正在解析 Word 模板...';
      try {
        const result = await parseDocxTemplate(file);
        if (!result.success) {
          statusText.textContent = result.error;
          // 提供手动创建选项
          setTimeout(() => {
            document.body.removeChild(overlay);
            showManualBuilder({ onSave: async (tpl) => {
              const { saveTemplate } = await import('./db.js?v=20260701f');
              const record = await saveTemplate({ ...tpl, source: 'manual', isBuiltin: false });
              refreshCustomTemplate(record.id, tpl);
              clearTypeInfoCache();
              showToast(`模板"${tpl.name}"创建成功`);
              onBack();
            }, onCancel: onBack });
          }, 2000);
          return;
        }

        // 识别成功 → 显示确认页
        document.body.removeChild(overlay);
        showTemplateConfirm(result, { onBack });
      } catch (e) {
        statusText.textContent = '解析失败：' + (e.message || '未知错误');
        setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
      }
    } else {
      statusText.textContent = '不支持的文件格式，请上传 .json 或 .docx';
      setTimeout(() => { statusDiv.style.display = 'none'; }, 3000);
    }
  }
}
```

- [ ] **Step 2: 在文件末尾 export 中添加 `showImportPanel`**

检查 ui.js 末尾的 export 语句，确保包含新函数。

- [ ] **Step 3: 提交**

```bash
git add js/ui.js
git commit -m "导入面板：拖拽上传 .json/.docx，JSON直导，DOCX进识别流程"
```

---

### Task 9: UI — 模板识别确认页 + 手动建模板

**Files:**
- Modify: `js/ui.js` (追加新函数)

- [ ] **Step 1: 添加 `showTemplateConfirm` 函数**

```javascript
function showTemplateConfirm(parseResult, { onBack }) {
  const { template, unknowns } = parseResult;

  const overlay = document.createElement('div');
  overlay.id = 'tpl-confirm-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';

  const columnsHtml = template.columns.map((col, i) => {
    const unknown = unknowns.find(u => u.index === i);
    let statusIcon = '✅';
    let statusColor = '#4caf50';
    if (unknown) {
      statusIcon = unknown.guessedType ? '⚠️' : '❓';
      statusColor = unknown.guessedType ? '#ff9800' : '#f44336';
    }
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;">
        <span style="font-size:16px;" title="${statusIcon === '✅' ? '已识别' : statusIcon === '⚠️' ? 'AI猜测' : '未识别'}">${statusIcon}</span>
        <span style="flex:1;font-size:14px;">${col.label}</span>
        <select class="tpl-col-type" data-index="${i}" style="font-size:13px;padding:4px;border-radius:6px;border:1px solid #${statusColor};">
          <option value="number" ${col.type === 'number' ? 'selected' : ''}>序号</option>
          <option value="description" ${col.type === 'description' ? 'selected' : ''}>问题描述</option>
          <option value="image" ${col.type === 'image' ? 'selected' : ''}>照片</option>
          <option value="remark" ${col.type === 'remark' ? 'selected' : ''}>备注</option>
          <option value="text" ${col.type === 'text' ? 'selected' : ''}>普通文字</option>
        </select>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:4px;">🔍 模板识别结果</h3>
      <p style="font-size:12px;color:#999;margin-bottom:12px;">
        ✅已识别 | ⚠️AI猜测(可改) | ❓未识别(请手动选择)
      </p>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">模板名称</label>
        <input type="text" id="tpl-name-input" value="${escapeHtml(template.name)}" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">所属行业</label>
        <select id="tpl-industry-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;">
          <option value="">请选择</option>
          <option value="制造业">🏭 制造业</option>
          <option value="化工">🧪 化工</option>
          <option value="建筑">🏗️ 建筑</option>
          <option value="仓储">📦 仓储</option>
          <option value="餐饮">🍽️ 餐饮</option>
          <option value="消防">🧯 消防</option>
          <option value="电力">⚡ 电力</option>
          <option value="通用">📄 通用</option>
        </select>
      </div>

      <div style="margin-bottom:4px;font-size:13px;color:#666;">表格列识别</div>
      <div style="border:1px solid #eee;border-radius:8px;margin-bottom:16px;">
        ${columnsHtml}
      </div>

      ${unknowns.length > 0 ? `
        <button class="btn btn-purple btn-block" id="ai-guess-btn" style="margin-bottom:12px;">🤖 AI 智能识别未匹配列</button>
      ` : ''}

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="tpl-cancel-btn">取消</button>
        <button class="btn btn-primary btn-block" id="tpl-save-btn">💾 保存模板</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  // 事件绑定
  document.getElementById('tpl-cancel-btn').onclick = () => {
    document.body.removeChild(overlay);
    onBack();
  };

  document.getElementById('tpl-save-btn').onclick = async () => {
    // 收集修改
    template.name = document.getElementById('tpl-name-input').value.trim() || template.name;
    template.industry = document.getElementById('tpl-industry-select').value;

    const typeSelects = overlay.querySelectorAll('.tpl-col-type');
    typeSelects.forEach(sel => {
      const i = parseInt(sel.dataset.index);
      template.columns[i].type = sel.value;
      // 修正 field
      if (sel.value === 'number') template.columns[i].field = '_index';
      else if (sel.value === 'description') template.columns[i].field = 'description';
      else if (sel.value === 'remark') template.columns[i].field = '_remark';
    });

    const { saveTemplate } = await import('./db.js?v=20260701f');
    const record = await saveTemplate({ ...template, source: 'docx-imported', isBuiltin: false });
    refreshCustomTemplate(record.id, template);
    clearTypeInfoCache();

    document.body.removeChild(overlay);
    showToast(`模板"${template.name}"导入成功`);
    onBack();
  };

  // AI 识别按钮
  const aiBtn = document.getElementById('ai-guess-btn');
  if (aiBtn) {
    aiBtn.onclick = async () => {
      aiBtn.disabled = true;
      aiBtn.textContent = 'AI 识别中...';
      const guessed = await aiGuessColumns(unknowns, null);
      // 重建确认页
      document.body.removeChild(overlay);
      showTemplateConfirm({ template, unknowns: guessed.map(u => ({ ...u, guessedType: u.guessedType })) }, { onBack });
    };
  }
}
```

- [ ] **Step 2: 添加 `showManualBuilder` 降级函数**

```javascript
function showManualBuilder({ onSave, onCancel }) {
  const overlay = document.createElement('div');
  overlay.id = 'manual-builder-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:60;display:flex;align-items:flex-end;justify-content:center;';
  overlay.innerHTML = `
    <div style="background:#fff;width:100%;max-width:480px;border-radius:16px 16px 0 0;padding:20px;max-height:80vh;overflow-y:auto;">
      <h3 style="margin-bottom:12px;">🛠️ 手动创建模板</h3>
      <p style="font-size:13px;color:#999;margin-bottom:12px;">Word 模板解析失败，请手动配置</p>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">模板名称</label>
        <input type="text" id="manual-name" value="自定义模板" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;box-sizing:border-box;">
      </div>

      <div style="margin-bottom:12px;">
        <label style="font-size:13px;color:#666;">列配置（5列推荐）</label>
        <div id="manual-columns">
          ${[0,1,2,3,4].map(i => `
            <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
              <input type="text" value="${['序号','检查项目','检查情况','整改情况','备注'][i]}" style="flex:1;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
              <select style="width:100px;padding:6px;border:1px solid #ddd;border-radius:6px;font-size:13px;">
                <option value="number" ${i===0?'selected':''}>序号</option>
                <option value="description" ${i===1?'selected':''}>描述</option>
                <option value="image" ${[2,3].includes(i)?'selected':''}>照片</option>
                <option value="remark" ${i===4?'selected':''}>备注</option>
                <option value="text">文字</option>
              </select>
            </div>
          `).join('')}
        </div>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-outline btn-block" id="manual-cancel">取消</button>
        <button class="btn btn-primary btn-block" id="manual-save">💾 创建</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('manual-cancel').onclick = () => { document.body.removeChild(overlay); onCancel(); };
  document.getElementById('manual-save').onclick = () => {
    const name = document.getElementById('manual-name').value.trim() || '自定义模板';
    const colDivs = document.getElementById('manual-columns').children;
    const columns = [];
    const FIELD_MAP = { number: '_index', description: 'description', remark: '_remark' };
    let imgCount = 0;
    for (const div of colDivs) {
      const input = div.querySelector('input');
      const select = div.querySelector('select');
      if (!input.value.trim()) continue;
      let field = FIELD_MAP[select.value] || 'field_' + columns.length;
      if (select.value === 'image') {
        field = imgCount === 0 ? 'beforePhoto' : 'afterPhoto';
        imgCount++;
      }
      columns.push({ label: input.value.trim(), field, type: select.value, width: 1800 });
    }

    const tpl = {
      id: 'tpl_' + Date.now(),
      name, industry: '通用', description: '手动创建',
      overviewType: 'generic',
      page: { margins: { top: 1213, bottom: 1440, left: 1123, right: 1123 }, tableWidth: 9207 },
      title: { font: '宋体', size: 36, bold: true, alignment: 'center', spacing: { before: 242, after: 0, line: 400 } },
      overview: { font: '宋体', size: 24, alignment: 'justified', spacing: { before: 242, after: 120, line: 400 }, firstLineIndent: 560, leftIndent: 120 },
      columns,
      columnStyles: { header: { font: '宋体', size: 24, bold: true, background: 'D9E2F3' }, number: { font: '宋体', size: 28, alignment: 'center' }, text: { font: '宋体', size: 28, alignment: 'center' }, description: { font: '宋体', size: 22, alignment: 'left' }, remark: { font: '宋体', size: 20, alignment: 'center' }, image: { displayWidth: 192 } },
      cellMargins: { top: 0, bottom: 0, left: 108, right: 108 },
      rowHeight: { header: 90, data: 3400 },
      hasSignatures: true, signatureText: '编制：               审核：                 批准：',
      footer: { font: '宋体', size: 28, spacing: { after: 200 } },
      aiPromptTag: '影响',
      variables: { company: { label: '公司名称', default: '', editable: true }, department: { label: '部门', default: '', editable: true } },
    };

    document.body.removeChild(overlay);
    onSave(tpl);
  };
}
```

- [ ] **Step 3: 在 export 中导出新函数**

检查 ui.js 末尾 export 是否包含 `showImportPanel`, `showTemplateConfirm`, `showManualBuilder`, `clearTypeInfoCache`。

- [ ] **Step 4: 提交**

```bash
git add js/ui.js
git commit -m "模板确认页：列类型修改+AI识别+保存，手动建模板降级方案"
```

---

### Task 10: 更新 app.js 初始化流程 + 事件绑定

**Files:**
- Modify: `js/app.js`

- [ ] **Step 1: 更新 import 添加模板相关导入**

```javascript
import { saveDraft, getDraft, deleteDraft, listDrafts, getBackupInfo, getPresets, savePresets, getTodayStr, migrateFromV1, saveTemplate, deleteTemplate, getCustomTemplate, listCustomTemplates, exportTemplateAsFile } from './db.js?v=20260701f';
import { generateDocx, loadTemplate } from './docx-gen.js?v=20260701f';
import { getTemplate, loadCustomTemplates, refreshCustomTemplate, removeCustomTemplate, isBuiltinTemplate } from '../templates/templates.js';
import { callDoubaoOptimize } from './ai.js?v=20260701f';
import { parseDocxTemplate, aiGuessColumns } from './docx-parser.js';
import {
  showToast, FIXED_COMPANY, FIXED_DEPARTMENT,
  renderHomePage,
  renderItemList,
  renderItemForm,
  renderOptimizePage,
  showEditModal,
  showMergePanel,
  renderGeneratePage,
  showImportPanel,          // 新增
  showTemplateConfirm,       // 新增
  showManualBuilder,         // 新增
} from './ui.js?v=20260701f';
```

- [ ] **Step 2: 在 `initApp()` 中添加模板加载**

在 `migrateFromV1()` 调用之后：

```javascript
  // 加载自定义模板
  await loadCustomTemplates();
```

- [ ] **Step 3: 提交**

```bash
git add js/app.js
git commit -m "app.js 初始化加载自定义模板，导入docx-parser和模板管理方法"
```

---

### Task 11: docx-gen.js — 添加 generic overviewType 兜底逻辑

**Files:**
- Modify: `js/docx-gen.js`

- [ ] **Step 1: 在 `buildOverview` 的 switch 中添加 `default` 分支**

找到 `buildOverview` 函数中的 `default:` 分支，替换为：

```javascript
    default:
      // generic 或未知类型：通用概述
      titleText = `${department || '检查部门'}检查报告`;
      overviewText = `本次检查共发现${totalItems}个问题，其中已整改完成${completedItems}项，未完成整改${unfinishedItems}项。`;
```

- [ ] **Step 2: 提交**

```bash
git add js/docx-gen.js
git commit -m "docx-gen: generic overviewType 兜底概述逻辑"
```

---

### Task 12: 验证

**Files:**
- 运行: `verify-templates.mjs`
- 手动: 浏览器测试

- [ ] **Step 1: 运行现有验证**

```bash
node verify-templates.mjs
```
期望：全部通过（含内置三套模板的 93 项检查）

- [ ] **Step 2: 补充 universal 和 generic overviewType 验证**

在 `verify-templates.mjs` 末尾添加：

```javascript
// 测试 universal 模板
const universalTpl = JSON.parse(readFileSync('./templates/universal.json', 'utf-8'));
loadTemplate(universalTpl);
const uniResult = await generateDocx(
  { company: '测试', department: '测试', date: '2026-07-06' },
  [{ description: '测试问题', beforePhoto: 'x', afterPhoto: 'y' }]
);
check('Universal 报告生成成功', uniResult instanceof Blob, true);
check('Universal 报告大小 > 0', uniResult.size > 0, true);
check('Universal overviewType', universalTpl.overviewType, 'generic');
console.log('\n🎉 全部验证通过！(含 universal 模板)');
```

运行：
```bash
node verify-templates.mjs
```
期望：全部通过

- [ ] **Step 3: 浏览器手动测试**

```bash
npx serve .
```

测试流程：
1. 打开首页 → 看到分组的内置模板和导入按钮
2. 点击导入 → 上传 .json 模板 → 首页出现新卡片
3. 点击导入 → 上传 .docx 模板 → 识别确认页 → 保存
4. 选任意模板 → 拍照 → 描述 → 生成报告 → 下载
5. 自定义模板 → 点导出 → 下载 .json 文件
6. 自定义模板 → 点删除 → 消失

- [ ] **Step 4: 提交最终版本**

```bash
git add -A
git commit -m "验证: 全部模板导入功能通过测试"
git push origin master
```
