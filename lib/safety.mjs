import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Electron 官方 Fuse Sentinel 字符串
const ELECTRON_FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNnH4m43547281', 'ascii');
const FUSE_NAMES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
];

/**
 * 解析默认或用户指定的 Antigravity 2.0 桌面端安装目录。
 * @param {string} [customDir]
 */
export function resolveInstallDir(customDir) {
  if (customDir) {
    return path.resolve(customDir);
  }
  if (process.env.ANTIGRAVITY_INSTALL_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_INSTALL_DIR);
  }
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'antigravity');
}

/**
 * 解析用户外部配置与备份存放目录（位于用户目录，不受官方更新覆盖）。
 * @param {string} [customDataDir]
 */
export function resolveDataDir(customDataDir) {
  if (customDataDir) {
    return path.resolve(customDataDir);
  }
  if (process.env.ANTIGRAVITY_ZH_HOME) {
    return path.resolve(process.env.ANTIGRAVITY_ZH_HOME);
  }
  return path.join(os.homedir(), '.antigravity-zh');
}

/**
 * 计算文件 SHA-256 十六进制摘要。
 * @param {string} filePath
 */
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 只读检查可执行文件内是否启用了 Electron ASAR 完整性校验 Fuse。
 * 若启用（index 4 == '1'），绝不尝试绕过，必须安全中止。
 * @param {string} exePath
 */
export function checkElectronFuses(exePath) {
  if (!fs.existsSync(exePath)) {
    return { found: false, asarIntegrityEnabled: false, safe: false, reason: 'exe-not-found' };
  }
  const buf = fs.readFileSync(exePath);
  const idx = buf.indexOf(ELECTRON_FUSE_SENTINEL);
  if (idx === -1) {
    return { found: false, asarIntegrityEnabled: false, safe: true, reason: 'no-fuse-wire' };
  }
  const offset = idx + ELECTRON_FUSE_SENTINEL.length;
  if (offset + 2 > buf.length) {
    return { found: true, asarIntegrityEnabled: false, safe: false, reason: 'fuse-header-invalid' };
  }
  const version = buf[offset];
  const count = buf[offset + 1];
  if (count <= 4 || offset + 2 + count > buf.length) {
    return { found: true, version, count, asarIntegrityEnabled: false, safe: false, reason: 'fuse-header-invalid' };
  }
  const fuses = {};
  for (let i = 0; i < count; i++) {
    const ch = String.fromCharCode(buf[offset + 2 + i]);
    const name = FUSE_NAMES[i] || `Fuse_${i}`;
    fuses[name] = ch === '1' ? 'ENABLE' : ch === '0' ? 'DISABLE' : ch;
  }
  const asarIntegrityVal = buf[offset + 2 + 4];
  if (asarIntegrityVal === 0x31) {
    return {
      found: true,
      version,
      count,
      fuses,
      asarIntegrityEnabled: true,
      safe: false,
      reason: 'fuse-enabled',
    };
  }
  if (asarIntegrityVal === 0x30) {
    return {
      found: true,
      version,
      count,
      fuses,
      asarIntegrityEnabled: false,
      safe: true,
      reason: 'fuse-disabled',
    };
  }
  return {
    found: true,
    version,
    count,
    fuses,
    asarIntegrityEnabled: false,
    safe: false,
    reason: 'fuse-unknown-state',
  };
}

const SIDECAR_WORKER_RE = /sidecar_sdk|register_loader\.js|antigravity-zh-patch[\\/]+cli\.mjs/i;

/**
 * 区分真实桌面端主/渲染进程与后台独立 Sidecar / 本工具自身 Node 进程（后两者不占用 app.asar）。
 * @param {Array<{ pid: number, commandLine?: string }>} entries
 * @param {number} [currentPid]
 */
export function classifyAntigravityProcesses(entries, currentPid = process.pid) {
  const pids = [];
  const sidecarPids = [];
  const allPids = [];
  for (const item of entries || []) {
    const pid = Number(item && item.pid);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (currentPid && pid === currentPid) continue;
    allPids.push(pid);
    const cmd = typeof item.commandLine === 'string' ? item.commandLine : '';
    if (SIDECAR_WORKER_RE.test(cmd)) {
      sidecarPids.push(pid);
    } else {
      pids.push(pid);
    }
  }
  return {
    running: pids.length > 0,
    pids,
    sidecarPids,
    allPids,
  };
}

/**
 * 检查指定安装目录对应的 Antigravity 桌面端是否正在运行（跳过 sidecar_sdk / CLI 进程，并支持按安装目录过滤）。
 * @param {string} [targetInstallDir]
 */
export function isAntigravityRunning(targetInstallDir) {
  if (process.platform !== 'win32') {
    return { running: false, pids: [], sidecarPids: [], allPids: [] };
  }
  try {
    const psOut = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object ProcessId, CommandLine, ExecutablePath | ConvertTo-Json -Compress",
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      }
    ).trim();

    if (!psOut) {
      return { running: false, pids: [], sidecarPids: [], allPids: [] };
    }
    const parsed = JSON.parse(psOut);
    let list = Array.isArray(parsed) ? parsed : [parsed];
    if (targetInstallDir) {
      const targetExe = path.resolve(targetInstallDir, 'Antigravity.exe').toLowerCase();
      list = list.filter((p) => {
        const exePath = p && p.ExecutablePath ? path.resolve(String(p.ExecutablePath)).toLowerCase() : '';
        return exePath === targetExe;
      });
    }
    return classifyAntigravityProcesses(
      list.map((p) => ({
        pid: p && p.ProcessId,
        commandLine: p && p.CommandLine ? String(p.CommandLine) : '',
      }))
    );
  } catch {
    // PowerShell 查询失败时降级回 tasklist
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const entries = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('INFO:')) continue;
        const match = /^"Antigravity\.exe","(\d+)"/i.exec(line);
        if (match) {
          entries.push({ pid: Number(match[1]), commandLine: '' });
        }
      }
      return classifyAntigravityProcesses(entries);
    } catch {
      return { running: false, pids: [], sidecarPids: [], allPids: [] };
    }
  }
}

/**
 * 读取已安装的 Antigravity 版本号。
 * @param {string} installDir
 */
export function readInstalledVersion(installDir) {
  const versionFile = path.join(installDir, 'version');
  if (fs.existsSync(versionFile)) {
    const ver = fs.readFileSync(versionFile, 'utf8').trim();
    if (ver) return ver;
  }
  return 'unknown';
}
