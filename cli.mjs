#!/usr/bin/env node
import process from 'node:process';
// 当通过 Antigravity.exe (ELECTRON_RUN_AS_NODE=1) 运行时，关闭 Electron 对 .asar 文件的虚拟文件系统拦截
process.noAsar = true;
import { updateCommunityDicts } from './lib/community_dicts.mjs';
import { getStatus, patchAntigravity, restoreAntigravity, syncRuntimeAndDicts } from './lib/patcher.mjs';
import { resolveDataDir } from './lib/safety.mjs';

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = 'status';
  let installDir;
  let dataDir;
  let allSources = false;
  let localOnly = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') {
      help = true;
    } else if (a === '--install-dir' && args[i + 1]) {
      installDir = args[++i];
    } else if (a === '--data-dir' && args[i + 1]) {
      dataDir = args[++i];
    } else if (a === '--all-sources') {
      allSources = true;
      localOnly = true;
    } else if (a === '--local-only') {
      localOnly = true;
    } else if (!a.startsWith('-')) {
      command = a;
    }
  }

  return { command, installDir, dataDir, allSources, localOnly, help };
}

function printHelp() {
  console.log(`
Antigravity 2.0 桌面端纯 DOM 汉化补丁工具

用法：
  node cli.mjs <command> [选项]

命令：
  status        查看安装版本、补丁状态、Fuse 校验与备份情况（默认，只读）
  patch         备份原版 app.asar 并应用纯渲染层 DOM 汉化补丁（支持更新后重打）
  restore       无损还原为官方原版 app.asar
  sync-dicts    仅同步外置词典与运行时脚本到用户目录（无需重打 app.asar）
  update-dicts  从 MIT 开源社区纯 JSON 词库同步翻译并同步到用户目录
  check-update  检查是否因官方自动更新导致补丁失效（返回码 2 表示需重新 patch）

选项：
  --install-dir <dir>   指定 Antigravity 安装目录
  --data-dir <dir>      指定词典与备份目录（默认 ~/.antigravity-zh）
  --all-sources         （仅 update-dicts）额外合并个人本地补充词库（仅写入用户目录）
  --local-only          （仅 update-dicts）仅写入用户目录，不修改仓库 dicts/
  -h, --help            显示帮助信息

界面快捷键（生效后）：
  Ctrl+Alt+L            实时切换「中文界面 / 原版英文界面」
`);
}

function formatStateLabel(state) {
  switch (state) {
    case 'patched':
      return '已汉化（生效中）';
    case 'unpatched':
      return '官方原版（未打补丁）';
    case 'needs-repatch':
      return '检测到官方已更新（原补丁被覆盖，需重新执行 patch）';
    case 'fuse-blocked':
      return '已启用 Electron ASAR 完整性校验（安全中止，禁止修改）';
    case 'not-found':
      return '未找到 Antigravity 2.0 安装目录';
    default:
      return state;
  }
}

function formatFuseLabel(fuse) {
  switch (fuse && fuse.reason) {
    case 'no-fuse-wire':
      return '当前构建未嵌入 Electron Fuse 表（可加载）';
    case 'fuse-disabled':
      return 'Electron Fuse 校验已关闭（可加载）';
    case 'fuse-enabled':
      return '已开启 ASAR 完整性校验（已拒绝修改）';
    case 'exe-not-found':
      return '未找到 Antigravity.exe（安全中止，禁止修改）';
    case 'fuse-header-invalid':
    case 'fuse-unknown-state':
      return 'Fuse 标志位结构异常或状态未知（安全中止，禁止修改）';
    default:
      return fuse && fuse.safe ? '可安全加载' : '校验未通过（已拒绝修改）';
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  const commonOpts = {
    installDir: opts.installDir,
    dataDir: opts.dataDir,
  };

  if (opts.command === 'status' || opts.command === 'check-update') {
    const st = getStatus(commonOpts);
    console.log('=== Antigravity 2.0 汉化补丁状态 ===');
    console.log(`状态       : ${formatStateLabel(st.state)}`);
    if (!st.asarExists) {
      console.log(`安装目录   : ${st.installDir}`);
      process.exitCode = 1;
      return;
    }
    console.log(`版本       : ${st.version}`);
    console.log(`安装目录   : ${st.installDir}`);
    console.log(`词典目录   : ${st.dataDir}`);
    console.log(`主入口     : ${st.mainEntry}`);
    console.log(`ASAR 校验  : ${formatFuseLabel(st.fuse)}`);
    console.log(`进程状态   : ${st.running.running ? `桌面端运行中 (PID: ${st.running.pids.join(', ')})` : '桌面端未运行'}`);
    if (st.running.sidecarPids && st.running.sidecarPids.length > 0) {
      console.log(`后台Sidecar: 运行中 (PID: ${st.running.sidecarPids.join(', ')}，不占用 app.asar，不影响打补丁)`);
    }
    console.log(`历史备份数 : ${st.backupsCount}`);
    console.log(`当前 SHA256: ${st.asarSha256}`);

    if (opts.command === 'check-update') {
      if (st.state === 'needs-repatch') {
        console.log('\n[提示] 检测到官方客户端已更新覆盖 app.asar，请退出 Antigravity 后运行 patch 重新适配。');
        process.exitCode = 2;
      } else if (st.state === 'fuse-blocked') {
        process.exitCode = 3;
      }
    } else if (st.state === 'fuse-blocked') {
      process.exitCode = 3;
    }
    return;
  }

  if (opts.command === 'sync-dicts') {
    const res = syncRuntimeAndDicts(commonOpts);
    console.log('[成功] 已同步外置词典与运行时翻译引擎（custom.json 与 config.json 已保留）。');
    console.log(`词典目录: ${res.dictsDir}`);
    console.log(`同步文件: ${res.copiedDicts.join(', ')}`);
    return;
  }

  if (opts.command === 'update-dicts') {
    const resolvedDataDir = resolveDataDir(commonOpts.dataDir);
    const effectiveLocalOnly = Boolean(opts.allSources || opts.localOnly);
    const modeLabel = opts.allSources
      ? '扩展模式（MIT 主词库 + 个人本地补充词库，仅写入本机目录）'
      : effectiveLocalOnly
        ? '纯净 MIT 模式（仅写入本机目录）'
        : '纯净 MIT 模式（更新仓库与本机目录）';

    console.log('正在从开源社区拉取纯 JSON 中文词典（只读 JSON 解析，不执行任何远程代码）...');
    console.log(`更新模式  : ${modeLabel}`);

    let syncRes;
    let comm;
    if (effectiveLocalOnly) {
      syncRes = syncRuntimeAndDicts(commonOpts);
      comm = await updateCommunityDicts({
        dataDir: resolvedDataDir,
        includeAllSources: opts.allSources,
        localOnly: true,
      });
    } else {
      comm = await updateCommunityDicts({
        dataDir: resolvedDataDir,
        includeAllSources: false,
        localOnly: false,
      });
      syncRes = syncRuntimeAndDicts(commonOpts);
    }

    console.log(`[成功] 社区词典已合并写入并同步到 ${syncRes.dictsDir}！`);
    console.log(`模式标签  : ${comm.mode}${comm.localOnly ? ' (local-only)' : ''}`);
    console.log(`合并词条  : ${comm.totalEntries} 条（已成功拉取 ${comm.sourcesSucceeded.length} 个词库文件）`);
    console.log(`动态正则  : ${comm.totalRegexRules} 条（含内置基础规则与社区严格锚定规则）`);
    console.log(`词条变化  : 新增 ${comm.delta.added} / 更新 ${comm.delta.updated} / 移除 ${comm.delta.removed}`);
    if (comm.backupPath) {
      console.log(`旧版备份  : ${comm.backupPath}`);
    }
    if (comm.sourcesFailed.length > 0) {
      console.log(`跳过失败源: ${comm.sourcesFailed.map((f) => `${f.url} (${f.error})`).join('; ')}`);
    }
    console.log('提示: 无需重打 app.asar，在 Antigravity 中按 Ctrl+R 刷新或重启窗口即可生效。');
    return;
  }

  if (opts.command === 'patch') {
    const res = patchAntigravity(commonOpts);
    if (res.action === 'already-patched') {
      console.log(`[完成] 当前版本 (${res.version}) 已包含汉化入口，已顺便刷新外置词典与运行时脚本。`);
      console.log(`词典目录: ${res.syncRes.dictsDir}`);
      console.log('提示: 若 Antigravity 正在运行，按 Ctrl+R / 重启窗口即可读取最新词典；Ctrl+Alt+L 可切换中英文。');
      return;
    }
    console.log(`[成功] Antigravity ${res.version} 纯渲染层汉化补丁已应用！`);
    console.log(`主入口文件: ${res.mainEntry}`);
    console.log(`注入加载器: ${res.loaderEntry}`);
    console.log(`原版备份  : ${res.backupPath}`);
    console.log(`词典目录  : ${res.syncRes.dictsDir}`);
    console.log(`完整性验证: ${res.verifyRes.verifiedHashes} 个文件 SHA-256 校验通过`);
    console.log('\n下一步：重新启动 Antigravity 2.0 即可生效（按 Ctrl+Alt+L 可随时切换中/英文）。');
    return;
  }

  if (opts.command === 'restore') {
    const res = restoreAntigravity(commonOpts);
    if (res.action === 'already-original') {
      console.log(`[完成] 当前版本 (${res.version}) 已是官方原版 app.asar，无需还原。`);
      return;
    }
    console.log(`[成功] 已无损还原为官方原版 app.asar（版本 ${res.version}）！`);
    console.log(`还原来源  : ${res.backupPath}`);
    console.log(`SHA-256   : ${res.restoredSha256}`);
    return;
  }

  console.error(`未知命令：${opts.command}`);
  printHelp();
  process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error(`[错误] ${err && err.message ? err.message : String(err)}`);
  if (err && err.code === 'FUSE_BLOCKED') {
    process.exitCode = 3;
  } else {
    process.exitCode = 1;
  }
}
