// config.js — 应用配置（API、默认值等集中管理）
// v1: 从 ai.js / ui.js 中提取，方便统一修改
//
// ⚠️ 安全提醒：
// API Key 已暴露在公开仓库中，请在火山方舟控制台限制 Key 的调用来源
// 生产环境建议加一层后端代理（如 Cloudflare Worker）

// ---------- 豆包 API ----------

const DOUBAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DOUBAO_API_KEY = 'ark-4b152d9d-0ad1-4e65-838f-a52f264ff4ea-12064';
const DOUBAO_MODEL = 'ep-20260616232549-wr6bn';

// 图片编辑 API (Seedream 4.5)
const IMAGE_EDIT_MODEL = 'ep-20260619024752-vbxk7';
const IMAGE_API_KEY = 'ark-a5912081-882c-4cbf-917b-e9cac733f0d8-894c4';

// ---------- 默认预设 ----------

// Pro 版默认不写死公司/部门，首次使用由用户自行设置
const DEFAULT_COMPANY = '';
const DEFAULT_DEPARTMENT = '';

// ---------- 应用常量 ----------

const APP_NAME = '安全检查报告工具 Pro';
const MAX_DRAFTS = 6;

// ---------- 激活系统 ----------

const ACTIVATION_ENABLED = true;
const FREE_MONTHLY_LIMIT = 5;
const ACTIVATION_KEY = '_iap_v';

// Pro 版功能开关：设为 false 可全局禁用激活检查（调试用）
const REQUIRE_ACTIVATION_FOR_IMAGE_EDIT = true;  // AI修图需要Pro
const REQUIRE_ACTIVATION_FOR_UNLIMITED = true;    // 无限报告需要Pro

export {
  DOUBAO_API_URL, DOUBAO_API_KEY, DOUBAO_MODEL,
  IMAGE_EDIT_MODEL, IMAGE_API_KEY,
  DEFAULT_COMPANY, DEFAULT_DEPARTMENT,
  APP_NAME, MAX_DRAFTS,
  ACTIVATION_ENABLED, FREE_MONTHLY_LIMIT, ACTIVATION_KEY,
  REQUIRE_ACTIVATION_FOR_IMAGE_EDIT, REQUIRE_ACTIVATION_FOR_UNLIMITED,
};
