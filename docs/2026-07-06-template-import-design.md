# 模板导入系统 — 设计文档

> 日期：2026-07-06
> 状态：设计中 → 待用户审阅

## 一、目标

让安全检查工具 Pro 版支持三种模板来源：

| 来源 | 场景 | 用户 |
|------|------|------|
| 内置通用模板 | 没有模板的客户，开箱即用 | 所有人 |
| 导入 .docx | 客户已有 Word 模板，想格式一模一样 | 客户自己操作 |
| 导入/导出 .json | 模板包分发、备份、同事间共享 | 你→客户、客户→同事 |

---

## 二、新增文件

```
inspection-tool-pro/
├── js/
│   ├── docx-parser.js        ← 新增：Word 模板解析器
│   └── ...
├── templates/
│   ├── universal.json        ← 新增：万能通用模板（5列兜底）
│   └── ...
├── index.html                ← 修改：加 JSZip CDN
└── docs/
    └── 2026-07-06-template-import-design.md  ← 本文档
```

## 三、docx-parser.js 设计

### 3.1 依赖

- **JSZip**：CDN 引入（~100KB），解压 .docx 的 ZIP 结构
- **DOMParser**：浏览器自带，解析 XML
- **ai.js**（可选）：调用豆包 API 做 AI 列类型识别

### 3.2 三阶段流水线

```
阶段1：XML 结构提取（规则引擎）
  → 解压 ZIP → 解析 document.xml → 提取页边距/表格/列头/字体/签名行
  
阶段2：关键词匹配（规则引擎）
  → 根据列头文字关键词判断列类型（如"照片"→image）
  → 匹配到的标记 ✅，匹配不到的标记 ❓
  
阶段3：AI 兜底（可选，用户点击触发）
  → 把 ❓ 列名发给豆包 API
  → AI 返回类型判断
  → 标记为 ⚠️（AI猜测），用户可改
```

### 3.3 提取内容

| 提取项 | XML 路径 | 输出 |
|--------|----------|------|
| 页边距 | `w:sectPr/w:pgMar` | `{top, bottom, left, right}` twips |
| 表格总宽 | `w:tblPr/w:tblW@w:w` | 数字 twips |
| 列头文字 | `w:tr/w:tc/w:p/w:r/w:t` | 字符串数组 |
| 列宽 | `w:tblGrid/w:gridCol@w:w` | 数字数组 twips |
| 表头字体 | `w:rPr/w:rFonts, w:rPr/w:sz` | 字体名、半磅字号 |
| 表头底色 | `w:tcPr/w:shd@w:fill` | 颜色 hex |
| 签名行 | 表格后含"编制/审核/批准"的 `w:p` | 字符串 |
| 标题文字 | 表格前第一个 `w:p` | 字符串 |

### 3.4 列类型识别关键词库

```javascript
const TYPE_KEYWORDS = {
  number:   ['序号', '编号', 'No.', '项次', '检查序号', '隐患编号', '问题编号', 'NO', '编号'],
  image:    ['照片', '图片', '影像', '附图', '佐证', '截图', '图像'],
  description: ['问题', '描述', '隐患', '检查发现', '不符合', '存在问题', '检查情况',
                '检查内容', '检查项目', '具体描述', '现象', '情况', '不合格项'],
  remark:   ['备注', '说明', '注', '整改要求', '整改建议', '整改措施', '备注说明'],
  department: ['部门', '车间', '单位', '责任部门', '所属部门', '科室', '区域'],
  riskLevel: ['风险', '等级', '严重', '类别', '隐患等级', '风险等级', '分级'],
  date:     ['日期', '时间', '检查日期', '整改期限', '完成时间', '期限'],
  person:   ['责任人', '检查人', '负责人', '责任', '整改人', '签字'],
};
```

### 3.5 返回值（parserResult）

```javascript
{
  success: true,
  template: {
    id: "imported_xxxxx",          // 自动生成
    name: "从docx导入：xxx报告",     // 取标题文字
    industry: "",                   // 用户选择
    description: "",
    overviewType: "generic",        // 导入模板默认 generic
    // ... 完整模板 JSON，可直接喂给 docx-gen.js
  },
  warnings: [],                     // 解析警告
  unknowns: [                       // 未识别的列
    { index: 2, header: "检查情况", guessedType: null }
  ]
}
```

### 3.6 错误处理

| 情况 | 处理 |
|------|------|
| 文件不是 .docx（无法解压） | 提示"请上传 .docx 格式文件" |
| 无表格 | 提示"未检测到表格，是否手动创建模板？" |
| 表头行为空 | 取表格第一行当列头 |
| 合并单元格 | 跳过复杂合并，标记 warning |
| 多表格 | 只解析第一个含表头的表格 |

---

## 四、模板管理（db.js 扩展）

### 4.1 新增表：`templates`

```javascript
// IndexedDB object store: templates
// keyPath: id
{
  id: "custom_xxxxx",       // 主键
  name: "餐饮卫生检查报告",
  source: "imported",       // "builtin" | "imported" | "docx-imported"
  createdAt: "2026-07-06",
  updatedAt: "2026-07-06",
  isBuiltin: false,         // 内置模板不可删除
  data: { /* 完整模板 JSON */ }
}
```

### 4.2 新增方法

```javascript
saveTemplate(templateData)     // 保存自定义模板
deleteTemplate(id)              // 删除自定义模板
getTemplate(id)                 // 获取单个模板
listAllTemplates()              // 列出所有模板（内置+自定义）
exportTemplate(id)              // 导出为 .json 文件
importTemplate(jsonFile)        // 导入 .json 模板文件
```

---

## 五、UI 改动

### 5.1 首页改动

```
┌──────────────────────────────────────┐
│  安全检查报告 Pro                      │
│  ─────────────────────────────────── │
│                                      │
│  📦 内置模板                          │
│  ┌─ 🏭 安全自查整改报告              │
│  ├─ 📋 5S现场检查通报                │
│  ├─ 🏭 公司现场检查整改报告           │
│  └─ 📄 万能通用模板        ← 新增     │
│                                      │
│  📥 我的模板                          │
│  ┌─ 🍽️ 餐饮卫生检查报告  [导出] [删] │
│  └─ 🏗️ 工地安全检查表    [导出] [删] │
│                                      │
│  [+ 导入模板]  ← 点击弹出导入面板      │
└──────────────────────────────────────┘
```

### 5.2 导入面板

```
┌──────────────────────────────────────┐
│  导入模板                             │
│                                      │
│  支持格式：.json（模板文件）            │
│           .docx（Word模板，自动识别）   │
│                                      │
│  ┌──────────────────────────────┐    │
│  │  拖拽文件到这里或点击选择      │    │
│  └──────────────────────────────┘    │
│                                      │
│  .docx 导入选项：                     │
│  ☑ 使用 AI 智能识别列类型（推荐）      │
│                                      │
│  [取消]                              │
└──────────────────────────────────────┘
```

### 5.3 识别确认页（仅 .docx）

如 Part 2 设计，展示识别结果，✅/⚠️/❓ 三种状态，用户修改后保存。

### 5.4 手动建模板（降级方案）

docx 解析失败或用户选择手动创建时：
- 输入模板名称、选择行业
- 逐列添加：列名下拉 + 类型选择 + 宽度
- 预览表格
- 保存

---

## 六、内置"万能通用模板"

```json
{
  "id": "universal",
  "name": "通用检查报告",
  "industry": "通用",
  "description": "适用于任何检查场景的通用模板",
  "overviewType": "generic",
  "columns": [
    { "label": "序号", "field": "_index", "type": "number", "width": 600 },
    { "label": "检查项目", "field": "description", "type": "description", "width": 2000 },
    { "label": "检查情况", "field": "beforePhoto", "type": "image", "width": 2800 },
    { "label": "整改情况", "field": "afterPhoto", "type": "image", "width": 2800 },
    { "label": "备注", "field": "_remark", "type": "remark", "width": 1000 }
  ]
}
```

5 列兜底结构，覆盖最通用的检查场景。

---

## 七、和现有架构的关系

```
                    ┌─────────────┐
    客户 Word 模板 →│docx-parser.js│→ 半成品 JSON
                    └─────────────┘        ↓
                                    用户预览确认
    你写的 JSON 包 ─────────────────→    ↓
                                    完整 JSON 模板
    内置模板 JSON ─────────────────→    ↓
                                    db.js 存储
                                          ↓
                                    docx-gen.js 生成报告
```

**导入的模板和内置模板在 docx-gen.js 层面完全平等**——都通过 loadTemplate() 加载，generateDocx() 统一处理。

---

## 八、待定事项

- [ ] `overviewType: "generic"` 的概述文字生成逻辑（后续实现）
- [ ] AI 列识别的 prompt 调优
- [ ] docx 模板预览（浏览器渲染 Word 表格预览）

---

## 九、关联记忆

- [[inspection-tool-pro-design]] — Pro 版整体设计
- [[side-business-plan]] — 副业计划（模板包售卖）
