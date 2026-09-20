// onlyoffice.js - OnlyOffice Document Server 对接层
// 配置：ONLYOFFICE_URL（Document Server 地址，可空）、ONLYOFFICE_JWT_SECRET（可空）
// 未配置时所有相关入口只做降级提示，不加载任何外部脚本、不报错。
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UNCONFIGURED_MSG = '在线编辑需部署 OnlyOffice Document Server 并在服务端配置 ONLYOFFICE_URL（当前未配置）';

function config() {
  const raw = String(process.env.ONLYOFFICE_URL || '').trim().replace(/\/+$/, '');
  const secret = String(process.env.ONLYOFFICE_JWT_SECRET || '').trim();
  return {
    url: raw,
    jwtSecret: secret,
    configured: /^https?:\/\//i.test(raw)
  };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const p = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(p, 'base64').toString('utf8');
}

// HS256 JWT 签发
function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload || {}));
  const data = header + '.' + body;
  const sig = b64url(crypto.createHmac('sha256', String(secret)).update(data).digest());
  return data + '.' + sig;
}

// HS256 JWT 校验：合法返回 payload，否则 null
function verifyJwt(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const data = parts[0] + '.' + parts[1];
    const expect = crypto.createHmac('sha256', String(secret)).update(data).digest();
    const given = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
    const payload = JSON.parse(b64urlDecode(parts[1]));
    if (payload && payload.exp && Date.now() / 1000 > Number(payload.exp)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// 下载远端文件到本地（用于 Document Server 回传的保存地址）
function downloadToFile(rawUrl, destPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(new Error('回调文件地址非法')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('回调文件地址仅支持 http/https'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + (u.search || ''), method: 'GET',
      headers: { 'User-Agent': 'CCNetDisk-OnlyOffice/1.0' }
    }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('回调文件下载失败，HTTP ' + res.statusCode)); }
      const ws = fs.createWriteStream(destPath);
      let size = 0;
      res.on('data', (c) => { size += c.length; });
      res.on('error', (e) => { ws.destroy(); reject(e); });
      ws.on('error', reject);
      ws.on('finish', () => resolve({ size: size }));
      res.pipe(ws);
    });
    req.setTimeout(Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000, () => req.destroy(new Error('回调文件下载超时')));
    req.on('error', reject);
    req.end();
  });
}

// OnlyOffice 文档 key：同一文件在内容变化时必须变化（用 id + 更新时间哈希）
function buildKey(file) {
  const src = 'f' + file.id + '-' + (file.uploaded_at || '') + '-' + (file.stored_name || '');
  return (String(file.id) + '-' + crypto.createHash('md5').update(src).digest('hex')).slice(0, 60);
}

// 供 Document Server 无会话拉取原文件 / 回调用的签名令牌
function fileToken(fileId, key, ttlMs) {
  const exp = Math.floor((Date.now() + (ttlMs || 12 * 3600 * 1000)) / 1000);
  const secret = config().jwtSecret || 'cc-onlyoffice-internal';
  const sig = crypto.createHmac('sha256', secret).update('onlyoffice:' + fileId + ':' + key + ':' + exp).digest('hex');
  return { t: sig, e: exp };
}

function checkFileToken(fileId, key, t, e) {
  if (!t || !e) return false;
  if (Number(e) * 1000 < Date.now()) return false;
  const secret = config().jwtSecret || 'cc-onlyoffice-internal';
  const sig = crypto.createHmac('sha256', secret).update('onlyoffice:' + fileId + ':' + key + ':' + e).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(String(t));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  config, signJwt, verifyJwt, downloadToFile, buildKey, fileToken, checkFileToken,
  UNCONFIGURED_MSG
};
