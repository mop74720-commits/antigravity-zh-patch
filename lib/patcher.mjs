import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAsarFile, readAsarHeader, rebuildAsarWithOverrides, verifyAsarArchive } from './asar.mjs';
import {
  checkElectronFuses,
  isAntigravityRunning,
  readInstalledVersion,
  resolveDataDir,
  resolveInstallDir,
  sanitizeVersionForFilename,
  sha256File,
} from './safety.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PATCH_MARKER = '/* __ANTIGRAVITY_ZH_PATCH_V1__ */';
export const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..');

function resolvePaths(opts = {}) {
  const projectDir = opts.projectDir ? path.resolve(opts.projectDir) : DEFAULT_PROJECT_DIR;
  const installDir = resolveInstallDir(opts.installDir);
  const dataDir = resolveDataDir(opts.dataDir);
  const resourcesDir = path.join(installDir, 'resources');
  return {
    projectDir,
    installDir,
    dataDir,
    exePath: path.join(installDir, 'Antigravity.exe'),
    asarPath: path.join(resourcesDir, 'app.asar'),
    backupsDir: path.join(dataDir, 'backups'),
    dictsDir: path.join(dataDir, 'dicts'),
    runtimeDir: path.join(dataDir, 'runtime'),
    configPath: path.join(dataDir, 'config.json'),
    manifestPath: path.join(dataDir, 'manifest.json'),
  };
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    return { backups: [], lastPatched: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      backups: Array.isArray(parsed.backups) ? parsed.backups : [],
      lastPatched: parsed.lastPatched || null,
    };
  } catch {
    return { backups: [], lastPatched: null };
  }
}

function writeManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function getMainEntryInfo(asarPath) {
  const pkgBuf = readAsarFile(asarPath, 'package.json');
  const pkg = JSON.parse(pkgBuf.toString('utf8'));
  const mainRel = String(pkg.main || 'dist/main.js').replace(/^\.\//, '').replace(/\\/g, '/');
  const mainDir = path.posix.dirname(mainRel);
  const loaderRel = mainDir === '.' ? 'zh_loader.cjs' : `${mainDir}/zh_loader.cjs`;
  const isEsm = !mainRel.endsWith('.cjs') && (pkg.type === 'module' || mainRel.endsWith('.mjs'));
  const mainCode = readAsarFile(asarPath, mainRel).toString('utf8');
  return { pkg, mainRel, loaderRel, isEsm, mainCode };
}

export function injectHookIntoMain(mainCode, isEsm) {
  if (mainCode.includes(PATCH_MARKER)) {
    return mainCode;
  }
  const hookLine = isEsm
    ? `${PATCH_MARKER} try { await import('./zh_loader.cjs'); } catch (_zhErr) {}`
    : `${PATCH_MARKER} try { require('./zh_loader.cjs'); } catch (_zhErr) {}`;

  let rest = mainCode;
  let prefix = '';

  if (rest.startsWith('\uFEFF')) {
    prefix += '\uFEFF';
    rest = rest.slice(1);
  }

  const shebangMatch = /^(#![^\r\n]*(?:\r?\n|$))/.exec(rest);
  if (shebangMatch) {
    prefix += shebangMatch[1];
    rest = rest.slice(shebangMatch[1].length);
  }

  const useStrictMatch = /^(\s*['"]use strict['"];?[ \t]*\r?\n?)/.exec(rest);
  if (useStrictMatch) {
    let directive = useStrictMatch[1];
    rest = rest.slice(directive.length);
    if (!directive.endsWith('\n') && !directive.endsWith('\r')) {
      directive += '\n';
    }
    return `${prefix}${directive}${hookLine}\n${rest}`;
  }

  return `${prefix}${hookLine}\n${rest}`;
}

/**
 * 同步运行时脚本与默认词典到用户目录，不覆盖用户自定义配置与 custom.json。
 */
export function syncRuntimeAndDicts(opts = {}) {
  const paths = resolvePaths(opts);
  fs.mkdirSync(paths.dictsDir, { recursive: true });
  fs.mkdirSync(paths.runtimeDir, { recursive: true });

  const srcRuntime = path.join(paths.projectDir, 'runtime', 'dom_translator.js');
  const dstRuntime = path.join(paths.runtimeDir, 'dom_translator.js');
  fs.copyFileSync(srcRuntime, dstRuntime);

  const srcDictsDir = path.join(paths.projectDir, 'dicts');
  const copiedDicts = [];
  for (const name of fs.readdirSync(srcDictsDir)) {
    if (!name.endsWith('.json')) continue;
    fs.copyFileSync(path.join(srcDictsDir, name), path.join(paths.dictsDir, name));
    copiedDicts.push(name);
  }

  const customDictPath = path.join(paths.dictsDir, 'custom.json');
  if (!fs.existsSync(customDictPath)) {
    fs.writeFileSync(
      customDictPath,
      JSON.stringify({ _comment: '在此添加你自己的英文->中文自定义词条（优先级最高，更新时自动保留）' }, null, 2) + '\n',
      'utf8'
    );
  }

  if (!fs.existsSync(paths.configPath)) {
    fs.writeFileSync(
      paths.configPath,
      JSON.stringify(
        {
          enabled: true,
          translateMenus: true,
          collectUntranslated: false,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  return {
    dataDir: paths.dataDir,
    dictsDir: paths.dictsDir,
    runtimePath: dstRuntime,
    copiedDicts,
  };
}

/**
 * 只读检查当前安装版本、补丁状态、Fuse 安全状态与运行进程状态。
 */
export function getStatus(opts = {}) {
  const paths = resolvePaths(opts);
  if (!fs.existsSync(paths.installDir) || !fs.existsSync(paths.asarPath)) {
    return {
      state: 'not-found',
      installDir: paths.installDir,
      dataDir: paths.dataDir,
      asarExists: false,
    };
  }

  const asarSha256 = sha256File(paths.asarPath);
  const fuse = checkElectronFuses(paths.exePath);
  const processInfo = opts.skipProcessCheck ? { running: false, pids: [] } : isAntigravityRunning(paths.installDir);
  const mainInfo = getMainEntryInfo(paths.asarPath);
  const version = readInstalledVersion(paths.installDir, mainInfo.pkg && mainInfo.pkg.version);
  const hasMarker = mainInfo.mainCode.includes(PATCH_MARKER);
  const manifest = readManifest(paths.manifestPath);

  let state = 'unpatched';
  if (!fuse.safe) {
    state = 'fuse-blocked';
  } else if (hasMarker) {
    state = 'patched';
  } else if (manifest.lastPatched && manifest.lastPatched.patchedSha256 && manifest.lastPatched.patchedSha256 !== asarSha256) {
    state = 'needs-repatch';
  }

  return {
    state,
    asarExists: true,
    version,
    installDir: paths.installDir,
    dataDir: paths.dataDir,
    asarPath: paths.asarPath,
    asarSha256,
    mainEntry: mainInfo.mainRel,
    hasMarker,
    fuse,
    running: processInfo,
    backupsCount: manifest.backups.length,
    lastPatched: manifest.lastPatched,
  };
}

function formatFuseError(fuse) {
  switch (fuse && fuse.reason) {
    case 'exe-not-found':
      return '未找到 Antigravity.exe，无法校验运行环境与安全标志位，已安全中止补丁操作。';
    case 'fuse-header-invalid':
      return '检测到 Antigravity.exe 的 Electron Fuse 结构异常或截断，出于安全考虑已中止补丁操作。';
    case 'fuse-unknown-state':
      return '检测到 Antigravity.exe 中存在无法识别的 Electron ASAR 校验状态，出于安全考虑已中止补丁操作。';
    default:
      return '检测到新版 Antigravity.exe 已启用 Electron ASAR 完整性校验（EnableEmbeddedAsarIntegrityValidation）。为防止应用启动崩溃与合规风险，已自动中止补丁操作。';
  }
}

/**
 * 对 Antigravity 2.0 桌面端应用纯 DOM 汉化补丁。
 */
export function patchAntigravity(opts = {}) {
  const paths = resolvePaths(opts);
  if (!fs.existsSync(paths.asarPath)) {
    throw new Error(`未找到 app.asar：${paths.asarPath}`);
  }

  const fuse = checkElectronFuses(paths.exePath);
  if (!fuse.safe) {
    const err = new Error(formatFuseError(fuse));
    err.code = 'FUSE_BLOCKED';
    throw err;
  }

  const processInfo = opts.skipProcessCheck ? { running: false, pids: [] } : isAntigravityRunning(paths.installDir);
  if (processInfo.running) {
    const err = new Error(
      `检测到 Antigravity.exe 正在运行（PID: ${processInfo.pids.join(', ')}）。请先完全退出 Antigravity 桌面端（包括系统托盘图标），然后再执行补丁。`
    );
    err.code = 'APP_RUNNING';
    throw err;
  }

  const currentSha = sha256File(paths.asarPath);
  const mainInfo = getMainEntryInfo(paths.asarPath);
  const version = readInstalledVersion(paths.installDir, mainInfo.pkg && mainInfo.pkg.version);

  if (mainInfo.mainCode.includes(PATCH_MARKER)) {
    const syncRes = syncRuntimeAndDicts(opts);
    return {
      action: 'already-patched',
      version,
      asarSha256: currentSha,
      mainEntry: mainInfo.mainRel,
      syncRes,
    };
  }

  // 1. 先确保原版 app.asar 被完整无损备份，并立即持久化备份索引到 manifest.json
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  const manifest = readManifest(paths.manifestPath);
  let backupRecord = manifest.backups.find((b) => b.originalSha256 === currentSha && fs.existsSync(b.backupPath));
  if (!backupRecord) {
    const backupName = `app.asar.${sanitizeVersionForFilename(version)}.${currentSha.slice(0, 8)}.bak`;
    const backupPath = path.join(paths.backupsDir, backupName);
    fs.copyFileSync(paths.asarPath, backupPath);
    const verifyBakSha = sha256File(backupPath);
    if (verifyBakSha !== currentSha) {
      throw new Error('备份文件校验失败，已中止补丁操作');
    }
    backupRecord = {
      version,
      originalSha256: currentSha,
      backupPath,
      createdAt: new Date().toISOString(),
    };
    manifest.backups.push(backupRecord);
    writeManifest(paths.manifestPath, manifest);
  }

  const syncRes = syncRuntimeAndDicts(opts);
  const hookedMain = injectHookIntoMain(mainInfo.mainCode, mainInfo.isEsm);
  let loaderSource = fs.readFileSync(path.join(paths.projectDir, 'lib', 'zh_loader.cjs'), 'utf8');
  if (opts.dataDir || paths.dataDir !== resolveDataDir()) {
    loaderSource = loaderSource.replace(/'__AGY_ZH_EMBEDDED_DATA_DIR__'/, () => JSON.stringify(paths.dataDir));
  }
  const loaderBuf = Buffer.from(loaderSource, 'utf8');

  const overrides = new Map([
    [mainInfo.mainRel, Buffer.from(hookedMain, 'utf8')],
    [mainInfo.loaderRel, loaderBuf],
  ]);

  // 2. 先在暂存文件构建并完成全量 SHA-256 校验，校验通过后再原子替换正式 app.asar
  const stagedPath = `${paths.asarPath}.staged-${process.pid}-${Date.now()}`;
  let verifyRes;
  try {
    rebuildAsarWithOverrides(paths.asarPath, stagedPath, overrides);
    verifyRes = verifyAsarArchive(stagedPath, { strictHashes: true });
  } catch (err) {
    try {
      if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
    } catch {}
    throw err;
  }

  try {
    fs.renameSync(stagedPath, paths.asarPath);
  } catch (err) {
    try {
      if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
    } catch {}
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      const lockErr = new Error(
        `无法替换 ${paths.asarPath}，文件当前正被进程占用（${err.code}）。请确认 Antigravity 桌面端已完全退出后再试。`
      );
      lockErr.code = 'FILE_LOCKED';
      throw lockErr;
    }
    throw err;
  }

  let patchedSha;
  try {
    readAsarHeader(paths.asarPath);
    patchedSha = sha256File(paths.asarPath);
  } catch (postErr) {
    // 若替换后极小概率读取异常，尝试立即从备份自动回滚
    try {
      const rollbackTmp = `${paths.asarPath}.rollback-${process.pid}`;
      fs.copyFileSync(backupRecord.backupPath, rollbackTmp);
      fs.renameSync(rollbackTmp, paths.asarPath);
    } catch {}
    throw postErr;
  }

  manifest.lastPatched = {
    version,
    originalSha256: currentSha,
    patchedSha256: patchedSha,
    mainEntry: mainInfo.mainRel,
    loaderEntry: mainInfo.loaderRel,
    patchedAt: new Date().toISOString(),
  };
  writeManifest(paths.manifestPath, manifest);

  return {
    action: 'patched',
    version,
    originalSha256: currentSha,
    patchedSha256: patchedSha,
    backupPath: backupRecord.backupPath,
    mainEntry: mainInfo.mainRel,
    loaderEntry: mainInfo.loaderRel,
    verifyRes,
    syncRes,
  };
}

/**
 * 从备份无损还原官方原版 app.asar。
 */
export function restoreAntigravity(opts = {}) {
  const paths = resolvePaths(opts);
  if (!fs.existsSync(paths.asarPath)) {
    throw new Error(`未找到 app.asar：${paths.asarPath}`);
  }

  const processInfo = opts.skipProcessCheck ? { running: false, pids: [] } : isAntigravityRunning(paths.installDir);
  if (processInfo.running) {
    const err = new Error(
      `检测到 Antigravity.exe 正在运行（PID: ${processInfo.pids.join(', ')}）。请先完全退出 Antigravity 桌面端后再还原。`
    );
    err.code = 'APP_RUNNING';
    throw err;
  }

  const status = getStatus({ ...opts, skipProcessCheck: true });
  if (!status.hasMarker) {
    return {
      action: 'already-original',
      version: status.version,
      asarSha256: status.asarSha256,
    };
  }

  const manifest = readManifest(paths.manifestPath);
  const targetOrigSha = manifest.lastPatched && manifest.lastPatched.originalSha256;
  let backup =
    manifest.backups.find((b) => b.originalSha256 === targetOrigSha && fs.existsSync(b.backupPath)) ||
    [...manifest.backups].reverse().find((b) => b.version === status.version && fs.existsSync(b.backupPath));

  if (!backup) {
    throw new Error('未找到与当前版本匹配的原版 app.asar 备份，无法安全还原。');
  }

  const bakSha = sha256File(backup.backupPath);
  if (bakSha !== backup.originalSha256) {
    throw new Error(`备份文件校验失败（期望 ${backup.originalSha256}，实际 ${bakSha}），拒绝还原。`);
  }

  const tmpRestore = `${paths.asarPath}.restore-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(backup.backupPath, tmpRestore);
  try {
    const tmpSha = sha256File(tmpRestore);
    if (tmpSha !== backup.originalSha256) {
      throw new Error('还原暂存文件 SHA-256 校验失败，已中止覆盖原文件。');
    }
    readAsarHeader(tmpRestore);
    fs.renameSync(tmpRestore, paths.asarPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpRestore)) fs.unlinkSync(tmpRestore);
    } catch {}
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      const lockErr = new Error(
        `无法还原 ${paths.asarPath}，文件当前正被进程占用（${err.code}）。请确认 Antigravity 桌面端已完全退出后再试。`
      );
      lockErr.code = 'FILE_LOCKED';
      throw lockErr;
    }
    throw err;
  }

  const restoredSha = sha256File(paths.asarPath);
  if (restoredSha !== backup.originalSha256) {
    throw new Error('还原后 SHA-256 与原版不一致，请检查磁盘状态。');
  }

  manifest.lastPatched = null;
  writeManifest(paths.manifestPath, manifest);

  return {
    action: 'restored',
    version: status.version,
    restoredSha256: restoredSha,
    backupPath: backup.backupPath,
  };
}
