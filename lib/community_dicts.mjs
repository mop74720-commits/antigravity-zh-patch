import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_REGEX_RULES } from './base_regex_rules.mjs';
import { resolveDataDir } from './safety.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..');

const CJK_RE = /[\u4e00-\u9fff]/;
const LATIN_RE = /[A-Za-z]/;
const CHINESE_TRAILING_ASCII_DOT_RE = /([\u4e00-\u9fff])\.$/u;

function normalizeZhValue(val) {
  return val.replace(CHINESE_TRAILING_ASCII_DOT_RE, '$1。');
}

// 严禁把短英文关键词或常见程序/扩展名误当成翻译词条
const BLOCKED_LOWER_TOKENS = new Set([
  'id',
  'in',
  'on',
  'to',
  'of',
  'or',
  'as',
  'at',
  'by',
  'is',
  'it',
  'up',
  'no',
  'go',
  'do',
  'be',
  'if',
  'for',
  'var',
  'let',
  'get',
  'set',
  'map',
  'key',
  'url',
  'api',
  'cli',
  'mcp',
  'ssh',
  'wsl',
  'git',
  'src',
  'lib',
  'dist',
  'json',
  'html',
  'css',
  'js',
  'ts',
  'md',
]);

// 系统目录或常见个人文件夹名称，易与侧边栏项目名冲突，禁止作为独立词条自动翻译
const BLOCKED_EXACT_KEYS = new Set([
  'Downloads',
  'Desktop',
  'Documents',
  'Pictures',
  'Videos',
  'Music',
]);

export const MIT_COMMUNITY_SOURCES = [
  'https://raw.githubusercontent.com/yiheng8023/antigravity-chinese/main/dict/zh-CN.json',
];

export const EXTRA_UNLICENSED_SOURCES = [
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/common.json',
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/menu_nav.json',
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/page_agents.json',
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/page_mcp_knowledge.json',
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/page_settings.json',
  'https://raw.githubusercontent.com/qqxpee/antigravity2-cn/main/dicts/page_main.json',
  'https://raw.githubusercontent.com/Silas-02/antigravity-desktop-cn/main/dicts/marketplace_plugins.json',
  'https://raw.githubusercontent.com/Silas-02/antigravity-desktop-cn/main/dicts/page_settings.json',
];

// 默认社区词库仅包含明确 MIT 授权来源，确保仓库与分发包许可证纯净
export const COMMUNITY_SOURCES = MIT_COMMUNITY_SOURCES;

/**
 * 对远程社区 JSON 字典做严格结构与安全清洗（兼容扁平映射与 { exact } 包装格式）。
 * @param {unknown} rawObj
 */
export function sanitizeCommunityEntries(rawObj) {
  const entries = {};
  let kept = 0;
  let skipped = 0;

  const sourceObj =
    rawObj &&
    typeof rawObj === 'object' &&
    !Array.isArray(rawObj) &&
    rawObj.exact &&
    typeof rawObj.exact === 'object' &&
    !Array.isArray(rawObj.exact)
      ? rawObj.exact
      : rawObj;

  if (!sourceObj || typeof sourceObj !== 'object' || Array.isArray(sourceObj)) {
    return { entries, kept, skipped: 1 };
  }

  for (const [rawKey, rawVal] of Object.entries(sourceObj)) {
    if (typeof rawKey !== 'string' || typeof rawVal !== 'string') {
      skipped++;
      continue;
    }
    const key = rawKey.trim();
    const val = normalizeZhValue(rawVal.trim());
    if (!key || !val || key === val) {
      skipped++;
      continue;
    }
    if (val.includes('反重力')) {
      skipped++;
      continue;
    }
    if (key.startsWith('_') || key.startsWith('//')) {
      skipped++;
      continue;
    }
    if (key.length < 2 || !LATIN_RE.test(key) || CJK_RE.test(key)) {
      skipped++;
      continue;
    }
    if (BLOCKED_LOWER_TOKENS.has(key.toLowerCase()) || BLOCKED_EXACT_KEYS.has(key)) {
      skipped++;
      continue;
    }
    entries[key] = val;
    kept++;
  }

  return { entries, kept, skipped };
}

/**
 * 对社区动态正则规则做安全清洗，仅保留严格首尾锚定（^...$）且语法合法的规则。
 * @param {unknown} rawPatterns
 */
export function sanitizeRegexPatterns(rawPatterns) {
  const list = Array.isArray(rawPatterns)
    ? rawPatterns
    : rawPatterns && typeof rawPatterns === 'object' && Array.isArray(rawPatterns.patterns)
      ? rawPatterns.patterns
      : null;
  const rules = [];
  let kept = 0;
  let skipped = 0;

  if (!list) {
    return { rules, kept, skipped: rawPatterns == null ? 0 : 1 };
  }

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const rawPattern = typeof item.pattern === 'string' ? item.pattern : item.regex;
    const rawReplace = typeof item.replace === 'string' ? item.replace : item.replacement;
    if (typeof rawPattern !== 'string' || typeof rawReplace !== 'string') {
      skipped++;
      continue;
    }
    const pattern = rawPattern.trim();
    const replace = normalizeZhValue(rawReplace.trim());
    if (!pattern || !replace || !pattern.startsWith('^') || !pattern.endsWith('$')) {
      skipped++;
      continue;
    }
    if (replace.includes('反重力')) {
      skipped++;
      continue;
    }
    const flags = typeof item.flags === 'string' ? item.flags.trim() : '';
    try {
      new RegExp(pattern, flags);
    } catch {
      skipped++;
      continue;
    }
    const rule = { pattern, replace };
    if (flags) {
      rule.flags = flags;
    }
    rules.push(rule);
    kept++;
  }

  return { rules, kept, skipped };
}

function computeDictDelta(prevObj, nextObj) {
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const [k, v] of Object.entries(nextObj)) {
    if (!Object.prototype.hasOwnProperty.call(prevObj, k)) {
      added++;
    } else if (prevObj[k] !== v) {
      updated++;
    }
  }
  for (const k of Object.keys(prevObj)) {
    if (!Object.prototype.hasOwnProperty.call(nextObj, k)) {
      removed++;
    }
  }
  return { added, updated, removed };
}

/**
 * 仅下载纯 JSON 社区词库并清洗写入 00_community_zh.json 与 regex_rules.json。
 * 默认仅拉取 MIT 词库；启用 includeAllSources 时强制 localOnly 仅写入本机 dataDir。
 * @param {{ projectDir?: string, dataDir?: string, includeAllSources?: boolean, localOnly?: boolean, sources?: string[] }} [opts]
 */
export async function updateCommunityDicts(opts = {}) {
  const projectDir = opts.projectDir ? path.resolve(opts.projectDir) : DEFAULT_PROJECT_DIR;
  const includeAllSources = Boolean(opts.includeAllSources);
  const localOnly = opts.localOnly !== undefined ? Boolean(opts.localOnly) : includeAllSources;
  const resolvedDataDir = opts.dataDir ? resolveDataDir(opts.dataDir) : localOnly ? resolveDataDir() : null;

  const defaultSources = includeAllSources
    ? [...EXTRA_UNLICENSED_SOURCES, ...MIT_COMMUNITY_SOURCES]
    : MIT_COMMUNITY_SOURCES;
  const sources = Array.isArray(opts.sources) && opts.sources.length > 0 ? opts.sources : defaultSources;

  const merged = {};
  const communityRegexMap = new Map();
  const sourcesSucceeded = [];
  const sourcesFailed = [];

  for (const url of sources) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'antigravity-zh-patch' },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const text = await resp.text();
      const parsed = JSON.parse(text);
      const { entries, kept, skipped } = sanitizeCommunityEntries(parsed);
      Object.assign(merged, entries);

      let regexKept = 0;
      let regexSkipped = 0;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.patterns)) {
        const rx = sanitizeRegexPatterns(parsed.patterns);
        regexKept = rx.kept;
        regexSkipped = rx.skipped;
        for (const rule of rx.rules) {
          communityRegexMap.set(rule.pattern, rule);
        }
      }

      sourcesSucceeded.push({ url, kept, skipped, regexKept, regexSkipped });
    } catch (err) {
      sourcesFailed.push({
        url,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  if (sourcesSucceeded.length === 0) {
    throw new Error(
      `所有社区词库来源均拉取失败：${sourcesFailed.map((f) => `${f.url} (${f.error})`).join('; ')}`
    );
  }

  // 先写入内置 37 条基础锚定规则，再按 pattern 去重追加社区锚定规则（不覆盖内置规则）
  const finalRegexMap = new Map();
  for (const rule of BASE_REGEX_RULES) {
    finalRegexMap.set(rule.pattern, { ...rule });
  }
  for (const rule of communityRegexMap.values()) {
    if (!finalRegexMap.has(rule.pattern)) {
      finalRegexMap.set(rule.pattern, rule);
    }
  }
  const mergedRegexRules = Array.from(finalRegexMap.values());

  const targetDictsDir = localOnly ? path.join(resolvedDataDir, 'dicts') : path.join(projectDir, 'dicts');
  const exactOutPath = path.join(targetDictsDir, '00_community_zh.json');
  const regexOutPath = path.join(targetDictsDir, 'regex_rules.json');

  let prevExactObj = {};
  let backupPath = null;
  if (fs.existsSync(exactOutPath)) {
    try {
      const parsedPrev = JSON.parse(fs.readFileSync(exactOutPath, 'utf8'));
      if (parsedPrev && typeof parsedPrev === 'object' && !Array.isArray(parsedPrev)) {
        prevExactObj = parsedPrev;
      }
    } catch {
      prevExactObj = {};
    }
    if (resolvedDataDir) {
      backupPath = path.join(resolvedDataDir, 'backups', '00_community_zh.prev.json');
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(exactOutPath, backupPath);
    }
  }

  const delta = computeDictDelta(prevExactObj, merged);

  fs.mkdirSync(targetDictsDir, { recursive: true });
  fs.writeFileSync(exactOutPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.writeFileSync(regexOutPath, JSON.stringify(mergedRegexRules, null, 2) + '\n', 'utf8');

  return {
    mode: includeAllSources ? 'all-sources' : 'mit',
    localOnly,
    totalEntries: Object.keys(merged).length,
    totalRegexRules: mergedRegexRules.length,
    delta,
    backupPath,
    sourcesSucceeded,
    sourcesFailed,
    exactOutPath,
    regexOutPath,
    projectOutPath: exactOutPath,
  };
}
