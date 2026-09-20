// offline.js - 离线下载（服务端代下载）管理器
// 支持：HTTP/HTTPS 直链（Node 内置 http/https 流式下载、Range 断点续传、暂停/继续/取消/重试、
//       并发上限与排队、进程重启恢复）与磁力/种子（对接 Aria2 JSON-RPC，未部署时明确降级提示）。
// 设计要点：
//   1. 全程流式落临时文件，绝不把文件读进内存；
//   2. 下载完成后再 putFile 到「当前默认存储策略」，随后由宿主的 saveFile 回调写入 files 表；
//   3. 断点续传依赖固定临时文件路径（os.tmpdir()/teamcloud-offline/<taskId>.part）；
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');

const PART_DIR = path.join(os.tmpdir(), 'teamcloud-offline');
const MAX_CONCURRENCY = 2;           // 并发下载上限
const CONNECT_TIMEOUT_MS = 20000;    // 连接/响应头超时
const IDLE_TIMEOUT_MS = 30000;       // 无数据（空闲）超时
const MAX_REDIRECTS = 5;
const ARIA2_MAGNET_MSG = '磁力/种子需要部署 Aria2（未检测到 127.0.0.1:6800）';

function now() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function formatBytes(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ---------- URL 校验 / SSRF 防护 ----------
// 允许列表：环境变量 OFFLINE_ALLOW_HOSTS（逗号分隔，命中则跳过内网校验）
function allowHosts() {
  return String(process.env.OFFLINE_ALLOW_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isPrivateAddress(addr) {
  const h = String(addr || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true;               // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;    // 私网
    if (p[0] === 192 && p[1] === 168) return true;               // 私网
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;   // CGNAT
    if (p[0] >= 224) return true;                                 // 组播/保留
    return false;
  }
  if (h.includes(':')) {   // IPv6：保守拒绝回环/ULA/link-local 及其它
    if (h === '::1' || h === '::') return true;
    if (/^f[cd]/.test(h)) return true;
    if (/^fe80/.test(h)) return true;
    return true;
  }
  return false;
}

// 校验并规范化 URL（仅 http/https；拒绝内网与 localhost）
async function validateTargetUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, error: '下载地址不能为空' };
  if (/^magnet:/i.test(s)) {
    if (s.length > 4096) return { ok: false, error: '磁力链接过长' };
    return { ok: true, url: s, isMagnet: true };
  }
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, error: '下载地址格式非法' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: '仅支持 http/https 直链（不允许 ' + u.protocol + '）' };
  }
  const host = u.hostname;
  const allow = allowHosts();
  if (!allow.includes(host.toLowerCase())) {
    if (isPrivateAddress(host)) {
      return { ok: false, error: '出于安全考虑，禁止下载内网/localhost 地址（如需允许请配置 OFFLINE_ALLOW_HOSTS）' };
    }
    // 域名解析后二次校验，避免 DNS 指向内网
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) {
      try {
        const addrs = await dns.promises.lookup(host, { all: true });
        for (const a of addrs) {
          if (isPrivateAddress(a.address)) {
            return { ok: false, error: '该域名解析到内网地址，已拒绝下载（如需允许请配置 OFFLINE_ALLOW_HOSTS）' };
          }
        }
      } catch (e) {
        return { ok: false, error: '域名无法解析：' + host };
      }
    }
  }
  return { ok: true, url: u.toString(), isMagnet: false };
}

// 从响应头 / URL 推断文件名
function filenameFromResponse(headers, url) {
  const cd = String((headers && headers['content-disposition']) || '');
  let name = '';
  let m = cd.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (m) { try { name = decodeURIComponent(m[1].trim()); } catch (e) { name = m[1].trim(); } }
  if (!name) {
    m = cd.match(/filename\s*=\s*"([^"]*)"/i) || cd.match(/filename\s*=\s*([^;]+)/i);
    if (m) name = m[1].trim();
  }
  if (!name) {
    try {
      const u = new URL(url);
      const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
      name = base || 'download';
    } catch (e) { name = 'download'; }
  }
  name = String(name).replace(/[\u0000-\u001F\u007F]/g, '_').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!name || name === '.' || name === '..') name = 'download';
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 160) + ext;
  }
  return name;
}

class OfflineManager {
  /**
   * @param {Object} opts
   *  db             sqlite 连接
   *  storage        storage.js 模块
   *  s3store        s3store.js 模块
   *  aria2          aria2.js 客户端实例（可为 null）
   *  quota          async (userId, bytes) => { ok, remain, quota }
   *  saveFile       async ({userId, filename, storedName, fileSize, folderId, policyId}) => fileId
   *  onLog          (msg) => void
   */
  constructor(opts) {
    this.db = opts.db;
    this.storage = opts.storage;
    this.s3store = opts.s3store;
    this.aria2 = opts.aria2 || null;
    this.quota = opts.quota;
    this.saveFile = opts.saveFile;
    this.onLog = opts.onLog || function () {};
    this.running = new Map();     // taskId -> runtime
    this.probeCache = new Map();  // taskId -> probe 结果
    this.aria2Available = false;
    this.aria2CheckedAt = 0;
    this._pumping = false;
    this._importing = new Set();
  }

  async init() {
    fs.mkdirSync(PART_DIR, { recursive: true });
    // 进程重启：running → paused（可继续）
    try {
      const r = await this.db.run("UPDATE offline_tasks SET status='paused', updated_at=? WHERE status='running'", now());
      if (r && r.changes) this.onLog('[离线下载] 启动恢复：' + r.changes + ' 个进行中任务已置为「已暂停」');
    } catch (e) { this.onLog('[离线下载] 启动状态恢复失败: ' + e.message); }
    // 重启后残留的临时分片（无对应任务）清理
    try {
      const rows = await this.db.all('SELECT id FROM offline_tasks');
      const alive = new Set(rows.map(r => Number(r.id)));
      for (const f of fs.readdirSync(PART_DIR)) {
        const m = f.match(/^(\d+)\.part$/);
        if (m && !alive.has(Number(m[1]))) { try { fs.unlinkSync(path.join(PART_DIR, f)); } catch (e) {} }
      }
    } catch (e) { /* 忽略 */ }
    this.checkAria2().then(() => this._pump()).catch(() => {});
  }

  partPath(taskId) { return path.join(PART_DIR, Number(taskId) + '.part'); }

  // ---------- Aria2 探测 ----------
  async checkAria2(force) {
    if (!this.aria2) { this.aria2Available = false; return false; }
    const t = Date.now();
    if (!force && t - this.aria2CheckedAt < 30000) return this.aria2Available;
    this.aria2CheckedAt = t;
    this.aria2Available = await this.aria2.available();
    if (this.aria2Available) this.onLog('[离线下载] 已检测到 Aria2 服务: ' + this.aria2.rpcUrl);
    return this.aria2Available;
  }

  aria2Info() {
    return {
      available: !!this.aria2Available,
      url: (this.aria2 && this.aria2.rpcUrl) || 'http://127.0.0.1:6800/jsonrpc',
      hasSecret: !!(this.aria2 && this.aria2.hasSecret),
      hint: ARIA2_MAGNET_MSG
    };
  }

  // ---------- 任务创建 ----------
  // 返回 { task } 或抛出 Error（参数/配额校验失败）
  async create(userId, rawUrl, folderId) {
    const v = await validateTargetUrl(rawUrl);
    if (!v.ok) throw new Error(v.error);

    if (v.isMagnet) return this._createMagnet(userId, v.url, folderId);

    // 直链：创建前探测（HEAD/Range 预取大小，用于配额校验；探测失败不阻断，由下载阶段给出错误）
    let probe = null;
    try { probe = await this.probe(v.url, 8000); } catch (e) { probe = null; }
    if (probe && probe.size > 0) {
      const q = await this.quota(userId, probe.size);
      if (!q.ok) {
        const e = new Error('超出网盘配额：文件 ' + formatBytes(probe.size) + '，剩余空间 ' + formatBytes(q.remain));
        e.code = 'QUOTA';
        throw e;
      }
    }

    const filename = (probe && probe.filename) || filenameFromResponse(null, v.url);
    const total = (probe && probe.size) || 0;
    const policyId = this.storage.defaultPolicy() ? Number(this.storage.defaultPolicy().id) : null;
    const ts = now();
    const r = await this.db.run(
      'INSERT INTO offline_tasks (user_id, url, filename, total_bytes, done_bytes, status, error, source, folder_id, policy_id, created_at, updated_at) ' +
      "VALUES (?, ?, ?, ?, 0, 'queued', NULL, 'http', ?, ?, ?, ?)",
      userId, v.url, filename, total, folderId || null, policyId, ts, ts);
    const taskId = r.lastID;
    if (probe) this.probeCache.set(Number(taskId), probe);
    this._pump();
    return await this.get(userId, taskId);
  }

  async _createMagnet(userId, magnet, folderId) {
    const ok = await this.checkAria2(true);
    if (!ok) {
      const e = new Error(ARIA2_MAGNET_MSG + '；请配置环境变量 ARIA2_RPC_URL（默认 http://127.0.0.1:6800/jsonrpc）与 ARIA2_RPC_SECRET 后重启服务。');
      e.code = 'ARIA2_UNAVAILABLE';
      throw e;
    }
    const policyId = this.storage.defaultPolicy() ? Number(this.storage.defaultPolicy().id) : null;
    const ts = now();
    let gid = null;
    try {
      gid = await this.aria2.addUri([magnet], { dir: this._aria2Dir() });
    } catch (e) {
      throw new Error('提交到 Aria2 失败：' + e.message);
    }
    const filename = '磁力任务 ' + String(gid).slice(0, 8);
    const r = await this.db.run(
      'INSERT INTO offline_tasks (user_id, url, filename, total_bytes, done_bytes, status, error, source, folder_id, policy_id, aria2_gid, created_at, updated_at) ' +
      "VALUES (?, ?, ?, 0, 0, 'running', NULL, 'aria2', ?, ?, ?, ?, ?)",
      userId, magnet, filename, folderId || null, policyId, String(gid), ts, ts);
    return await this.get(userId, r.lastID);
  }

  _aria2Dir() {
    // 交由 Aria2 自身配置的下载目录；如需指定可在 Aria2 侧设置 dir
    return undefined;
  }

  async _getOwned(userId, id) {
    const t = await this.db.get('SELECT * FROM offline_tasks WHERE id = ? AND user_id = ?', Number(id), userId);
    return t || null;
  }

  async get(userId, id) {
    const t = await this._getOwned(userId, id);
    return t ? this._decorate(t) : null;
  }

  _decorate(r) {
    const rt = this.running.get(Number(r.id));
    const total = Number(r.total_bytes) || 0;
    const done = Number(r.done_bytes) || 0;
    const speed = rt ? (rt.speed || 0) : (Number(r._speed) || 0);
    let percent = 0;
    if (total > 0) percent = Math.min(100, Math.round(done / total * 1000) / 10);
    else if (r.status === 'done') percent = 100;
    return {
      id: Number(r.id),
      url: r.url,
      filename: r.filename,
      totalBytes: total,
      doneBytes: done,
      totalText: total > 0 ? formatBytes(total) : '未知',
      doneText: formatBytes(done),
      percent: percent,
      speed: speed,
      speedText: speed > 0 ? formatBytes(speed) + '/s' : '',
      status: r.status,
      error: r.error || '',
      source: r.source || 'http',
      aria2Gid: r.aria2_gid || null,
      resultFileId: r.result_file_id || null,
      folderId: r.folder_id || null,
      createdAt: r.created_at || '',
      updatedAt: r.updated_at || '',
      finishedAt: r.finished_at || ''
    };
  }

  // ---------- 列表（含 Aria2 状态刷新） ----------
  async list(userId) {
    const rows = await this.db.all('SELECT * FROM offline_tasks WHERE user_id = ? ORDER BY id DESC LIMIT 200', userId);
    const out = [];
    for (const r of rows) {
      if (r.source === 'aria2' && r.aria2_gid) {
        try { await this._refreshAria2(r); } catch (e) { /* 单个任务刷新失败忽略 */ }
        const fresh = await this.db.get('SELECT * FROM offline_tasks WHERE id = ?', r.id);
        out.push(this._decorate(fresh || r));
      } else {
        out.push(this._decorate(r));
      }
    }
    await this.checkAria2(false);
    return out;
  }

  async _refreshAria2(r) {
    if (['done', 'error', 'canceled'].includes(r.status)) return;
    if (!this.aria2) return;
    let st;
    try {
      st = await this.aria2.tellStatus(r.aria2_gid, ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'errorMessage', 'files'], 6000);
    } catch (e) {
      // Aria2 不可达：保留原状态，记录错误信息但不覆盖为 error（服务可能临时重启）
      return;
    }
    if (!st) return;
    const total = Number(st.totalLength) || 0;
    const done = Number(st.completedLength) || 0;
    const speed = Number(st.downloadSpeed) || 0;
    const ts = now();
    if (st.status === 'complete') {
      const key = 'aria2:' + r.id;
      if (this._importing.has(key)) return;
      this._importing.add(key);
      try {
        await this._importAria2Result(r);
      } catch (e) {
        await this.db.run("UPDATE offline_tasks SET status='error', error=?, total_bytes=?, done_bytes=?, updated_at=? WHERE id=?",
          'Aria2 已完成但导入网盘失败：' + e.message, total, done, now(), r.id);
      } finally {
        this._importing.delete(key);
      }
      return;
    }
    let status = r.status;
    if (st.status === 'active') status = 'running';
    else if (st.status === 'waiting') status = 'queued';
    else if (st.status === 'paused') status = 'paused';
    else if (st.status === 'error') status = 'error';
    else if (st.status === 'removed') status = 'canceled';
    await this.db.run('UPDATE offline_tasks SET status=?, total_bytes=?, done_bytes=?, error=?, updated_at=? WHERE id=?',
      status, total, done, st.status === 'error' ? (st.errorMessage || 'Aria2 下载出错') : null, ts, r.id);
    const rt = this.running.get(Number(r.id)) || {};
    rt.speed = speed;
    this.running.set(Number(r.id), rt);
  }

  // 把 Aria2 下载完成的本地文件导入当前默认存储策略并入库
  async _importAria2Result(r) {
    let files = null;
    try { files = await this.aria2.getFiles(r.aria2_gid); } catch (e) { files = null; }
    const p = files && files.length ? files[0].path : null;
    if (!p) throw new Error('无法从 Aria2 获取文件路径');
    const st = await fs.promises.stat(p).catch(() => null);
    if (!st || !st.isFile()) throw new Error('Aria2 下载目录中的文件不可访问: ' + p);
    const filename = path.basename(p);
    const size = st.size;
    const q = await this.quota(r.user_id, size);
    if (!q.ok) throw new Error('超出网盘配额，剩余空间 ' + formatBytes(q.remain));
    const policyId = r.policy_id || (this.storage.defaultPolicy() ? Number(this.storage.defaultPolicy().id) : null);
    const storedName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(filename);
    const backend = this.storage.backendForPolicyId(policyId);
    await backend.putFile(this.s3store.userKey(r.user_id, storedName), p);
    const fileId = await this.saveFile({
      userId: r.user_id, filename: filename, storedName: storedName,
      fileSize: size, folderId: r.folder_id || null, policyId: policyId
    });
    await this.db.run("UPDATE offline_tasks SET status='done', total_bytes=?, done_bytes=?, error=NULL, result_file_id=?, finished_at=?, updated_at=? WHERE id=?",
      size, size, fileId, now(), now(), r.id);
  }

  // ---------- 任务操作 ----------
  async pause(userId, id) {
    const t = await this._getOwned(userId, id);
    if (!t) throw new Error('任务不存在');
    if (t.source === 'aria2') {
      if (t.aria2_gid && this.aria2Available) { try { await this.aria2.pause(t.aria2_gid); } catch (e) { throw new Error('暂停 Aria2 任务失败：' + e.message); } }
      await this.db.run("UPDATE offline_tasks SET status='paused', updated_at=? WHERE id=?", now(), t.id);
      return;
    }
    if (t.status === 'queued') {
      await this.db.run("UPDATE offline_tasks SET status='paused', updated_at=? WHERE id=?", now(), t.id);
      return;
    }
    if (t.status !== 'running') throw new Error('当前状态不可暂停');
    const rt = this.running.get(Number(t.id));
    if (rt) {
      rt.paused = true;
      rt.speed = 0;
      if (rt.stream) { try { rt.stream.destroy(); } catch (e) {} }
    }
    await this.db.run("UPDATE offline_tasks SET status='paused', updated_at=? WHERE id=?", now(), t.id);
  }

  async resume(userId, id) {
    const t = await this._getOwned(userId, id);
    if (!t) throw new Error('任务不存在');
    if (!['paused', 'error', 'canceled'].includes(t.status)) throw new Error('当前状态不可继续');
    if (t.source === 'aria2') {
      const ok = await this.checkAria2(true);
      if (!ok) throw new Error(ARIA2_MAGNET_MSG);
      if (t.aria2_gid) {
        try { await this.aria2.unpause(t.aria2_gid); } catch (e) {
          // unpause 失败（任务可能已结束）时重试一次 removeResult + 重新提交
          throw new Error('继续 Aria2 任务失败：' + e.message);
        }
      }
      await this.db.run("UPDATE offline_tasks SET status='running', error=NULL, updated_at=? WHERE id=?", now(), t.id);
      return;
    }
    await this.db.run("UPDATE offline_tasks SET status='queued', error=NULL, updated_at=? WHERE id=?", now(), t.id);
    this._pump();
  }

  async cancel(userId, id) {
    const t = await this._getOwned(userId, id);
    if (!t) throw new Error('任务不存在');
    if (t.source === 'aria2') {
      if (t.aria2_gid && this.aria2Available) { try { await this.aria2.remove(t.aria2_gid); } catch (e) {} }
    }
    const rt = this.running.get(Number(t.id));
    if (rt) {
      rt.canceled = true;
      rt.speed = 0;
      if (rt.stream) { try { rt.stream.destroy(); } catch (e) {} }
    }
    await this.db.run("UPDATE offline_tasks SET status='canceled', finished_at=?, updated_at=? WHERE id=?", now(), now(), t.id);
    if (t.source !== 'aria2') {
      try { fs.unlinkSync(this.partPath(t.id)); } catch (e) {}
    }
  }

  async remove(userId, id) {
    const t = await this._getOwned(userId, id);
    if (!t) throw new Error('任务不存在');
    if (t.status === 'running' || t.status === 'queued') throw new Error('请先取消任务再删除记录');
    if (t.source === 'aria2' && t.aria2_gid && this.aria2Available) {
      try { await this.aria2.removeResult(t.aria2_gid); } catch (e) {}
    }
    try { fs.unlinkSync(this.partPath(t.id)); } catch (e) {}
    await this.db.run('DELETE FROM offline_tasks WHERE id = ?', t.id);
  }

  async retry(userId, id) {
    const t = await this._getOwned(userId, id);
    if (!t) throw new Error('任务不存在');
    if (!['error', 'canceled'].includes(t.status)) throw new Error('仅失败/已取消的任务可重试');
    if (t.status === 'canceled') {
      // 已取消时临时分片已删除，从头下载
      this.probeCache.delete(Number(t.id));
      await this.db.run("UPDATE offline_tasks SET status='queued', error=NULL, done_bytes=0, updated_at=? WHERE id=?", now(), t.id);
      this._pump();
      return;
    }
    this.probeCache.delete(Number(t.id));
    await this.db.run("UPDATE offline_tasks SET status='queued', error=NULL, updated_at=? WHERE id=?", now(), t.id);
    this._pump();
  }

  // ---------- 调度 ----------
  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (this.running.size < MAX_CONCURRENCY) {
        const t = await this.db.get("SELECT * FROM offline_tasks WHERE status = 'queued' AND source = 'http' ORDER BY id ASC LIMIT 1");
        if (!t) break;
        const r = await this.db.run("UPDATE offline_tasks SET status='running', updated_at=? WHERE id=? AND status='queued'", now(), t.id);
        if (!r || !r.changes) continue;
        t.status = 'running';
        this._start(t);
        if (this.running.size >= MAX_CONCURRENCY) break;
      }
    } catch (e) {
      this.onLog('[离线下载] 调度失败: ' + e.message);
    } finally {
      this._pumping = false;
    }
  }

  _start(task) {
    const id = Number(task.id);
    if (this.running.has(id)) return;
    const rt = { id: id, speed: 0, stream: null, ws: null, paused: false, canceled: false, done: Number(task.done_bytes) || 0 };
    this.running.set(id, rt);
    this._run(task, rt).catch((err) => {
      this.onLog('[离线下载] 任务 #' + id + ' 异常: ' + (err && err.message));
      void this._fail(id, (err && err.message) || '下载失败', rt.done);
    }).then(() => {
      this.running.delete(id);
      this._pump();
    });
  }

  // ---------- HTTP 请求（含重定向） ----------
  requestStream(url, headers, redirectsLeft, holder, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + (u.search || ''),
        method: 'GET',
        headers: Object.assign({ 'User-Agent': 'CCNetDisk-Offline/1.0', 'Accept': '*/*' }, headers || {})
      }, (res) => {
        const code = res.statusCode;
        if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('重定向地址非法')); }
          return this.requestStream(next, headers, redirectsLeft - 1, holder, timeoutMs).then(resolve, reject);
        }
        if (holder) { holder.url = url; holder.req = req; }
        resolve({ status: code, headers: res.headers, stream: res, req: req });
      });
      req.setTimeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : CONNECT_TIMEOUT_MS, () => req.destroy(new Error('连接超时')));
      req.on('error', reject);
      if (holder) holder.req = req;
      req.end();
    });
  }

  // 预取大小（Range: bytes=0-0；失败回退 HEAD）
  async probe(url, timeoutMs) {
    const holder = {};
    let size = 0, rangeSupport = false, filename = '';
    try {
      const r = await this.requestStream(url, { Range: 'bytes=0-0' }, MAX_REDIRECTS, holder, timeoutMs);
      const h = r.headers || {};
      const cr = String(h['content-range'] || '');
      const m = cr.match(/\/(\d+)\s*$/);
      if (r.status === 206 && m) { size = Number(m[1]) || 0; rangeSupport = true; }
      else if (r.status >= 200 && r.status < 300 && h['content-length']) { size = Number(h['content-length']) || 0; }
      filename = filenameFromResponse(h, holder.url || url);
      try { r.stream.destroy(); } catch (e) {}
      if (r.status >= 200 && r.status < 300) return { size: size, rangeSupport: rangeSupport, filename: filename, finalUrl: holder.url || url };
    } catch (e) { /* 继续尝试 HEAD */ }

    // HEAD 回退
    try {
      const h2 = await new Promise((resolve, reject) => {
        let u; try { u = new URL(url); } catch (e) { return reject(e); }
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request({ protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + (u.search || ''), method: 'HEAD', headers: { 'User-Agent': 'CCNetDisk-Offline/1.0' } }, (res) => {
          resolve({ status: res.statusCode, headers: res.headers });
          try { res.destroy(); } catch (e) {}
        });
        req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('HEAD 超时')));
        req.on('error', reject);
        req.end();
      });
      if (h2.status >= 200 && h2.status < 300 && h2.headers['content-length']) size = Number(h2.headers['content-length']) || 0;
      filename = filenameFromResponse(h2.headers, url);
      return { size: size, rangeSupport: false, filename: filename, finalUrl: url };
    } catch (e) {
      throw new Error('无法访问下载地址：' + e.message);
    }
  }

  // ---------- 下载主流程 ----------
  async _run(task, rt) {
    const id = Number(task.id);
    let info = this.probeCache.get(id);
    this.probeCache.delete(id);
    if (!info || !info.finalUrl) {
      info = await this.probe(task.url, 15000);
    }
    const filename = task.filename || info.filename || filenameFromResponse(null, task.url);
    const part = this.partPath(id);

    // 配额：已知大小则精确校验，未知则用当前剩余空间做流式上限
    const q0 = await this.quota(task.user_id, info.size > 0 ? info.size : 0);
    if (info.size > 0 && !q0.ok) {
      await this._fail(id, '超出网盘配额：文件 ' + formatBytes(info.size) + '，剩余空间 ' + formatBytes(q0.remain), rt.done);
      return;
    }
    rt.remain = q0.remain;

    // 断点续传：读取已有分片大小
    let start = 0;
    try {
      const st = await fs.promises.stat(part);
      if (st.isFile()) start = st.size;
    } catch (e) { start = 0; }
    if (start > 0 && info.size > 0 && start >= info.size) {
      start = 0;
      try { fs.unlinkSync(part); } catch (e) {}
    }

    const headers = start > 0 ? { Range: 'bytes=' + start + '-' } : {};
    const r2 = await this.requestStream(info.finalUrl || task.url, headers, MAX_REDIRECTS, rt);
    if (r2.status >= 400) throw new Error('服务器返回 HTTP ' + r2.status);
    let append = false;
    if (start > 0) {
      if (r2.status === 206) append = true;
      else if (r2.status === 200) {
        start = 0;
        try { await fs.promises.rm(part, { force: true }); } catch (e) {}
      } else {
        try { r2.stream.destroy(); } catch (e) {}
        throw new Error('服务器返回 HTTP ' + r2.status);
      }
    }
    let total = info.size || 0;
    if (r2.status === 206) {
      const m = String(r2.headers['content-range'] || '').match(/\/(\d+)\s*$/);
      if (m) total = Number(m[1]) || total;
    } else if (r2.headers['content-length']) {
      total = start + (Number(r2.headers['content-length']) || 0);
    }
    await this.db.run('UPDATE offline_tasks SET total_bytes=?, done_bytes=?, updated_at=? WHERE id=?', total, start, now(), id);
    rt.done = start;

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
      rt.ws = ws;
      rt.stream = r2.stream;
      let finished = false;
      let sawEnd = false;
      let idleTimer = null;
      let lastTick = Date.now();
      let lastBytes = start;
      let lastDb = 0;
      const cleanup = () => {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        rt.stream = null;
        rt.ws = null;
      };
      const ok = () => { if (finished) return; finished = true; cleanup(); resolve(); };
      const bad = (e) => { if (finished) return; finished = true; cleanup(); reject(e); };
      const touch = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { try { r2.stream.destroy(new Error('下载超时（长时间无数据）')); } catch (e) {} }, IDLE_TIMEOUT_MS);
      };
      touch();
      r2.stream.on('data', (chunk) => {
        rt.done += chunk.length;
        touch();
        const t = Date.now();
        if (t - lastTick >= 1000) {
          rt.speed = Math.round((rt.done - lastBytes) / ((t - lastTick) / 1000));
          lastTick = t;
          lastBytes = rt.done;
        }
        if (t - lastDb >= 1000) {
          lastDb = t;
          this.db.run('UPDATE offline_tasks SET done_bytes=?, total_bytes=?, updated_at=? WHERE id=?', rt.done, total || rt.done, now(), id)
            .catch(() => {});
        }
        if (rt.remain != null && rt.done > rt.remain) {
          try { r2.stream.destroy(new Error('超出网盘剩余容量')); } catch (e) {}
        }
      });
      r2.stream.on('end', () => { sawEnd = true; });
      r2.stream.on('error', (e) => { try { ws.destroy(); } catch (_) {} bad(e); });
      r2.stream.on('close', () => {
        if (finished) return;
        // 主动暂停/取消：销毁连接导致的 close 视为正常中断（后续写入分片与状态）
        if (rt.paused || rt.canceled) return ok();
        // 数据未收完就断开 = 异常
        if (!sawEnd) return bad(new Error('连接中断（下载未完成）'));
        // 数据已收完：等待写入流 flush，由 ws 'finish' 结束
      });
      ws.on('error', (e) => { try { r2.stream.destroy(); } catch (_) {} bad(e); });
      ws.on('finish', ok);
      r2.stream.pipe(ws);
    });

    rt.speed = 0;
    let written = rt.done;

    if (rt.canceled || rt.paused) {
      // 以落盘分片的实际大小为准（暂停瞬间可能有未刷盘数据）
      try {
        const st = await fs.promises.stat(part);
        if (st.isFile()) written = st.size;
      } catch (e) { /* 保留 rt.done */ }
    }

    if (rt.canceled) {
      await this.db.run("UPDATE offline_tasks SET status='canceled', done_bytes=?, finished_at=?, updated_at=? WHERE id=?", written, now(), now(), id);
      try { fs.unlinkSync(part); } catch (e) {}
      return;
    }
    if (rt.paused) {
      await this.db.run("UPDATE offline_tasks SET status='paused', done_bytes=?, total_bytes=?, updated_at=? WHERE id=?", written, total || written, now(), id);
      return;
    }
    if (total > 0 && written !== total) {
      await this._fail(id, '下载不完整（已下载 ' + formatBytes(written) + ' / ' + formatBytes(total) + '）', written);
      return;
    }

    // 写入当前默认存储策略
    const policyId = this.storage.defaultPolicy() ? Number(this.storage.defaultPolicy().id) : null;
    const storedName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(filename);
    const backend = this.storage.backendForPolicyId(policyId);
    await backend.putFile(this.s3store.userKey(task.user_id, storedName), part);
    let fileId = null;
    try {
      fileId = await this.saveFile({
        userId: task.user_id, filename: filename, storedName: storedName,
        fileSize: written, folderId: task.folder_id || null, policyId: policyId
      });
    } catch (e) {
      try { await backend.deleteObject(this.s3store.userKey(task.user_id, storedName)); } catch (e2) {}
      throw e;
    }
    try { fs.unlinkSync(part); } catch (e) {}
    await this.db.run(
      "UPDATE offline_tasks SET status='done', done_bytes=?, total_bytes=?, error=NULL, result_file_id=?, finished_at=?, updated_at=? WHERE id=?",
      written, total || written, fileId, now(), now(), id);
    this.onLog('[离线下载] 任务 #' + id + ' 完成：' + filename + '（' + formatBytes(written) + '）→ 文件 #' + fileId);
  }

  async _fail(id, message, doneBytes) {
    try {
      await this.db.run("UPDATE offline_tasks SET status='error', error=?, done_bytes=?, updated_at=? WHERE id=?",
        String(message).slice(0, 400), Number(doneBytes) || 0, now(), id);
    } catch (e) { /* 忽略 */ }
    this.onLog('[离线下载] 任务 #' + id + ' 失败：' + message);
  }
}

module.exports = {
  OfflineManager,
  validateTargetUrl,
  isPrivateAddress,
  formatBytes,
  ARIA2_MAGNET_MSG,
  MAX_CONCURRENCY,
  PART_DIR
};
