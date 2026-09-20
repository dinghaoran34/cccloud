// storage.js - 团队云「存储策略」抽象层
// 支持两种策略后端：s3（复用 s3store 的对象存储）、local（本地磁盘目录）。
// 上层按 files.policy_id 决定读写在哪个后端；policy_id 为空视为当前默认策略。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const s3store = require('./s3store');

const PROJECT_DIR = __dirname;
const LOCAL_DEFAULT_ROOT = path.join(PROJECT_DIR, 'storage-local');

let db = null;
let policies = [];

function init(database) { db = database; }

// ---------- 键与路径安全 ----------
// 存储键形如 wwwuser/user_1/xxx、wwwuser/shared/xxx、wwwuser/teams/team_2/xxx
// 逐段校验，拒绝 ..、绝对路径、盘符、控制字符等，防止目录穿越
function safeKey(key) {
  const k = String(key == null ? '' : key).replace(/\\/g, '/');
  if (!k) throw new Error('无效的存储键');
  const parts = k.split('/');
  const out = [];
  for (const raw of parts) {
    if (raw === '') continue;
    if (raw === '.' || raw === '..') throw new Error('非法存储键（路径穿越）');
    if (/[\u0000-\u001F]/.test(raw)) throw new Error('非法存储键（控制字符）');
    if (/[:*?"<>|]/.test(raw)) throw new Error('非法存储键（非法字符）');
    out.push(raw);
  }
  if (!out.length) throw new Error('无效的存储键');
  return out.join('/');
}

function resolveLocalPath(root, key) {
  const base = path.resolve(String(root || LOCAL_DEFAULT_ROOT));
  const full = path.resolve(base, ...safeKey(key).split('/'));
  if (full !== base && full.indexOf(base + path.sep) !== 0) throw new Error('路径越界');
  return full;
}

function parseRange(rangeHeader, total) {
  // 返回 { start, end } 或 null（无 Range）或 { invalid: true }
  if (!rangeHeader || !/^bytes=/.test(rangeHeader)) return null;
  const spec = String(rangeHeader).replace(/^bytes=/, '').split(',')[0].trim();
  const m = spec.match(/^(\d*)-(\d*)$/);
  if (!m) return { invalid: true };
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return { invalid: true };
  let start, end;
  if (!hasStart) {
    const suffix = parseInt(m[2], 10);
    if (!suffix) return { invalid: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : total - 1;
  }
  if (isNaN(start) || isNaN(end) || start > end || start >= total) return { invalid: true };
  if (end > total - 1) end = total - 1;
  return { start, end };
}

// ---------- 后端：本地磁盘 ----------
function localBackend(root) {
  const rootDir = String(root || LOCAL_DEFAULT_ROOT);
  function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
  function tempName(dest) { return dest + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'); }
  return {
    type: 'local',
    root: rootDir,
    ensureRoot() { ensureDir(rootDir); return rootDir; },
    async putFile(key, localPathSrc) {
      const dest = resolveLocalPath(rootDir, key);
      ensureDir(path.dirname(dest));
      const tmp = tempName(dest);
      await fs.promises.copyFile(localPathSrc, tmp);
      await fs.promises.rm(dest, { force: true });
      await fs.promises.rename(tmp, dest);
    },
    async putStream(key, stream) {
      const dest = resolveLocalPath(rootDir, key);
      ensureDir(path.dirname(dest));
      const tmp = tempName(dest);
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(tmp);
          stream.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', resolve);
          stream.pipe(ws);
        });
        await fs.promises.rm(dest, { force: true });
        await fs.promises.rename(tmp, dest);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
        throw e;
      }
    },
    async headObject(key) {
      try {
        const st = await fs.promises.stat(resolveLocalPath(rootDir, key));
        if (!st.isFile()) return { exists: false, size: 0 };
        return { exists: true, size: st.size };
      } catch (e) {
        return { exists: false, size: 0 };
      }
    },
    async getObject(key, range) {
      let full;
      try { full = resolveLocalPath(rootDir, key); } catch (e) { return { notFound: true }; }
      let st;
      try { st = await fs.promises.stat(full); } catch (e) { return { notFound: true }; }
      if (!st.isFile()) return { notFound: true };
      const total = st.size;
      if (!range) return { stream: fs.createReadStream(full), size: total, contentLength: total, contentRange: null };
      const r = parseRange(range, total);
      if (!r) return { stream: fs.createReadStream(full), size: total, contentLength: total, contentRange: null };
      if (r.invalid) return { invalidRange: true, size: total };
      const len = r.end - r.start + 1;
      return {
        stream: fs.createReadStream(full, { start: r.start, end: r.end }),
        size: total,
        contentLength: len,
        contentRange: 'bytes ' + r.start + '-' + r.end + '/' + total
      };
    },
    async deleteObject(key) {
      try { await fs.promises.rm(resolveLocalPath(rootDir, key), { force: true }); } catch (e) { /* 忽略 */ }
    },
    async copyObject(srcKey, dstKey) {
      const src = resolveLocalPath(rootDir, srcKey);
      const dest = resolveLocalPath(rootDir, dstKey);
      ensureDir(path.dirname(dest));
      const tmp = tempName(dest);
      await fs.promises.copyFile(src, tmp);
      await fs.promises.rename(tmp, dest);
    }
  };
}

// ---------- 后端：S3（包装 s3store） ----------
const s3Backend = {
  type: 's3',
  async putFile(key, localPath) { return s3store.putFile(key, localPath); },
  async headObject(key) { return s3store.headObject(key); },
  async getObject(key, range) { return s3store.getObject(key, range); },
  async deleteObject(key) { return s3store.deleteObject(key); },
  async copyObject(srcKey, dstKey) { return s3store.copyObject(srcKey, dstKey); }
};

// ---------- 策略查询 ----------
async function loadPolicies() {
  policies = await db.all('SELECT * FROM storage_policies ORDER BY id ASC');
  return policies;
}
function listPolicies() { return policies.slice(); }
function getPolicy(id) {
  const n = Number(id);
  if (!n) return null;
  return policies.find(p => Number(p.id) === n) || null;
}
function defaultPolicy() {
  return policies.find(p => Number(p.is_default) === 1) || policies[0] || null;
}
function parseConfig(pol) {
  if (!pol || !pol.config) return {};
  try { const c = JSON.parse(pol.config); return (c && typeof c === 'object') ? c : {}; }
  catch (e) { return {}; }
}
function backendOf(pol) {
  if (pol && pol.type === 'local') {
    const cfg = parseConfig(pol);
    return localBackend(cfg.root || LOCAL_DEFAULT_ROOT);
  }
  return s3Backend;
}
function backendForPolicyId(policyId) {
  const pol = policyId ? getPolicy(policyId) : null;
  return backendOf(pol || defaultPolicy());
}

// 文件记录所属策略：policy_id 为空视为默认策略
function policyIdOf(file) {
  if (file && file.policy_id) return Number(file.policy_id);
  const d = defaultPolicy();
  return d ? Number(d.id) : null;
}
function backendForFile(file) { return backendForPolicyId(policyIdOf(file)); }
function isLocalFile(file) { return backendForFile(file).type === 'local'; }

// ---------- 按文件记录读写 ----------
async function headFile(file) { return backendForFile(file).headObject(s3store.resolveKey(file)); }
async function getFileObject(file, range) { return backendForFile(file).getObject(s3store.resolveKey(file), range); }
async function deleteFileObject(file) { return backendForFile(file).deleteObject(s3store.resolveKey(file)); }

// 下载地址：S3 返回预签名 URL；本地策略返回 null（调用方回退到服务器中转流）
async function presignFile(file, filename, expiresIn, contentType) {
  const backend = backendForFile(file);
  if (backend.type !== 's3') return null;
  return s3store.presignGet(s3store.resolveKey(file), filename, expiresIn, contentType);
}

// 跨策略复制（同 S3 时走服务端 CopyObject，其它情况经临时文件中转）
async function copyObjectBetween(srcFile, dstPolicyId, dstKey) {
  const srcBackend = backendForFile(srcFile);
  const dstBackend = backendForPolicyId(dstPolicyId);
  const srcKey = s3store.resolveKey(srcFile);
  if (srcBackend.type === 's3' && dstBackend.type === 's3') {
    return s3store.copyObject(srcKey, dstKey);
  }
  const obj = await srcBackend.getObject(srcKey);
  if (!obj || obj.notFound || !obj.stream) throw new Error('源文件不存在');
  const tmp = path.join(os.tmpdir(), 'teamcloud-copy-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      obj.stream.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      obj.stream.pipe(ws);
    });
    await dstBackend.putFile(dstKey, tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
  }
}

// 通用「流式回源」：S3 / 本地均可，支持 HTTP Range（供服务器中转下载/预览使用）
async function pipeToResponse(file, req, res, opts) {
  opts = opts || {};
  const backend = backendForFile(file);
  const key = s3store.resolveKey(file);
  let head;
  try { head = await backend.headObject(key); } catch (e) { head = { exists: false }; }
  if (!head.exists) return { notFound: true };
  const total = Number(head.size) || 0;

  let rangeHeader = null;
  let start = 0, end = total - 1, status = 200;
  if (total > 0 && req.headers && req.headers.range) {
    const r = parseRange(req.headers.range, total);
    if (r && r.invalid) {
      res.status(416).setHeader('Content-Range', 'bytes */' + total);
      res.end();
      return { invalidRange: true };
    }
    if (r) { start = r.start; end = r.end; status = 206; rangeHeader = 'bytes=' + start + '-' + end; }
  }

  const obj = rangeHeader ? await backend.getObject(key, rangeHeader) : await backend.getObject(key);
  if (!obj || obj.notFound || !obj.stream) {
    if (obj && obj.invalidRange) { res.status(416).end(); return { invalidRange: true }; }
    return { notFound: true };
  }

  if (opts.contentType) res.setHeader('Content-Type', opts.contentType);
  else res.setHeader('Content-Type', 'application/octet-stream');
  const name = String(opts.filename || 'download').replace(/[\r\n"]/g, '_');
  if (opts.download) {
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
  } else {
    res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(name));
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  if (status === 206) {
    res.status(206);
    res.setHeader('Content-Range', obj.contentRange || ('bytes ' + start + '-' + end + '/' + total));
    res.setHeader('Content-Length', String(obj.contentLength != null ? obj.contentLength : (end - start + 1)));
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(total));
  }
  obj.stream.on('error', () => { try { res.end(); } catch (e) { /* 忽略 */ } });
  obj.stream.pipe(res);
  return { ok: true, size: total };
}

// ---------- 供 ZIP 解析使用的随机读适配器（S3 / 本地通用） ----------
function recordReader(file) {
  const backend = backendForFile(file);
  const key = s3store.resolveKey(file);
  const readRange = async (offset, length) => {
    const r = await backend.getObject(key, `bytes=${offset}-${offset + length - 1}`);
    if (r.notFound || !r.stream) throw new Error('读取对象失败');
    const chunks = [];
    for await (const c of r.stream) chunks.push(c);
    return Buffer.concat(chunks).slice(0, length);
  };
  return {
    size: async () => {
      const h = await backend.headObject(key);
      if (!h.exists) throw new Error('文件不存在');
      return h.size;
    },
    read: readRange,
    createReadStream: async (offset, length) => {
      if (length <= 0) return null;
      const r = await backend.getObject(key, `bytes=${offset}-${offset + length - 1}`);
      if (r.notFound || !r.stream) return null;
      return r.stream;
    }
  };
}

module.exports = {
  LOCAL_DEFAULT_ROOT,
  init, loadPolicies, listPolicies, getPolicy, defaultPolicy, parseConfig,
  backendOf, backendForPolicyId, backendForFile, policyIdOf, isLocalFile,
  safeKey, resolveLocalPath,
  headFile, getFileObject, deleteFileObject, presignFile, copyObjectBetween, pipeToResponse, recordReader
};
