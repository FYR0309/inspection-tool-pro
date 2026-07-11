// activate.js — 激活码验证、用量计数、权限控制
// v1: SHA-256 哈希白名单 + localStorage 持久化
//
// 纯客户端验证，目标是诚实用户保护（非防破解）
// 激活码格式：RTHX-XXXX-XXXX（12位字母数字）

// ---------- 有效激活码 SHA-256 哈希白名单 ----------

const VALID_HASHES = [
  '33761950b7f40a99aebd3c081c209aaf28751fd1baeb06757ae197873d95d2f3',
  'f4e90ba3dd8968173520fb3e78b94700e6b4f3facf7eb8aff255b53edd57d101',
  '10ebbe299f278418f413ac9f89191ee54b0cf7d0609193f88ffe3eb511a02572',
  'efef0a5233109ddec737c8208164c57d75ae5de3e31ff903d263c08b5e2a7ae5',
  'ea69fd5a7634a5097770ce1243d5030e771eea68a58f44eeb560be908682b966',
  'dd59ef0501bf1617e60bf8b77d01ea323c23c26f8d67bfb7689587d55e82ece5',
  '40b8274a6344fd9f7ceb0d628ad58c219a6a0de32bfda72fa106b04e16f25392',
  '0683d8c30708ae555b70eee7928d5a556f7ef62eb3a0272adf5c281cc9ae4717',
  '6c75d77ef8cce0af04cf26ae58d0d26f688cd9634fbbf16c75eeafd1153534be',
  'ff53fe196d109edf695a8fc29a53bee46aba1d87d531c213b3e0783c21539382',
  'b9ae47bca255e2da4f7d0b10f795a92361debd318ca8b0ddae0e7a4658dd26d1',
  '1ba923dfd9c66959352ec2575a65169b7c6ff79d656b583a355d2592a0a9adb1',
  '4225f2bded6fe2296fbed467cc287fc5ba7cda0bdc77a7e874390c50bbdf00e8',
  '80a8b49838ec47ad2f70d21a72e7e8058f562b6d2fa984cd46272f86ec891e78',
  '6658b3b78b56df4c890e08079ee259555d5e18c4ce1730ddb753b35559a0bac4',
  '19624ef3135d0525b5458c01478054530375672c2e8a720ab5e439b9c06f6340',
  'ae21df868c83bc5bd78b164253b0c7b3218a5b49e19bf84a4568cbc8c380cb0a',
  '5c1018e11d8a5bd35cbcada8c2125ec1973d228e249551cbd344977f16f01fc8',
  'e2fed6581ca26c0323b23e80fb7fe291aede3f6e14d0147ac11026debd297ae8',
  '9a372ca5e47dd3160629ce506c51985f5af3c0550caf141261aa729a446b152c',
  // 开发者专用（激活码 RTHX-DEV0-DEV0）
  'b33ded1ff363aa09b05d4d0636b8a41e54da3f5ec99c5216e34f89e88400c99a',
];

// ---------- 常量 ----------

const FREE_MONTHLY_LIMIT = 5;
const ACTIVATION_KEY = '_iap_v';  // 故意用不明显的 key 名
const GRACE_LIMIT = 1;  // 免费版超限后可额外生成 1 份（软性限制）

// 开发者专用哈希（激活码 RTHX-DEV0-DEV0）
const DEV_HASH = 'b33ded1ff363aa09b05d4d0636b8a41e54da3f5ec99c5216e34f89e88400c99a';

// ---------- 工具函数 ----------

/** 规范化激活码：去分隔符、转大写 */
function normalizeCode(input) {
  return input.replace(/[\s\-_]/g, '').toUpperCase();
}

/** 计算字符串的 SHA-256 哈希（hex） */
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 获取当前年月 key（格式：YYYY-MM） */
function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 读取激活数据（base64 编码的 JSON blob） */
function readActivationData() {
  try {
    const raw = localStorage.getItem(ACTIVATION_KEY);
    if (!raw) return null;
    const json = atob(raw);
    const data = JSON.parse(json);
    // 校验 checksum
    if (!data._cs || data._cs !== computeChecksum(data)) {
      console.warn('[激活] 数据被篡改，已重置');
      localStorage.removeItem(ACTIVATION_KEY);
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

/** 写入激活数据 */
function writeActivationData(data) {
  // 计算 checksum（排除 _cs 字段本身）
  const clean = { ...data };
  delete clean._cs;
  clean._cs = computeChecksum(clean);
  const json = JSON.stringify(clean);
  const encoded = btoa(json);
  localStorage.setItem(ACTIVATION_KEY, encoded);
}

/** 简单 checksum（防 casual tampering） */
function computeChecksum(data) {
  // 排除 _cs 字段自身，确保写入和读取时计算一致
  const obj = {};
  for (const key of Object.keys(data).sort()) {
    if (key === '_cs') continue;
    obj[key] = data[key];
  }
  const str = JSON.stringify(obj);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

// ---------- 公开 API ----------

/** 检查激活状态 */
function checkActivation() {
  const data = readActivationData();
  if (data && data.activated && data.codeHash) {
    const isDev = data.codeHash === DEV_HASH;
    return {
      activated: true,
      activatedAt: data.activatedAt || 0,
      dev: isDev,  // 开发者模式：永久有效、无限制
    };
  }
  return { activated: false };
}

/** 验证激活码（输入 → SHA-256 → 比对白名单） */
async function validateCode(input) {
  const normalized = normalizeCode(input);

  // 格式校验
  if (!/^RTHX[A-Z0-9]{8}$/.test(normalized)) {
    return { valid: false, error: '激活码格式不正确' };
  }

  // 检查 Web Crypto API 可用性
  if (!crypto || !crypto.subtle) {
    console.error('[激活] crypto.subtle 不可用，可能需要 HTTPS 环境');
    return { valid: false, error: '安全环境不可用，请使用 HTTPS 访问' };
  }

  // SHA-256 哈希比对
  const hash = await sha256(normalized);
  console.log('[激活] 验证码:', normalized, 'hash:', hash.substring(0, 16) + '...');
  if (VALID_HASHES.includes(hash)) {
    return { valid: true };
  }

  return { valid: false, error: '无效的激活码' };
}

/** 激活（验证 + 持久化） */
async function activateCode(input) {
  const validation = await validateCode(input);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const normalized = normalizeCode(input);
  const hash = await sha256(normalized);

  writeActivationData({
    activated: true,
    codeHash: hash,
    activatedAt: Date.now(),
  });

  // 激活后清空用量计数（重新开始）
  clearUsage();

  return { success: true };
}

/** 获取本月用量 */
function getUsageThisMonth() {
  const data = readActivationData();
  const monthKey = getMonthKey();
  const usage = (data && data.usage) ? data.usage : {};
  const used = usage[monthKey] || 0;
  const graceUsed = usage[monthKey + '_grace'] || 0;
  return {
    used,
    limit: FREE_MONTHLY_LIMIT,
    remaining: Math.max(0, FREE_MONTHLY_LIMIT - used),
    graceRemaining: Math.max(0, GRACE_LIMIT - graceUsed),
  };
}

/** 递增本月用量 */
function incrementUsage() {
  const data = readActivationData() || {};
  const monthKey = getMonthKey();

  if (!data.usage) data.usage = {};

  const used = data.usage[monthKey] || 0;
  if (used >= FREE_MONTHLY_LIMIT) {
    // 已用完免费额度，使用 grace
    const graceUsed = data.usage[monthKey + '_grace'] || 0;
    data.usage[monthKey + '_grace'] = graceUsed + 1;
  } else {
    data.usage[monthKey] = used + 1;
  }

  // 存储最后使用时间戳（用于检测时钟回拨）
  data._lastUsed = Date.now();
  data._lastMonthKey = monthKey;

  writeActivationData(data);
}

/** 清除用量计数（保留激活状态，只重置 usage） */
function clearUsage() {
  const data = readActivationData();
  if (!data) return;  // 无数据时不写入，防止覆盖
  data.usage = {};
  writeActivationData(data);
}

/** 检查功能是否可用 */
function isFeatureAllowed(feature) {
  const activation = checkActivation();
  if (activation.activated) return true;  // Pro 版 + 开发者全开放

  // 免费版功能限制
  switch (feature) {
    case 'image-edit':
      return false;  // AI 修图仅 Pro 版
    case 'unlimited-reports':
      return false;
    default:
      return true;
  }
}

/** 检查是否可以生成报告 */
function canGenerateReport() {
  const activation = checkActivation();
  if (activation.activated) return { allowed: true };  // Pro/Dev 无限制

  const usage = getUsageThisMonth();
  if (usage.remaining > 0) {
    return { allowed: true, reason: null };
  }
  if (usage.graceRemaining > 0) {
    return { allowed: true, reason: 'grace', message: '本月免费额度已用完，本次为赠送次数' };
  }
  return { allowed: false, reason: 'limit', message: '本月免费额度已用完（5次），请升级Pro版' };
}

/** 重置激活（仅测试用） */
function deactivate() {
  localStorage.removeItem(ACTIVATION_KEY);
}

export {
  checkActivation,
  validateCode,
  activateCode,
  getUsageThisMonth,
  incrementUsage,
  isFeatureAllowed,
  canGenerateReport,
  clearUsage,
  deactivate,
  FREE_MONTHLY_LIMIT,
};
