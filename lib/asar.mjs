import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 确保直接导入本模块在 ELECTRON_RUN_AS_NODE 模式下也能按普通二进制文件读写 .asar
process.noAsar = true;

const INTEGRITY_BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB，与 Electron ASAR 默认块大小一致

/**
 * 读取 ASAR 归档的 Chromium Pickle 头部信息与文件树 JSON。
 * @param {string} asarPath
 */
export function readAsarHeader(asarPath) {
  const stat = fs.statSync(asarPath);
  if (stat.size < 16) {
    throw new Error(`ASAR 文件过小，格式无效：${asarPath}`);
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.allocUnsafe(16);
    const bytesRead = readExact(fd, prefix, 16, 0);
    if (bytesRead < 16) {
      throw new Error(`无法读取 ASAR 头部：${asarPath}`);
    }
    const p1Size = prefix.readUInt32LE(0);
    const p2Size = prefix.readUInt32LE(4);
    const p2Payload = prefix.readUInt32LE(8);
    const strLen = prefix.readUInt32LE(12);

    if (p1Size !== 4) {
      throw new Error(`不支持的 ASAR Pickle p1Size=${p1Size}`);
    }
    const baseOffset = 8 + p2Size;
    if (baseOffset > stat.size || 16 + strLen > baseOffset) {
      throw new Error(`ASAR 头部长度异常：baseOffset=${baseOffset}, strLen=${strLen}, fileSize=${stat.size}`);
    }

    const jsonBuf = Buffer.allocUnsafe(strLen);
    const jsonRead = readExact(fd, jsonBuf, strLen, 16);
    if (jsonRead < strLen) {
      throw new Error(`读取 ASAR 元数据 JSON 失败：${asarPath}`);
    }

    const header = JSON.parse(jsonBuf.toString('utf8'));
    if (!header || typeof header !== 'object' || !header.files) {
      throw new Error(`ASAR 元数据缺少 files 根节点：${asarPath}`);
    }
    return {
      header,
      baseOffset,
      fileSize: stat.size,
      p1Size,
      p2Size,
      p2Payload,
      strLen,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 在 ASAR 元数据树中查找相对路径对应的节点。
 * @param {object} header
 * @param {string} relPath
 */
export function findAsarNode(header, relPath) {
  const parts = normalizeRelPath(relPath).split('/');
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      return null;
    }
    cur = cur.files[part];
  }
  return cur;
}

/**
 * 从 ASAR 中读取单个已打包文件的二进制内容。
 * @param {string} asarPath
 * @param {string} relPath
 */
export function readAsarFile(asarPath, relPath) {
  const { header, baseOffset, fileSize } = readAsarHeader(asarPath);
  const node = findAsarNode(header, relPath);
  if (!node) {
    throw new Error(`ASAR 中找不到文件：${relPath}`);
  }
  if (node.files) {
    throw new Error(`目标路径是目录而非文件：${relPath}`);
  }
  if (node.unpacked) {
    throw new Error(`目标文件为 unpacked（未打包进 ASAR）：${relPath}`);
  }
  const offset = Number(node.offset);
  const size = Number(node.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
    throw new Error(`ASAR 条目偏移或大小无效：${relPath}`);
  }
  const absStart = baseOffset + offset;
  if (absStart + size > fileSize) {
    throw new Error(`ASAR 条目越界：${relPath}`);
  }
  const out = Buffer.allocUnsafe(size);
  if (size === 0) {
    return out;
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    const n = readExact(fd, out, size, absStart);
    if (n !== size) {
      throw new Error(`读取文件字节数不足：${relPath}`);
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 计算与 Electron ASAR 规范一致的 SHA-256 完整性信息（含 4MiB 分块哈希）。
 * @param {Buffer} buf
 */
export function computeAsarIntegrity(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  } else {
    for (let pos = 0; pos < buf.length; pos += INTEGRITY_BLOCK_SIZE) {
      const end = Math.min(pos + INTEGRITY_BLOCK_SIZE, buf.length);
      blocks.push(crypto.createHash('sha256').update(buf.subarray(pos, end)).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize: INTEGRITY_BLOCK_SIZE,
    blocks,
  };
}

/**
 * 编码 ASAR Chromium Pickle 二进制头部（严格按 4 字节对齐）。
 * @param {object} headerObj
 */
export function encodeAsarHeader(headerObj) {
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const strLen = jsonBuf.length;
  const p2Payload = (4 + strLen + 3) & ~3;
  const p2Size = p2Payload + 4;
  const totalHeaderLen = 8 + p2Size;
  const out = Buffer.alloc(totalHeaderLen, 0);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(p2Size, 4);
  out.writeUInt32LE(p2Payload, 8);
  out.writeUInt32LE(strLen, 12);
  jsonBuf.copy(out, 16);
  return out;
}

/**
 * 基于原版 ASAR 与若干覆盖/新增文件重建新的 ASAR 归档，原子替换到 destPath。
 * 所有未修改条目按原始字节与元数据原封复制，仅更新偏移与覆盖条目完整性哈希。
 * @param {string} srcPath
 * @param {string} destPath
 * @param {Map<string, Buffer> | Record<string, Buffer>} overrides
 */
export function rebuildAsarWithOverrides(srcPath, destPath, overrides) {
  const overrideMap = overrides instanceof Map
    ? new Map([...overrides.entries()].map(([k, v]) => [normalizeRelPath(k), Buffer.isBuffer(v) ? v : Buffer.from(v)]))
    : new Map(Object.entries(overrides).map(([k, v]) => [normalizeRelPath(k), Buffer.isBuffer(v) ? v : Buffer.from(v)]));

  const { header, baseOffset, fileSize } = readAsarHeader(srcPath);
  const newHeader = structuredClone(header);

  // 确保新增或覆盖的路径在目录树中均存在对应节点
  for (const relPath of overrideMap.keys()) {
    ensureFileSlot(newHeader, relPath);
  }

  const slices = [];
  let cursor = 0;

  function processTree(node, prefix) {
    if (!node.files) {
      return;
    }
    for (const [name, child] of Object.entries(node.files)) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        processTree(child, relPath);
        continue;
      }
      if (overrideMap.has(relPath)) {
        const buf = overrideMap.get(relPath);
        delete child.unpacked;
        delete child.link;
        child.size = buf.length;
        child.offset = String(cursor);
        child.integrity = computeAsarIntegrity(buf);
        slices.push({ type: 'buffer', buf });
        cursor += buf.length;
        continue;
      }
      if (child.unpacked || child.link) {
        continue;
      }
      const origOffset = Number(child.offset);
      const size = Number(child.size);
      if (!Number.isFinite(origOffset) || !Number.isFinite(size) || origOffset < 0 || size < 0) {
        throw new Error(`原 ASAR 条目元数据无效：${relPath}`);
      }
      const absStart = baseOffset + origOffset;
      if (absStart + size > fileSize) {
        throw new Error(`原 ASAR 条目越界：${relPath}`);
      }
      child.offset = String(cursor);
      slices.push({ type: 'copy', absStart, size });
      cursor += size;
    }
  }

  processTree(newHeader, '');

  const headerBuf = encodeAsarHeader(newHeader);
  const destDir = path.dirname(destPath);
  fs.mkdirSync(destDir, { recursive: true });
  const tmpPath = path.join(destDir, `${path.basename(destPath)}.tmp-${process.pid}-${Date.now()}`);

  const srcFd = fs.openSync(srcPath, 'r');
  const dstFd = fs.openSync(tmpPath, 'w');
  try {
    writeAll(dstFd, headerBuf);
    const copyBuf = Buffer.allocUnsafe(1024 * 1024);
    for (const item of slices) {
      if (item.type === 'buffer') {
        writeAll(dstFd, item.buf);
      } else if (item.size > 0) {
        let remaining = item.size;
        let pos = item.absStart;
        while (remaining > 0) {
          const chunk = Math.min(remaining, copyBuf.length);
          const n = fs.readSync(srcFd, copyBuf, 0, chunk, pos);
          if (n !== chunk) {
            throw new Error(`复制原 ASAR 数据块失败（pos=${pos}, expected=${chunk}, got=${n}）`);
          }
          writeAll(dstFd, copyBuf.subarray(0, n));
          pos += n;
          remaining -= n;
        }
      }
    }
  } catch (err) {
    try { fs.closeSync(dstFd); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  } finally {
    try { fs.closeSync(srcFd); } catch {}
  }
  fs.closeSync(dstFd);

  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      const lockErr = new Error(
        `无法替换 ${destPath}，文件当前正被进程占用（${err.code}）。请确认 Antigravity 桌面端已完全退出后再试。`
      );
      lockErr.code = 'FILE_LOCKED';
      throw lockErr;
    }
    throw err;
  }
}

/**
 * 校验 ASAR 归档头部对齐、边界与各打包条目 SHA-256 完整性。
 * @param {string} asarPath
 * @param {{ strictHashes?: boolean }} [options]
 */
export function verifyAsarArchive(asarPath, options = {}) {
  const { strictHashes = true } = options;
  const { header, baseOffset, fileSize } = readAsarHeader(asarPath);
  let packedFiles = 0;
  let unpackedFiles = 0;
  let symlinkFiles = 0;
  let verifiedHashes = 0;

  const fd = fs.openSync(asarPath, 'r');
  try {
    function walk(node, prefix) {
      if (!node.files) {
        return;
      }
      for (const [name, child] of Object.entries(node.files)) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (child.files) {
          walk(child, relPath);
          continue;
        }
        if (child.unpacked) {
          unpackedFiles++;
          continue;
        }
        if (child.link) {
          symlinkFiles++;
          continue;
        }
        packedFiles++;
        const offset = Number(child.offset);
        const size = Number(child.size);
        if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size < 0) {
          throw new Error(`条目元数据无效：${relPath}`);
        }
        const absStart = baseOffset + offset;
        if (absStart + size > fileSize) {
          throw new Error(`条目偏移越界：${relPath}`);
        }
        if (strictHashes && child.integrity && child.integrity.algorithm === 'SHA256') {
          const buf = Buffer.allocUnsafe(size);
          if (size > 0) {
            const n = readExact(fd, buf, size, absStart);
            if (n !== size) {
              throw new Error(`读取校验字节失败：${relPath}`);
            }
          }
          const actual = computeAsarIntegrity(buf);
          if (actual.hash !== child.integrity.hash) {
            throw new Error(`SHA-256 校验失败：${relPath}`);
          }
          if (Array.isArray(child.integrity.blocks) && JSON.stringify(actual.blocks) !== JSON.stringify(child.integrity.blocks)) {
            throw new Error(`分块 SHA-256 校验失败：${relPath}`);
          }
          verifiedHashes++;
        }
      }
    }
    walk(header, '');
  } finally {
    fs.closeSync(fd);
  }

  return {
    ok: true,
    baseOffset,
    fileSize,
    packedFiles,
    unpackedFiles,
    symlinkFiles,
    verifiedHashes,
  };
}

const UNSAFE_PROP_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

function ensureFileSlot(headerRoot, relPath) {
  const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`ASAR 目标路径为空：${relPath}`);
  }
  for (const seg of parts) {
    if (seg === '.' || seg === '..' || UNSAFE_PROP_NAMES.has(seg)) {
      throw new Error(`ASAR 路径包含非法段 "${seg}"：${relPath}`);
    }
  }

  let cur = headerRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    const dirName = parts[i];
    if (!cur.files || typeof cur.files !== 'object') {
      cur.files = {};
    }
    if (!Object.prototype.hasOwnProperty.call(cur.files, dirName)) {
      cur.files[dirName] = { files: {} };
    } else if (!cur.files[dirName] || typeof cur.files[dirName].files !== 'object') {
      throw new Error(`ASAR 路径冲突，中间节点并非目录 "${dirName}"：${relPath}`);
    }
    cur = cur.files[dirName];
  }
  const leaf = parts[parts.length - 1];
  if (!cur.files || typeof cur.files !== 'object') {
    cur.files = {};
  }
  if (!Object.prototype.hasOwnProperty.call(cur.files, leaf)) {
    cur.files[leaf] = { size: 0, offset: '0' };
  } else if (cur.files[leaf] && cur.files[leaf].files) {
    throw new Error(`ASAR 路径冲突，目标已是目录 "${leaf}"：${relPath}`);
  }
}

export function normalizeRelPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function readExact(fd, buf, length, position) {
  let offset = 0;
  let curPos = position;
  while (offset < length) {
    const n = fs.readSync(fd, buf, offset, length - offset, curPos);
    if (n <= 0) {
      return offset;
    }
    offset += n;
    if (curPos !== null && curPos !== undefined) {
      curPos += n;
    }
  }
  return offset;
}

function writeAll(fd, buf) {
  let written = 0;
  while (written < buf.length) {
    written += fs.writeSync(fd, buf, written, buf.length - written);
  }
}
