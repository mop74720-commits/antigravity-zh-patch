import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

process.noAsar = true;

import {
  computeAsarIntegrity,
  encodeAsarHeader,
  readAsarFile,
  readAsarHeader,
  rebuildAsarWithOverrides,
  verifyAsarArchive,
} from '../lib/asar.mjs';
import { sanitizeCommunityEntries, sanitizeRegexPatterns } from '../lib/community_dicts.mjs';
import { getStatus, PATCH_MARKER, patchAntigravity, restoreAntigravity } from '../lib/patcher.mjs';
import { checkElectronFuses, classifyAntigravityProcesses, sha256File } from '../lib/safety.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '..');
const REAL_INSTALL_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'antigravity'
);
const REAL_ASAR = path.join(REAL_INSTALL_DIR, 'resources', 'app.asar');
const REAL_VERSION_FILE = path.join(REAL_INSTALL_DIR, 'version');

function createSyntheticAsar(destPath) {
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'synthetic-app', version: '2.33.0', main: 'dist/main.js' }, null, 2), 'utf8');
  const mainBuf = Buffer.from("'use strict';\nconsole.log('boot');\n", 'utf8');
  const constBuf = Buffer.from("'use strict';\nexports.FLAG = 42;\n", 'utf8');

  const headerObj = {
    files: {
      'package.json': {
        size: pkgBuf.length,
        offset: '0',
        integrity: computeAsarIntegrity(pkgBuf),
      },
      dist: {
        files: {
          'main.js': {
            size: mainBuf.length,
            offset: String(pkgBuf.length),
            integrity: computeAsarIntegrity(mainBuf),
          },
          'constants.js': {
            size: constBuf.length,
            offset: String(pkgBuf.length + mainBuf.length),
            integrity: computeAsarIntegrity(constBuf),
          },
          'unpacked-bin.node': {
            size: 16,
            unpacked: true,
          },
          'linked.js': {
            link: 'dist/constants.js',
          },
        },
      },
    },
  };
  const headerBuf = encodeAsarHeader(headerObj);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.concat([headerBuf, pkgBuf, mainBuf, constBuf]));
}

function runTest(name, fn) {
  fn();
  console.log(`[PASS] ${name}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-zh-test-'));

try {
  // 1. 校验所有 JSON 词典文件与正则表达式
  runTest('词典 JSON 解析与正则表达式合法性检查', () => {
    const dictsDir = path.join(PROJECT_DIR, 'dicts');
    const files = fs.readdirSync(dictsDir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 5, '词典文件数量应不少于 5 个');
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(dictsDir, f), 'utf8'));
      if (f === 'regex_rules.json') {
        assert.ok(Array.isArray(data));
        for (const r of data) {
          assert.equal(typeof r.pattern, 'string');
          assert.equal(typeof r.replace, 'string');
          new RegExp(r.pattern);
        }
      } else if (f === 'menus_tray.json') {
        assert.equal(typeof data.exact, 'object');
        assert.ok(Array.isArray(data.regexRules));
        for (const r of data.regexRules) {
          new RegExp(r.pattern);
        }
      } else {
        assert.equal(typeof data, 'object');
      }
    }
  });

  // 2. 校验所有 JS / CJS / MJS 文件语法
  runTest('所有源码文件 node --check 语法检查', () => {
    const targets = [
      path.join(PROJECT_DIR, 'cli.mjs'),
      path.join(PROJECT_DIR, 'lib', 'asar.mjs'),
      path.join(PROJECT_DIR, 'lib', 'base_regex_rules.mjs'),
      path.join(PROJECT_DIR, 'lib', 'community_dicts.mjs'),
      path.join(PROJECT_DIR, 'lib', 'safety.mjs'),
      path.join(PROJECT_DIR, 'lib', 'patcher.mjs'),
      path.join(PROJECT_DIR, 'lib', 'zh_loader.cjs'),
      path.join(PROJECT_DIR, 'runtime', 'dom_translator.js'),
    ];
    for (const file of targets) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    }
  });

  // 3. 单元测试 DOM 翻译引擎核心逻辑
  runTest('dom_translator 核心词典与正则翻译逻辑验证', () => {
    const code = fs.readFileSync(path.join(PROJECT_DIR, 'runtime', 'dom_translator.js'), 'utf8');
    const cjsSandbox = { module: { exports: {} }, exports: {}, Set, Map, WeakMap, RegExp };
    cjsSandbox.exports = cjsSandbox.module.exports;
    vm.runInNewContext(code, cjsSandbox);
    const translator = cjsSandbox.module.exports;

    const common = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dicts', 'common.json'), 'utf8'));
    const sidebar = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dicts', 'sidebar_chat.json'), 'utf8'));
    const settings = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dicts', 'settings.json'), 'utf8'));
    const titlebar = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dicts', 'titlebar_menus.json'), 'utf8'));
    const regexRaw = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'dicts', 'regex_rules.json'), 'utf8'));

    const built = translator.buildExactMaps({ ...common, ...sidebar, ...settings, ...titlebar });
    const regexRules = translator.compileRegexRules(regexRaw);

    assert.equal(translator.translateText('View', built.exactMap, regexRules, built.lowerExactMap), '视图');
    assert.equal(translator.translateText('Window', built.exactMap, regexRules, built.lowerExactMap), '窗口');
    assert.equal(translator.translateText('Zoom In', built.exactMap, regexRules, built.lowerExactMap), '放大');
    assert.equal(translator.translateText('Zoom Out', built.exactMap, regexRules, built.lowerExactMap), '缩小');
    assert.equal(translator.translateText('Reset Zoom', built.exactMap, regexRules, built.lowerExactMap), '重置缩放');
    assert.equal(translator.translateText('Checking for updates\u2026', built.exactMap, regexRules, built.lowerExactMap), '正在检查更新...');
    assert.equal(translator.translateText('New Conversation (Ctrl+N)', built.exactMap, regexRules, built.lowerExactMap), '新建对话 (Ctrl+N)');
    assert.equal(translator.translateText('Zoom In (Ctrl+=)', built.exactMap, regexRules, built.lowerExactMap), '放大 (Ctrl+=)');
    assert.equal(translator.translateText('Send (Enter)', built.exactMap, regexRules, built.lowerExactMap), '发送 (Enter)');
    assert.equal(translator.translateText('UnmappedAction (Ctrl+K)', built.exactMap, regexRules, built.lowerExactMap), null);
    assert.equal(translator.translateText('Interface Layout', built.exactMap, regexRules, built.lowerExactMap), '界面布局');
    assert.equal(translator.translateText('Knowledge Work', built.exactMap, regexRules, built.lowerExactMap), '知识工作模式');
    assert.equal(translator.translateText('Software Engineering', built.exactMap, regexRules, built.lowerExactMap), '软件工程模式');
    assert.equal(translator.translateText('Queued Messages', built.exactMap, regexRules, built.lowerExactMap), '排队消息');
    assert.equal(translator.translateText('Send Immediately', built.exactMap, regexRules, built.lowerExactMap), '立即发送');
    assert.equal(translator.translateText('Give Feedback', built.exactMap, regexRules, built.lowerExactMap), '反馈建议');
    assert.equal(translator.translateText('Application', built.exactMap, regexRules, built.lowerExactMap), '应用程序');
    assert.equal(translator.translateText('Advanced', built.exactMap, regexRules, built.lowerExactMap), '高级');
    assert.equal(translator.translateText('Turbo', built.exactMap, regexRules, built.lowerExactMap), '极速模式 (Turbo)');
    assert.equal(
      translator.translateText("Default and Auto need the\n  terminal sandbox, which isn't available on this host.", built.exactMap, regexRules, built.lowerExactMap),
      '“默认”和“自动”模式需要终端沙箱，当前主机不可用。'
    );
    assert.equal(
      translator.translateText('The voice used in Voice mode. Powered by Gemini Live.', built.exactMap, regexRules, built.lowerExactMap),
      '语音模式使用的声音，由 Gemini Live 提供支持。'
    );
    assert.equal(
      translator.translateText("How loud Antigravity\u2019s voice is.", built.exactMap, regexRules, built.lowerExactMap),
      '调整 Antigravity 语音播报的音量。'
    );
    assert.equal(translator.translateText('  Tool Execution Policy  ', built.exactMap, regexRules, built.lowerExactMap), '  工具执行策略 (Tool Execution Policy)  ');
    assert.equal(translator.translateText('Thought for 12s', built.exactMap, regexRules, built.lowerExactMap), '已思考 12 秒');
    assert.equal(translator.translateText('5 minutes ago', built.exactMap, regexRules, built.lowerExactMap), '5 分钟前');
    assert.equal(translator.translateText('3 files changed', built.exactMap, regexRules, built.lowerExactMap), '3 个文件已变更');
    assert.equal(translator.translateText('已有中文文本', built.exactMap, regexRules, built.lowerExactMap), null);
    assert.equal(translator.translateText('12345', built.exactMap, regexRules, built.lowerExactMap), null);
    assert.equal(translator.translateText('An unrelated English sentence in AI response.', built.exactMap, regexRules, built.lowerExactMap), null);

    // 验证短词（≤4 字符）UI 控件守卫：非控件正文跳过，UI 控件或属性放行，长词组正常放行
    assert.equal(translator.translateText('Run', built.exactMap, regexRules, built.lowerExactMap, { allowShortWord: false }), null);
    assert.equal(translator.translateText('Run', built.exactMap, regexRules, built.lowerExactMap, { allowShortWord: true }), '运行');
    assert.equal(translator.translateText('Plan', built.exactMap, regexRules, built.lowerExactMap, { allowShortWord: false }), null);
    assert.equal(translator.translateText('Plan', built.exactMap, regexRules, built.lowerExactMap, { allowShortWord: true }), '计划');
    assert.equal(
      translator.translateText('Interface Layout', built.exactMap, regexRules, built.lowerExactMap, { allowShortWord: false }),
      '界面布局'
    );

    // 验证社区词库安全清洗逻辑（含 { exact } 解包、反重力剔除、同形词过滤、中文句末英文句号修正、系统目录名剔除）
    const cleaned = sanitizeCommunityEntries({
      _comment: 'ignored',
      id: '编号',
      json: 'JSON',
      Downloads: '下载',
      Desktop: '桌面',
      '已有中文': '忽略',
      badObj: { nested: 'x' },
      Antigravity: '反重力',
      SameWord: 'SameWord',
      'Interface Layout': '界面布局',
      '  Give Feedback  ': '  反馈建议.  ',
    });
    assert.deepEqual(cleaned.entries, {
      'Interface Layout': '界面布局',
      'Give Feedback': '反馈建议。',
    });

    const cleanedWrapped = sanitizeCommunityEntries({
      exact: {
        'Save File': '保存文件.',
        'Ignore Meme': '请勿使用反重力',
        Gemini: 'Gemini',
      },
      patterns: [],
    });
    assert.deepEqual(cleanedWrapped.entries, {
      'Save File': '保存文件。',
    });

    // 验证社区动态正则清洗（{ regex, replacement } 转换、严格 ^...$ 锚定过滤、反重力剔除与中文句号规范化）
    const cleanedRegex = sanitizeRegexPatterns([
      { regex: '^(\\d+) tasks?$', replacement: '共 $1 项任务.' },
      { regex: '\\bJan\\b(?=\\s+\\d+日)', replacement: '1月' },
      { regex: '^Antigravity (\\d+)$', replacement: '反重力 $1' },
      { regex: '^[invalid(', replacement: '非法正则' },
      { pattern: '^Step (\\d+)$', replace: '第 $1 步', flags: 'i' },
    ]);
    assert.deepEqual(cleanedRegex.rules, [
      { pattern: '^(\\d+) tasks?$', replace: '共 $1 项任务。' },
      { pattern: '^Step (\\d+)$', replace: '第 $1 步', flags: 'i' },
    ]);
    assert.equal(cleanedRegex.skipped, 3);

    const communityFile = path.join(PROJECT_DIR, 'dicts', '00_community_zh.json');
    if (fs.existsSync(communityFile)) {
      const commObj = JSON.parse(fs.readFileSync(communityFile, 'utf8'));
      assert.equal(Object.prototype.hasOwnProperty.call(commObj, 'Downloads'), false);
      for (const [k, v] of Object.entries(commObj)) {
        assert.equal(v.includes('反重力'), false, `00_community_zh.json 不应包含「反重力」: ${k}`);
        assert.equal(/[\u4e00-\u9fff]\.$/.test(v), false, `00_community_zh.json 不应以中文后接英文句号结尾: ${k} -> ${v}`);
      }
    }

    const regexFile = path.join(PROJECT_DIR, 'dicts', 'regex_rules.json');
    if (fs.existsSync(regexFile)) {
      const regexArr = JSON.parse(fs.readFileSync(regexFile, 'utf8'));
      for (const r of regexArr) {
        assert.equal(r.pattern.startsWith('^') && r.pattern.endsWith('$'), true, `regex_rules.json 必须严格 ^...$ 锚定: ${r.pattern}`);
        assert.equal(r.replace.includes('反重力'), false, `regex_rules.json 不应包含「反重力」: ${r.pattern}`);
        assert.equal(/[\u4e00-\u9fff]\.$/.test(r.replace), false, `regex_rules.json 不应以中文后接英文句号结尾: ${r.pattern}`);
      }
    }

    // 验证 DOM 安全隔离规则（放行输入框 placeholder、保护无 value 的 option 与 AI 正文/Lexical 编辑器）
    const mockInput = { nodeType: 1, tagName: 'INPUT', isContentEditable: false, closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockInput, true), false);
    assert.equal(translator.isSkippedElement(mockInput, false), true);

    const mockOptionNoVal = { nodeType: 1, tagName: 'OPTION', hasAttribute: () => false, closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockOptionNoVal, false), true);

    const mockOptionWithVal = { nodeType: 1, tagName: 'OPTION', hasAttribute: (a) => a === 'value', closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockOptionWithVal, false), false);

    const mockPlannerNode = {
      nodeType: 1,
      tagName: 'DIV',
      closest: (sel) => (sel.includes('planner-response-text') ? {} : null),
      getRootNode: () => null,
    };
    assert.equal(translator.isSkippedElement(mockPlannerNode, false), true);
    assert.equal(translator.isSkippedElement(mockPlannerNode, true), true);

    const mockLexicalNode = {
      nodeType: 1,
      tagName: 'SPAN',
      closest: (sel) => (sel.includes('data-lexical-editor') ? {} : null),
      getRootNode: () => null,
    };
    assert.equal(translator.isSkippedElement(mockLexicalNode, false), true);
    assert.equal(translator.isSkippedElement(mockLexicalNode, true), true);

    // 验证图标字体、文件树、路径面包屑与显式跳过属性隔离
    const mockGoogleIcon = { nodeType: 1, tagName: 'SPAN', className: 'google-symbols', closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockGoogleIcon, false), true);
    const mockCodicon = { nodeType: 1, tagName: 'I', className: 'codicon codicon-gear', closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockCodicon, false), true);
    const mockMaterialIcon = { nodeType: 1, tagName: 'SPAN', className: 'material-symbols-outlined', closest: () => null, getRootNode: () => null };
    assert.equal(translator.isSkippedElement(mockMaterialIcon, false), true);

    for (const selectorNeedle of ['role="treeitem"', 'File path breadcrumbs', 'data-ag-localization-skip']) {
      const mockSpecial = {
        nodeType: 1,
        tagName: 'DIV',
        closest: (sel) => (sel.includes(selectorNeedle) ? {} : null),
        getRootNode: () => null,
      };
      assert.equal(translator.isSkippedElement(mockSpecial, false), true);
    }

    // 验证左侧 Projects 列表里的用户文件夹名称不被翻译，但 Projects 标题与 Show All 控件正常翻译
    const projectHeading = { nodeType: 1, tagName: 'DIV', textContent: 'Projects', closest: (sel) => (sel.includes('aside') ? {} : null), getRootNode: () => null };
    projectHeading.contains = (t) => t === projectHeading;
    const projectFolder = { nodeType: 1, tagName: 'DIV', textContent: 'Downloads', closest: (sel) => (sel.includes('aside') ? {} : null), getRootNode: () => null };
    const projectShowAll = { nodeType: 1, tagName: 'BUTTON', textContent: 'Show All', closest: (sel) => (sel.includes('aside') ? {} : null), getRootNode: () => null };
    const projectSection = { nodeType: 1, tagName: 'SECTION', children: [projectHeading, projectFolder, projectShowAll], parentElement: null };
    projectHeading.parentElement = projectSection;
    projectFolder.parentElement = projectSection;
    projectShowAll.parentElement = projectSection;

    assert.equal(translator.isSkippedElement(projectFolder, false), true);
    assert.equal(translator.isSkippedElement(projectHeading, false), false);
    assert.equal(translator.isSkippedElement(projectShowAll, false), false);
  });

  // 4. 自包含合成 ASAR（含 unpacked + link 符号链接）往返与兼容性测试
  const synthAsar = path.join(tmpRoot, 'synthetic.asar');
  runTest('合成 ASAR（含 link 符号链接与 unpacked 条目）重写与完整性校验', () => {
    createSyntheticAsar(synthAsar);
    const v0 = verifyAsarArchive(synthAsar, { strictHashes: true });
    assert.equal(v0.ok, true);
    assert.equal(v0.unpackedFiles, 1);
    assert.equal(v0.symlinkFiles, 1);

    const stagedSynth = path.join(tmpRoot, 'synthetic.staged.asar');
    rebuildAsarWithOverrides(synthAsar, stagedSynth, {
      'dist/main.js': Buffer.from("'use strict';\nconsole.log('patched');\n", 'utf8'),
      'dist/extra.cjs': Buffer.from('module.exports = 1;\n', 'utf8'),
    });
    const v1 = verifyAsarArchive(stagedSynth, { strictHashes: true });
    assert.equal(v1.ok, true);
    assert.equal(v1.unpackedFiles, 1);
    assert.equal(v1.symlinkFiles, 1);
    assert.equal(
      readAsarFile(stagedSynth, 'dist/constants.js').toString('utf8'),
      "'use strict';\nexports.FLAG = 42;\n"
    );
  });

  // 5. 在隔离临时沙盒中选用官方原版 app.asar（若无本地安装则自动使用合成 ASAR，绝不改动真实安装目录！）
  const sandboxInstall = path.join(tmpRoot, 'install');
  const sandboxResources = path.join(sandboxInstall, 'resources');
  const sandboxData = path.join(tmpRoot, 'data');
  const sandboxAsar = path.join(sandboxResources, 'app.asar');
  fs.mkdirSync(sandboxResources, { recursive: true });

  let sourceOriginalAsar = null;
  let sourceVersion = '2.33.0';
  const realManifestPath = path.join(os.homedir(), '.antigravity-zh', 'manifest.json');
  if (fs.existsSync(realManifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(realManifestPath, 'utf8'));
      const bak = Array.isArray(m.backups) ? m.backups.find((b) => b && b.backupPath && fs.existsSync(b.backupPath)) : null;
      if (bak) {
        sourceOriginalAsar = bak.backupPath;
      }
    } catch {}
  }
  if (!sourceOriginalAsar && fs.existsSync(REAL_ASAR)) {
    const tmpHdr = readAsarHeader(REAL_ASAR);
    const mainRel = JSON.parse(readAsarFile(REAL_ASAR, 'package.json').toString('utf8')).main || 'dist/main.js';
    if (!readAsarFile(REAL_ASAR, mainRel).toString('utf8').includes(PATCH_MARKER)) {
      sourceOriginalAsar = REAL_ASAR;
    }
    void tmpHdr;
  }
  if (!sourceOriginalAsar) {
    sourceOriginalAsar = synthAsar;
  } else if (fs.existsSync(REAL_VERSION_FILE)) {
    sourceVersion = fs.readFileSync(REAL_VERSION_FILE, 'utf8').trim() || sourceVersion;
  }

  fs.copyFileSync(sourceOriginalAsar, sandboxAsar);
  fs.writeFileSync(path.join(sandboxInstall, 'version'), sourceVersion, 'utf8');
  // 创建一个不含开启态 Fuse 的占位 exe（模拟当前官方桌面端）
  fs.writeFileSync(path.join(sandboxInstall, 'Antigravity.exe'), Buffer.from('MZ-dummy-exe'));

  const originalSha = sha256File(sandboxAsar);

  runTest('沙盒 ASAR 副本状态检查与完整性基线校验', () => {
    const hdr = readAsarHeader(sandboxAsar);
    assert.ok(hdr.header.files.dist, '应包含 dist 目录');
    const ver = verifyAsarArchive(sandboxAsar, { strictHashes: true });
    assert.equal(ver.ok, true);
    assert.ok(ver.verifiedHashes >= 3);
    const st0 = getStatus({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(st0.state, 'unpatched');
    assert.equal(st0.asarExists, true);
  });

  // 记录一个未修改参考文件的 SHA-256，确保重建后未改动文件字节完全一致
  const untouchedBefore = readAsarFile(sandboxAsar, 'dist/constants.js');

  runTest('沙盒中应用汉化补丁并验证先校验后替换、--data-dir 贯通与代码语法', () => {
    const res = patchAntigravity({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(res.action, 'patched');
    assert.equal(res.verifyRes.ok, true);

    const verAfter = verifyAsarArchive(sandboxAsar, { strictHashes: true });
    assert.equal(verAfter.ok, true);

    // 验证未改动文件字节级一致
    const untouchedAfter = readAsarFile(sandboxAsar, 'dist/constants.js');
    assert.equal(Buffer.compare(untouchedBefore, untouchedAfter), 0);

    // 验证自定义 --data-dir 已写进注入的 zh_loader.cjs 且语法正确
    const patchedMain = readAsarFile(sandboxAsar, 'dist/main.js').toString('utf8');
    assert.ok(patchedMain.includes(PATCH_MARKER), '主入口应包含补丁标记');
    const patchedLoaderBuf = readAsarFile(sandboxAsar, 'dist/zh_loader.cjs');
    const patchedLoaderStr = patchedLoaderBuf.toString('utf8');
    assert.ok(patchedLoaderStr.includes(JSON.stringify(sandboxData)), 'zh_loader.cjs 应嵌入传入的 --data-dir 路径');
    assert.equal(patchedLoaderStr.includes("'__AGY_ZH_EMBEDDED_DATA_DIR__'"), false);

    const tmpMain = path.join(tmpRoot, 'main_check.js');
    const tmpLoader = path.join(tmpRoot, 'zh_loader_check.cjs');
    fs.writeFileSync(tmpMain, patchedMain, 'utf8');
    fs.writeFileSync(tmpLoader, patchedLoaderBuf);
    execFileSync(process.execPath, ['--check', tmpMain], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--check', tmpLoader], { stdio: 'pipe' });

    // 检查 custom.json 与 config.json 已被创建
    assert.ok(fs.existsSync(path.join(sandboxData, 'dicts', 'custom.json')));
    assert.ok(fs.existsSync(path.join(sandboxData, 'config.json')));
  });

  runTest('幂等性检查与用户自定义 custom.json 保留验证', () => {
    const customPath = path.join(sandboxData, 'dicts', 'custom.json');
    fs.writeFileSync(customPath, JSON.stringify({ 'Custom Key': '自定义译名' }), 'utf8');

    const res2 = patchAntigravity({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(res2.action, 'already-patched');
    const customAfter = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    assert.equal(customAfter['Custom Key'], '自定义译名');
  });

  runTest('模拟官方自动更新覆盖 app.asar 后自动检测与重新适配', () => {
    fs.copyFileSync(sourceOriginalAsar, sandboxAsar);
    fs.writeFileSync(path.join(sandboxInstall, 'version'), '2.99.0', 'utf8');

    const st = getStatus({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(st.state, 'needs-repatch');
    assert.equal(st.version, '2.99.0');

    const repatch = patchAntigravity({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(repatch.action, 'patched');
    assert.equal(repatch.version, '2.99.0');
  });

  runTest('Electron ASAR Fuse 安全闭环测试（启用/缺失/截断/未知位全部中止，禁用/无Fuse放行）', () => {
    const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNnH4m43547281', 'ascii');
    const lockedExe = path.join(sandboxInstall, 'Antigravity.exe');

    // 1) EXE 不存在 -> safe: false
    fs.rmSync(lockedExe, { force: true });
    const missingRes = checkElectronFuses(lockedExe);
    assert.equal(missingRes.safe, false);
    assert.equal(missingRes.reason, 'exe-not-found');

    // 2) Fuse 头部截断 -> safe: false
    fs.writeFileSync(lockedExe, Buffer.concat([Buffer.from('MZ'), sentinel, Buffer.from([1, 8, 0x30])]));
    const invalidRes = checkElectronFuses(lockedExe);
    assert.equal(invalidRes.safe, false);
    assert.equal(invalidRes.reason, 'fuse-header-invalid');

    // 3) Fuse 状态未知字符 'X' -> safe: false
    fs.writeFileSync(lockedExe, Buffer.concat([Buffer.from('MZ'), sentinel, Buffer.from([1, 8, 0x30, 0x30, 0x30, 0x30, 0x58, 0x30, 0x30, 0x30])]));
    const unknownRes = checkElectronFuses(lockedExe);
    assert.equal(unknownRes.safe, false);
    assert.equal(unknownRes.reason, 'fuse-unknown-state');

    // 4) Fuse index 4 = '0' (禁用) -> safe: true
    fs.writeFileSync(lockedExe, Buffer.concat([Buffer.from('MZ'), sentinel, Buffer.from([1, 8, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30])]));
    const disabledRes = checkElectronFuses(lockedExe);
    assert.equal(disabledRes.safe, true);
    assert.equal(disabledRes.reason, 'fuse-disabled');

    // 5) Fuse index 4 = '1' (启用) -> safe: false 且 patchAntigravity 拒绝改写
    const fuseBytes = Buffer.from([1, 8, 0x30, 0x30, 0x30, 0x30, 0x31, 0x31, 0x30, 0x30]);
    fs.writeFileSync(lockedExe, Buffer.concat([Buffer.from('MZ'), sentinel, fuseBytes]));

    const fuseRes = checkElectronFuses(lockedExe);
    assert.equal(fuseRes.found, true);
    assert.equal(fuseRes.asarIntegrityEnabled, true);
    assert.equal(fuseRes.safe, false);
    assert.equal(fuseRes.reason, 'fuse-enabled');

    fs.copyFileSync(sourceOriginalAsar, sandboxAsar);
    assert.throws(
      () =>
        patchAntigravity({
          installDir: sandboxInstall,
          dataDir: sandboxData,
          projectDir: PROJECT_DIR,
          skipProcessCheck: true,
        }),
      (err) => err && err.code === 'FUSE_BLOCKED'
    );
    assert.equal(sha256File(sandboxAsar), originalSha);

    // 恢复无 Fuse 占位 exe 以继续还原测试
    fs.writeFileSync(lockedExe, Buffer.from('MZ-dummy-exe'));
  });

  runTest('无损还原为官方原版 app.asar（SHA-256 逐字节一致）', () => {
    // 先重新针对当前版本打回补丁，再还原
    fs.writeFileSync(path.join(sandboxInstall, 'version'), '2.99.0', 'utf8');
    patchAntigravity({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    const restoreRes = restoreAntigravity({
      installDir: sandboxInstall,
      dataDir: sandboxData,
      projectDir: PROJECT_DIR,
      skipProcessCheck: true,
    });
    assert.equal(restoreRes.action, 'restored');
    assert.equal(sha256File(sandboxAsar), originalSha);
  });

  runTest('进程识别可区分桌面主进程与独立 sidecar_sdk 工作进程（且排除自身 PID）', () => {
    const onlySidecars = classifyAntigravityProcesses(
      [
        {
          pid: 1001,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/Users/User/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
        },
        {
          pid: 1002,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/Users/User/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs',
        },
        {
          pid: 9999,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" "C:\\path\\to\\antigravity-zh-patch\\cli.mjs" patch',
        },
      ],
      9999
    );
    assert.equal(onlySidecars.running, false);
    assert.deepEqual(onlySidecars.pids, []);
    assert.deepEqual(onlySidecars.sidecarPids, [1001, 1002]);

    const mixed = classifyAntigravityProcesses(
      [
        {
          pid: 2001,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe"',
        },
        {
          pid: 2002,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=renderer --app-path="...\\app.asar"',
        },
        {
          pid: 2003,
          commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --import=file:///C:/.../sidecar_sdk/register_loader.js main.mjs',
        },
      ],
      8888
    );
    assert.equal(mixed.running, true);
    assert.deepEqual(mixed.pids, [2001, 2002]);
    assert.deepEqual(mixed.sidecarPids, [2003]);
  });

  console.log('\n全部自动化测试通过（沙盒内操作，未对真实安装目录做任何写入）。');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
