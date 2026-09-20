// aria2.js - Aria2 JSON-RPC 客户端（仅用 Node 内置 http/https，无第三方依赖）
// 配置：ARIA2_RPC_URL（默认 http://127.0.0.1:6800/jsonrpc）、ARIA2_RPC_SECRET（可空）
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_RPC_URL = 'http://127.0.0.1:6800/jsonrpc';

// 创建客户端；opts: { url, secret, timeout }
function createClient(opts) {
  opts = opts || {};
  const rpcUrl = String(opts.url || DEFAULT_RPC_URL);
  const secret = opts.secret ? String(opts.secret) : '';
  const defTimeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 8000;
  let seq = 0;

  function call(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(rpcUrl); } catch (e) { return reject(new Error('ARIA2_RPC_URL 配置非法')); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return reject(new Error('ARIA2_RPC_URL 仅支持 http/https'));
      }
      const full = secret ? ['token:' + secret].concat(params || []) : (params || []);
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'cc-' + (++seq), method: method, params: full });
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
          if (data.length > 4 * 1024 * 1024) req.destroy(new Error('Aria2 响应过大'));
        });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(data); } catch (e) { return reject(new Error('Aria2 响应不是合法 JSON')); }
          if (j && j.error) return reject(new Error((j.error && j.error.message) || 'Aria2 调用失败'));
          resolve(j ? j.result : null);
        });
      });
      req.setTimeout(timeoutMs || defTimeout, () => req.destroy(new Error('Aria2 请求超时')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  return {
    rpcUrl,
    hasSecret: !!secret,

    // 探测服务是否可用（短超时，异常时返回 false，不抛出）
    async available(timeoutMs) {
      try {
        const r = await call('aria2.getVersion', [], timeoutMs || 2500);
        return !!(r && r.version);
      } catch (e) {
        return false;
      }
    },
    getVersion(timeoutMs) { return call('aria2.getVersion', [], timeoutMs); },

    // 添加 URI 任务（支持 magnet: 与普通 URL），返回 gid
    addUri(uris, options) {
      const list = Array.isArray(uris) ? uris : [uris];
      return call('aria2.addUri', [list, options || {}]);
    },
    // 添加种子（base64 内容）
    addTorrent(base64, uris, options) {
      return call('aria2.addTorrent', [base64, uris || [], options || {}]);
    },
    // 查询任务状态；keys 为空则取全部字段
    tellStatus(gid, keys, timeoutMs) {
      const p = keys && keys.length ? [gid, keys] : [gid];
      return call('aria2.tellStatus', p, timeoutMs);
    },
    tellActive(keys) { return call('aria2.tellActive', keys && keys.length ? [keys] : []); },
    getFiles(gid) { return call('aria2.getFiles', [gid]); },
    pause(gid) { return call('aria2.pause', [gid]); },
    unpause(gid) { return call('aria2.unpause', [gid]); },
    // remove：删除任务记录（不删已下载文件）
    remove(gid) { return call('aria2.remove', [gid]); },
    // removeDownloadResult：清除已完成/失败任务的记录
    removeResult(gid) { return call('aria2.removeDownloadResult', [gid]); },
    purgeDownloadResult() { return call('aria2.purgeDownloadResult'); }
  };
}

module.exports = { createClient, DEFAULT_RPC_URL };
