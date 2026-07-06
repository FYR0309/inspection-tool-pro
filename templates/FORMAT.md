# 报告模板 JSON 格式规范

## 整体结构

```json
{
  "id": "模板唯一标识",
  "name": "模板显示名称",
  "industry": "所属行业",
  "description": "一句话描述",
  "overviewType": "概述类型标识",
  "page": { ... },
  "title": { ... },
  "overview": { ... },
  "columns": [ ... ],
  "columnStyles": { ... },
  "cellMargins": { ... },
  "rowHeight": { ... },
  "hasSignatures": true/false,
  "signatureText": "签名行文字",
  "footer": { ... },
  "aiPromptTag": "风险/影响",
  "variables": { ... }
}
```

## 字段说明

### id
模板唯一标识，英文。如 `"safety"`、`"catering"`。

### name
显示给用户看的名称。如 `"安全自查整改报告"`。

### industry
所属行业分类。如 `"制造业"`、`"餐饮"`、`"化工"`、`"建筑"`。

### description
一句话描述模板用途。

### overviewType
告诉代码用哪套逻辑生成概述段落和标题文字。目前支持：
- `"safety"` — 安全自查整改报告格式
- `"5s"` — 5S 现场检查通报格式
- `"company"` — 公司现场检查整改报告格式

### page
```json
{
  "margins": { "top": 800, "bottom": 1100, "left": 600, "right": 480 },
  "tableWidth": 9971
}
```
- `margins`: 页边距，单位 twips（1/20 磅）
- `tableWidth`: 表格总宽度，单位 twips

### title
标题样式配置：
```json
{
  "font": "宋体",
  "size": 44,
  "bold": true,
  "alignment": "center",
  "spacing": { "before": 242, "after": 0, "line": 400 }
}
```
- `size`: 半磅（half-points），44 = 22pt
- `alignment`: "left" | "center" | "right" | "justified"

### overview
概述段样式配置，字段同 title。

### columns
列定义数组，顺序即表格从左到右的列顺序：
```json
[
  { "label": "序号", "field": "_index", "type": "number", "width": 606 },
  { "label": "部门", "field": "department", "type": "text", "width": 834 },
  { "label": "问题描述", "field": "description", "type": "description", "width": 1960 },
  { "label": "整改前图片", "field": "beforePhoto", "type": "image", "width": 2749 },
  { "label": "整改后图片", "field": "afterPhoto", "type": "image", "width": 2800 },
  { "label": "备注", "field": "_remark", "type": "remark", "width": 1022 }
]
```

- `label`: 表头显示文字
- `field`: 数据字段名。`_index` 和 `_remark` 是特殊字段（自动生成序号和备注）
- `type`: 列类型，决定单元格渲染方式
  - `"number"` — 自动序号
  - `"text"` — 普通文字
  - `"description"` — 问题描述（左对齐，字号较小）
  - `"image"` — 图片
  - `"remark"` — 自动备注（有整改后照片时自动填"已整改"）
- `width`: 列宽，单位 twips

### columnStyles
各类型单元格的样式：
```json
{
  "header": { "font": "宋体", "size": 28, "bold": true, "background": "D9E2F3" },
  "number": { "font": "宋体", "size": 28, "alignment": "center" },
  "text": { "font": "宋体", "size": 28, "alignment": "center" },
  "description": { "font": "宋体", "size": 22, "alignment": "left" },
  "remark": { "font": "宋体", "size": 20, "alignment": "center" },
  "image": { "displayWidth": 192 }
}
```
- `header`: 表头行样式，`background` 是底色
- 其他 key 对应 columns 中的 `type`
- `image.displayWidth`: 图片显示宽度（像素@96DPI）

### cellMargins
单元格内边距：
```json
{ "top": 0, "bottom": 0, "left": 0, "right": 0 }
```
安全模板全0，5S/公司模板左右108。

### rowHeight
行高配置：
```json
{ "header": 90, "data": 3400 }
```
单位 twips，规则 atLeast（最小高度）。

### hasSignatures
布尔值，是否在文档末尾显示签名行。

### signatureText
签名行文字，如 `"编制：               审核：                 批准："`。

### footer
落款区域样式（公司名、部门、日期）：
```json
{
  "font": "宋体",
  "size": 30,
  "spacing": { "after": 200 }
}
```

### aiPromptTag
AI 润色末尾追加的标签类型：
- `"风险"` → `[风险：xxx]`
- `"影响"` → `[影响：xxx]`

### variables
模板中可配置的变量：
```json
{
  "company": {
    "label": "公司名称",
    "default": "广西糖业集团红河制糖有限公司",
    "editable": false
  },
  "department": {
    "label": "部门",
    "default": "压榨车间",
    "editable": false
  }
}
```
- `editable: false` → 用户不能修改（如压榨车间专用版）
- `editable: true` → 用户可以修改（如付费版自定义公司名）
