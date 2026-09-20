const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const s3store = require('./s3store'); // S3 对象存储层
const storage = require('./storage'); // 阶段二：存储策略抽象层（S3 / 本地磁盘）
const offlineMod = require('./offline');   // 阶段三：离线下载管理器（HTTP/HTTPS 直链 + Aria2 磁力对接）
const aria2Mod = require('./aria2');       // 阶段三：Aria2 JSON-RPC 客户端
const officedoc = require('./officedoc');  // 阶段三：Office Open XML 只读解析（docx/xlsx/pptx → HTML）
const onlyoffice = require('./onlyoffice'); // 阶段三：OnlyOffice Document Server 对接层

const app = express();
// 端口：默认 9178（可被环境变量 PORT 覆盖，便于部署时灵活配置）
const PORT = process.env.PORT || 9178;
const HOST = process.env.HOST || '127.0.0.1';
let db;

// ==================== 文件名编码辅助函数 ====================
// 解决 multer 1.x 将 HTTP 头部文件名按 latin1 编码存储的问题
// 同时兼容某些浏览器直接发送 UTF-8 编码的情况
// 清洗文件名中的控制字符（NUL/0x1F 等会让浏览器显示异常或截断）与替换字符
// 控制字符替换为空格（保持原文件名的空格语义），U+FFFD 直接丢弃
function sanitizeFilename(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\uFFFD/g, '').trim();
}

function decodeFilename(originalname) {
  try {
    // 标准做法：将 latin1 字节重新解释为 UTF-8
    var decoded = Buffer.from(originalname, 'latin1').toString('utf8');
    // 检查解码结果是否包含非法字符（U+FFFD 替换字符的 UTF-8 编码）
    var hasInvalid = false;
    for (var i = 0; i < decoded.length; i++) {
      if (decoded.charCodeAt(i) === 65533) { hasInvalid = true; break; }
    }
    // 如果解码结果有替换字符，说明原始文件名可能已经是 UTF-8，直接返回
    if (hasInvalid) return originalname;
    // 检查是否出现典型的"双重编码"特征（如 Ã¤ 等 latin1 残影）
    if (/[ÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö]/.test(decoded) &&
        /[\\x00-\\x7F]/.test(originalname)) {
      return originalname;
    }
    return decoded;
  } catch (e) {
    return originalname;
  }
}

// ==================== 极验行为验证第四代配置 ====================
// 登录与注册使用独立的 captcha_id / captcha_key
const GEETEST_CAPTCHA_ID = 'c2ce95294dd45f8ea74a123f4ff0325b';
const GEETEST_CAPTCHA_KEY = '59532e66f7e3bcdb7db310c3131554d5';

const GEETEST_REGISTER_CAPTCHA_ID = '1c70aa586b17c6fc804b414d46688cfe';
const GEETEST_REGISTER_CAPTCHA_KEY = '42cf95e618ec5c6c73531040bd134088';

// ==================== 内部 API 密钥 ====================
// 免极验验证登录等内部接口使用。生产环境务必通过环境变量 INTERNAL_API_KEY 覆盖默认值！
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'teamcloud-internal-key-change-me';

// 极验v4服务端二次验证（支持传入不同的 captcha_id / captcha_key）
function verifyGeetest(lot_number, captcha_output, pass_token, gen_time, captchaId = GEETEST_CAPTCHA_ID, captchaKey = GEETEST_CAPTCHA_KEY) {
  return new Promise((resolve) => {
    // 生成签名 token: HMAC-SHA256(captcha_key, lot_number)
    const sign_token = crypto.createHmac('sha256', captchaKey).update(lot_number).digest('hex');

    // 组装请求参数
    const postData = new URLSearchParams({
      lot_number,
      captcha_output,
      pass_token,
      gen_time,
      sign_token
    }).toString();

    const options = {
      hostname: 'gcaptcha4.geetest.com',
      path: `/validate?captcha_id=${captchaId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.result === 'success');
        } catch {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

// ==================== 极验行为验证3.0 配置（安卓App专用） ====================
// 从极验控制台创建两个「行为验证3.0」验证：一个用于登录、一个用于注册（分开）。
// 将验证的 captcha_id / captcha_key 填入下方即可生效（无需改安卓App / 无需重启流程）。
const GT3_LOGIN_CAPTCHA_ID = 'b472f7a471b9cbf99cc45671e9d8145c';     // 登录专用 3.0 captcha_id
const GT3_LOGIN_CAPTCHA_KEY = '6afc8fb300d91fd68ac6e0ea7582bf92';    // 登录专用 3.0 captcha_key
const GT3_REGISTER_CAPTCHA_ID = '60905fe16f5390271c19cc8c0030d75c';  // 注册专用 3.0 captcha_id
const GT3_REGISTER_CAPTCHA_KEY = '3b93f0edaecf1c12a08b69ca196d6bcb'; // 注册专用 3.0 captcha_key

// 极验3.0 是否已配置
function gt3Configured(scene) {
  const id = scene === 'register' ? GT3_REGISTER_CAPTCHA_ID : GT3_LOGIN_CAPTCHA_ID;
  const key = scene === 'register' ? GT3_REGISTER_CAPTCHA_KEY : GT3_LOGIN_CAPTCHA_KEY;
  return !!(id && key);
}

// 极验3.0 api1：向极验服务器注册 challenge（GET register.php）
function gt3RegisterChallenge(captchaId) {
  return new Promise((resolve) => {
    https.get(`https://api.geetest.com/register.php?gt=${captchaId}&json_format=1`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// 极验3.0 服务端二次验证（POST validate.php，校验 md5(seccode)）
function verifyGeetestV3(challenge, validate, seccode, captchaId) {
  return new Promise((resolve) => {
    if (!challenge || !validate || !seccode) { resolve(false); return; }
    const postData = new URLSearchParams({
      gt: captchaId,
      challenge,
      validate,
      seccode,
      json_format: 1
    }).toString();

    const options = {
      hostname: 'api.geetest.com',
      path: '/validate.php',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const md5 = crypto.createHash('md5').update(seccode).digest('hex');
          resolve(result.status === 'success' && result.seccode === md5);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.write(postData);
    req.end();
  });
}

(async function init() {
  // 打开数据库（如果不存在会自动创建）
  db = await open({
    filename: path.join(__dirname, 'teamcloud.db'),
    driver: sqlite3.Database
  });

  // 创建表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      filename TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      file_size INTEGER,
      is_shared INTEGER DEFAULT 0,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_uid TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      password TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (file_id) REFERENCES files(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      expires_ms INTEGER
    );
  `);

  // 迁移：老库 share_links 表可能缺 password 列
  try {
    const shareCols = await db.all(`PRAGMA table_info(share_links)`);
    if (!shareCols.some(c => c.name === 'password')) {
      await db.run(`ALTER TABLE share_links ADD COLUMN password TEXT`);
      console.log('[迁移] share_links 表已添加 password 列');
    }
  } catch (e) {
    console.log('[迁移] share_links password 列检查/添加跳过:', e.message);
  }

  // 兼容已有数据库：补充新字段（列已存在则忽略错误）
  const ensureColumn = async (table, col, def) => {
    try { await db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) { /* 列已存在 */ }
  };
  await ensureColumn('users', 'uid', 'TEXT');
  await ensureColumn('users', 'nickname', 'TEXT');
  await ensureColumn('users', 'avatar', 'TEXT');
  await ensureColumn('users', 'role', 'TEXT DEFAULT \'user\'');
  await ensureColumn('users', 'banned', 'INTEGER DEFAULT 0');
  await ensureColumn('files', 'team_id', 'INTEGER');
  await ensureColumn('files', 'folder_id', 'INTEGER');
  await ensureColumn('files', 'deleted_at', 'DATETIME');
  await ensureColumn('teams', 'password_hash', 'TEXT');

  // 内部 API 密钥表：管理员可动态生成/删除密钥，供免验证登录等内部接口使用
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT NOT NULL UNIQUE,
      label TEXT,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 个人文件夹表（parent_id 为 NULL 表示根目录）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  await ensureColumn('folders', 'deleted_at', 'DATETIME');

  // ==================== 阶段一新增能力：数据库迁移（可重复执行，老库平滑升级） ====================
  // 秒传哈希 / 分享增强（有效期、下载次数、文件夹分享）
  await ensureColumn('files', 'file_hash', 'TEXT');
  await ensureColumn('share_links', 'folder_id', 'INTEGER');
  await ensureColumn('share_links', 'expires_at', 'DATETIME');
  await ensureColumn('share_links', 'download_count', 'INTEGER DEFAULT 0');

  // 文件版本历史
  await db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL,
      stored_name TEXT NOT NULL,
      file_size INTEGER,
      created_at DATETIME,
      uploader_id INTEGER
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id)`);

  // 收藏 / 星标
  await db.exec(`
    CREATE TABLE IF NOT EXISTS starred (
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (user_id, kind, target_id)
    );
  `);

  // 标签
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      color TEXT,
      created_at DATETIME
    );
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS file_tags (
      file_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (file_id, tag_id)
    );
  `);

  // 最近访问
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recent_views (
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      viewed_at DATETIME,
      PRIMARY KEY (user_id, kind, target_id)
    );
  `);

  // ==================== 阶段二新增能力：数据库迁移（可重复执行，老库平滑升级） ====================
  const nowStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // 审计日志
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      ip TEXT,
      ua TEXT,
      created_at DATETIME
    );
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action)`);

  // 用户组
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      max_storage_bytes INTEGER DEFAULT 0,
      can_upload INTEGER DEFAULT 1,
      can_share INTEGER DEFAULT 1,
      can_use_webdav INTEGER DEFAULT 1,
      can_use_api INTEGER DEFAULT 1,
      created_at DATETIME
    );
  `);
  await ensureColumn('users', 'group_id', 'INTEGER');

  // 存储策略
  await db.exec(`
    CREATE TABLE IF NOT EXISTS storage_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      config TEXT,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME
    );
  `);
  await ensureColumn('files', 'policy_id', 'INTEGER');
  await ensureColumn('file_versions', 'policy_id', 'INTEGER');

  // ==================== 阶段三：离线下载任务表（幂等迁移） ====================
  await db.exec(`
    CREATE TABLE IF NOT EXISTS offline_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      url TEXT NOT NULL,
      filename TEXT,
      total_bytes INTEGER DEFAULT 0,
      done_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      error TEXT,
      created_at DATETIME,
      updated_at DATETIME,
      finished_at DATETIME
    );
  `);
  // 老库/早期版本补齐扩展字段（可重复执行）
  await ensureColumn('offline_tasks', 'source', "TEXT DEFAULT 'http'");
  await ensureColumn('offline_tasks', 'folder_id', 'INTEGER');
  await ensureColumn('offline_tasks', 'policy_id', 'INTEGER');
  await ensureColumn('offline_tasks', 'result_file_id', 'INTEGER');
  await ensureColumn('offline_tasks', 'aria2_gid', 'TEXT');
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_offline_user ON offline_tasks(user_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_offline_status ON offline_tasks(status)`);

  // 初始化用户组：默认组（可上传/可分享/可用 API/WebDAV）与受限组（仅下载）
  // 逐条补齐，保证幂等（即使上次初始化中断也能补齐）
  const defaultGroupRow = await db.get('SELECT id FROM user_groups WHERE name = ?', '默认组');
  if (!defaultGroupRow) {
    await db.run(
      'INSERT INTO user_groups (name, description, max_storage_bytes, can_upload, can_share, can_use_webdav, can_use_api, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      '默认组', '默认权限：可上传、可分享、可使用开放 API 与 WebDAV（跟随全局 20GB 配额）', 0, 1, 1, 1, 1, nowStr());
    console.log('[初始化] 已创建用户组：默认组');
  }
  const restrictedGroupRow = await db.get('SELECT id FROM user_groups WHERE name = ?', '受限组');
  if (!restrictedGroupRow) {
    await db.run(
      'INSERT INTO user_groups (name, description, max_storage_bytes, can_upload, can_share, can_use_webdav, can_use_api, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      '受限组', '受限权限：仅可浏览与下载，禁止上传、分享、开放 API 与 WebDAV', 0, 0, 0, 0, 0, nowStr());
    console.log('[初始化] 已创建用户组：受限组');
  }
  const firstGroup = await db.get('SELECT id FROM user_groups ORDER BY id ASC LIMIT 1');
  if (firstGroup) {
    await db.run('UPDATE users SET group_id = ? WHERE group_id IS NULL', firstGroup.id);
  }

  // 初始化存储策略：S3（默认，避免改变现有部署）+ 本地磁盘（逐条补齐，保证幂等）
  let policyRows = await db.all('SELECT * FROM storage_policies ORDER BY id ASC');
  if (!policyRows.some(p => p.type === 's3')) {
    await db.run('INSERT INTO storage_policies (name, type, config, is_default, created_at) VALUES (?, ?, ?, ?, ?)',
      'S3 对象存储', 's3', '{}', policyRows.length ? 0 : 1, nowStr());
    console.log('[初始化] 已写入存储策略：S3 对象存储');
  }
  if (!policyRows.some(p => p.type === 'local')) {
    await db.run('INSERT INTO storage_policies (name, type, config, is_default, created_at) VALUES (?, ?, ?, 0, ?)',
      '本地磁盘', 'local', JSON.stringify({ root: storage.LOCAL_DEFAULT_ROOT }), nowStr());
    console.log('[初始化] 已写入存储策略：本地磁盘');
  }
  policyRows = await db.all('SELECT * FROM storage_policies ORDER BY id ASC');
  // 保证有且仅有一个默认策略（历史/异常数据兜底：默认优先落在 S3 上）
  if (!policyRows.some(p => Number(p.is_default) === 1)) {
    const prefer = policyRows.find(p => p.type === 's3') || policyRows[0];
    await db.run('UPDATE storage_policies SET is_default = 1 WHERE id = ?', prefer.id);
  }
  storage.init(db);
  await storage.loadPolicies();
  // 本地策略目录准备：创建失败仅告警，不阻止启动
  for (const pol of storage.listPolicies()) {
    if (pol.type !== 'local') continue;
    const cfg = storage.parseConfig(pol);
    const root = cfg.root || storage.LOCAL_DEFAULT_ROOT;
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (e) {
      console.warn('[存储策略] 本地目录不可创建（该策略的文件将无法读写）:', root, e.message);
    }
  }
  // 老库平滑升级：历史文件的 policy_id 回填为 S3 策略，避免切换默认策略后读不到旧文件
  {
    const s3Policy = storage.listPolicies().find(p => p.type === 's3') || storage.defaultPolicy();
    if (s3Policy) {
      const r = await db.run('UPDATE files SET policy_id = ? WHERE policy_id IS NULL', s3Policy.id);
      if (r && r.changes) console.log('[迁移] 已为 ' + r.changes + ' 个历史文件补全存储策略（S3）');
    }
  }

  // ==================== 阶段三：离线下载管理器初始化 ====================
  // 配置：ARIA2_RPC_URL（默认 http://127.0.0.1:6800/jsonrpc）、ARIA2_RPC_SECRET（可空）
  const aria2Client = aria2Mod.createClient({
    url: process.env.ARIA2_RPC_URL || aria2Mod.DEFAULT_RPC_URL,
    secret: process.env.ARIA2_RPC_SECRET || ''
  });
  const offlineMgr = new offlineMod.OfflineManager({
    db,
    storage,
    s3store,
    aria2: aria2Client,
    quota: (userId, bytes) => checkQuota(userId, bytes),
    saveFile: async (opt) => {
      const saved = await recordUploadedFile({
        userId: opt.userId, filename: opt.filename, storedName: opt.storedName,
        fileSize: opt.fileSize, folderId: opt.folderId, policyId: opt.policyId
      });
      return saved.id;
    },
    onLog: (msg) => console.log(msg)
  });
  await offlineMgr.init();
  console.log('[离线下载] 管理器已就绪（并发上限 ' + offlineMod.MAX_CONCURRENCY + '）');

  // ==================== 阶段三：OnlyOffice 配置状态 ====================
  {
    const oc = onlyoffice.config();
    if (oc.configured) console.log('[OnlyOffice] 已配置 Document Server: ' + oc.url + (oc.jwtSecret ? '（已启用 JWT）' : '（未配置 JWT 密钥）'));
    else console.log('[OnlyOffice] 未配置 ONLYOFFICE_URL，在线编辑入口将提示「需部署 OnlyOffice」');
  }

  // ==================== 一次性数据清理：移除「共享空间」历史数据（幂等，失败不影响启动） ====================
  // 共享空间功能已下线，is_shared = 1 的历史文件记录及其关联分享记录需一并清理。
  // 通过 app_meta 迁移标记保证只执行一次；无可清理数据时自然跳过，不增加启动负担。
  try {
    await db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME)`);
    const sharedMigrationKey = 'migration_remove_shared_space_v1';
    const done = await db.get('SELECT value FROM app_meta WHERE key = ?', sharedMigrationKey);
    if (!done) {
      const sharedRows = await db.all('SELECT id, stored_name FROM files WHERE is_shared = 1');
      if (sharedRows.length) {
        const ids = sharedRows.map(r => Number(r.id));
        const ph = ids.map(() => '?').join(',');
        await db.run(`DELETE FROM share_links WHERE file_id IN (${ph})`, ...ids);
        await db.run(`DELETE FROM file_versions WHERE file_id IN (${ph})`, ...ids);
        await db.run(`DELETE FROM file_tags WHERE file_id IN (${ph})`, ...ids);
        await db.run(`DELETE FROM starred WHERE kind = 'file' AND target_id IN (${ph})`, ...ids);
        await db.run(`DELETE FROM recent_views WHERE kind = 'file' AND target_id IN (${ph})`, ...ids);
        await db.run(`DELETE FROM files WHERE id IN (${ph})`, ...ids);
        console.warn('[迁移] 共享空间已下线：已删除 ' + ids.length + ' 条共享文件数据库记录及其关联分享记录（对象存储文件需管理员自行清理）。');
        console.warn('[迁移] 本机无 S3 凭据，以下对象存储文件未被删除，请管理员后续手动清理：');
        sharedRows.forEach(r => console.warn('  - ' + r.stored_name));
      } else {
        console.log('[迁移] 共享空间清理：无历史共享文件记录，跳过。');
      }
      await db.run('INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)',
        sharedMigrationKey, String(sharedRows.length), nowStr());
    }
  } catch (e) {
    console.warn('[迁移] 共享空间历史数据清理失败（不影响启动）:', e.message);
  }

  // 为已有用户补 UID
  const usersWithoutUid = await db.all('SELECT id FROM users WHERE uid IS NULL OR uid = ""');
  for (const u of usersWithoutUid) {
    let uid, exists = true;
    while (exists) {
      uid = crypto.randomBytes(4).toString('hex').toUpperCase();
      exists = await db.get('SELECT id FROM users WHERE uid = ?', uid);
    }
    await db.run('UPDATE users SET uid = ? WHERE id = ?', uid, u.id);
  }

  // ==================== 内置管理员账户 ====================
  // 首次启动自动创建用户名 Administrator 的超级管理员（role=admin）。
  // 初始密码 admin123（可通过浏览量里的"修改密码"或直接更新数据库更换，生产环境务必尽快修改）。
  const ADMIN_USERNAME = 'Administrator';
  const ADMIN_INITIAL_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
  const adminExists = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', ADMIN_USERNAME);
  if (!adminExists) {
    let adminUid, exists = true;
    while (exists) {
      adminUid = crypto.randomBytes(4).toString('hex').toUpperCase();
      exists = await db.get('SELECT id FROM users WHERE uid = ?', adminUid);
    }
    await db.run('INSERT INTO users (username, password_hash, uid, nickname, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ADMIN_USERNAME, bcrypt.hashSync(ADMIN_INITIAL_PASSWORD, 10), adminUid, ADMIN_USERNAME, 'admin',
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    console.log(`[初始化] 已创建管理员账户 "${ADMIN_USERNAME}"（初始密码: ${ADMIN_INITIAL_PASSWORD}，请尽快修改）`);
  } else {
    // 已存在则确保其角色为管理员
    await db.run('UPDATE users SET role = \'admin\' WHERE LOWER(username) = LOWER(?)', ADMIN_USERNAME);
  }

  // 团队文件存储目录（历史数据位于 /wwwuser，保持一致；本机不可写时回退项目目录）
  const teamsDir = path.join('/wwwuser', 'teams');
  try {
    if (!fs.existsSync(teamsDir)) {
      fs.mkdirSync(teamsDir, { recursive: true });
    }
    app.locals.teamsDir = teamsDir;
  } catch (e) {
    const fallbackDir = path.join(__dirname, 'wwwuser-local', 'teams');
    if (!fs.existsSync(fallbackDir)) {
      fs.mkdirSync(fallbackDir, { recursive: true });
    }
    app.locals.teamsDir = fallbackDir;
    console.log('[存储] /wwwuser 不可写，已回退到项目本地目录:', fallbackDir);
  }

  // 上传目录（S3 对象存储，本地仅作临时中转）
  const uploadsDir = '/wwwuser'; // 保留变量名兼容,实际存储走 S3
  app.locals.uploadsDir = uploadsDir;

  // 本地临时中转目录（multer 先写临时文件，路由再上传 S3）
  const tmpUploadDir = path.join(os.tmpdir(), 'teamcloud-upload');
  if (!fs.existsSync(tmpUploadDir)) {
    fs.mkdirSync(tmpUploadDir, { recursive: true });
  }

  // Express 配置
  // 阶段二：WebDAV PUT 与「本地存储策略直传」以原始流读写请求体，
  // 需要跳过全局 JSON / 表单体解析，否则 Content-Type 为 application/json
  // 的文件（如上传 .json）会被解析器消费，导致上传流被破坏。
  const isRawStreamRequest = (req) => {
    const p = String((req && req.path) || '');
    return p === '/upload/local-put' || p === '/dav' || p.indexOf('/dav/') === 0;
  };
  const jsonBodyParser = express.json();
  const urlencodedBodyParser = express.urlencoded({ extended: true });
  app.use((req, res, next) => {
    if (isRawStreamRequest(req)) return next();
    jsonBodyParser(req, res, next);
  });
  app.use((req, res, next) => {
    if (isRawStreamRequest(req)) return next();
    urlencodedBodyParser(req, res, next);
  });
  app.use(require('cookie-parser')());

// [TEMP-DIAG] 临时全量请求日志 - 排查下载 403 用,确认后删除
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ua = (req.headers['user-agent'] || '').slice(0, 60);
    console.log(`[REQ] ${new Date().toISOString().slice(11,19)} ${req.method} ${req.originalUrl.slice(0,120)} -> ${res.statusCode} (${Date.now()-start}ms) UA:${ua}`);
  });
  next();
});

  // 动态 JS 分发：旧浏览器（不支持 fetch/Blob/async）加载 ES3 兼容版 app-legacy.js
  // 必须在 express.static 之前注册，否则静态文件服务会先拦截 /js/app.js
  // 版本化路径: /js/app-latest.js 为新版入口(旧 /js/app.js 曾因无缓存头被浏览器长期缓存旧内容)
  app.get(['/js/app.js', '/js/app-latest.js'], (req, res) => {
    // 禁止缓存：版本演进频繁，避免浏览器拿到旧版 JS（曾导致用户跑旧版多线程下载代码）
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ua = req.headers['user-agent'] || '';
    const androidMatch = ua.match(/Android\s+(\d+)/);
    const androidVer = androidMatch ? parseInt(androidMatch[1], 10) : null;
    const chromeMatch = ua.match(/Chrome\/(\d+)/);
    const chromeVer = chromeMatch && !ua.includes('Edg') ? parseInt(chromeMatch[1], 10) : null;
    const isOld = (androidVer !== null && androidVer < 8) ||
      (chromeVer !== null && chromeVer < 60) ||
      /MSIE/i.test(ua);
    if (isOld) {
      res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'public', 'js', 'app-legacy.js')));
    } else {
      res.type('application/javascript').send(fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js')));
    }
  });

  // 安卓客户端 APK 下载（移动端顶部「下载CC云盘」横幅入口）
  // 安装包放在 public/download/ccyun.apk：发布新版本时直接覆盖该文件即可，无需改代码
  app.get('/app/download', (req, res) => {
    const apkPath = path.join(__dirname, 'public', 'download', 'ccyun.apk');
    if (!fs.existsSync(apkPath)) {
      return res.status(404).type('text/plain; charset=utf-8').send('安装包暂未提供');
    }
    res.download(apkPath, 'CC云盘.apk', (err) => {
      if (err && !res.headersSent) {
        res.status(500).type('text/plain; charset=utf-8').send('下载失败');
      }
    });
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // 兼容旧浏览器 - 设置响应头
  app.use(function(req, res, next) {
    res.setHeader('X-UA-Compatible', 'IE=EmulateIE8, chrome=1');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Session 配置：SQLite 持久化存储（服务器重启不再丢失登录态）
  // 默认不设置 maxAge（会话 cookie，浏览器关闭即失效）
  // 勾选"记住我"设置 30 天有效期；rolling 使活动用户自动续期（长久登录）
  class SqliteSessionStore extends session.Store {
    constructor() { super(); this._db = db; }
    _exp(sess) {
      if (!sess || !sess.cookie || !sess.cookie.expires) return null;
      const t = new Date(sess.cookie.expires).getTime();
      return isNaN(t) ? null : t;
    }
    get(sid, cb) {
      this._db.get('SELECT data FROM sessions WHERE sid = ?', [sid])
        .then(row => {
          if (!row) { if (cb) cb(null, null); return; }
          let s = null;
          try { s = JSON.parse(row.data); } catch (e) {}
          if (cb) cb(null, s);
        })
        .catch(e => { if (cb) cb(e); });
    }
    set(sid, sess, cb) {
      const exp = this._exp(sess);
      this._db.run(
        'INSERT INTO sessions (sid, data, expires_ms) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_ms = excluded.expires_ms',
        [sid, JSON.stringify(sess), exp])
        .then(() => { if (cb) cb(null); })
        .catch(e => { if (cb) cb(e); });
    }
    destroy(sid, cb) {
      this._db.run('DELETE FROM sessions WHERE sid = ?', [sid])
        .then(() => { if (cb) cb(null); })
        .catch(e => { if (cb) cb(e); });
    }
    touch(sid, sess, cb) {
      const exp = this._exp(sess);
      this._db.run('UPDATE sessions SET expires_ms = ? WHERE sid = ?', [exp, sid])
        .then(() => { if (cb) cb(null); })
        .catch(e => { if (cb) cb(e); });
    }
  }
  const sessionStore = new SqliteSessionStore();
  // 每小时清理过期会话
  setInterval(() => {
    sessionStore._db.run('DELETE FROM sessions WHERE expires_ms IS NOT NULL AND expires_ms < ?', Date.now()).catch(() => {});
  }, 60 * 60 * 1000).unref();

  app.use(session({
    secret: 'team-cloud-secret-key-2024',
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    rolling: true,
    cookie: {} // 不设置 maxAge，由登录路由根据"记住我"决定
  }));

  // 模板引擎
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Multer 文件上传配置（先写本地临时目录，路由内上传 S3）
  const uploadLocalStorage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, tmpUploadDir);
    },
    filename: function (req, file, cb) {
      const safeName = sanitizeFilename(decodeFilename(file.originalname));
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(safeName);
      cb(null, uniqueName);
    }
  });

  const upload = multer({
    storage: uploadLocalStorage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB
  });

  // 团队文件上传 multer（先写本地临时目录，路由内上传 S3）
  const teamStorage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, tmpUploadDir);
    },
    filename: function (req, file, cb) {
      const safeName = sanitizeFilename(decodeFilename(file.originalname));
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(safeName);
      cb(null, uniqueName);
    }
  });
  const teamUpload = multer({
    storage: teamStorage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }
  });

  // 头像上传 multer（≤5MB 图片）
  const avatarUpload = multer({
    storage: uploadLocalStorage,
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  // API 认证（401 返回 JSON 而非重定向，便于前端识别跳转登录页）
  function requireAuthApi(req, res, next) {
    if (req.session.userId) {
      next();
    } else {
      res.status(401).json({ ok: false, error: '请先登录CC网盘' });
    }
  }

  // 管理员 API 认证：需已登录且 role=admin
  function requireAdminApi(req, res, next) {
    if (req.session.userId) {
      db.get('SELECT role FROM users WHERE id = ?', req.session.userId)
        .then(user => {
          if (user && user.role === 'admin') return next();
          res.status(403).json({ ok: false, error: '无管理员权限' });
        })
        .catch(() => res.status(500).json({ ok: false, error: '服务器错误' }));
    } else {
      res.status(401).json({ ok: false, error: '请先登录CC网盘' });
    }
  }

  // ==================== 网盘容量配额（20GB/人） ====================
  const QUOTA_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  // 统计用户已用容量（个人/共享/团队上传均计入上传者）
  // 配额优先级：用户所属组的 max_storage_bytes（>0 时生效）> 全局 20GB
  async function getUserUsage(userId) {
    const row = await db.get('SELECT COALESCE(SUM(file_size), 0) AS used FROM files WHERE user_id = ?', userId);
    const used = row ? (Number(row.used) || 0) : 0;
    let quota = QUOTA_BYTES;
    try {
      const g = await getUserGroup(userId);
      if (g && Number(g.max_storage_bytes) > 0) quota = Number(g.max_storage_bytes);
    } catch (e) { /* 组信息不可用时回退全局配额 */ }
    return { used, quota };
  }

  // 校验容量：{ ok, used, quota, remain }
  async function checkQuota(userId, additionalBytes) {
    const { used, quota } = await getUserUsage(userId);
    const remain = quota - used;
    return { ok: additionalBytes <= remain, used, quota, remain };
  }

  function quotaErrorMsg(remain, quota) {
    const total = Number(quota) > 0 ? formatBytes(Number(quota)) : formatBytes(QUOTA_BYTES);
    return '网盘容量不足：已使用 ' + total + ' 上限' + (remain > 0 ? '，剩余空间仅 ' + formatBytes(remain) : '，请先清理文件');
  }

  // ==================== 阶段二：审计日志 ====================
  function appVersion() {
    try { return require('./package.json').version || '1.0.0'; } catch (e) { return '1.0.0'; }
  }

  function clientIp(req) {
    if (!req) return '';
    const xf = req.headers && req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim().slice(0, 64);
    const sock = req.socket || req.connection || {};
    return String(sock.remoteAddress || '').slice(0, 64);
  }

  // 写审计日志（失败仅打印，绝不影响主流程）
  async function writeAudit(entry) {
    try {
      await db.run(
        'INSERT INTO audit_logs (user_id, username, action, target, detail, ip, ua, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        entry.userId != null ? entry.userId : null,
        entry.username != null ? String(entry.username).slice(0, 60) : null,
        String(entry.action || 'unknown').slice(0, 40),
        entry.target != null ? String(entry.target).slice(0, 200) : null,
        entry.detail != null ? String(entry.detail).slice(0, 500) : null,
        entry.ip || null,
        entry.ua ? String(entry.ua).slice(0, 200) : null,
        nowStr()
      );
    } catch (e) {
      console.error('[审计] 写入失败（已忽略）:', e.message);
    }
  }

  // 便捷审计：从请求上下文自动取用户/IP/UA；opts 可覆盖 username/userId（如登录失败场景）
  function audit(req, action, target, detail, opts) {
    opts = opts || {};
    try {
      const userId = opts.userId !== undefined ? opts.userId : (req && req.session ? req.session.userId : null);
      const username = opts.username !== undefined ? opts.username : (req && req.session ? req.session.username : null);
      writeAudit({
        userId: userId != null ? userId : null,
        username,
        action,
        target,
        detail,
        ip: clientIp(req),
        ua: req && req.headers ? (req.headers['user-agent'] || '') : ''
      });
    } catch (e) { /* 忽略 */ }
  }

  // ==================== 阶段二：用户组与权限 ====================
  async function getUserGroup(userId) {
    const u = await db.get('SELECT group_id FROM users WHERE id = ?', Number(userId));
    let g = null;
    if (u && u.group_id) g = await db.get('SELECT * FROM user_groups WHERE id = ?', u.group_id);
    if (!g) g = await db.get('SELECT * FROM user_groups ORDER BY id ASC LIMIT 1');
    return g || null;
  }

  // 权限判定：无组配置时视为允许（保持既有行为不退化）
  async function userCan(userId, perm) {
    try {
      const g = await getUserGroup(userId);
      if (!g) return true;
      return Number(g[perm]) !== 0;
    } catch (e) {
      return true;
    }
  }

  // 上传权限拦截：JSON 接口返回 403 JSON；页面接口返回 403 文本
  async function denyIfCannotUpload(req, res, json) {
    if (await userCan(req.session.userId, 'can_upload')) return false;
    if (json) res.status(403).json({ ok: false, error: '当前用户组不允许上传文件' });
    else res.status(403).type('text/plain').send('当前用户组不允许上传文件');
    return true;
  }

  // 预览类型判定(按扩展名); 返回 null=不支持预览
function previewKind(filename) {
  const ext = (String(filename || '').split('.').pop() || '').toLowerCase();
  const img = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  if (img[ext]) return { kind: 'image', mime: img[ext] };
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  const vid = { mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v' };
  if (vid[ext]) return { kind: 'video', mime: vid[ext] };
  const aud = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' };
  if (aud[ext]) return { kind: 'audio', mime: aud[ext] };
  const txt = ['txt', 'md', 'log', 'js', 'json', 'css', 'py', 'ts', 'java', 'c', 'cpp', 'h', 'xml', 'ini', 'conf', 'yml', 'yaml', 'sh', 'csv', 'srt'];
  if (txt.includes(ext)) return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  // 阶段三：Office Open XML 只读在线预览（服务端本地解析，不依赖外部服务）
  if (officedoc.OFFICE_EXTS[ext]) return { kind: 'office', mime: 'text/html; charset=utf-8' };
  return null;
}

// 认证中间件
  function requireAuth(req, res, next) {
    if (req.session.userId) {
      next();
    } else {
      res.redirect('/login');
    }
  }

  // 全局中间件 - 将用户信息添加到 res.locals
  app.use(async (req, res, next) => {
    if (req.session.userId) {
      const user = await db.get('SELECT id, username, uid, nickname, avatar, role FROM users WHERE id = ?', req.session.userId);
      res.locals.currentUser = user;
    } else {
      res.locals.currentUser = null;
    }
    next();
  });

  // ==================== 浏览器检测 - 三方案 ====================
  // 检测 User-Agent，判断使用哪种方案
  // 手机端 → 手机方案（触摸优化/单列布局/底部导航）
  // 安卓8.0以上桌面 → 现代方案（Flexbox/CSS3/ES6）
  // 安卓8.0以下桌面 → 兼容方案（Table布局/ES3）
  app.use((req, res, next) => {
    const ua = req.headers['user-agent'] || '';
    let isLegacy = false;
    let isMobile = false;

    // === 手机端检测（优先级最高）===
    // 检测 Mobile/Android/iPhone/iPad/iPod/Windows Phone 等关键词
    if (/Mobile|Android|iPhone|iPad|iPod|Windows\s+Phone|BlackBerry|Opera\s+Mini|IEMobile/i.test(ua)) {
      isMobile = true;
    }
    // iPad 上的 Safari 桌面模式 UA 也检测
    if (/Macintosh.*Safari/i.test(ua) && /Touch/i.test(ua)) {
      isMobile = true;
    }

    // === 兼容方案检测 ===
    // 检测安卓版本
    const androidMatch = ua.match(/Android\s+(\d+)/);
    if (androidMatch) {
      const androidVer = parseInt(androidMatch[1], 10);
      isLegacy = androidVer < 8;
    }

    // 检测旧版 IE (IE8 及以下)
    const ieMatch = ua.match(/MSIE\s+(\d+)/);
    if (ieMatch) {
      const ieVer = parseInt(ieMatch[1], 10);
      if (ieVer <= 8) isLegacy = true;
    }

    // 检测旧版 Chrome (Chrome < 30)
    const chromeMatch = ua.match(/Chrome\/(\d+)/);
    if (chromeMatch && !ua.includes('Edg') && !ua.includes('Mobile')) {
      const chromeVer = parseInt(chromeMatch[1], 10);
      if (chromeVer < 30) isLegacy = true;
    }

    // 检测旧版 Safari (Version < 8)
    const safariMatch = ua.match(/Version\/(\d+).*Safari/);
    if (safariMatch) {
      const safariVer = parseInt(safariMatch[1], 10);
      if (safariVer < 8) isLegacy = true;
    }

    res.locals.isMobile = isMobile;
    res.locals.isLegacy = isLegacy;
    next();
  });

  // 模板渲染辅助函数 - 优先级: 手机 > 兼容 > 现代
  function renderPage(req, res, name, data) {
    let template;
    if (res.locals.isMobile) {
      template = name + '-mobile';
    } else if (res.locals.isLegacy) {
      template = name + '-legacy';
    } else {
      template = name;
    }
    res.render(template, data);
  }

  // ==================== 路由 ====================

  // 首页
  app.get('/', (req, res) => {
    if (req.session.userId) {
      res.redirect('/dashboard');
    } else {
      renderPage(req, res, 'index', { title: 'CC网盘 - 首页' });
    }
  });

  // 注册页面（?from=app 表示由安卓客户端跳转而来，注册成功后展示「请返回APP」提示页）
  app.get('/register', (req, res) => {
    if (req.session.userId) {
      res.redirect('/dashboard');
    } else {
      req.session.registerFromApp = (req.query.from === 'app');
      renderPage(req, res, 'register', { title: '注册账户', error: null, captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }
  });

  app.post('/register', async (req, res) => {
    const { username, password, confirmPassword, lot_number, captcha_output, pass_token, gen_time } = req.body;

    if (!username || !password) {
      return renderPage(req, res, 'register', { title: '注册账户', error: '用户名和密码不能为空', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }

    if (password !== confirmPassword) {
      return renderPage(req, res, 'register', { title: '注册账户', error: '两次输入的密码不一致', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }

    if (username.length < 3) {
      return renderPage(req, res, 'register', { title: '注册账户', error: '用户名至少3个字符', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }

    if (password.length < 6) {
      return renderPage(req, res, 'register', { title: '注册账户', error: '密码至少6个字符', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }

    // 人机验证：极验第四代；验证参数缺失则降级跳过（兼容老安卓 WebView 等无法加载极验SDK的环境）
    if (lot_number && captcha_output && pass_token && gen_time) {
      const geetestValid = await verifyGeetest(lot_number, captcha_output, pass_token, gen_time, GEETEST_REGISTER_CAPTCHA_ID, GEETEST_REGISTER_CAPTCHA_KEY);
      if (!geetestValid) {
        return renderPage(req, res, 'register', { title: '注册账户', error: '行为验证失败，请重新验证', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
      }
    }

    // 检查用户名是否已存在
    const existingUser = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (existingUser) {
      return renderPage(req, res, 'register', { title: '注册账户', error: '用户名已存在', captchaId: GEETEST_REGISTER_CAPTCHA_ID });
    }

    // 创建用户
    const hashedPassword = bcrypt.hashSync(password, 10);
    // 生成唯一 UID
    let uid, uidExists = true;
    while (uidExists) {
      uid = crypto.randomBytes(4).toString('hex').toUpperCase();
      uidExists = await db.get('SELECT id FROM users WHERE uid = ?', uid);
    }
    const result = await db.run('INSERT INTO users (username, password_hash, uid, nickname, created_at) VALUES (?, ?, ?, ?, ?)', username, hashedPassword, uid, username, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));

    // S3 对象存储无需创建目录

    // 来自安卓客户端的注册：展示「注册完成，请返回APP」提示页；网页注册仍跳转登录页
    if (req.session.registerFromApp) {
      req.session.registerFromApp = false;
      return res.render('register-done', { username: username });
    }

    res.redirect('/login');
  });

  // 登录页面
  app.get('/login', (req, res) => {
    if (req.session.userId) {
      res.redirect('/dashboard');
    } else {
      const deleted = req.query.deleted === '1';
      renderPage(req, res, 'login', { title: '登录', error: null, captchaId: GEETEST_CAPTCHA_ID, deleted: deleted });
    }
  });

  // 回收站页（独立通用页，数据走 /api/trash/*）
  app.get('/trash', requireAuth, (req, res) => {
    res.render(res.locals.isMobile ? 'trash-mobile' : 'trash', { title: '回收站', layout: false });
  });

  // 搜索页（独立通用页，数据走 /api/search）
  app.get('/search', requireAuth, (req, res) => {
    res.render(res.locals.isMobile ? 'search-mobile' : 'search', { title: '搜索', layout: false });
  });

  // 管理后台（仅管理员；数据走 /api/admin/*）
  app.get('/admin', requireAuth, (req, res) => {
    const cu = res.locals.currentUser;
    if (!cu || cu.role !== 'admin') {
      return res.redirect('/dashboard');
    }
    res.render(res.locals.isMobile ? 'admin-mobile' : 'admin', { title: '管理后台', layout: false });
  });

  // 隐私政策在线预览（UTF-8 源文件）
  app.get('/privacy', (req, res) => {
    try {
      const text = fs.readFileSync(path.join(__dirname, '隐私政策.txt'), 'utf8');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);
    } catch (err) {
      res.status(404).send('隐私政策不存在');
    }
  });

  // 用户协议在线预览（源文件为 GBK 编码，转为 UTF-8 后浏览器直接打开）
  app.get('/agreement', (req, res) => {
    try {
      const buf = fs.readFileSync(path.join(__dirname, '用户协议.txt'));
      let text;
      if (buf.toString('utf8').includes('\uFFFD')) {
        const iconv = require('iconv-lite');
        text = iconv.decode(buf, 'gbk');
      } else {
        text = buf.toString('utf8');
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);
    } catch (err) {
      console.error('读取用户协议失败:', err);
      res.status(404).send('用户协议不存在');
    }
  });

  app.post('/login', async (req, res) => {
    const { username, password, rememberMe, agree, lot_number, captcha_output, pass_token, gen_time } = req.body;

    if (!username || !password) {
      return renderPage(req, res, 'login', { title: '登录', error: '用户名和密码不能为空', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
    }

    // 必须勾选同意用户协议
    if (agree !== 'true') {
      return renderPage(req, res, 'login', { title: '登录', error: '请先阅读并同意用户协议', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
    }

    // 人机验证：极验第四代；验证参数缺失则降级跳过（兼容老安卓 WebView 等无法加载极验SDK的环境）
    if (lot_number && captcha_output && pass_token && gen_time) {
      const geetestValid = await verifyGeetest(lot_number, captcha_output, pass_token, gen_time);
      if (!geetestValid) {
        return renderPage(req, res, 'login', { title: '登录', error: '行为验证失败，请重新验证', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
      }
    }

    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) {
      audit(req, 'login_fail', username, '用户不存在');
      return renderPage(req, res, 'login', { title: '登录', error: '用户名或密码错误', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      audit(req, 'login_fail', username, '密码错误', { userId: user.id, username: user.username });
      return renderPage(req, res, 'login', { title: '登录', error: '用户名或密码错误', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
    }

    // 封禁用户禁止登录（任何入口）
    if (user.banned) {
      audit(req, 'login_fail', username, '账户已被封禁', { userId: user.id, username: user.username });
      return renderPage(req, res, 'login', { title: '登录', error: '该账户已被封禁，请联系管理员', captchaId: GEETEST_CAPTCHA_ID, deleted: false });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    audit(req, 'login_success', user.username, '网页端登录', { userId: user.id, username: user.username });

    // 处理"记住我"：勾选时设置 30 天有效期，否则为会话 cookie（关闭浏览器即失效）
    if (rememberMe === 'true' || rememberMe === 'on' || rememberMe === true) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30天
    } else {
      req.session.cookie.maxAge = null; // 会话 cookie，浏览器关闭即失效
    }
    res.redirect('/dashboard');
  });

  // 登出
  app.post('/logout', (req, res) => {
    if (req.session.userId) audit(req, 'logout', req.session.username || '', '网页端登出');
    req.session.destroy((err) => {
      if (err) console.error(err);
      res.redirect('/login');
    });
  });

  // 注销账户（需验证密码）
  app.post('/account/delete', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const { password } = req.body;

    // 验证密码
    const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      return res.redirect('/login');
    }

    const isValid = bcrypt.compareSync(password || '', user.password_hash);
    if (!isValid) {
      // 密码错误 - 返回仪表盘并显示错误
      const personalFiles = await db.all('SELECT * FROM files WHERE user_id = ? AND is_shared = 0 ORDER BY uploaded_at DESC', userId);
      return renderPage(req, res, 'dashboard', {
        title: 'CC网盘 - 首页',
        personalFiles: personalFiles,
        personalCount: personalFiles.length,
        deleteError: '密码验证失败，无法注销账户'
      });
    }

    // 密码正确 - 删除用户所有个人文件（对象存储 + 数据库记录）
    const userFiles = await db.all('SELECT * FROM files WHERE user_id = ?', userId);
    for (let i = 0; i < userFiles.length; i++) {
      const f = userFiles[i];
      try { await storage.deleteFileObject(f); } catch (e) { /* 忽略 */ }
    }

    // 从数据库删除用户所有文件记录（连同分享链接）
    await db.run('DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', userId);
    await db.run('DELETE FROM files WHERE user_id = ?', userId);

    // 删除用户账户
    await db.run('DELETE FROM users WHERE id = ?', userId);

    audit(req, 'account_delete', user.username, '用户注销账户');

    // 销毁会话
    req.session.destroy((err) => {
      if (err) console.error(err);
      res.redirect('/login?deleted=1');
    });
  });

  // 修改密码（需验证原密码）
  app.post('/account/password', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    // 验证原密码
    const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) {
      return res.redirect('/login');
    }

    const isValid = bcrypt.compareSync(oldPassword || '', user.password_hash);
    if (!isValid) {
      const personalFiles = await db.all('SELECT * FROM files WHERE user_id = ? AND is_shared = 0 ORDER BY uploaded_at DESC', userId);
      return renderPage(req, res, 'dashboard', {
        title: 'CC网盘 - 首页',
        personalFiles,
        personalCount: personalFiles.length,
        passwordError: '原密码错误，无法修改密码'
      });
    }

    // 验证新密码
    if (!newPassword || newPassword.length < 6) {
      const personalFiles = await db.all('SELECT * FROM files WHERE user_id = ? AND is_shared = 0 ORDER BY uploaded_at DESC', userId);
      return renderPage(req, res, 'dashboard', {
        title: 'CC网盘 - 首页',
        personalFiles,
        personalCount: personalFiles.length,
        passwordError: '新密码至少需要6位字符'
      });
    }

    if (newPassword !== confirmPassword) {
      const personalFiles = await db.all('SELECT * FROM files WHERE user_id = ? AND is_shared = 0 ORDER BY uploaded_at DESC', userId);
      return renderPage(req, res, 'dashboard', {
        title: 'CC网盘 - 首页',
        personalFiles,
        personalCount: personalFiles.length,
        passwordError: '两次输入的新密码不一致'
      });
    }

    // 更新密码
    const newHash = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
    audit(req, 'password_change', user.username, '修改登录密码');

    const personalFiles = await db.all('SELECT * FROM files WHERE user_id = ? AND is_shared = 0 ORDER BY uploaded_at DESC', userId);
    renderPage(req, res, 'dashboard', {
      title: 'CC网盘 - 首页',
      personalFiles,
      personalCount: personalFiles.length,
      passwordSuccess: '密码修改成功'
    });
  });

  // 仪表盘（首页）
  app.get('/dashboard', requireAuth, async (req, res) => {
    const userId = req.session.userId;

    // 当前文件夹（?folder= 参数，缺省为根目录）
    const currentFolder = await getOwnedFolder(req.query.folder, userId);
    const currentFolderId = currentFolder ? currentFolder.id : null;

    // 当前文件夹内的子文件夹（排除已移入回收站的）
    const folders = await db.all(
      'SELECT * FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name ASC',
      userId, currentFolderId
    );

    // 面包屑路径（根目录 → … → 当前文件夹）
    const folderPath = currentFolder ? await buildFolderPath(currentFolder) : [];

    // 获取用户个人文件（非团队、非共享、当前文件夹内，排除已移入回收站的）
    const personalFiles = await db.all(
      'SELECT * FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL AND folder_id IS ? AND deleted_at IS NULL ORDER BY uploaded_at DESC',
      userId, currentFolderId
    );

    // 获取用户加入的团队
    const teams = await db.all(`
      SELECT t.id, t.name, t.owner_uid, t.created_at, u.username as owner_name
      FROM team_members tm
      JOIN teams t ON tm.team_id = t.id
      JOIN users u ON t.owner_uid = u.uid
      WHERE tm.user_id = ?
      ORDER BY t.created_at ASC
    `, userId);

    // 为每个团队加载文件列表和团员列表
    for (const team of teams) {
      team.files = await db.all(`
        SELECT f.*, u.username as uploader_name
        FROM files f
        JOIN users u ON f.user_id = u.id
        WHERE f.team_id = ? AND f.deleted_at IS NULL
        ORDER BY f.uploaded_at DESC
      `, team.id);
      team.members = await db.all(`
        SELECT u.id, u.username, u.uid, tm.joined_at
        FROM team_members tm
        JOIN users u ON tm.user_id = u.id
        WHERE tm.team_id = ?
        ORDER BY tm.joined_at ASC
      `, team.id);
      team.isOwner = (team.owner_uid === res.locals.currentUser.uid);
    }

    // 获取用户文件统计（个人文件总数含所有子文件夹）
    const countRow = await db.get('SELECT COUNT(*) AS c FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL', userId);
    const personalCount = countRow ? countRow.c : 0;

    // 网盘容量使用情况
    const usage = await getUserUsage(userId);

    // ---------- 阶段一：收藏 / 标签 / 最近访问 ----------
    // 打开文件夹时记录最近访问
    if (currentFolderId) await recordRecentView(userId, 'folder', currentFolderId);

    // 收藏集合（"kind:id"）
    const starRows = await db.all('SELECT kind, target_id FROM starred WHERE user_id = ?', userId);
    const starredKeys = {};
    starRows.forEach(r => { starredKeys[r.kind + ':' + r.target_id] = 1; });

    // 收藏列表（跨目录）
    const starredItems = await db.all(`
      SELECT 'file' AS kind, f.id AS id, f.filename AS name, f.file_size AS size, f.uploaded_at AS ts
        FROM starred s JOIN files f ON f.id = s.target_id
       WHERE s.user_id = ? AND s.kind = 'file' AND f.deleted_at IS NULL AND f.team_id IS NULL AND f.is_shared = 0
      UNION ALL
      SELECT 'folder' AS kind, fo.id AS id, fo.name AS name, 0 AS size, fo.created_at AS ts
        FROM starred s JOIN folders fo ON fo.id = s.target_id
       WHERE s.user_id = ? AND s.kind = 'folder' AND fo.deleted_at IS NULL
      ORDER BY ts DESC LIMIT 200`, userId, userId);

    // 最近访问列表
    const recentItems = await db.all(`
      SELECT r.kind AS kind, r.viewed_at AS viewed_at,
             CASE WHEN r.kind = 'file' THEN f.filename ELSE fo.name END AS name,
             CASE WHEN r.kind = 'file' THEN f.file_size ELSE 0 END AS size,
             CASE WHEN r.kind = 'file' THEN f.folder_id ELSE fo.parent_id END AS folder_id
        FROM recent_views r
        LEFT JOIN files f ON r.kind = 'file' AND f.id = r.target_id
        LEFT JOIN folders fo ON r.kind = 'folder' AND fo.id = r.target_id
       WHERE r.user_id = ?
         AND ((r.kind = 'file' AND f.id IS NOT NULL AND f.deleted_at IS NULL AND f.team_id IS NULL AND f.is_shared = 0)
           OR (r.kind = 'folder' AND fo.id IS NOT NULL AND fo.deleted_at IS NULL))
       ORDER BY r.viewed_at DESC LIMIT 50`, userId);

    // 我的标签（含每个标签下的文件数）
    const myTags = await db.all(`
      SELECT t.id, t.name, t.color,
        (SELECT COUNT(*) FROM file_tags ft JOIN files f ON f.id = ft.file_id
          WHERE ft.tag_id = t.id AND f.deleted_at IS NULL) AS count
      FROM tags t WHERE t.user_id = ? ORDER BY t.name ASC`, userId);

    // 标签筛选（?tag=id）
    const activeTag = req.query.tag ? Number(req.query.tag) : 0;
    let tagFilteredFiles = personalFiles;
    if (activeTag) {
      tagFilteredFiles = await db.all(
        `SELECT f.* FROM files f JOIN file_tags ft ON ft.file_id = f.id
         WHERE f.user_id = ? AND f.is_shared = 0 AND f.team_id IS NULL AND f.folder_id IS ? AND f.deleted_at IS NULL AND ft.tag_id = ?
         ORDER BY f.uploaded_at DESC`, userId, currentFolderId, activeTag);
    }
    // 文件 → 标签集合（供前端展示/编辑）
    const tagRows = await db.all(
      `SELECT ft.file_id, ft.tag_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
       WHERE t.user_id = ?`, userId);
    const fileTags = {};
    tagRows.forEach(r => { (fileTags[r.file_id] = fileTags[r.file_id] || []).push(r.tag_id); });

    renderPage(req, res, 'dashboard', {
      title: 'CC网盘 - 首页',
      personalFiles: tagFilteredFiles,
      personalCount: personalCount,
      folders: folders,
      folderPath: folderPath,
      currentFolderId: currentFolderId,
      teams: teams,
      hasTeam: teams.length > 0,
      teamError: req.query.teamError || '',
      teamSuccess: req.query.teamSuccess || '',
      usage: usage,
      uploadError: req.query.uploadError || '',
      initialTab: req.query.tab || '',
      starredKeys: starredKeys,
      starredItems: starredItems,
      recentItems: recentItems,
      myTags: myTags,
      activeTag: activeTag,
      fileTags: fileTags
    });
  });

  // ==================== 个人文件夹 ====================
  // 校验文件夹归属（返回文件夹记录或 null）
  async function getOwnedFolder(folderId, userId) {
    if (!folderId) return null;
    const f = await db.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', Number(folderId), userId);
    return f || null;
  }

  // 构建面包屑路径（从当前文件夹向上遍历到根）
  async function buildFolderPath(folder) {
    const path = [];
    let cur = folder;
    while (cur) {
      path.unshift(cur);
      cur = cur.parent_id ? await db.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', cur.parent_id, cur.user_id) : null;
    }
    return path;
  }

  // 递归收集文件夹及其所有后代 id
  async function collectFolderIds(userId, rootId) {
    const ids = [rootId];
    const subs = await db.all('SELECT id FROM folders WHERE user_id = ? AND parent_id = ?', userId, rootId);
    for (const s of subs) {
      const childIds = await collectFolderIds(userId, s.id);
      ids.push(...childIds);
    }
    return ids;
  }

  // ==================== 回收站 / 移动 / 搜索 / 批量 / 团队密码（个人范围） ====================
  const dbNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  // 个人文件（非团队）软删除→回收站，同时撤销公开分享链接
  async function softDeletePersonalFile(fileId, userId) {
    const f = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL', Number(fileId), userId);
    if (!f) return false;
    await db.run('UPDATE files SET deleted_at = ? WHERE id = ?', dbNow(), f.id);
    await db.run('DELETE FROM share_links WHERE file_id = ?', f.id);
    return true;
  }

  // 个人文件夹整树软删除→回收站（子文件夹与文件一并标记；分享链接一并撤销）
  async function softDeletePersonalFolder(folderId, userId) {
    const folder = await getOwnedFolder(folderId, userId);
    if (!folder) return false;
    const ids = await collectFolderIds(userId, folder.id);
    const ph = ids.map(() => '?').join(',');
    const ts = dbNow();
    await db.run(`UPDATE folders SET deleted_at = ? WHERE user_id = ? AND id IN (${ph})`, ts, userId, ...ids);
    await db.run(`UPDATE files SET deleted_at = ? WHERE user_id = ? AND folder_id IN (${ph}) AND team_id IS NULL`, ts, userId, ...ids);
    await db.run(`DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE user_id = ? AND folder_id IN (${ph}) AND team_id IS NULL)`, userId, ...ids);
    // 文件夹分享链接一并撤销（阶段一新增 share_links.folder_id）
    await db.run(`DELETE FROM share_links WHERE folder_id IN (${ph})`, ...ids);
    return true;
  }

  // 物理删除文件行与存储对象（清空回收站/永久删除用）
  async function purgeFileRow(file) {
    try {
      // 秒传/版本可能共用同一存储对象：确认无人引用后再删除，避免误删他人文件
      const scope = { teamId: file.team_id, userId: file.user_id };
      if (!(await isObjectReferenced(scope, file.stored_name, file.id))) {
        await storage.deleteFileObject(file);
      }
    } catch (e) { /* 尽力删除 */ }
    // 清理版本历史中的存储对象
    try {
      const vers = await db.all('SELECT * FROM file_versions WHERE file_id = ?', file.id);
      for (const v of vers) {
        const scope = { teamId: file.team_id, userId: file.user_id };
        if (!(await isObjectReferenced(scope, v.stored_name, null))) {
          await storage.deleteFileObject(Object.assign({}, file, { stored_name: v.stored_name, policy_id: v.policy_id || file.policy_id }));
        }
      }
    } catch (e) { /* 尽力删除 */ }
    await db.run('DELETE FROM file_versions WHERE file_id = ?', file.id);
    await db.run('DELETE FROM file_tags WHERE file_id = ?', file.id);
    await db.run('DELETE FROM starred WHERE kind = ? AND target_id = ?', 'file', file.id);
    await db.run('DELETE FROM recent_views WHERE kind = ? AND target_id = ?', 'file', file.id);
    await db.run('DELETE FROM share_links WHERE file_id = ?', file.id);
    await db.run('DELETE FROM files WHERE id = ?', file.id);
  }

  app.get('/api/trash/list', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folders = await db.all('SELECT id, parent_id, name, deleted_at FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', userId);
      const files = await db.all('SELECT id, filename, file_size, folder_id, deleted_at FROM files WHERE user_id = ? AND team_id IS NULL AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', userId);
      res.json({ ok: true, folders, files });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载回收站失败: ' + err.message });
    }
  });

  app.post('/api/trash/restore', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folderIds = (req.body && req.body.folderIds) || [];
      const fileIds = (req.body && req.body.fileIds) || [];
      for (const id of folderIds) {
        const folder = await getOwnedFolder(id, userId);
        if (!folder || !folder.deleted_at) continue;
        const ids = await collectFolderIds(userId, folder.id);
        const ph = ids.map(() => '?').join(',');
        await db.run(`UPDATE folders SET deleted_at = NULL WHERE user_id = ? AND id IN (${ph})`, userId, ...ids);
        await db.run(`UPDATE files SET deleted_at = NULL WHERE user_id = ? AND folder_id IN (${ph}) AND team_id IS NULL`, userId, ...ids);
      }
      for (const id of fileIds) {
        const f = await db.get('SELECT id FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NOT NULL', Number(id), userId);
        if (f) await db.run('UPDATE files SET deleted_at = NULL WHERE id = ?', f.id);
      }
      audit(req, 'restore', '回收站', '恢复 文件夹 ' + folderIds.length + ' 个 / 文件 ' + fileIds.length + ' 个');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '恢复失败: ' + err.message });
    }
  });

  // 永久删除回收站中的指定项（物理删除 S3）
  app.post('/api/trash/purge', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folderIds = (req.body && req.body.folderIds) || [];
      const fileIds = (req.body && req.body.fileIds) || [];
      const delRows = new Set();
      for (const id of folderIds) {
        const folder = await getOwnedFolder(id, userId);
        if (!folder || !folder.deleted_at) continue;
        const ids = await collectFolderIds(userId, folder.id);
        const ph = ids.map(() => '?').join(',');
        const files = await db.all(`SELECT * FROM files WHERE user_id = ? AND folder_id IN (${ph}) AND team_id IS NULL`, userId, ...ids);
        for (const f of files) delRows.add(f.id);
        await db.run(`DELETE FROM folders WHERE user_id = ? AND id IN (${ph})`, userId, ...ids);
      }
      for (const id of fileIds) {
        const f = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NOT NULL', Number(id), userId);
        if (f) delRows.add(f.id);
      }
      for (const fid of delRows) {
        const f = await db.get('SELECT * FROM files WHERE id = ?', fid);
        if (f) await purgeFileRow(f);
      }
      audit(req, 'purge', '回收站', '彻底删除 ' + delRows.size + ' 个文件');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '删除失败: ' + err.message });
    }
  });

  app.post('/api/trash/empty', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folders = await db.all('SELECT id FROM folders WHERE user_id = ? AND deleted_at IS NOT NULL', userId);
      const ids = [];
      for (const fo of folders) {
        const all = await collectFolderIds(userId, fo.id);
        for (const i of all) ids.push(i);
      }
      let ph = ids.length ? ids.map(() => '?').join(',') : null;
      const allFiles = [];
      if (ph) {
        allFiles.push(...(await db.all(`SELECT * FROM files WHERE user_id = ? AND folder_id IN (${ph}) AND team_id IS NULL`, userId, ...ids)));
        await db.run(`DELETE FROM folders WHERE user_id = ? AND id IN (${ph})`, userId, ...ids);
      }
      allFiles.push(...(await db.all('SELECT * FROM files WHERE user_id = ? AND team_id IS NULL AND deleted_at IS NOT NULL', userId)));
      for (const f of allFiles) await purgeFileRow(f);
      audit(req, 'purge', '回收站', '清空回收站（' + allFiles.length + ' 个文件）');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '清空回收站失败: ' + err.message });
    }
  });

  // 移动文件（folderId=0/缺省 表示根目录）
  app.post('/api/file/move', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const fileId = Number((req.body || {}).id);
      const target = Number((req.body || {}).folderId || 0);
      const f = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NULL', fileId, userId);
      if (!f) return res.status(404).json({ ok: false, error: '文件不存在' });
      const tid = target > 0 ? target : null;
      if (tid) {
        const folder = await getOwnedFolder(tid, userId);
        if (!folder || folder.deleted_at) return res.status(403).json({ ok: false, error: '目标文件夹不存在' });
      }
      await db.run('UPDATE files SET folder_id = ? WHERE id = ?', tid, f.id);
      audit(req, 'move', f.filename, '移动到文件夹 #' + (tid || '根目录'));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '移动失败: ' + err.message });
    }
  });

  // 移动文件夹（含环检测）
  app.post('/api/folder/move', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folderId = Number((req.body || {}).id);
      const target = Number((req.body || {}).parentId || 0);
      const folder = await getOwnedFolder(folderId, userId);
      if (!folder) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      const tid = target > 0 ? target : null;
      if (tid) {
        const targetFolder = await getOwnedFolder(tid, userId);
        if (!targetFolder || targetFolder.deleted_at) return res.status(403).json({ ok: false, error: '目标文件夹不存在' });
        if (tid === folder.id) return res.status(400).json({ ok: false, error: '不能移动到自身' });
        // 环检测：目标不能在当前文件夹子树内
        let cur = targetFolder;
        while (cur) {
          if (cur.id === folder.id) return res.status(400).json({ ok: false, error: '不能移动到自身的子文件夹中' });
          cur = cur.parent_id ? await getOwnedFolder(cur.parent_id, userId) : null;
        }
      }
      await db.run('UPDATE folders SET parent_id = ? WHERE id = ?', tid, folder.id);
      audit(req, 'move', folder.name, '文件夹移动到 #' + (tid || '根目录'));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '移动失败: ' + err.message });
    }
  });

  // 搜索（个人文件/文件夹 + 所属团队文件；不含回收站；相关性排序）
  function searchScore(name, q) {
    const n = String(name || '').toLowerCase();
    const ql = String(q || '').toLowerCase();
    if (!ql || n.indexOf(ql) < 0) return 0;
    let s = 10;
    if (n === ql) s += 100;
    else if (n.startsWith(ql)) s += 60;
    if (n.indexOf(' ' + ql) >= 0 || n.indexOf('.' + ql) >= 0 || n.indexOf('_' + ql) >= 0) s += 15;
    return s;
  }

  app.get('/api/search', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const q = String((req.query.q || '').trim());
      if (q.length < 1) return res.status(400).json({ ok: false, error: '请输入搜索关键词' });
      const like = '%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%';
      const ESC = "ESCAPE '\\'";
      const rawFiles = await db.all(
        `SELECT id, filename, file_size, folder_id, uploaded_at FROM files
         WHERE user_id = ? AND team_id IS NULL AND deleted_at IS NULL AND filename LIKE ? ${ESC}
         ORDER BY uploaded_at DESC LIMIT 300`, userId, like);
      const rawFolders = await db.all(
        `SELECT id, parent_id, name FROM folders
         WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ${ESC} ORDER BY name LIMIT 300`, userId, like);
      const rawTeams = await db.all(
        `SELECT f.id AS fileId, f.filename, f.file_size, f.uploaded_at, t.id AS teamId, t.name AS teamName
         FROM files f JOIN team_members tm ON tm.team_id = f.team_id AND tm.user_id = ? JOIN teams t ON t.id = f.team_id
         WHERE f.deleted_at IS NULL AND f.filename LIKE ? ${ESC} ORDER BY f.uploaded_at DESC LIMIT 300`, userId, like);
      const folders = rawFolders
        .map(x => Object.assign({ score: searchScore(x.name, q) }, x))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)))
        .slice(0, 50)
        .map(x => ({ id: x.id, parent_id: x.parent_id, name: x.name, score: x.score }));
      const files = rawFiles
        .map(x => Object.assign({ score: searchScore(x.filename, q) }, x))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || String(a.filename).localeCompare(String(b.filename)))
        .slice(0, 50)
        .map(x => ({ id: x.id, filename: x.filename, file_size: x.file_size, folder_id: x.folder_id, uploaded_at: x.uploaded_at, score: x.score }));
      const teamFiles = rawTeams
        .map(x => Object.assign({ score: searchScore(x.filename, q) }, x))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || String(a.filename).localeCompare(String(b.filename)))
        .slice(0, 50)
        .map(x => ({ id: x.fileId, filename: x.filename, file_size: x.file_size, uploaded_at: x.uploaded_at, teamId: x.teamId, teamName: x.teamName, score: x.score }));
      res.json({ ok: true, q, folders, files, teamFiles });
    } catch (err) {
      res.status(500).json({ ok: false, error: '搜索失败: ' + err.message });
    }
  });

  // 搜索建议/自动完成（返回 ≤8 条：文件夹/个人文件/团队文件）
  app.get('/api/search/suggest', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const q = String((req.query.q || '').trim());
      if (q.length < 1) return res.json({ ok: true, items: [] });
      const like = '%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%';
      const ESC = "ESCAPE '\\'";
      const rows = [];
      const folders = await db.all(`SELECT id, name FROM folders WHERE user_id = ? AND deleted_at IS NULL AND name LIKE ? ${ESC} ORDER BY name LIMIT 200`, userId, like);
      for (const f of folders) rows.push({ type: 'folder', text: f.name, sub: '文件夹', score: searchScore(f.name, q) });
      const files = await db.all(`SELECT id, filename FROM files WHERE user_id = ? AND team_id IS NULL AND deleted_at IS NULL AND filename LIKE ? ${ESC} ORDER BY filename LIMIT 200`, userId, like);
      for (const f of files) rows.push({ type: 'file', text: f.filename, sub: '文件', score: searchScore(f.filename, q) });
      const teams = await db.all(`SELECT f.id AS fileId, f.filename, t.name AS teamName FROM files f JOIN team_members tm ON tm.team_id = f.team_id AND tm.user_id = ? JOIN teams t ON t.id = f.team_id WHERE f.deleted_at IS NULL AND f.filename LIKE ? ${ESC} ORDER BY f.filename LIMIT 100`, userId, like);
      for (const t of teams) rows.push({ type: 'team', text: t.filename, sub: '团队·' + t.teamName, score: searchScore(t.filename, q) });
      rows.sort((a, b) => b.score - a.score || String(a.text).localeCompare(String(b.text)));
      res.json({ ok: true, items: rows.slice(0, 8) });
    } catch (err) {
      res.status(500).json({ ok: false, error: '获取建议失败: ' + err.message });
    }
  });

  // 批量删除（多选）：个人文件/文件夹 → 回收站
  app.post('/api/batch/delete', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folderIds = (req.body && req.body.folderIds) || [];
      const fileIds = (req.body && req.body.fileIds) || [];
      let folders = 0, files = 0;
      for (const id of folderIds) if (await softDeletePersonalFolder(id, userId)) folders++;
      for (const id of fileIds) if (await softDeletePersonalFile(id, userId)) files++;
      if (folders || files) audit(req, 'delete', '批量删除', '文件夹 ' + folders + ' 个 / 文件 ' + files + ' 个（移入回收站）');
      res.json({ ok: true, folders, files });
    } catch (err) {
      res.status(500).json({ ok: false, error: '批量删除失败: ' + err.message });
    }
  });

  // 批量生成分享（仅个人文件；已存在链接直接复用）
  app.post('/api/batch/share', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!(await userCan(userId, 'can_share'))) return res.status(403).json({ ok: false, error: '当前用户组不允许创建分享' });
      const fileIds = (req.body && req.body.fileIds) || [];
      const items = [];
      for (const id of fileIds) {
        const f = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NULL', Number(id), userId);
        if (!f) continue;
        let link = await db.get('SELECT * FROM share_links WHERE file_id = ?', f.id);
        if (!link) {
          let token = crypto.randomBytes(16).toString('hex');
          let exists = await db.get('SELECT 1 FROM share_links WHERE token = ?', token);
          while (exists) {
            token = crypto.randomBytes(16).toString('hex');
            exists = await db.get('SELECT 1 FROM share_links WHERE token = ?', token);
          }
          const password = String(1000 + Math.floor(Math.random() * 9000));
          await db.run('INSERT INTO share_links (file_id, token, password, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
            f.id, token, password, userId, dbNow());
          link = { token, password };
        }
        items.push({ fileId: f.id, filename: f.filename, url: '/s/' + link.token, password: link.password || '' });
      }
      if (items.length) audit(req, 'share_create', '批量分享', '生成/复用分享链接 ' + items.length + ' 个');
      res.json({ ok: true, items });
    } catch (err) {
      res.status(500).json({ ok: false, error: '批量分享失败: ' + err.message });
    }
  });

  // 团队密码：是否需密码（公开给登录用户预检）
  app.get('/api/team/info', requireAuthApi, async (req, res) => {
    const ownerUid = String((req.query.ownerUid || '').trim().toUpperCase());
    const team = ownerUid ? await db.get('SELECT id, name, password_hash FROM teams WHERE owner_uid = ?', ownerUid) : null;
    if (!team) return res.json({ ok: true, exists: false });
    res.json({ ok: true, exists: true, teamId: team.id, name: team.name, hasPassword: !!(team.password_hash) });
  });

  // 设置/修改/清除团队密码（仅团队长）
  app.post('/api/team/password', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const teamId = Number((req.body || {}).teamId);
      const password = String((req.body || {}).password || '');
      const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
      if (!team) return res.status(404).json({ ok: false, error: '团队不存在' });
      if (team.owner_uid !== res.locals.currentUser.uid) return res.status(403).json({ ok: false, error: '只有团队长可以设置团队密码' });
      if (password === '') {
        await db.run('UPDATE teams SET password_hash = NULL WHERE id = ?', team.id);
        return res.json({ ok: true, hasPassword: false });
      }
      if (password.length < 4) return res.status(400).json({ ok: false, error: '团队密码至少4位字符' });
      await db.run('UPDATE teams SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), team.id);
      res.json({ ok: true, hasPassword: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '设置团队密码失败: ' + err.message });
    }
  });

  // 新建文件夹
  app.post('/folder/create', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const name = sanitizeFilename(String(req.body.name || '')).trim().slice(0, 60);
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    const backUrl = '/dashboard' + (parentId ? '?folder=' + parentId : '');
    try {
      if (!name) {
        return res.redirect(backUrl + (parentId ? '&' : '?') + 'uploadError=' + encodeURIComponent('文件夹名称不能为空'));
      }
      if (parentId) {
        const parent = await getOwnedFolder(parentId, userId);
        if (!parent) {
          return res.redirect('/dashboard?uploadError=' + encodeURIComponent('父文件夹不存在'));
        }
      }
      // 同级重名检查（自动追加序号）
      let finalName = name;
      const siblings = await db.all('SELECT name FROM folders WHERE user_id = ? AND parent_id IS ?', userId, parentId);
      const names = new Set(siblings.map(s => s.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(finalName + '(' + i + ')')) i++;
        finalName = finalName + '(' + i + ')';
      }
      await db.run('INSERT INTO folders (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
        userId, parentId, finalName, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
      audit(req, 'mkdir', finalName, '新建文件夹于 #' + (parentId || '根目录'));
      res.redirect(backUrl);
    } catch (err) {
      console.error('[新建文件夹失败]', err);
      res.redirect(backUrl + (parentId ? '&' : '?') + 'uploadError=' + encodeURIComponent('新建文件夹失败: ' + err.message));
    }
  });

  // 重命名文件夹
  app.post('/folder/:id/rename', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const folder = await getOwnedFolder(req.params.id, userId);
    const name = sanitizeFilename(String(req.body.name || '')).trim().slice(0, 60);
    if (!folder) return res.redirect('/dashboard');
    const backUrl = '/dashboard' + (folder.parent_id ? '?folder=' + folder.parent_id : '');
    try {
      if (!name) {
        return res.redirect(backUrl + (folder.parent_id ? '&' : '?') + 'uploadError=' + encodeURIComponent('名称不能为空'));
      }
      await db.run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', name, folder.id, userId);
      audit(req, 'rename', name, '文件夹重命名：' + folder.name + ' → ' + name);
      res.redirect(backUrl);
    } catch (err) {
      console.error('[重命名文件夹失败]', err);
      res.redirect(backUrl + (folder.parent_id ? '&' : '?') + 'uploadError=' + encodeURIComponent('重命名失败: ' + err.message));
    }
  });

  // 删除文件夹（级联删除内部所有文件与子文件夹）
  app.post('/folder/:id/delete', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const folder = await getOwnedFolder(req.params.id, userId);
    if (!folder) return res.redirect('/dashboard');
    const backUrl = '/dashboard' + (folder.parent_id ? '?folder=' + folder.parent_id : '');
    try {
      // 个人文件夹→回收站（软删除，可在回收站恢复）
      await softDeletePersonalFolder(folder.id, userId);
      audit(req, 'delete', folder.name, '删除文件夹（移入回收站）');
      res.redirect(backUrl);
    } catch (err) {
      console.error('[删除文件夹失败]', err);
      res.redirect(backUrl + (folder.parent_id ? '&' : '?') + 'uploadError=' + encodeURIComponent('删除文件夹失败: ' + err.message));
    }
  });

  // 文件重命名
  app.post('/file/:id/rename', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', Number(req.params.id), userId);
    if (!file) return res.redirect('/dashboard');
    const name = sanitizeFilename(String(req.body.name || '')).trim().slice(0, 200);
    const backUrl = '/dashboard' + (file.folder_id ? '?folder=' + file.folder_id : '');
    try {
      if (!name) {
        return res.redirect(backUrl + (file.folder_id ? '&' : '?') + 'uploadError=' + encodeURIComponent('名称不能为空'));
      }
      await db.run('UPDATE files SET filename = ? WHERE id = ? AND user_id = ?', name, file.id, userId);
      audit(req, 'rename', name, '文件重命名：' + file.filename + ' → ' + name);
      res.redirect(backUrl);
    } catch (err) {
      console.error('[重命名文件失败]', err);
      res.redirect(backUrl + (file.folder_id ? '&' : '?') + 'uploadError=' + encodeURIComponent('重命名失败: ' + err.message));
    }
  });

  // ==================== S3 直传/直下（浏览器不经服务器中转） ====================

  // 获取预签名上传 URL（浏览器直接 PUT 到 S3）
  // body: { filename, teamId, contentType }
  app.post('/upload/presign', requireAuth, express.json(), async (req, res) => {
    try {
      const { filename, teamId, contentType, size } = req.body;
      if (!filename) {
        return res.status(400).json({ error: '参数不完整' });
      }
      const userId = req.session.userId;
      if (await denyIfCannotUpload(req, res, true)) return;

      // 容量配额校验（提前拦截，避免无效直传）
      if (typeof size === 'number' && size > 0) {
        const q = await checkQuota(userId, size);
        if (!q.ok) {
          return res.status(413).json({ error: quotaErrorMsg(q.remain, q.quota) });
        }
      }

      // 生成存储文件名（与 multer 格式一致）
      const safeName = sanitizeFilename(decodeFilename(filename)).replace(/[\\/:*?"<>|]/g, '_');
      const ext = path.extname(safeName);
      const storedName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;

      let s3Key;
      let teamIdVal = null;
      if (teamId) {
        const isMember = await isTeamMember(teamId, userId);
        if (!isMember) {
          return res.status(403).json({ error: '您不是该团队成员，无权上传' });
        }
        teamIdVal = teamId;
        s3Key = s3store.teamKey(teamId, storedName);
      } else {
        s3Key = s3store.userKey(userId, storedName);
      }

      // 新上传落在「默认存储策略」上；本地磁盘策略无法浏览器直传，改为服务器中转 PUT
      const defPolicy = storage.defaultPolicy();
      const policyId = defPolicy ? Number(defPolicy.id) : null;
      if (storage.backendForPolicyId(policyId).type !== 's3') {
        const params = new URLSearchParams();
        params.set('storedName', storedName);
        params.set('policyId', String(policyId || ''));
        if (teamIdVal) params.set('teamId', String(teamIdVal));
        return res.json({ uploadUrl: '/upload/local-put?' + params.toString(), relay: true, policyId, storedName, teamId: teamIdVal });
      }

      const uploadUrl = await s3store.presignPut(s3Key, contentType || 'application/octet-stream', 3600);
      res.json({ uploadUrl, s3Key, storedName, teamId: teamIdVal, policyId });
    } catch (err) {
      console.error('[预签名失败]', err);
      res.status(500).json({ error: '获取上传地址失败: ' + err.message });
    }
  });

  // 本地磁盘策略的直传落盘中转（浏览器 PUT 到本接口，服务端流式写入本地目录）
  app.put('/upload/local-put', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (await denyIfCannotUpload(req, res, true)) return;
      const storedName = String(req.query.storedName || '');
      if (!storedName || /[\\/]|\.\./.test(storedName)) return res.status(400).json({ error: 'storedName 非法' });
      const teamId = req.query.teamId ? Number(req.query.teamId) : null;
      const policyId = req.query.policyId ? Number(req.query.policyId) : null;
      const targetPolicyId = (policyId && storage.getPolicy(policyId)) ? policyId : (storage.defaultPolicy() ? storage.defaultPolicy().id : null);
      const backend = storage.backendForPolicyId(targetPolicyId);
      const key = teamId ? s3store.teamKey(teamId, storedName) : s3store.userKey(userId, storedName);
      if (teamId && !(await isTeamMember(teamId, userId))) return res.status(403).json({ error: '您不是该团队成员，无权上传' });
      // 安全约束：key 由服务端按 userId/团队关系生成，不接受客户端传入路径，杜绝越权写入
      if (backend.type !== 'local') return res.status(400).json({ error: '当前策略不支持该上传方式' });
      await backend.putStream(key, req);
      res.json({ ok: true, storedName, policyId: targetPolicyId });
    } catch (err) {
      console.error('[本地直传失败]', err);
      if (!res.headersSent) res.status(500).json({ error: '上传失败: ' + err.message });
    }
  });

  // 直传完成后入库（浏览器 PUT 成功后调用）
  // body: { storedName, filename, size, teamId, folderId, hash }
  app.post('/upload/confirm', requireAuth, express.json(), async (req, res) => {
    try {
      const { storedName, filename, size, teamId, folderId, hash } = req.body;
      if (!storedName || !filename) {
        return res.status(400).json({ error: '参数不完整' });
      }
      if (typeof storedName !== 'string' || /[\\/]|\.\./.test(storedName)) {
        return res.status(400).json({ error: 'storedName 非法' });
      }
      const userId = req.session.userId;
      const safeName = sanitizeFilename(decodeFilename(filename));
      if (await denyIfCannotUpload(req, res, true)) return;

      // 个人上传：目标文件夹（校验归属）
      let folderIdVal = null;
      if (!teamId && folderId) {
        const folder = await getOwnedFolder(folderId, userId);
        folderIdVal = folder ? folder.id : null;
      }

      // 校验对象确实存在（按客户端回传的 policyId，缺省用默认策略）
      let s3Key, teamIdVal = null;
      if (teamId) {
        const isMember = await isTeamMember(teamId, userId);
        if (!isMember) {
          return res.status(403).json({ error: '您不是该团队成员，无权上传' });
        }
        teamIdVal = teamId;
        s3Key = s3store.teamKey(teamId, storedName);
      } else {
        s3Key = s3store.userKey(userId, storedName);
      }
      const reqPolicyId = req.body.policyId ? Number(req.body.policyId) : null;
      const targetPolicyId = (reqPolicyId && storage.getPolicy(reqPolicyId)) ? reqPolicyId
        : (storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null);
      const targetBackend = storage.backendForPolicyId(targetPolicyId);
      const head = await targetBackend.headObject(s3Key);
      if (!head.exists) {
        return res.status(404).json({ error: '文件未上传成功' });
      }
      const actualSize = size || head.size;

      // 容量配额校验（超限则删除已上传对象，避免孤儿文件）
      const q = await checkQuota(userId, actualSize);
      if (!q.ok) {
        try { await targetBackend.deleteObject(s3Key); } catch (e) {}
        return res.status(413).json({ error: quotaErrorMsg(q.remain, q.quota) });
      }

      // 入库（同名文件自动保留历史版本）
      const saved = await recordUploadedFile({
        userId, filename: safeName, storedName, fileSize: actualSize, fileHash: hash,
        folderId: folderIdVal, teamId: teamIdVal, policyId: targetPolicyId
      });
      audit(req, 'upload', safeName, '直传完成，大小 ' + formatBytes(actualSize) + (teamIdVal ? '（团队 #' + teamIdVal + '）' : ''));
      res.json({ ok: true, fileId: saved.id, versioned: saved.versioned, policyId: targetPolicyId });
    } catch (err) {
      console.error('[上传确认失败]', err);
      res.status(500).json({ error: '上传确认失败: ' + err.message });
    }
  });

  // 获取预签名下载 URL（浏览器直接 GET S3）
  // 返回 { downloadUrl }，前端可多线程 Range 直连 S3
  app.get('/download/presign/:id', requireAuth, async (req, res) => {
    try {
      const fileId = req.params.id;
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);
      if (!file) {
        return res.status(404).json({ error: '文件不存在' });
      }
      if (file.user_id !== userId) {
        return res.status(403).json({ error: '没有访问权限' });
      }
      const head = await storage.headFile(file);
      if (!head.exists) {
        return res.status(404).json({ error: '文件不存在' });
      }
      const url = await storage.presignFile(file, file.filename, 600);
      // 本地磁盘策略：无预签名地址，回退到服务器中转下载
      if (!url) return res.json({ downloadUrl: '/download/' + file.id, size: head.size, relay: true });
      res.json({ downloadUrl: url, size: head.size });
    } catch (err) {
      console.error('[下载签名失败]', err);
      res.status(500).json({ error: '获取下载地址失败: ' + err.message });
    }
  });

  // 团队文件预签名下载
  app.get('/team/:teamId/download/presign/:fileId', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const teamId = req.params.teamId;
      const fileId = req.params.fileId;
      if (!(await isTeamMember(teamId, userId))) {
        return res.status(403).json({ error: '您不是该团队成员，无权下载' });
      }
      const file = await db.get('SELECT * FROM files WHERE id = ? AND team_id = ?', fileId, teamId);
      if (!file) {
        return res.status(404).json({ error: '文件不存在' });
      }
      const head = await storage.headFile(file);
      if (!head.exists) {
        return res.status(404).json({ error: '文件不存在' });
      }
      const url = await storage.presignFile(file, file.filename, 600);
      if (!url) return res.json({ downloadUrl: '/team/' + teamId + '/download/' + file.id, size: head.size, relay: true });
      res.json({ downloadUrl: url, size: head.size });
    } catch (err) {
      console.error('[团队下载签名失败]', err);
      res.status(500).json({ error: '获取下载地址失败: ' + err.message });
    }
  });

  // 分享链接预签名下载（免登录，需密码 cookie 校验）
  app.get('/s/:token/presign', async (req, res) => {
    try {
      const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
      if (!link) {
        return res.status(404).json({ error: '链接不存在或已失效' });
      }
      if (isShareExpired(link)) {
        return res.status(410).json({ error: '分享链接已过期', expired: true });
      }
      if (link.folder_id) {
        return res.status(400).json({ error: '这是文件夹分享，请使用 /s/:token/list 获取文件列表' });
      }
      const file = await db.get('SELECT * FROM files WHERE id = ?', link.file_id);
      if (!file) {
        return res.status(404).json({ error: '文件不存在或已删除' });
      }
      if (!isShareAuthorized(req, link)) {
        return res.status(403).json({ error: '需要密码验证' });
      }
      const head = await storage.headFile(file);
      if (!head.exists) {
        return res.status(404).json({ error: '文件不存在或已删除' });
      }
      const url = await storage.presignFile(file, file.filename, 600);
      if (!url) return res.json({ downloadUrl: '/s/' + link.token, size: head.size, needPassword: false, relay: true });
      res.json({ downloadUrl: url, size: head.size, needPassword: false });
    } catch (err) {
      console.error('[分享下载签名失败]', err);
      res.status(500).json({ error: '获取下载地址失败: ' + err.message });
    }
  });

  // ==================== 原有上传路由（保留作为兼容/旧浏览器路径） ====================

  // 上传文件
  app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.redirect('/dashboard');
    }

    const userId = req.session.userId;
    const teamId = req.body.teamId || null;
    const filename = sanitizeFilename(decodeFilename(req.file.originalname));
    const storedName = req.file.filename;
    const fileSize = req.file.size;

    // 个人上传：目标文件夹（校验归属，非法则回根目录）
    let folderId = null;
    if (!teamId && req.body.folderId) {
      const folder = await getOwnedFolder(req.body.folderId, userId);
      folderId = folder ? folder.id : null;
    }
    const folderBack = folderId ? '?folder=' + folderId : '';

    try {
      // 用户组上传权限（can_upload=0 时返回 403）
      if (!(await userCan(userId, 'can_upload'))) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).type('text/plain').send('当前用户组不允许上传文件');
      }
      // 容量配额校验（超限则删除临时文件并提示）
      const q = await checkQuota(userId, fileSize);
      if (!q.ok) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.redirect('/dashboard' + folderBack + (folderBack ? '&' : '?') + 'uploadError=' + encodeURIComponent(quotaErrorMsg(q.remain, q.quota)));
      }

      // 新上传落在默认存储策略上
      const defPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      const putBackend = storage.backendForPolicyId(defPolicyId);

      // 团队上传：校验成员身份，文件传到团队目录，写入 team_id
      if (teamId) {
        const isMember = await isTeamMember(teamId, userId);
        if (!isMember) {
          try { fs.unlinkSync(req.file.path); } catch (e) {}
          return res.status(403).send('您不是该团队成员，无权上传');
        }
        await putBackend.putFile(s3store.teamKey(teamId, storedName), req.file.path);
        try { fs.unlinkSync(req.file.path); } catch (e) {}

        await recordUploadedFile({ userId, filename, storedName, fileSize, teamId, policyId: defPolicyId });
        audit(req, 'upload', filename, '团队上传，大小 ' + formatBytes(fileSize));
        return res.redirect('/dashboard');
      }

      // 个人上传
      await putBackend.putFile(s3store.userKey(userId, storedName), req.file.path);
      try { fs.unlinkSync(req.file.path); } catch (e) {}

      await recordUploadedFile({ userId, filename, storedName, fileSize, folderId, policyId: defPolicyId });
      audit(req, 'upload', filename, '个人上传，大小 ' + formatBytes(fileSize));

      res.redirect('/dashboard' + folderBack);
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      console.error('[上传失败]', err);
      res.status(500).send('上传失败: ' + err.message);
    }
  });

  // 下载文件（S3 + HTTP Range 分片下载）
  app.get('/download/:id', requireAuth, async (req, res) => {
    try {
      const fileId = req.params.id;
      const userId = req.session.userId;

      const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);

      if (!file) {
        return res.status(404).send('文件不存在');
      }

      // 检查权限：仅文件所有者可下载
      if (file.user_id !== userId) {
        return res.status(403).send('没有访问权限');
      }

      const head = await storage.headFile(file);
      if (!head.exists) {
        return res.status(404).send('文件不存在');
      }

      audit(req, 'download', file.filename, '下载（' + formatBytes(head.size) + '）');

      // S3 策略：302 到预签名 URL（浏览器直连，不占服务器带宽）
      const url = await storage.presignFile(file, file.filename, 600);
      if (url) return res.redirect(302, url);
      // 本地磁盘策略：由服务器流式回源（支持 Range）
      const r = await storage.pipeToResponse(file, req, res, { download: true, filename: file.filename });
      if (r.notFound) return res.status(404).send('文件不存在');
      return;
    } catch (err) {
      console.error('[下载失败]', err);
      if (!res.headersSent) return res.status(500).send('获取下载地址失败: ' + err.message);
    }
  });

  // 通用内联/下载回源（本地磁盘策略的预览与分享下载使用；S3 策略也可用）
  app.get('/file/:id/raw', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (file.team_id) {
        if (!(await isTeamMember(file.team_id, userId))) return res.status(403).json({ ok: false, error: '没有访问权限' });
      } else if (file.user_id !== userId) {
        return res.status(403).json({ ok: false, error: '没有访问权限' });
      }
      if (file.deleted_at) return res.status(404).json({ ok: false, error: '文件不存在' });
      const pk = previewKind(file.filename);
      const download = req.query.dl === '1';
      if (download && !file.team_id && file.user_id === userId) {
        audit(req, 'download', file.filename, '下载（服务器回源）');
      }
      const r = await storage.pipeToResponse(file, req, res, {
        download,
        filename: file.filename,
        contentType: download ? 'application/octet-stream' : (pk ? pk.mime : 'application/octet-stream')
      });
      if (r.notFound) return res.status(404).json({ ok: false, error: '文件不存在' });
      return;
    } catch (err) {
      console.error('[回源失败]', err);
      if (!res.headersSent) return res.status(500).json({ ok: false, error: '读取失败: ' + err.message });
    }
  });

  // ==================== 文件预览(内联预签名, 浏览器直读 S3；本地策略回源中转) ====================
  // 个人文件预览
  app.get('/preview/:id', requireAuth, async (req, res) => {
    try {
      const fileId = req.params.id;
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (file.user_id !== userId) return res.status(403).json({ ok: false, error: '没有访问权限' });
      // 最近访问记录（阶段一：预览文件时记录）
      if (!file.team_id && file.user_id === userId) await recordRecentView(userId, 'file', file.id);
      const pk = previewKind(file.filename);
      if (!pk) return res.json({ ok: false, unsupported: true, name: file.filename });
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).json({ ok: false, error: '文件不存在' });
      // Office 文档：现代端通过 ?office=1 获取服务端解析预览页地址；
      // 移动端/兼容版不传该参数，仍保持既有「不支持在线预览」语义（不改动其代码）
      if (pk.kind === 'office') {
        if (req.query.office !== '1') {
          return res.json({ ok: false, unsupported: true, name: file.filename, officeUrl: '/office/' + file.id });
        }
        return res.json({ ok: true, kind: 'office', name: file.filename, size: head.size, url: '/office/' + file.id, officeUrl: '/office/' + file.id, tooLarge: head.size > officedoc.MAX_OFFICE_BYTES });
      }
      const url = await storage.presignFile(file, null, 3600, pk.mime);
      return res.json({ ok: true, kind: pk.kind, name: file.filename, size: head.size, url: url || ('/file/' + file.id + '/raw') });
    } catch (err) {
      console.error('[预览失败]', err);
      return res.status(500).json({ ok: false, error: '预览失败: ' + err.message });
    }
  });

  // 团队文件预览
  app.get('/team/:teamId/preview/:fileId', requireAuth, async (req, res) => {
    try {
      const { teamId, fileId } = req.params;
      const userId = req.session.userId;
      if (!(await isTeamMember(teamId, userId))) return res.status(403).json({ ok: false, error: '您不是该团队成员' });
      const file = await db.get('SELECT * FROM files WHERE id = ? AND team_id = ?', fileId, teamId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      const pk = previewKind(file.filename);
      if (!pk) return res.json({ ok: false, unsupported: true, name: file.filename });
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (pk.kind === 'office') {
        if (req.query.office !== '1') {
          return res.json({ ok: false, unsupported: true, name: file.filename, officeUrl: '/office/' + file.id });
        }
        return res.json({ ok: true, kind: 'office', name: file.filename, size: head.size, url: '/office/' + file.id, officeUrl: '/office/' + file.id, tooLarge: head.size > officedoc.MAX_OFFICE_BYTES });
      }
      const url = await storage.presignFile(file, null, 3600, pk.mime);
      return res.json({ ok: true, kind: pk.kind, name: file.filename, size: head.size, url: url || ('/file/' + file.id + '/raw') });
    } catch (err) {
      console.error('[团队文件预览失败]', err);
      return res.status(500).json({ ok: false, error: '预览失败: ' + err.message });
    }
  });

  // ==================== 链接分享（免登录下载） ====================
  // 生成分享链接 token：256 位随机，不可猜测
  function generateShareToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // 文件大小格式化（密码页用）
  function formatFileSize(bytes) {
    if (bytes === null || bytes === undefined) return '未知大小';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  // HTML 转义（密码页用）
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 文件路径解析（个人/共享/团队），供分享校验使用（存储键，S3/本地策略通用）
  function resolveFilePath(file) {
    return s3store.resolveKey(file);
  }

  // 检查文件对象是否存在于其所属存储策略上（S3 / 本地磁盘通用）
  async function fileExistsOnS3(file) {
    if (!file) return false;
    const r = await storage.headFile(file);
    return r.exists;
  }

  // 校验当前用户是否有权管理某文件的分享链接（所有文件夹：仅上传者本人）
  async function canManageShare(file, userId) {
    if (!file) return false;
    return file.user_id === userId;
  }

  // 生成 4 位数字密码
  function generateSharePassword() {
    return String(Math.floor(1000 + Math.random() * 9000)); // 1000-9999
  }

  // 分享下载授权 cookie 名
  function shareAuthCookie(token) {
    return 'share_auth_' + token;
  }

  // 校验分享下载授权（cookie 中存 token+password 的签名）
  function isShareAuthorized(req, link) {
    if (!link || !link.password) return true; // 无密码的旧链接不拦截
    const cookieVal = req.cookies && req.cookies[shareAuthCookie(link.token)];
    if (!cookieVal) return false;
    const expected = crypto.createHash('sha256').update(link.token + ':' + link.password + ':teamcloud-share').digest('hex');
    return cookieVal === expected;
  }

  // 创建分享链接（阶段一增强：有效期 / 提取码 / 文件夹分享）
  // 兼容旧调用：仅传 fileId 时行为与旧版一致（复用已有链接、自动生成 4 位数字提取码）
  app.post('/share/create', requireAuth, express.json(), async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      if (!(await userCan(userId, 'can_share'))) return res.status(403).json({ error: '当前用户组不允许创建分享' });
      const fileId = body.fileId ? parseInt(body.fileId, 10) : 0;
      const folderId = body.folderId ? parseInt(body.folderId, 10) : 0;
      if (!fileId && !folderId) {
        return res.status(400).json({ error: '参数不完整' });
      }

      let link = null;
      if (fileId) {
        const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);
        if (!file) return res.status(404).json({ error: '文件不存在' });
        if (!(await canManageShare(file, userId))) return res.status(403).json({ error: '没有分享权限' });
        if (!(await fileExistsOnS3(file))) return res.status(404).json({ error: '文件不存在' });
        link = await db.get('SELECT * FROM share_links WHERE file_id = ? AND folder_id IS NULL', fileId);
      } else {
        const folder = await getOwnedFolder(folderId, userId);
        if (!folder || folder.deleted_at) return res.status(404).json({ error: '文件夹不存在' });
        link = await db.get('SELECT * FROM share_links WHERE folder_id = ?', folderId);
      }

      // 有效期：expireDays = 1 / 7 / 30，空或 0 表示永久
      const hasExpire = body.expireDays !== undefined && body.expireDays !== null && body.expireDays !== '';
      const expiresAt = hasExpire ? shareExpiryFromDays(body.expireDays) : null;
      const codeMode = String(body.codeMode || '').trim(); // auto | none | custom | keep
      let password;
      if (codeMode === 'none') password = '';
      else if (codeMode === 'custom') {
        password = String(body.code || '').trim().slice(0, 32);
        if (!password) return res.status(400).json({ error: '提取码不能为空' });
      } else if (codeMode === 'keep') password = link ? (link.password || '') : generateSharePassword();
      else password = generateSharePassword();

      if (!link) {
        const token = generateShareToken();
        await db.run(
          'INSERT INTO share_links (file_id, folder_id, token, password, created_by, created_at, expires_at, download_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
          fileId || 0, folderId || null, token, password, userId, dbNow(), expiresAt);
        link = await db.get('SELECT * FROM share_links WHERE token = ?', token);
      } else if (hasExpire || codeMode) {
        const newPwd = (codeMode === 'keep' || !codeMode) ? (link.password || '') : password;
        await db.run('UPDATE share_links SET expires_at = ?, password = ? WHERE id = ?',
          hasExpire ? expiresAt : (link.expires_at || null), newPwd, link.id);
        link = await db.get('SELECT * FROM share_links WHERE id = ?', link.id);
      }

      audit(req, 'share_create', link.folder_id ? ('文件夹分享 #' + link.folder_id) : ('文件分享 #' + link.file_id),
        '生成/更新分享链接 ' + ('/s/' + link.token) + (link.password ? '（含提取码）' : ''));
      res.json({
        ok: true,
        token: link.token,
        url: '/s/' + link.token,
        password: link.password || '',
        kind: link.folder_id ? 'folder' : 'file',
        expiresAt: link.expires_at || null,
        downloadCount: link.download_count || 0
      });
    } catch (err) {
      console.error('[创建分享失败]', err);
      res.status(500).json({ error: '创建分享失败: ' + err.message });
    }
  });

  // 撤销分享链接（阶段一扩展：支持文件夹分享）
  app.post('/share/revoke', requireAuth, express.json(), async (req, res) => {
    const fileId = parseInt(req.body.fileId, 10);
    const folderId = parseInt(req.body.folderId, 10);
    if (!fileId && !folderId) {
      return res.status(400).json({ error: '参数不完整' });
    }
    if (folderId) {
      const folder = await getOwnedFolder(folderId, req.session.userId);
      if (!folder) return res.status(404).json({ error: '文件夹不存在' });
      await db.run('DELETE FROM share_links WHERE folder_id = ?', folderId);
      audit(req, 'share_revoke', folder.name, '取消文件夹分享 #' + folderId);
      return res.json({ ok: true });
    }
    const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);
    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }
    if (!(await canManageShare(file, req.session.userId))) {
      return res.status(403).json({ error: '没有撤销权限' });
    }
    await db.run('DELETE FROM share_links WHERE file_id = ?', fileId);
    audit(req, 'share_revoke', file.filename, '取消文件分享 #' + fileId);
    res.json({ ok: true });
  });

  // 分享链接信息（公开，供分享页展示）：阶段一支持有效期校验与文件夹分享
  app.get('/s/:token/info', async (req, res) => {
    const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
    if (!link) {
      return res.status(404).json({ error: '链接不存在或已失效' });
    }
    if (isShareExpired(link)) {
      return res.status(410).json({ error: '分享链接已过期', expired: true });
    }
    if (link.folder_id) {
      const folder = await db.get('SELECT * FROM folders WHERE id = ?', link.folder_id);
      if (!folder || folder.deleted_at) {
        return res.status(404).json({ error: '文件夹不存在或已删除' });
      }
      return res.json({
        kind: 'folder',
        filename: folder.name,
        file_size: null,
        uploaded_at: folder.created_at,
        needPassword: !!(link.password),
        expiresAt: link.expires_at || null,
        downloadCount: link.download_count || 0,
        downloadUrl: '/s/' + link.token
      });
    }
    const file = await db.get('SELECT * FROM files WHERE id = ?', link.file_id);
    if (!file || !(await fileExistsOnS3(file))) {
      return res.status(404).json({ error: '文件不存在或已删除' });
    }
    res.json({
      kind: 'file',
      filename: file.filename,
      file_size: file.file_size,
      uploaded_at: file.uploaded_at,
      needPassword: !!(link.password),
      expiresAt: link.expires_at || null,
      downloadCount: link.download_count || 0,
      downloadUrl: '/s/' + link.token
    });
  });

  // 分享密码验证：正确则种授权 cookie
  app.post('/s/:token/verify', express.json(), async (req, res) => {
    const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
    if (!link) {
      return res.status(404).json({ error: '链接不存在或已失效' });
    }
    if (isShareExpired(link)) {
      return res.status(410).json({ error: '分享链接已过期', expired: true });
    }
    const targetInfo = await shareTarget(link);
    if (!targetInfo) {
      return res.status(404).json({ error: '内容不存在或已删除' });
    }
    if (targetInfo.kind === 'file' && !(await fileExistsOnS3(targetInfo.file))) {
      return res.status(404).json({ error: '文件不存在或已删除' });
    }
    const inputPwd = String(req.body.password || '').trim();
    if (!link.password) {
      // 无密码的旧链接：直接授权
      const expected = crypto.createHash('sha256').update(link.token + ':' + ':teamcloud-share').digest('hex');
      res.setHeader('Set-Cookie', shareAuthCookie(link.token) + '=' + expected + '; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax');
      return res.json({ ok: true });
    }
    if (inputPwd !== link.password) {
      return res.status(403).json({ error: '密码错误' });
    }
    const expected = crypto.createHash('sha256').update(link.token + ':' + link.password + ':teamcloud-share').digest('hex');
    res.setHeader('Set-Cookie', shareAuthCookie(link.token) + '=' + expected + '; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax');
    res.json({ ok: true });
  });

  // 公开下载（免登录，需密码）：/s/:token 无授权时返回密码页，已授权直接下载（支持 HTTP Range 多线程）
  app.get('/s/:token', async (req, res) => {
    const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
    if (!link) {
      return res.status(404).send('链接不存在或已失效');
    }
    // 有效期校验（阶段一新增）
    if (isShareExpired(link)) {
      return res.status(410).send(shareMessagePage('分享链接已过期', '该分享链接已超过有效期（' + link.expires_at + '），请联系分享者重新分享。', '⏰'));
    }
    // 文件夹分享（阶段一新增）
    if (link.folder_id) {
      const rootFolder = await db.get('SELECT * FROM folders WHERE id = ?', link.folder_id);
      if (!rootFolder || rootFolder.deleted_at) {
        return res.status(404).send(shareMessagePage('文件夹不存在', '该分享的文件夹已被删除。', '📁'));
      }
      if (!isShareAuthorized(req, link)) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        return res.send(shareFolderPasswordPage(link, rootFolder.name));
      }
      let folder = rootFolder;
      if (req.query.folder) {
        const fid = Number(req.query.folder);
        if (fid && fid !== rootFolder.id) {
          const sub = await db.get('SELECT * FROM folders WHERE id = ?', fid);
          let cur = sub, guard = 0, ok = false;
          while (cur && guard++ < 200) {
            if (cur.id === rootFolder.id) { ok = true; break; }
            cur = cur.parent_id ? await db.get('SELECT * FROM folders WHERE id = ?', cur.parent_id) : null;
          }
          if (!ok) return res.status(403).send(shareMessagePage('没有访问权限', '该目录不属于此分享内容。', '🔒'));
          folder = sub;
        }
      }
      return renderFolderSharePage(res, link, folder, folder.id);
    }
    const file = await db.get('SELECT * FROM files WHERE id = ?', link.file_id);
    if (!file) {
      return res.status(404).send('文件不存在或已删除');
    }
    if (!(await fileExistsOnS3(file))) {
      return res.status(404).send('文件不存在或已删除');
    }

    // 密码校验：未授权则渲染密码输入页
    if (!isShareAuthorized(req, link)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      const sizeStr = formatFileSize(file.file_size);
      return res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta name="referrer" content="no-referrer">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>输入密码 - ${escapeHtml(file.filename)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { background:#fff; border-radius:16px; padding:32px 28px; width:100%; max-width:420px; box-shadow:0 20px 60px rgba(0,0,0,0.25); }
  .icon { font-size:40px; text-align:center; margin-bottom:12px; }
  h2 { text-align:center; color:#2d3748; font-size:1.15rem; margin-bottom:6px; word-break:break-all; }
  .meta { text-align:center; color:#718096; font-size:0.85rem; margin-bottom:22px; }
  .pwd-wrap { display:flex; gap:8px; margin-bottom:10px; }
  input[type=password] { flex:1; min-width:0; padding:12px 14px; border:2px solid #cbd5e0; border-radius:10px; font-size:1.2rem; letter-spacing:6px; text-align:center; outline:none; }
  input[type=password]:focus { border-color:#667eea; }
  .btn { width:100%; padding:13px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; border:none; border-radius:10px; font-size:1rem; font-weight:600; cursor:pointer; }
  .btn:disabled { opacity:0.6; cursor:not-allowed; }
  .err { color:#e53e3e; font-size:0.85rem; text-align:center; min-height:20px; margin-bottom:8px; }
  .tip { color:#a0aec0; font-size:0.78rem; text-align:center; margin-top:14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h2>${escapeHtml(file.filename)}</h2>
    <p class="meta">${sizeStr} · 需要访问密码</p>
    <div class="err" id="errMsg"></div>
    <div class="pwd-wrap">
      <input type="password" id="pwd" inputmode="numeric" maxlength="4" placeholder="4位数字密码" autocomplete="off">
    </div>
    <button class="btn" id="submitBtn" onclick="verifyPwd()">验证并下载</button>
    <p class="tip">请输入分享者提供的 4 位数字密码</p>
  </div>
  <script>
    function verifyPwd() {
      var pwd = document.getElementById('pwd').value.trim();
      var err = document.getElementById('errMsg');
      var btn = document.getElementById('submitBtn');
      if (!pwd) { err.textContent = '请输入密码'; return; }
      btn.disabled = true; btn.textContent = '验证中...';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/s/${link.token}/verify', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) {
          window.location.href = '/s/${link.token}';
        } else {
          btn.disabled = false; btn.textContent = '验证并下载';
          try { err.textContent = JSON.parse(xhr.responseText).error || '密码错误'; }
          catch(e) { err.textContent = '验证失败，请重试'; }
        }
      };
      xhr.send(JSON.stringify({ password: pwd }));
    }
    document.getElementById('pwd').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') verifyPwd();
    });
  </script>
</body>
</html>`);
    }

    // 已授权：累加下载次数后 302 重定向到预签名 URL，浏览器直连 S3 下载（不占服务器带宽）
    await countShareDownload(link);
    const shareUrl = await storage.presignFile(file, file.filename, 600);
    if (shareUrl) return res.redirect(302, shareUrl);
    // 本地磁盘策略：服务器流式回源
    const shareR = await storage.pipeToResponse(file, req, res, { download: true, filename: file.filename });
    if (shareR.notFound) return res.status(404).send('文件不存在或已删除');
    return;
  });
  // 多线程上传 - 初始化分片上传会话
  app.post('/upload/init', requireAuth, express.json(), async (req, res) => {
    const { filename, size, chunkCount, teamId } = req.body;
    if (!filename || !size || !chunkCount) {
      return res.status(400).json({ error: '参数不完整' });
    }
    if (await denyIfCannotUpload(req, res, true)) return;
    // 团队上传需校验成员身份
    if (teamId) {
      const isMember = await isTeamMember(teamId, req.session.userId);
      if (!isMember) {
        return res.status(403).json({ error: '您不是该团队成员，无权上传' });
      }
    }
    // 容量配额校验
    const q0 = await checkQuota(req.session.userId, Number(size) || 0);
    if (!q0.ok) {
      return res.status(413).json({ error: quotaErrorMsg(q0.remain, q0.quota) });
    }
    const sessionId = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeName = sanitizeFilename(decodeFilename(filename)).replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(safeName);
    const storedName = sessionId + ext;
    const policyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
    res.json({ sessionId, storedName, chunkSize: Math.ceil(size / chunkCount), chunkCount, policyId });
  });

  // 多线程上传 - 上传单个分片（保存到临时文件）
  const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } });
  app.post('/upload/chunk', requireAuth, chunkUpload.single('chunk'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '分片数据缺失' });
    }
    const { sessionId, index } = req.body;
    if (!sessionId || index === undefined) {
      return res.status(400).json({ error: '分片参数不完整' });
    }
    // sessionId / index 会参与路径拼接，必须先校验（防目录穿越）
    if (!/^[0-9]{6,}-[0-9]{1,}$/.test(String(sessionId)) || !/^\d+$/.test(String(index))) {
      return res.status(400).json({ error: '分片参数非法' });
    }
    const tmpDir = path.join(os.tmpdir(), 'teamcloud-chunks', `user_${req.session.userId}`, sessionId);
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    // 先写临时文件再原子改名：并发/中断时不会留下半截分片被误判为「已上传」
    const finalPath = path.join(tmpDir, String(index));
    const partPath = finalPath + '.' + process.pid + '.part';
    fs.writeFileSync(partPath, req.file.buffer);
    fs.renameSync(partPath, finalPath);
    res.json({ ok: true, index });
  });

  // 多线程上传 - 合并分片并入库
  app.post('/upload/complete', requireAuth, express.json(), async (req, res) => {
    const { sessionId, storedName, filename, size, chunkCount, teamId, folderId, hash, policyId } = req.body;
    if (!sessionId || !storedName || !filename) {
      return res.status(400).json({ error: '参数不完整' });
    }
    // 防目录穿越（sessionId / storedName 会参与路径拼接）
    if (!/^[0-9]{6,}-[0-9]{1,}$/.test(String(sessionId)) || /[\\/]|\.\./.test(String(storedName))) {
      return res.status(400).json({ error: 'sessionId 或 storedName 非法' });
    }
    const completePolicyId = (policyId && storage.getPolicy(Number(policyId))) ? Number(policyId)
      : (storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null);
    const tmpDir = path.join(os.tmpdir(), 'teamcloud-chunks', `user_${req.session.userId}`, sessionId);
    const mergePath = path.join(tmpDir, '_merged');
    // 个人上传：目标文件夹（校验归属）
    let folderIdVal = null;
    if (!teamId && folderId) {
      const folder = await getOwnedFolder(folderId, req.session.userId);
      folderIdVal = folder ? folder.id : null;
    }
    let teamIdVal = null;
    if (teamId) {
      // 团队上传：校验成员身份
      const isMember = await isTeamMember(teamId, req.session.userId);
      if (!isMember) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(403).json({ error: '您不是该团队成员，无权上传' });
      }
      teamIdVal = teamId;
    }

    try {
      // 按序合并分片到临时文件
      const need = Number(chunkCount) || 0;
      const ws = fs.createWriteStream(mergePath);
      for (let i = 0; i < need; i++) {
        const chunkPath = path.join(tmpDir, String(i));
        if (!fs.existsSync(chunkPath)) {
          ws.destroy();
          try { fs.unlinkSync(mergePath); } catch (e) {}
          return res.status(400).json({ error: `缺少分片 ${i}` });
        }
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(chunkPath);
          rs.on('error', reject);
          rs.on('end', resolve);
          rs.pipe(ws, { end: false });
        });
      }
      ws.end();
      await new Promise((resolve, reject) => {
        ws.on('finish', resolve);
        ws.on('error', reject);
      });

      const actualSize = fs.statSync(mergePath).size;

      // 容量配额校验（超限则清理分片并拒绝）
      const q = await checkQuota(req.session.userId, actualSize);
      if (!q.ok) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return res.status(413).json({ error: quotaErrorMsg(q.remain, q.quota) });
      }

      // 上传合并后的文件（落在默认/指定存储策略）
      const completeBackend = storage.backendForPolicyId(completePolicyId);
      let s3Key;
      if (teamIdVal) {
        s3Key = s3store.teamKey(teamIdVal, storedName);
      } else {
        s3Key = s3store.userKey(req.session.userId, storedName);
      }
      await completeBackend.putFile(s3Key, mergePath);

      // 清理临时分片与合并文件
      fs.rmSync(tmpDir, { recursive: true, force: true });

      const safeName = sanitizeFilename(decodeFilename(filename));
      const saved = await recordUploadedFile({
        userId: req.session.userId, filename: safeName, storedName,
        fileSize: size || actualSize, fileHash: hash,
        folderId: folderIdVal, teamId: teamIdVal, policyId: completePolicyId
      });
      audit(req, 'upload', safeName, '分片上传完成，大小 ' + formatBytes(size || actualSize));
      res.json({ ok: true, fileId: saved.id, versioned: saved.versioned });
    } catch (err) {
      try { fs.unlinkSync(mergePath); } catch (e) {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
      res.status(500).json({ error: '合并失败: ' + err.message });
    }
  });

  // 删除文件
  app.post('/delete/:id', requireAuth, async (req, res) => {
    const fileId = req.params.id;
    const userId = req.session.userId;

    const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);

    if (!file) {
      return res.status(404).send('文件不存在');
    }

    if (file.team_id) {
      // 团队文件：团队成员可删除（永久删除）
      const isMember = await db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', file.team_id, userId);
      if (!isMember) {
        return res.status(403).send('没有删除权限');
      }
      try { await storage.deleteFileObject(file); } catch (e) { /* 尽力删除 */ }
      await db.run('DELETE FROM share_links WHERE file_id = ?', fileId);
      await db.run('DELETE FROM files WHERE id = ?', fileId);
      audit(req, 'delete', file.filename, '彻底删除团队文件（团队 #' + file.team_id + '）');
      return res.redirect('/dashboard');
    }

    // 个人文件：进入回收站（软删除）
    if (file.user_id !== userId) {
      return res.status(403).send('没有删除权限');
    }
    await softDeletePersonalFile(file.id, userId);
    audit(req, 'delete', file.filename, '删除文件（移入回收站）');
    res.redirect('/dashboard');
  });

  // ==================== 团队功能 ====================
  // 检查是否团队成员
  async function isTeamMember(teamId, userId) {
    const m = await db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
    return !!m;
  }

  // 创建团队
  app.post('/team/create', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('请输入团队名称'));
    }
    if (name.length > 30) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队名称不能超过30个字符'));
    }
    // 已加入团队则不能再创建/加入
    const existing = await db.all('SELECT 1 FROM team_members WHERE user_id = ?', userId);
    if (existing.length > 0) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('您已加入一个团队，请先退出后再创建新团队'));
    }
    const ownerUid = res.locals.currentUser.uid;
    const password = (req.body.password || '').trim();
    if (password && password.length < 4) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队密码至少4位字符'));
    }
    const hash = password ? bcrypt.hashSync(password, 10) : null;
    const result = await db.run('INSERT INTO teams (name, owner_uid, password_hash, created_at) VALUES (?, ?, ?, ?)', name, ownerUid, hash, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', result.lastID, userId, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    // S3 对象存储无需创建团队目录
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('团队「' + name + '」创建成功，您是团队长'));
  });

  // 加入团队（输入创建者 UID）
  app.post('/team/join', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const ownerUid = (req.body.ownerUid || '').trim().toUpperCase();
    if (!ownerUid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('请输入团队创建者的UID'));
    }
    const existing = await db.all('SELECT 1 FROM team_members WHERE user_id = ?', userId);
    if (existing.length > 0) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('您已加入一个团队，请先退出后再加入新团队'));
    }
    const team = await db.get('SELECT * FROM teams WHERE owner_uid = ?', ownerUid);
    if (!team) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('未找到该UID对应的团队，请确认UID是否正确'));
    }
    if (team.owner_uid === res.locals.currentUser.uid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('这是您自己创建的团队，无需加入'));
    }
    // 团队设了密码：必须正确
    if (team.password_hash) {
      const pwd = (req.body.password || '').trim();
      if (!pwd || !bcrypt.compareSync(pwd, team.password_hash)) {
        return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队已设置密码，请输入正确密码后才能加入'));
      }
    }
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', team.id, userId, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('成功加入团队：' + team.name));
  });

  // 防御：误发 GET 到团队上传地址时重定向回 dashboard（避免 Cannot GET）
  app.get('/team/:teamId/upload', requireAuth, (req, res) => {
    res.redirect('/dashboard');
  });

  // 团队文件上传
  app.post('/team/:teamId/upload', requireAuth, teamUpload.single('file'), async (req, res) => {
    const userId = req.session.userId;
    const teamId = req.params.teamId;
    if (!(await isTeamMember(teamId, userId))) {
      try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) {}
      return res.status(403).send('您不是该团队成员，无权上传');
    }
    if (!req.file) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('请选择要上传的文件'));
    }
    const filename = sanitizeFilename(decodeFilename(req.file.originalname));
    try {
      if (!(await userCan(userId, 'can_upload'))) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).type('text/plain').send('当前用户组不允许上传文件');
      }
      // 容量配额校验
      const q = await checkQuota(userId, req.file.size);
      if (!q.ok) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.redirect('/dashboard?uploadError=' + encodeURIComponent(quotaErrorMsg(q.remain, q.quota)));
      }
      const defPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      await storage.backendForPolicyId(defPolicyId).putFile(s3store.teamKey(teamId, req.file.filename), req.file.path);
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      await db.run('INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, team_id, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
        userId, filename, req.file.filename, req.file.size, teamId, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '), defPolicyId);
      audit(req, 'upload', filename, '团队上传（团队 #' + teamId + '），大小 ' + formatBytes(req.file.size));
      res.redirect('/dashboard');
    } catch (err) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      console.error('[团队上传失败]', err);
      res.status(500).send('上传失败: ' + err.message);
    }
  });

  // 团队文件下载（S3 + HTTP Range 分块并发下载）
  app.get('/team/:teamId/download/:fileId', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const teamId = req.params.teamId;
      const fileId = req.params.fileId;
      if (!(await isTeamMember(teamId, userId))) {
        return res.status(403).send('您不是该团队成员，无权下载');
      }
      const file = await db.get('SELECT * FROM files WHERE id = ? AND team_id = ?', fileId, teamId);
      if (!file) {
        return res.status(404).send('文件不存在');
      }
      const head = await storage.headFile(file);
      if (!head.exists) {
        return res.status(404).send('文件不存在');
      }
      audit(req, 'download', file.filename, '团队下载（团队 #' + teamId + '，' + formatBytes(head.size) + '）');

      // S3 策略：302 到预签名 URL：浏览器直连 S3 下载，流量走桶，不占服务器带宽
      const url = await storage.presignFile(file, file.filename, 600);
      if (url) return res.redirect(302, url);
      // 本地磁盘策略：服务器流式回源
      const r = await storage.pipeToResponse(file, req, res, { download: true, filename: file.filename });
      if (r.notFound) return res.status(404).send('文件不存在');
      return;
    } catch (err) {
      console.error('[团队下载失败]', err);
      if (!res.headersSent) return res.status(500).send('获取下载地址失败: ' + err.message);
    }
  });

  // 退出团队
  app.post('/team/:teamId/leave', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const teamId = req.params.teamId;
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('您已退出团队'));
  });

  // 团队长添加团员（输入目标用户UID）
  app.post('/team/:teamId/add-member', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const teamId = req.params.teamId;
    const targetUid = (req.body.targetUid || '').trim().toUpperCase();
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队不存在'));
    }
    if (team.owner_uid !== res.locals.currentUser.uid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('只有团队长可以添加团员'));
    }
    if (!targetUid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('请输入要添加的用户UID'));
    }
    const targetUser = await db.get('SELECT id, username, uid FROM users WHERE uid = ?', targetUid);
    if (!targetUser) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('未找到该UID对应的用户'));
    }
    if (targetUser.id === userId) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('不能添加自己为团员'));
    }
    const existing = await db.get('SELECT team_id FROM team_members WHERE user_id = ?', targetUser.id);
    if (existing) {
      if (String(existing.team_id) === String(teamId)) {
        return res.redirect('/dashboard?teamError=' + encodeURIComponent('该用户已是本团队成员'));
      }
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('该用户已加入其他团队，无法添加'));
    }
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', teamId, targetUser.id, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('已添加团员：' + targetUser.username));
  });

  // 团队长移除团员
  app.post('/team/:teamId/remove-member', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const teamId = req.params.teamId;
    const memberUserId = req.body.memberUserId;
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队不存在'));
    }
    if (team.owner_uid !== res.locals.currentUser.uid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('只有团队长可以移除团员'));
    }
    if (!memberUserId || String(memberUserId) === String(userId)) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('不能移除自己，请使用退出团队'));
    }
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, memberUserId);
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('已移除团员'));
  });

  // 团队长解散团队（需验证团队长账户密码）
  app.post('/team/:teamId/dissolve', requireAuth, async (req, res) => {
    const userId = req.session.userId;
    const teamId = req.params.teamId;
    const password = req.body.password || '';
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('团队不存在'));
    }
    if (team.owner_uid !== res.locals.currentUser.uid) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('只有团队长可以解散团队'));
    }
    // 验证团队长账户密码
    const owner = await db.get('SELECT password_hash FROM users WHERE id = ?', userId);
    if (!owner || !bcrypt.compareSync(password, owner.password_hash)) {
      return res.redirect('/dashboard?teamError=' + encodeURIComponent('密码错误，无法解散团队'));
    }
    // 删除团队所有文件（对象存储/本地磁盘 + DB）
    const teamFiles = await db.all('SELECT * FROM files WHERE team_id = ?', teamId);
    for (const f of teamFiles) {
      try { await storage.deleteFileObject(f); } catch (e) { /* 忽略 */ }
    }
    await db.run('DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM files WHERE team_id = ?', teamId);
    // 删除所有成员关系
    await db.run('DELETE FROM team_members WHERE team_id = ?', teamId);
    // 删除团队记录
    await db.run('DELETE FROM teams WHERE id = ?', teamId);
    res.redirect('/dashboard?teamSuccess=' + encodeURIComponent('团队「' + team.name + '」已解散'));
  });

  // ==================== 安卓原生App JSON API（/api/*）====================
  // 供安卓原生客户端调用，与网页端共用同一套数据与权限校验逻辑，网页端零影响。
  // 约定：成功 {ok:true,...}；失败 {ok:false, error}（未登录统一 401 JSON）。
  // 极验参数遵循网页端"有则验证、缺失则降级跳过"的同一语义。

  // ---------- 极验3.0 辅助 ----------
  function apiGt3Scene(req) {
    return (req.query && req.query.scene === 'register') ? 'register' : 'login';
  }

  // App 验证码弹窗调用的 api1：返回极验3.0 需要的 challenge
  app.get('/api/gt3/register', async (req, res) => {
    const scene = apiGt3Scene(req);
    if (!gt3Configured(scene)) {
      return res.json({ success: 0, error: 'GT3_NOT_CONFIGURED', message: '人机验证3.0尚未配置，请联系管理员在服务端配置验证ID' });
    }
    const captchaId = scene === 'register' ? GT3_REGISTER_CAPTCHA_ID : GT3_LOGIN_CAPTCHA_ID;
    const r = await gt3RegisterChallenge(captchaId);
    if (!r || !r.challenge) {
      console.error(`[极验GT3注册失败] scene=${scene} gt=${captchaId} upstream=`, r || 'null');
      return res.json({ success: 0, error: 'REGISTER_FAILED', message: '获取验证码失败，请检查网络后重试' });
    }
    console.log(`[极验GT3] scene=${scene} challengeLen=${r.challenge.length}`);
    res.json({ success: 1, challenge: r.challenge, gt: captchaId, new_captcha: true });
  });

  // 同源代理官方 gt.js（避免 App WebView 因第三方 CDN 网络/策略问题导致"验证组件加载失败"）
  app.get('/api/captcha/gt.js', (req, res) => {
    https.get('https://static.geetest.com/static/js/gt.0.5.0.js', (r) => {
      if (r.statusCode !== 200) {
        r.resume();
        return res.status(502).type('text/plain').send('gt.js upstream error');
      }
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      r.pipe(res);
    }).on('error', () => {
      res.status(502).type('text/plain').send('gt.js unavailable');
    });
  });

  // App 验证码弹窗页面（极简内联HTML，引GT3 web SDK；完成验证后经 JS Bridge 回传凭据）
  app.get('/api/captcha/page', (req, res) => {
    const scene = apiGt3Scene(req);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>安全验证</title>
<style>
html,body{margin:0;padding:0;background:#fff}
#wrap{padding:14px}
#tip{font-size:14px;color:#333;margin:0 0 12px;text-align:center}
#err{display:none;font-size:13px;color:#b91c1c;margin-bottom:12px;text-align:center;line-height:1.5}
#captcha{width:100%;min-height:64px}
#loading{color:#9ca3af;font-size:13px;text-align:center;padding:18px 0}
button#skip,button#retry{display:none;width:100%;height:44px;margin-top:10px;border-radius:6px;font-size:15px}
button#retry{background:#2563eb;color:#fff;border:none}
button#skip{background:#fff;border:1px solid #ccc;color:#4a5b6e}
</style>
</head>
<body>
<div id="wrap">
  <p id="tip">请完成安全验证</p>
  <p id="err"></p>
  <div id="loading" class="loading">安全组件加载中…</div>
  <div id="captcha"></div>
  <button id="retry" onclick="location.reload()">重试</button>
  <button id="skip" onclick="finish(null)">无法加载验证码，跳过并继续</button>
</div>
<script>
var SDK_URLS = [
  '/api/captcha/gt.js', // 同源代理优先（WebView 直接可加载）
  'https://static.geetest.com/static/js/gt.0.5.0.js',
  'https://static.geetest.com/static/tools/gt.js',
  'https://apiv6.geetest.com/gt.js'
];
function finish(obj){
  var p = obj || {geetest_challenge:'',geetest_validate:'',geetest_seccode:''};
  try { if (window.TeamCloudAndroid) window.TeamCloudAndroid.onCaptchaResult(JSON.stringify(p)); } catch(e){}
}
function showSkip(msg, final){
  var ld = document.getElementById('loading'); if (ld) ld.style.display = 'none';
  document.getElementById('err').style.display = 'block';
  document.getElementById('err').textContent = msg || '';
  document.getElementById('retry').style.display = 'block';
  document.getElementById('skip').style.display = 'block';
  document.getElementById('tip').textContent = '安全验证暂时不可用';
}
function hideLoading(){
  var ld = document.getElementById('loading'); if (ld) ld.style.display = 'none';
}
function startSdk(idx){
  if (idx >= SDK_URLS.length) {
    showSkip('验证组件加载失败：请检查网络后点“重试”；仍失败可点“跳过并继续”');
    return;
  }
  var s = document.createElement('script');
  s.src = SDK_URLS[idx];
  s.async = true;
  s.onload = function(){
    if (typeof initGeetest === 'function') { hideLoading(); bootCaptcha(); }
    else startSdk(idx + 1);
  };
  s.onerror = function(){ startSdk(idx + 1); };
  document.head.appendChild(s);
}
function bootCaptcha(){
  var scene = (location.search.match(/scene=(register|login)/) || [])[1] || 'login';
  var xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/gt3/register?scene=' + scene, true);
  xhr.onreadystatechange = function(){
    if (xhr.readyState !== 4) return;
    var d;
    try { d = JSON.parse(xhr.responseText); } catch(e){ showSkip('加载失败，请检查网络'); return; }
    if (!d || d.success !== 1 || !d.gt || !d.challenge) {
      showSkip(d && d.message ? d.message : '验证初始化失败');
      return;
    }
    try {
      var ready = false;
      var failedShown = false;
      var watchdog = setTimeout(function(){
        if (!ready && !failedShown) {
          failedShown = true;
          showSkip('安全组件响应超时，请检查网络后点“重试”');
        }
      }, 9000);
      function captchaFail(extra){
        if (failedShown) return;
        failedShown = true;
        clearTimeout(watchdog);
        showSkip('验证过程出错：' + (extra || '极验服务暂时不可用') +
                 '。请检查 Wi-Fi/移动数据后点“重试”，或点“跳过并继续”。');
      }
      initGeetest({
        gt: d.gt,
        challenge: d.challenge,
        offline: false,
        new_captcha: true,
        product: 'float',
        lang: 'zh-cn',
        width: '100%',
        api_server: 'apiv6.geetest.com'
      }, function(captchaObj){
        try { captchaObj.appendTo('#captcha'); } catch(e){}
        if (captchaObj.onReady) {
          captchaObj.onReady(function(){
            ready = true;
            clearTimeout(watchdog);
            hideLoading();
          });
        }
        captchaObj.onSuccess(function(){
          clearTimeout(watchdog);
          var r = captchaObj.getValidate();
          finish(r);
        });
        if (captchaObj.onError) {
          captchaObj.onError(function(err){
            captchaFail((err && String(err).length ? String(err) : '安全组件运行异常'));
          });
        }
        // 就绪后自动唤起验证（第三代 SDK float/popup 需 verify()/showCaptcha() 打开滑块）
        setTimeout(function(){
          try {
            if (ready && typeof captchaObj.verify === 'function') captchaObj.verify();
            if (ready && !window.__gtAutoShown && typeof captchaObj.showCaptcha === 'function') {
              window.__gtAutoShown = true;
              captchaObj.showCaptcha();
            }
          } catch(e){}
        }, 400);
      });
    } catch(e){ showSkip('验证组件启动失败：' + (e && e.message ? e.message : '未知错误')); }
  };
  xhr.send();
}
window.onerror = function(msg){ return false; };
function onlineCheck(){
  if (navigator.onLine === false) {
    showSkip('当前无网络，请检查 Wi-Fi 或移动数据后点“重试”');
  } else {
    startSdk(0);
  }
}
window.addEventListener('online', function(){ startSdk(0); });
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onlineCheck);
} else {
  onlineCheck();
}
</script>
</body></html>`);
  });

  // ---------- 认证 ----------
  app.post('/api/register', async (req, res) => {
    try {
      const { username, password, confirmPassword, geetest_challenge, geetest_validate, geetest_seccode } = req.body || {};
      if (!username || !password) return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
      if (password !== confirmPassword) return res.status(400).json({ ok: false, error: '两次输入的密码不一致' });
      if (username.length < 3) return res.status(400).json({ ok: false, error: '用户名至少3个字符' });
      if (password.length < 6) return res.status(400).json({ ok: false, error: '密码至少6个字符' });

      // 人机验证3.0（注册专用验证ID；有参数则验证，缺失则按网页端降级语义跳过）
      if (geetest_challenge && geetest_validate && geetest_seccode && gt3Configured('register')) {
        const gv = await verifyGeetestV3(geetest_challenge, geetest_validate, geetest_seccode, GT3_REGISTER_CAPTCHA_ID);
        if (!gv) return res.status(400).json({ ok: false, error: '行为验证失败，请重新验证' });
      }

      const existingUser = await db.get('SELECT id FROM users WHERE username = ?', username);
      if (existingUser) return res.status(400).json({ ok: false, error: '用户名已存在' });

      const hashedPassword = bcrypt.hashSync(password, 10);
      let uid, uidExists = true;
      while (uidExists) {
        uid = crypto.randomBytes(4).toString('hex').toUpperCase();
        uidExists = await db.get('SELECT id FROM users WHERE uid = ?', uid);
      }
      await db.run('INSERT INTO users (username, password_hash, uid, nickname, created_at) VALUES (?, ?, ?, ?, ?)',
        username, hashedPassword, uid, username, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
      res.json({ ok: true });
    } catch (err) {
      console.error('[API注册失败]', err);
      res.status(500).json({ ok: false, error: '注册失败: ' + err.message });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      const { username, password, rememberMe, agree, geetest_challenge, geetest_validate, geetest_seccode } = req.body || {};
      if (!username || !password) return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
      if (agree !== true && agree !== 'true') return res.status(400).json({ ok: false, error: '请先阅读并同意用户协议' });

      // 人机验证3.0（登录专用验证ID；有参数则验证，缺失则按网页端降级语义跳过）
      if (geetest_challenge && geetest_validate && geetest_seccode && gt3Configured('login')) {
        const gv = await verifyGeetestV3(geetest_challenge, geetest_validate, geetest_seccode, GT3_LOGIN_CAPTCHA_ID);
        if (!gv) return res.status(400).json({ ok: false, error: '行为验证失败，请重新验证' });
      }

      const user = await db.get('SELECT * FROM users WHERE username = ?', username);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        audit(req, 'login_fail', username, 'App 端登录：用户名或密码错误', { userId: user ? user.id : null, username: user ? user.username : username });
        return res.status(400).json({ ok: false, error: '用户名或密码错误' });
      }
      if (user.banned) {
        audit(req, 'login_fail', username, 'App 端登录：账户已被封禁', { userId: user.id, username: user.username });
        return res.status(403).json({ ok: false, error: '该账户已被封禁，请联系管理员' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      if (rememberMe === true || rememberMe === 'true') {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30天（长久登录，滚动续期）
      } else {
        req.session.cookie.maxAge = null;
      }
      audit(req, 'login_success', user.username, 'App 端登录', { userId: user.id, username: user.username });
      res.json({ ok: true, uid: user.uid, username: user.username });
    } catch (err) {
      console.error('[API登录失败]', err);
      res.status(500).json({ ok: false, error: '登录失败: ' + err.message });
    }
  });

  // 校验内部密钥：环境变量 INTERNAL_API_KEY 或管理员动态生成的 api_keys 表密钥任一有效即可
  async function isValidApiKey(key) {
    if (!key) return false;
    if (INTERNAL_API_KEY && key === INTERNAL_API_KEY) return true;
    const row = await db.get('SELECT id FROM api_keys WHERE api_key = ?', key);
    return !!row;
  }

  // 内部接口：免极验验证登录（供自动化脚本/运维使用）
  // 需通过请求头 X-Api-Key 或请求体 apiKey 携带有效密钥：环境变量 INTERNAL_API_KEY 或管理员生成并激活的密钥。
  // 成功后会建立与正常登录相同的 session，可用返回的 cookie 继续访问 /api/* 与网页端。
  app.post('/api/login/no-captcha', async (req, res) => {
    try {
      const { username, password, rememberMe, agree, apiKey } = req.body || {};
      const key = apiKey || req.headers['x-api-key'];
      if (!(await isValidApiKey(key))) {
        return res.status(401).json({ ok: false, error: '内部密钥无效' });
      }
      if (!username || !password) return res.status(400).json({ ok: false, error: '用户名和密码不能为空' });
      if (agree !== true && agree !== 'true') return res.status(400).json({ ok: false, error: '请先阅读并同意用户协议' });

      const user = await db.get('SELECT * FROM users WHERE username = ?', username);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        audit(req, 'login_fail', username, '免验证登录：用户名或密码错误', { userId: user ? user.id : null, username: user ? user.username : username });
        return res.status(400).json({ ok: false, error: '用户名或密码错误' });
      }
      if (user.banned) {
        audit(req, 'login_fail', username, '免验证登录：账户已被封禁', { userId: user.id, username: user.username });
        return res.status(403).json({ ok: false, error: '该账户已被封禁，请联系管理员' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      if (rememberMe === true || rememberMe === 'true') {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30天（长久登录，滚动续期）
      } else {
        req.session.cookie.maxAge = null;
      }
      audit(req, 'login_success', user.username, '免验证登录（API 密钥）', { userId: user.id, username: user.username });
      res.json({ ok: true, uid: user.uid, username: user.username });
    } catch (err) {
      console.error('[免验证登录失败]', err);
      res.status(500).json({ ok: false, error: '登录失败: ' + err.message });
    }
  });

  app.post('/api/logout', (req, res) => {
    if (req.session.userId) audit(req, 'logout', req.session.username || '', 'App 端登出');
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/api/me', requireAuthApi, async (req, res) => {
    const user = await db.get('SELECT id, username, uid, nickname, avatar FROM users WHERE id = ?', req.session.userId);
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
    const usage = await getUserUsage(user.id);
    res.json({ ok: true, uid: user.uid, username: user.username, nickname: user.nickname || user.username, avatar: user.avatar || '', used: usage.used, quota: usage.quota });
  });

  // ==================== 管理后台 API（仅管理员） ====================

  // 用户列表（含所属用户组）
  app.get('/api/admin/users', requireAdminApi, async (req, res) => {
    try {
      const users = await db.all(
        `SELECT u.id, u.username, u.uid, u.nickname, u.role, u.banned, u.created_at, u.group_id,
                g.name AS group_name
           FROM users u LEFT JOIN user_groups g ON g.id = u.group_id
          ORDER BY u.id ASC`);
      res.json({ ok: true, users });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载用户失败: ' + err.message });
    }
  });

  // 设置用户所属用户组（POST /api/admin/users/:id/group  { groupId }）
  app.post('/api/admin/users/:id/group', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const groupId = Number((req.body || {}).groupId);
      if (!id) return res.status(400).json({ ok: false, error: '无效的用户ID' });
      const target = await db.get('SELECT id, username FROM users WHERE id = ?', id);
      if (!target) return res.status(404).json({ ok: false, error: '用户不存在' });
      const group = await db.get('SELECT id, name FROM user_groups WHERE id = ?', groupId);
      if (!group) return res.status(404).json({ ok: false, error: '用户组不存在' });
      await db.run('UPDATE users SET group_id = ? WHERE id = ?', groupId, id);
      audit(req, 'group_assign', target.username, '设置用户组为「' + group.name + '」');
      res.json({ ok: true, groupId, groupName: group.name });
    } catch (err) {
      res.status(500).json({ ok: false, error: '设置用户组失败: ' + err.message });
    }
  });

  // 用户组列表
  app.get('/api/admin/groups', requireAdminApi, async (req, res) => {
    try {
      const groups = await db.all(`
        SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id = g.id) AS user_count
          FROM user_groups g ORDER BY g.id ASC`);
      res.json({ ok: true, groups });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载用户组失败: ' + err.message });
    }
  });

  // 新增用户组
  app.post('/api/admin/groups', requireAdminApi, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ ok: false, error: '用户组名称不能为空' });
      const dup = await db.get('SELECT id FROM user_groups WHERE name = ?', name);
      if (dup) return res.status(400).json({ ok: false, error: '用户组名称已存在' });
      const maxBytes = Math.max(0, Number(b.maxStorageBytes) || 0);
      const r = await db.run(
        'INSERT INTO user_groups (name, description, max_storage_bytes, can_upload, can_share, can_use_webdav, can_use_api, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        name, String(b.description || '').slice(0, 200), maxBytes,
        b.canUpload ? 1 : 0, b.canShare ? 1 : 0, b.canUseWebdav ? 1 : 0, b.canUseApi ? 1 : 0, nowStr());
      audit(req, 'group_create', name, '新增用户组 #' + r.lastID);
      res.json({ ok: true, id: r.lastID });
    } catch (err) {
      res.status(500).json({ ok: false, error: '新增用户组失败: ' + err.message });
    }
  });

  // 编辑用户组
  app.put('/api/admin/groups/:id', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const g = await db.get('SELECT * FROM user_groups WHERE id = ?', id);
      if (!g) return res.status(404).json({ ok: false, error: '用户组不存在' });
      const name = String(b.name || '').trim().slice(0, 40) || g.name;
      const dup = await db.get('SELECT id FROM user_groups WHERE name = ? AND id <> ?', name, id);
      if (dup) return res.status(400).json({ ok: false, error: '用户组名称已存在' });
      const maxBytes = Math.max(0, Number(b.maxStorageBytes) || 0);
      await db.run(
        'UPDATE user_groups SET name = ?, description = ?, max_storage_bytes = ?, can_upload = ?, can_share = ?, can_use_webdav = ?, can_use_api = ? WHERE id = ?',
        name, String(b.description || '').slice(0, 200), maxBytes,
        b.canUpload ? 1 : 0, b.canShare ? 1 : 0, b.canUseWebdav ? 1 : 0, b.canUseApi ? 1 : 0, id);
      audit(req, 'group_update', name, '编辑用户组 #' + id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '编辑用户组失败: ' + err.message });
    }
  });

  // 删除用户组（仍有用户使用时拒绝）
  app.delete('/api/admin/groups/:id', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const g = await db.get('SELECT * FROM user_groups WHERE id = ?', id);
      if (!g) return res.status(404).json({ ok: false, error: '用户组不存在' });
      const used = await db.get('SELECT COUNT(*) AS c FROM users WHERE group_id = ?', id);
      if (used && used.c > 0) return res.status(400).json({ ok: false, error: '该用户组下仍有 ' + used.c + ' 个用户，无法删除' });
      const total = await db.get('SELECT COUNT(*) AS c FROM user_groups');
      if (total && total.c <= 1) return res.status(400).json({ ok: false, error: '至少保留一个用户组' });
      await db.run('DELETE FROM user_groups WHERE id = ?', id);
      audit(req, 'group_delete', g.name, '删除用户组 #' + id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '删除用户组失败: ' + err.message });
    }
  });

  // 封禁 / 解封用户（POST /api/admin/users/:id/ban  { banned: 1|0 }）
  app.post('/api/admin/users/:id/ban', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const banned = req.body.banned ? 1 : 0;
      if (!id) return res.status(400).json({ ok: false, error: '无效的用户ID' });
      const target = await db.get('SELECT role, username FROM users WHERE id = ?', id);
      if (!target) return res.status(404).json({ ok: false, error: '用户不存在' });
      if (target.role === 'admin') return res.status(403).json({ ok: false, error: '不能封禁管理员账户' });
      await db.run('UPDATE users SET banned = ? WHERE id = ?', banned, id);
      audit(req, banned ? 'user_ban' : 'user_unban', target.username, banned ? '封禁用户' : '解封用户');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '操作失败: ' + err.message });
    }
  });

  // 删除用户（DELETE /api/admin/users/:id）
  app.delete('/api/admin/users/:id', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: '无效的用户ID' });
      if (id === req.session.userId) return res.status(400).json({ ok: false, error: '不能删除自己' });
      const target = await db.get('SELECT role, username FROM users WHERE id = ?', id);
      if (!target) return res.status(404).json({ ok: false, error: '用户不存在' });
      if (target.role === 'admin') return res.status(403).json({ ok: false, error: '不能删除管理员账户' });
      await db.run('DELETE FROM users WHERE id = ?', id);
      audit(req, 'user_delete', target.username, '删除用户 #' + id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '删除失败: ' + err.message });
    }
  });

  // API 密钥列表
  app.get('/api/admin/apikeys', requireAdminApi, async (req, res) => {
    try {
      const rows = await db.all(`
        SELECT k.id, k.api_key, k.label, k.created_at, k.created_by, u.username AS owner_name
          FROM api_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.id ASC`);
      res.json({ ok: true, keys: rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载密钥失败: ' + err.message });
    }
  });

  // 生成 API 密钥（返回明文一次）
  app.post('/api/admin/apikeys', requireAdminApi, async (req, res) => {
    try {
      const label = (req.body && req.body.label) || '免验证登录密钥';
      const apiKey = 'tc_' + crypto.randomBytes(24).toString('hex');
      const r = await db.run('INSERT INTO api_keys (api_key, label, created_by) VALUES (?, ?, ?)', apiKey, label, req.session.userId);
      audit(req, 'apikey_create', label, '生成 API 密钥 #' + r.lastID);
      res.json({ ok: true, apiKey, id: r.lastID });
    } catch (err) {
      res.status(500).json({ ok: false, error: '生成密钥失败: ' + err.message });
    }
  });

  // 删除 API 密钥
  app.delete('/api/admin/apikeys/:id', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: '无效的密钥ID' });
      const row = await db.get('SELECT label FROM api_keys WHERE id = ?', id);
      await db.run('DELETE FROM api_keys WHERE id = ?', id);
      audit(req, 'apikey_delete', row ? (row.label || ('#' + id)) : ('#' + id), '删除 API 密钥 #' + id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '删除密钥失败: ' + err.message });
    }
  });

  // ---------- 审计日志列表（分页 + 按用户/操作筛选） ----------
  app.get('/api/admin/audit', requireAdminApi, async (req, res) => {
    try {
      const pageSize = 50;
      const page = Math.max(1, Number(req.query.page) || 1);
      const username = String(req.query.username || '').trim();
      const action = String(req.query.action || '').trim();
      const where = [];
      const params = [];
      if (username) { where.push('username LIKE ?'); params.push('%' + username + '%'); }
      if (action) { where.push('action = ?'); params.push(action); }
      const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
      const totalRow = await db.get(`SELECT COUNT(*) AS c FROM audit_logs ${whereSql}`, ...params);
      const total = totalRow ? Number(totalRow.c) : 0;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const logs = await db.all(
        `SELECT id, user_id, username, action, target, detail, ip, ua, created_at
           FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        ...params, pageSize, (safePage - 1) * pageSize);
      const actionRows = await db.all('SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC LIMIT 60');
      res.json({ ok: true, logs, total, page: safePage, pages, pageSize, actions: actionRows });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载审计日志失败: ' + err.message });
    }
  });

  // ---------- 存储策略 ----------
  app.get('/api/admin/policies', requireAdminApi, async (req, res) => {
    try {
      await storage.loadPolicies();
      const list = storage.listPolicies().map(p => ({
        id: p.id, name: p.name, type: p.type, config: p.config,
        root: p.type === 'local' ? (storage.parseConfig(p).root || storage.LOCAL_DEFAULT_ROOT) : null,
        is_default: Number(p.is_default) === 1,
        created_at: p.created_at
      }));
      res.json({ ok: true, policies: list, defaultId: storage.defaultPolicy() ? storage.defaultPolicy().id : null });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载存储策略失败: ' + err.message });
    }
  });

  // 新增本地磁盘策略
  app.post('/api/admin/policies', requireAdminApi, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ ok: false, error: '策略名称不能为空' });
      if (b.type && b.type !== 'local') return res.status(400).json({ ok: false, error: '仅支持新增本地磁盘策略（S3 依赖环境变量配置）' });
      let root = String(b.root || '').trim();
      if (!root) root = path.join(__dirname, 'storage-local', 'policy-' + Date.now());
      root = path.resolve(root);
      // 安全：目录必须为绝对路径且可创建（失败仅告警，不影响其它策略）
      try { fs.mkdirSync(root, { recursive: true }); }
      catch (e) { return res.status(400).json({ ok: false, error: '目录无法创建：' + e.message }); }
      const r = await db.run('INSERT INTO storage_policies (name, type, config, is_default, created_at) VALUES (?, ?, ?, 0, ?)',
        name, 'local', JSON.stringify({ root }), nowStr());
      await storage.loadPolicies();
      audit(req, 'policy_create', name, '新增本地磁盘策略，目录 ' + root);
      res.json({ ok: true, id: r.lastID, root });
    } catch (err) {
      res.status(500).json({ ok: false, error: '新增存储策略失败: ' + err.message });
    }
  });

  // 切换默认策略（仅影响后续新上传）
  app.post('/api/admin/policies/:id/default', requireAdminApi, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const pol = await db.get('SELECT * FROM storage_policies WHERE id = ?', id);
      if (!pol) return res.status(404).json({ ok: false, error: '存储策略不存在' });
      if (pol.type === 'local') {
        const root = storage.parseConfig(pol).root || storage.LOCAL_DEFAULT_ROOT;
        try { fs.mkdirSync(root, { recursive: true }); }
        catch (e) { return res.status(400).json({ ok: false, error: '本地目录不可用：' + e.message }); }
      }
      await db.run('UPDATE storage_policies SET is_default = 0');
      await db.run('UPDATE storage_policies SET is_default = 1 WHERE id = ?', id);
      await storage.loadPolicies();
      audit(req, 'policy_default', pol.name, '切换默认存储策略为「' + pol.name + '」(' + pol.type + ')');
      res.json({ ok: true, defaultId: id });
    } catch (err) {
      res.status(500).json({ ok: false, error: '切换默认策略失败: ' + err.message });
    }
  });

  // 系统信息（关于）：默认策略 + 已用容量
  app.get('/api/admin/system', requireAdminApi, async (req, res) => {
    try {
      const pol = storage.defaultPolicy();
      const row = await db.get('SELECT COUNT(*) AS files, COALESCE(SUM(file_size), 0) AS used FROM files');
      const used = row ? Number(row.used) || 0 : 0;
      const ver = appVersion();
      res.json({
        ok: true,
        defaultPolicy: pol ? { id: pol.id, name: pol.name, type: pol.type, root: pol.type === 'local' ? (storage.parseConfig(pol).root || storage.LOCAL_DEFAULT_ROOT) : null } : null,
        fileCount: row ? Number(row.files) || 0 : 0,
        usedBytes: used,
        usedText: formatBytes(used),
        quotaText: formatBytes(QUOTA_BYTES),
        s3Configured: !!(process.env.TEAMCLOUD_S3_ACCESS_KEY && process.env.TEAMCLOUD_S3_SECRET_KEY),
        version: ver,
        webdavPath: '/dav'
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载系统信息失败: ' + err.message });
    }
  });

  // ---------- 网盘数据 ----------
  app.get('/api/list', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const currentFolder = await getOwnedFolder(req.query.folderId, userId);
      const currentFolderId = currentFolder ? currentFolder.id : null;
      const folders = await db.all('SELECT id, parent_id, name, created_at FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name ASC', userId, currentFolderId);
      const folderPath = currentFolder ? await buildFolderPath(currentFolder) : [];
      const files = await db.all('SELECT id, filename, file_size, is_shared, folder_id, uploaded_at FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL AND folder_id IS ? AND deleted_at IS NULL ORDER BY uploaded_at DESC', userId, currentFolderId);
      const teams = await db.all('SELECT t.id, t.name, t.owner_uid, t.created_at, u.username as owner_name, (CASE WHEN t.password_hash IS NULL THEN 0 ELSE 1 END) AS has_password FROM team_members tm JOIN teams t ON tm.team_id = t.id JOIN users u ON t.owner_uid = u.uid WHERE tm.user_id = ? ORDER BY t.created_at ASC', userId);
      for (const team of teams) {
        team.hasPassword = !!team.has_password;
        delete team.has_password;
        team.files = await db.all('SELECT f.id, f.filename, f.file_size, f.uploaded_at, u.username as uploader_name FROM files f JOIN users u ON f.user_id = u.id WHERE f.team_id = ? AND f.deleted_at IS NULL ORDER BY f.uploaded_at DESC', team.id);
        team.members = await db.all('SELECT u.id, u.username, u.uid, tm.joined_at FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = ? ORDER BY tm.joined_at ASC', team.id);
        team.isOwner = team.owner_uid === res.locals.currentUser.uid;
      }
      const countRow = await db.get('SELECT COUNT(*) AS c FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL AND deleted_at IS NULL', userId);
      const usage = await getUserUsage(userId);
      res.json({
        ok: true,
        currentFolderId,
        folders,
        files,
        folderPath: folderPath.map(f => ({ id: f.id, name: f.name })),
        usage,
        personalCount: countRow ? countRow.c : 0,
        teams
      });
    } catch (err) {
      console.error('[API列表失败]', err);
      res.status(500).json({ ok: false, error: '加载失败: ' + err.message });
    }
  });

  // ---------- 文件夹操作 ----------
  app.post('/api/folder/create', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const name = sanitizeFilename(String((req.body || {}).name || '')).trim().slice(0, 60);
      const parentId = (req.body || {}).parentId ? Number(req.body.parentId) : null;
      if (!name) return res.status(400).json({ ok: false, error: '文件夹名称不能为空' });
      if (parentId) {
        const parent = await getOwnedFolder(parentId, userId);
        if (!parent) return res.status(403).json({ ok: false, error: '父文件夹不存在' });
      }
      let finalName = name;
      const siblings = await db.all('SELECT name FROM folders WHERE user_id = ? AND parent_id IS ?', userId, parentId);
      const names = new Set(siblings.map(s => s.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(finalName + '(' + i + ')')) i++;
        finalName = finalName + '(' + i + ')';
      }
      const r = await db.run('INSERT INTO folders (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)',
        userId, parentId, finalName, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
      audit(req, 'mkdir', finalName, '新建文件夹于 #' + (parentId || '根目录'));
      res.json({ ok: true, id: r.lastID, name: finalName });
    } catch (err) {
      console.error('[API新建文件夹失败]', err);
      res.status(500).json({ ok: false, error: '新建文件夹失败: ' + err.message });
    }
  });

  app.post('/api/folder/rename', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folder = await getOwnedFolder((req.body || {}).id, userId);
      const name = sanitizeFilename(String((req.body || {}).name || '')).trim().slice(0, 60);
      if (!folder) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      if (!name) return res.status(400).json({ ok: false, error: '名称不能为空' });
      await db.run('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?', name, folder.id, userId);
      audit(req, 'rename', name, '文件夹重命名：' + folder.name + ' → ' + name);
      res.json({ ok: true, name });
    } catch (err) {
      console.error('[API重命名文件夹失败]', err);
      res.status(500).json({ ok: false, error: '重命名失败: ' + err.message });
    }
  });

  app.post('/api/folder/delete', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const folder = await getOwnedFolder((req.body || {}).id, userId);
      if (!folder) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      // 个人文件夹→回收站（软删除）
      await softDeletePersonalFolder(folder.id, userId);
      audit(req, 'delete', folder.name, '删除文件夹（移入回收站）');
      res.json({ ok: true });
    } catch (err) {
      console.error('[API删除文件夹失败]', err);
      res.status(500).json({ ok: false, error: '删除文件夹失败: ' + err.message });
    }
  });

  // ---------- 文件操作 ----------
  app.post('/api/file/rename', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', Number((req.body || {}).id), userId);
      const name = sanitizeFilename(String((req.body || {}).name || '')).trim().slice(0, 200);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (!name) return res.status(400).json({ ok: false, error: '名称不能为空' });
      await db.run('UPDATE files SET filename = ? WHERE id = ? AND user_id = ?', name, file.id, userId);
      audit(req, 'rename', name, '文件重命名：' + file.filename + ' → ' + name);
      res.json({ ok: true, name });
    } catch (err) {
      console.error('[API重命名文件失败]', err);
      res.status(500).json({ ok: false, error: '重命名失败: ' + err.message });
    }
  });

  app.post('/api/file/delete', requireAuthApi, async (req, res) => {
    try {
      const fileId = Number((req.body || {}).id);
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', fileId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (file.team_id) {
        // 团队文件：团队成员可删除（永久删除）
        const isMember = await db.get('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', file.team_id, userId);
        if (!isMember) return res.status(403).json({ ok: false, error: '没有删除权限' });
        try { await storage.deleteFileObject(file); } catch (e) { /* 尽力删除 */ }
        await db.run('DELETE FROM share_links WHERE file_id = ?', file.id);
        await db.run('DELETE FROM files WHERE id = ?', file.id);
        audit(req, 'delete', file.filename, '彻底删除团队文件（团队 #' + file.team_id + '）');
        return res.json({ ok: true });
      }
      // 个人文件：进入回收站（软删除）
      if (file.user_id !== userId) return res.status(403).json({ ok: false, error: '没有删除权限' });
      await softDeletePersonalFile(file.id, userId);
      audit(req, 'delete', file.filename, '删除文件（移入回收站）');
      res.json({ ok: true });
    } catch (err) {
      console.error('[API删除文件失败]', err);
      res.status(500).json({ ok: false, error: '删除失败: ' + err.message });
    }
  });

  // ---------- 团队操作 ----------
  app.post('/api/team/create', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const name = String((req.body || {}).name || '').trim();
    const password = String((req.body || {}).password || '');
    if (!name) return res.status(400).json({ ok: false, error: '请输入团队名称' });
    if (name.length > 30) return res.status(400).json({ ok: false, error: '团队名称不能超过30个字符' });
    if (password.length > 0 && password.length < 4) return res.status(400).json({ ok: false, error: '团队密码至少4位字符' });
    const existing = await db.all('SELECT 1 FROM team_members WHERE user_id = ?', userId);
    if (existing.length > 0) return res.status(400).json({ ok: false, error: '您已加入一个团队，请先退出后再创建新团队' });
    const ownerUid = res.locals.currentUser.uid;
    const hash = password.length > 0 ? bcrypt.hashSync(password, 10) : null;
    const result = await db.run('INSERT INTO teams (name, owner_uid, password_hash, created_at) VALUES (?, ?, ?, ?)', name, ownerUid, hash, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', result.lastID, userId, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    res.json({ ok: true, teamId: result.lastID, name, hasPassword: !!hash });
  });

  app.post('/api/team/join', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const ownerUid = String((req.body || {}).ownerUid || '').trim().toUpperCase();
    if (!ownerUid) return res.status(400).json({ ok: false, error: '请输入团队创建者的UID' });
    const existing = await db.all('SELECT 1 FROM team_members WHERE user_id = ?', userId);
    if (existing.length > 0) return res.status(400).json({ ok: false, error: '您已加入一个团队，请先退出后再加入新团队' });
    const team = await db.get('SELECT * FROM teams WHERE owner_uid = ?', ownerUid);
    if (!team) return res.status(400).json({ ok: false, error: '未找到该UID对应的团队，请确认UID是否正确' });
    if (team.owner_uid === res.locals.currentUser.uid) return res.status(400).json({ ok: false, error: '这是您自己创建的团队，无需加入' });
    // 团队设了密码：必须正确
    if (team.password_hash) {
      const pwd = String((req.body || {}).password || '');
      if (!pwd || !bcrypt.compareSync(pwd, team.password_hash)) {
        return res.status(400).json({ ok: false, needPassword: true, error: '团队已设置密码，请输入正确密码后才能加入' });
      }
    }
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', team.id, userId, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    res.json({ ok: true, teamId: team.id, name: team.name });
  });

  app.post('/api/team/leave', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const teamId = Number((req.body || {}).teamId);
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, userId);
    res.json({ ok: true });
  });

  app.post('/api/team/add-member', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const teamId = Number((req.body || {}).teamId);
    const targetUid = String((req.body || {}).targetUid || '').trim().toUpperCase();
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) return res.status(404).json({ ok: false, error: '团队不存在' });
    if (team.owner_uid !== res.locals.currentUser.uid) return res.status(403).json({ ok: false, error: '只有团队长可以添加团员' });
    if (!targetUid) return res.status(400).json({ ok: false, error: '请输入要添加的用户UID' });
    const targetUser = await db.get('SELECT id, username, uid FROM users WHERE uid = ?', targetUid);
    if (!targetUser) return res.status(400).json({ ok: false, error: '未找到该UID对应的用户' });
    if (targetUser.id === userId) return res.status(400).json({ ok: false, error: '不能添加自己为团员' });
    const existing = await db.get('SELECT team_id FROM team_members WHERE user_id = ?', targetUser.id);
    if (existing) {
      if (String(existing.team_id) === String(teamId)) return res.status(400).json({ ok: false, error: '该用户已是本团队成员' });
      return res.status(400).json({ ok: false, error: '该用户已加入其他团队，无法添加' });
    }
    await db.run('INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)', teamId, targetUser.id, new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '));
    res.json({ ok: true });
  });

  app.post('/api/team/remove-member', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const teamId = Number((req.body || {}).teamId);
    const memberUserId = Number((req.body || {}).memberUserId);
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) return res.status(404).json({ ok: false, error: '团队不存在' });
    if (team.owner_uid !== res.locals.currentUser.uid) return res.status(403).json({ ok: false, error: '只有团队长可以移除团员' });
    if (!memberUserId || memberUserId === userId) return res.status(400).json({ ok: false, error: '不能移除自己，请使用退出团队' });
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, memberUserId);
    res.json({ ok: true });
  });

  app.post('/api/team/dissolve', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const teamId = Number((req.body || {}).teamId);
    const password = String((req.body || {}).password || '');
    const team = await db.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) return res.status(404).json({ ok: false, error: '团队不存在' });
    if (team.owner_uid !== res.locals.currentUser.uid) return res.status(403).json({ ok: false, error: '只有团队长可以解散团队' });
    const owner = await db.get('SELECT password_hash FROM users WHERE id = ?', userId);
    if (!owner || !bcrypt.compareSync(password, owner.password_hash)) return res.status(400).json({ ok: false, error: '密码错误，无法解散团队' });
    const teamFiles = await db.all('SELECT * FROM files WHERE team_id = ?', teamId);
    for (const f of teamFiles) {
      try { await storage.deleteFileObject(f); } catch (e) { /* 忽略 */ }
    }
    await db.run('DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE team_id = ?)', teamId);
    await db.run('DELETE FROM files WHERE team_id = ?', teamId);
    await db.run('DELETE FROM team_members WHERE team_id = ?', teamId);
    await db.run('DELETE FROM teams WHERE id = ?', teamId);
    res.json({ ok: true });
  });

  // ---------- 账户操作 ----------
  app.post('/api/account/password', requireAuthApi, async (req, res) => {
    const userId = req.session.userId;
    const { oldPassword, newPassword, confirmPassword } = req.body || {};
    const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
    if (!bcrypt.compareSync(oldPassword || '', user.password_hash)) return res.status(400).json({ ok: false, error: '原密码错误' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ ok: false, error: '新密码至少需要6位字符' });
    if (newPassword !== confirmPassword) return res.status(400).json({ ok: false, error: '两次输入的新密码不一致' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(newPassword, 10), userId);
    audit(req, 'password_change', user.username, 'App 端修改登录密码');
    res.json({ ok: true });
  });

  app.post('/api/account/delete', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const { password } = req.body || {};
      const user = await db.get('SELECT * FROM users WHERE id = ?', userId);
      if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
      if (!bcrypt.compareSync(password || '', user.password_hash)) return res.status(400).json({ ok: false, error: '密码错误，无法注销账户' });
      const userFiles = await db.all('SELECT * FROM files WHERE user_id = ?', userId);
      for (const f of userFiles) {
        try { await storage.deleteFileObject(f); } catch (e) { /* 忽略 */ }
      }
      await db.run('DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', userId);
      await db.run('DELETE FROM share_links WHERE created_by = ?', userId);
      await db.run('DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', userId);
      await db.run('DELETE FROM file_tags WHERE file_id IN (SELECT id FROM files WHERE user_id = ?)', userId);
      await db.run('DELETE FROM starred WHERE user_id = ?', userId);
      await db.run('DELETE FROM recent_views WHERE user_id = ?', userId);
      await db.run('DELETE FROM file_tags WHERE tag_id IN (SELECT id FROM tags WHERE user_id = ?)', userId);
      await db.run('DELETE FROM tags WHERE user_id = ?', userId);
      await db.run('DELETE FROM files WHERE user_id = ?', userId);
      await db.run('DELETE FROM folders WHERE user_id = ?', userId);
      if (user.avatar) { try { await s3store.deleteObject(avatarKey(user.uid, user.avatar)); } catch (e) {} }
      await db.run('DELETE FROM users WHERE id = ?', userId);
      audit(req, 'account_delete', user.username, 'App 端注销账户', { userId: userId, username: user.username });
      req.session.destroy(() => res.json({ ok: true }));
    } catch (err) {
      console.error('[API注销失败]', err);
      res.status(500).json({ ok: false, error: '注销失败: ' + err.message });
    }
  });

  // ==================== 低版本安卓中转：上传 / 下载（经服务器 HTTPS 访问 S3，绕开旧设备对存储域证书的不兼容） ====================

  // 中转上传：multipart 字段 file + 可选 folderId（个人文件，逻辑与直传确认一致）
  app.post('/api/upload/relay', requireAuthApi, upload.single('file'), async (req, res) => {
    const userId = req.session.userId;
    const cleanup = () => { if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (e) {} } };
    try {
      if (!(await userCan(userId, 'can_upload'))) { cleanup(); return res.status(403).json({ ok: false, error: '当前用户组不允许上传文件' }); }
      const folderId = (req.body && req.body.folderId) ? Number(req.body.folderId) : null;
      if (folderId) {
        const folder = await getOwnedFolder(folderId, userId);
        if (!folder || folder.deleted_at) { cleanup(); return res.status(403).json({ ok: false, error: '目标文件夹不存在' }); }
      }
      if (!req.file) return res.status(400).json({ ok: false, error: '未选择文件' });
      const filename = sanitizeFilename(decodeFilename(req.file.originalname));
      const q = await checkQuota(userId, req.file.size);
      if (!q.ok) { cleanup(); return res.status(400).json({ ok: false, error: quotaErrorMsg(q.remain, q.quota) }); }
      const defPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      try {
        await storage.backendForPolicyId(defPolicyId).putFile(s3store.userKey(userId, req.file.filename), req.file.path);
      } finally { cleanup(); }
      await recordUploadedFile({ userId, filename, storedName: req.file.filename, fileSize: req.file.size, folderId, policyId: defPolicyId });
      audit(req, 'upload', filename, 'App 中转上传，大小 ' + formatBytes(req.file.size));
      res.json({ ok: true });
    } catch (err) {
      cleanup();
      console.error('[中转上传失败]', err);
      res.status(500).json({ ok: false, error: '上传失败: ' + err.message });
    }
  });

  // 中转下载（个人文件，须本人）
  app.get('/api/download/proxy/:id', requireAuthApi, async (req, res) => {
    try {
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL', Number(req.params.id), req.session.userId);
      if (!file || file.deleted_at) { res.status(404).type('text/plain').send(''); return; }
      const obj = await storage.getFileObject(file);
      if (obj.notFound || !obj.stream) { res.status(404).type('text/plain').send(''); return; }
      audit(req, 'download', file.filename, 'App 中转下载');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename || 'download'));
      if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
      obj.stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) { try { res.status(500).type('text/plain').send(''); } catch (e) {} }
    }
  });

  // 中转下载（团队文件，须成员）
  app.get('/api/team/:teamId/download/proxy/:fileId', requireAuthApi, async (req, res) => {
    try {
      const teamId = Number(req.params.teamId);
      if (!(await isTeamMember(teamId, req.session.userId))) { res.status(403).type('text/plain').send(''); return; }
      const file = await db.get('SELECT * FROM files WHERE id = ? AND team_id = ?', Number(req.params.fileId), teamId);
      if (!file || file.deleted_at) { res.status(404).type('text/plain').send(''); return; }
      const obj = await storage.getFileObject(file);
      if (obj.notFound || !obj.stream) { res.status(404).type('text/plain').send(''); return; }
      audit(req, 'download', file.filename, 'App 团队中转下载（团队 #' + teamId + '）');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename || 'download'));
      if (obj.contentLength) res.setHeader('Content-Length', obj.contentLength);
      obj.stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) { try { res.status(500).type('text/plain').send(''); } catch (e) {} }
    }
  });

  // ---------- 账户资料：昵称 + 头像 ----------
  // 头像对象键：wwwuser/avatars/<uid>/avatar<ext>（uid 为公开稳定标识，便于 <img>/App 直接读取）
  function avatarKey(uid, name) { return 'wwwuser/avatars/' + String(uid) + '/' + String(name); }
  function avatarMime(name) {
    const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    return map['.' + ext] || 'image/jpeg';
  }

  // 读取当前账户资料
  app.get('/api/account/profile', requireAuthApi, async (req, res) => {
    try {
      const u = await db.get('SELECT username, uid, nickname, avatar FROM users WHERE id = ?', req.session.userId);
      if (!u) return res.status(404).json({ ok: false, error: '用户不存在' });
      res.json({ ok: true, username: u.username, uid: u.uid, nickname: u.nickname || u.username, avatar: u.avatar || '' });
    } catch (err) {
      res.status(500).json({ ok: false, error: '获取资料失败: ' + err.message });
    }
  });

  // 修改昵称
  app.post('/api/account/profile', requireAuthApi, async (req, res) => {
    try {
      let nickname = sanitizeFilename(String((req.body || {}).nickname || '')).trim().slice(0, 20);
      if (!nickname) return res.status(400).json({ ok: false, error: '昵称不能为空' });
      await db.run('UPDATE users SET nickname = ? WHERE id = ?', nickname, req.session.userId);
      req.session.nickname = nickname;
      res.json({ ok: true, nickname });
    } catch (err) {
      res.status(500).json({ ok: false, error: '修改昵称失败: ' + err.message });
    }
  });

  // 上传/更换头像（服务端中转：临时文件→S3，成功后才删除旧头像）
  app.post('/api/account/avatar', requireAuthApi, avatarUpload.single('avatar'), async (req, res) => {
    const userId = req.session.userId;
    try {
      const user = await db.get('SELECT id, uid, avatar FROM users WHERE id = ?', userId);
      if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
      if (!req.file) return res.status(400).json({ ok: false, error: '未选择头像图片' });
      const mime = String(req.file.mimetype || '').toLowerCase();
      if (!mime.startsWith('image/')) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(400).json({ ok: false, error: '头像仅支持图片格式' });
      }
      const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
      const ext = extMap[mime] || '.jpg';
      const stored = 'avatar' + ext;
      const key = avatarKey(user.uid, stored);
      try {
        await s3store.putFile(key, req.file.path);
      } finally {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
      }
      if (user.avatar && user.avatar !== stored) {
        try { await s3store.deleteObject(avatarKey(user.uid, user.avatar)); } catch (e) {}
      }
      await db.run('UPDATE users SET avatar = ? WHERE id = ?', stored, userId);
      res.json({ ok: true, avatar: stored });
    } catch (err) {
      console.error('[头像上传失败]', err);
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
      res.status(500).json({ ok: false, error: '头像上传失败: ' + err.message });
    }
  });

  // 公开头像读取（uid 公开无隐私，便于网页 <img> 与聊天页共用；无头像 404）
  app.get('/avatar/:uid', async (req, res) => {
    try {
      const uid = String(req.params.uid || '').toUpperCase();
      const user = uid ? await db.get('SELECT avatar FROM users WHERE uid = ?', uid) : null;
      if (!user || !user.avatar) { res.status(404).type('text/plain').send(''); return; }
      const obj = await s3store.getObject(avatarKey(uid, user.avatar));
      if (obj.notFound || !obj.stream) { res.status(404).type('text/plain').send(''); return; }
      res.setHeader('Content-Type', avatarMime(user.avatar));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      obj.stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) { try { res.status(500).type('text/plain').send(''); } catch (e) {} }
    }
  });

  // ==================== 阶段一：文件能力增强 / 分享增强 / 个人化 ====================
  const ziplib = require('./ziplib');

  // ---------- 通用小工具 ----------
  // 生成唯一存储文件名（与既有上传链路格式保持一致）
  function makeStoredName(filename) {
    const safeName = sanitizeFilename(decodeFilename(String(filename || ''))).replace(/[\\/:*?"<>|]/g, '_');
    const ext = path.extname(safeName);
    return { safeName, storedName: Date.now() + '-' + Math.round(Math.random() * 1E9) + ext };
  }

  // 记录一次上传：同目录同名（个人/团队）→ 旧版本移入 file_versions，行内更新为新对象
  async function recordUploadedFile(opt) {
    const userId = opt.userId;
    const filename = opt.filename;
    const storedName = opt.storedName;
    const fileSize = Number(opt.fileSize) || 0;
    const fileHash = opt.fileHash ? String(opt.fileHash).toLowerCase() : null;
    const folderId = opt.folderId ? Number(opt.folderId) : null;
    const teamId = opt.teamId ? Number(opt.teamId) : null;
    const ts = dbNow();
    // 存储策略：显式传入优先，否则用当前默认策略
    const policyId = (opt.policyId && storage.getPolicy(Number(opt.policyId))) ? Number(opt.policyId)
      : (storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null);

    const existing = await db.get(
      'SELECT * FROM files WHERE user_id = ? AND filename = ? AND is_shared = 0 AND folder_id IS ? AND team_id IS ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1',
      userId, filename, folderId, teamId);
    if (!existing) {
      const r = await db.run(
        'INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, folder_id, team_id, file_hash, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
        userId, filename, storedName, fileSize, folderId, teamId, fileHash, ts, policyId);
      return { id: r.lastID, versioned: false };
    }
    await db.run(
      'INSERT INTO file_versions (file_id, stored_name, file_size, created_at, uploader_id, policy_id) VALUES (?, ?, ?, ?, ?, ?)',
      existing.id, existing.stored_name, existing.file_size, existing.uploaded_at || ts, existing.user_id, existing.policy_id || null);
    await db.run(
      'UPDATE files SET stored_name = ?, file_size = ?, file_hash = ?, uploaded_at = ?, policy_id = ? WHERE id = ?',
      storedName, fileSize, fileHash || existing.file_hash || null, ts, policyId, existing.id);
    return { id: existing.id, versioned: true };
  }

  // 某个存储对象是否仍被其它文件/版本引用（秒传共用对象、版本历史场景）
  async function isObjectReferenced(scope, storedName, exceptFileId) {
    const params = [];
    let where = 'stored_name = ?';
    params.push(storedName);
    if (scope.teamId) { where += ' AND team_id = ?'; params.push(scope.teamId); }
    else { where += ' AND user_id = ? AND is_shared = 0 AND team_id IS NULL'; params.push(scope.userId); }
    if (exceptFileId) { where += ' AND id <> ?'; params.push(exceptFileId); }
    const row = await db.get(`SELECT COUNT(*) AS c FROM files WHERE ${where}`, ...params);
    if (row && row.c > 0) return true;
    const vParams = params.slice(0, 1);
    let vWhere = 'stored_name = ?';
    if (exceptFileId) { vWhere += ' AND file_id <> ?'; vParams.push(exceptFileId); }
    const vrow = await db.get(`SELECT COUNT(*) AS c FROM file_versions WHERE ${vWhere}`, ...vParams);
    return !!(vrow && vrow.c > 0);
  }

  // ---------- 收藏 / 标签 / 最近访问 ----------
  async function isStarred(userId, kind, targetId) {
    const r = await db.get('SELECT 1 AS x FROM starred WHERE user_id = ? AND kind = ? AND target_id = ?', userId, kind, Number(targetId));
    return !!r;
  }

  async function recordRecentView(userId, kind, targetId) {
    try {
      await db.run(
        'INSERT INTO recent_views (user_id, kind, target_id, viewed_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, kind, target_id) DO UPDATE SET viewed_at = excluded.viewed_at',
        userId, kind, Number(targetId), dbNow());
    } catch (e) { /* 记录失败不影响主流程 */ }
  }

  async function getFileTagIds(fileId) {
    const rows = await db.all('SELECT tag_id FROM file_tags WHERE file_id = ?', fileId);
    return rows.map(r => r.tag_id);
  }

  // ---------- 分享增强 ----------
  // 有效期解析：支持 1/7/30 天与永久（空=永久）
  function shareExpiryFromDays(days) {
    const d = Number(days);
    if (!d || !isFinite(d) || d <= 0) return null;
    const ms = Date.now() + d * 24 * 3600 * 1000 + 8 * 3600 * 1000; // 统一用东八区字符串存储
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }

  function isShareExpired(link) {
    if (!link || !link.expires_at) return false;
    const t = new Date(String(link.expires_at).replace(' ', 'T')).getTime();
    if (isNaN(t)) return false;
    return t < Date.now();
  }

  async function countShareDownload(link) {
    try {
      await db.run('UPDATE share_links SET download_count = COALESCE(download_count, 0) + 1 WHERE id = ?', link.id);
    } catch (e) { /* 统计失败不影响下载 */ }
  }

  // 分享目标（文件或文件夹）
  async function shareTarget(link) {
    if (!link) return null;
    if (link.folder_id) {
      const folder = await db.get('SELECT * FROM folders WHERE id = ?', link.folder_id);
      return folder ? { kind: 'folder', folder } : null;
    }
    const file = await db.get('SELECT * FROM files WHERE id = ?', link.file_id);
    return file ? { kind: 'file', file } : null;
  }

  // 判断某个文件是否位于分享文件夹的子树内（用于文件夹分享的子文件下载鉴权）
  async function fileInFolderShare(file, link) {
    if (!file || !link || !link.folder_id) return false;
    if (file.team_id) return false;
    if (file.user_id !== link.created_by) return false;
    let cur = file.folder_id ? await db.get('SELECT id, parent_id, user_id FROM folders WHERE id = ?', file.folder_id) : null;
    let guard = 0;
    while (cur && guard++ < 200) {
      if (cur.id === link.folder_id) return true;
      cur = cur.parent_id ? await db.get('SELECT id, parent_id, user_id FROM folders WHERE id = ?', cur.parent_id) : null;
    }
    return false;
  }

  // 递归收集文件夹子树（仅个人文件/文件夹）
  async function collectFolderFiles(userId, rootId) {
    const folders = [];
    const files = [];
    async function walk(id) {
      const subs = await db.all('SELECT * FROM folders WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY name ASC', userId, id);
      for (const s of subs) { folders.push(s); await walk(s.id); }
      const fs2 = await db.all('SELECT * FROM files WHERE user_id = ? AND folder_id = ? AND team_id IS NULL AND is_shared = 0 AND deleted_at IS NULL ORDER BY filename ASC', userId, id);
      for (const f of fs2) files.push(f);
    }
    await walk(rootId);
    return { folders, files };
  }

  // 在指定父目录下确保存在同名子文件夹（用于解压/复制时还原目录结构）
  async function ensureSubFolder(userId, parentId, name, cache) {
    const key = (parentId || 0) + '/' + name;
    if (cache && cache.has(key)) return cache.get(key);
    const exist = await db.get('SELECT id FROM folders WHERE user_id = ? AND parent_id IS ? AND name = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', userId, parentId || null, name);
    let id;
    if (exist) {
      id = exist.id;
    } else {
      let finalName = name;
      const siblings = await db.all('SELECT name FROM folders WHERE user_id = ? AND parent_id IS ?', userId, parentId || null);
      const names = new Set(siblings.map(s => s.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(finalName + '(' + i + ')')) i++;
        finalName = finalName + '(' + i + ')';
      }
      const r = await db.run('INSERT INTO folders (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)', userId, parentId || null, finalName, dbNow());
      id = r.lastID;
      if (cache) { cache.set((parentId || 0) + '/' + finalName, id); }
    }
    if (cache) cache.set(key, id);
    return id;
  }

  // 目标目录中生成不冲突的文件名（复制场景）
  async function uniqueFileName(userId, folderId, filename) {
    const siblings = await db.all('SELECT filename FROM files WHERE user_id = ? AND folder_id IS ? AND team_id IS NULL AND is_shared = 0 AND deleted_at IS NULL', userId, folderId || null);
    const names = new Set(siblings.map(s => s.filename));
    if (!names.has(filename)) return filename;
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    let i = 2;
    while (names.has(base + '(' + i + ')' + ext)) i++;
    return base + '(' + i + ')' + ext;
  }

  // ---------- 存储随机读适配器（S3 / 本地磁盘通用，供 ZIP 解析使用，只需少量内存） ----------
  function s3Reader(file) {
    return storage.recordReader(file);
  }

  // 读取文件文本内容（上限 2MB，供在线文本预览）
  async function readFileText(file, maxBytes) {
    const limit = maxBytes || 2 * 1024 * 1024;
    const backend = storage.backendForFile(file);
    const key = s3store.resolveKey(file);
    const head = await backend.headObject(key);
    if (!head.exists) return { notFound: true };
    const len = Math.min(head.size, limit);
    const r = await backend.getObject(key, `bytes=0-${Math.max(0, len - 1)}`);
    if (r.notFound || !r.stream) return { notFound: true };
    const chunks = [];
    for await (const c of r.stream) chunks.push(c);
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: head.size > len, size: head.size };
  }

  // ==================== 秒传（hash 去重） ====================
  app.post('/upload/check-hash', requireAuth, express.json(), async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      const hash = String(body.hash || '').trim().toLowerCase();
      const size = Number(body.size) || 0;
      const teamId = body.teamId ? Number(body.teamId) : null;
      if (!/^[0-9a-f]{64}$/.test(hash)) return res.status(400).json({ ok: false, instant: false, error: 'hash 参数无效' });
      if (!(await userCan(userId, 'can_upload'))) return res.status(403).json({ ok: false, instant: false, error: '当前用户组不允许上传文件' });
      const safeName = sanitizeFilename(decodeFilename(String(body.filename || '')));
      if (!safeName) return res.status(400).json({ ok: false, instant: false, error: '缺少文件名' });

      let folderIdVal = null;
      if (teamId) {
        if (!(await isTeamMember(teamId, userId))) return res.status(403).json({ ok: false, instant: false, error: '您不是该团队成员，无权上传' });
      } else if (body.folderId) {
        const folder = await getOwnedFolder(body.folderId, userId);
        folderIdVal = folder ? folder.id : null;
      }
      if (size > 0) {
        const q = await checkQuota(userId, size);
        if (!q.ok) return res.status(413).json({ ok: false, instant: false, error: quotaErrorMsg(q.remain) });
      }

      const candidates = teamId
        ? await db.all('SELECT * FROM files WHERE file_hash = ? AND file_size = ? AND team_id = ? AND deleted_at IS NULL LIMIT 5', hash, size, teamId)
        : await db.all('SELECT * FROM files WHERE file_hash = ? AND file_size = ? AND user_id = ? AND is_shared = 0 AND team_id IS NULL AND deleted_at IS NULL LIMIT 5', hash, size, userId);
      if (!candidates.length) return res.json({ ok: true, instant: false });

      // 逐个校验源对象是否仍在存储中（异常/对象缺失时降级为普通上传）
      let src = null;
      for (const cand of candidates) {
        try {
          const head = await storage.headFile(cand);
          if (head.exists) { src = cand; break; }
        } catch (e) { /* 尝试下一个候选 */ }
      }
      if (!src) return res.json({ ok: true, instant: false });

      const saved = await recordUploadedFile({
        userId, filename: safeName, storedName: src.stored_name, fileSize: size, fileHash: hash,
        folderId: folderIdVal, teamId, policyId: src.policy_id || null
      });
      audit(req, 'upload', safeName, '秒传（复用已有对象），大小 ' + formatBytes(size));
      res.json({ ok: true, instant: true, fileId: saved.id, name: safeName, size, versioned: saved.versioned });
    } catch (err) {
      console.error('[秒传校验失败]', err);
      res.status(500).json({ ok: false, instant: false, error: '秒传校验失败: ' + err.message });
    }
  });

  // ==================== 断点续传：查询已上传分片 ====================
  app.get('/upload/chunks', requireAuth, async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId || '');
      if (!/^[0-9]{6,}-[0-9]{1,}$/.test(sessionId)) return res.status(400).json({ ok: false, error: 'sessionId 无效' });
      const tmpDir = path.join(os.tmpdir(), 'teamcloud-chunks', `user_${req.session.userId}`, sessionId);
      let uploaded = [];
      if (fs.existsSync(tmpDir)) {
        uploaded = fs.readdirSync(tmpDir)
          .filter(n => /^\d+$/.test(n))
          .map(n => Number(n))
          .sort((a, b) => a - b);
      }
      res.json({ ok: true, sessionId, uploaded, count: uploaded.length });
    } catch (err) {
      res.status(500).json({ ok: false, error: '查询分片失败: ' + err.message });
    }
  });

  // ==================== ZIP 打包下载（流式） ====================
  app.post('/api/download/zip', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      const asArray = (v) => Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]);
      const fileIds = asArray(body.fileIds).map(Number).filter(n => n > 0);
      const folderIds = asArray(body.folderIds).map(Number).filter(n => n > 0);
      if (!fileIds.length && !folderIds.length) return res.status(400).json({ ok: false, error: '请选择要下载的文件或文件夹' });

      // 组装待打包条目
      const items = [];   // { entryName, file }
      const usedNames = new Set();
      function uniqueEntry(name) {
        if (!usedNames.has(name)) { usedNames.add(name); return name; }
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        let i = 2;
        while (usedNames.has(base + '(' + i + ')' + ext)) i++;
        const out = base + '(' + i + ')' + ext;
        usedNames.add(out);
        return out;
      }
      const dirEntries = [];
      for (const id of fileIds) {
        const f = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NULL', id, userId);
        if (f) items.push({ entryName: uniqueEntry(f.filename), file: f });
      }
      for (const id of folderIds) {
        const folder = await getOwnedFolder(id, userId);
        if (!folder || folder.deleted_at) continue;
        const rootName = uniqueEntry(folder.name);
        dirEntries.push(rootName + '/');
        const tree = await collectFolderFiles(userId, folder.id);
        const idToPath = { [folder.id]: rootName };
        for (const sub of tree.folders) {
          const parentPath = idToPath[sub.parent_id] || rootName;
          const p = uniqueEntry(parentPath + '/' + sub.name);
          idToPath[sub.id] = p;
          dirEntries.push(p + '/');
        }
        for (const f of tree.files) {
          const p = idToPath[f.folder_id] || rootName;
          items.push({ entryName: uniqueEntry(p + '/' + f.filename), file: f });
        }
      }
      if (items.length + dirEntries.length > 2000) {
        return res.status(413).json({ ok: false, error: '单次打包条目过多（上限 2000），请分批下载' });
      }

      // 校验存在性（避免写出残缺条目）
      const entries = [];
      for (const it of items) {
        let head;
        try { head = await storage.headFile(it.file); } catch (e) { head = { exists: false }; }
        if (head.exists) entries.push({ name: it.entryName, file: it.file });
      }
      if (!entries.length && !dirEntries.length) return res.status(404).json({ ok: false, error: '所选内容已不存在' });

      const zipName = 'teamcloud-' + new Date().toISOString().slice(0, 10) + '.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
      res.setHeader('Cache-Control', 'no-store');

      const writer = new ziplib.ZipWriter(res);
      let aborted = false;
      res.on('close', () => { if (!res.writableEnded) aborted = true; });

      for (const d of dirEntries) {
        if (aborted) return;
        await writer.addEntry(d, null, {});
      }
      for (const e of entries) {
        if (aborted) return;
        const entryFile = e.file;
        await writer.addEntry(e.name, () => {
          const holder = { stream: null };
          // getObject 是异步的，这里先用一个 PassThrough 占位，再接管真实数据流
          const pt = new (require('stream').PassThrough)();
          storage.getFileObject(entryFile).then((r) => {
            if (r.notFound || !r.stream) { pt.end(); return; }
            holder.stream = r.stream;
            r.stream.on('error', (err) => pt.destroy(err));
            r.stream.pipe(pt);
          }).catch((err) => pt.destroy(err));
          return pt;
        }, { date: new Date(String(e.file.uploaded_at || '').replace(' ', 'T')) });
      }
      await writer.finalize();
      res.end();
    } catch (err) {
      console.error('[ZIP 打包失败]', err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: '打包失败: ' + err.message });
      else { try { res.end(); } catch (e) {} }
    }
  });

  // ==================== ZIP 解压到当前文件夹 ====================
  app.post('/api/file/unzip', requireAuthApi, async (req, res) => {
    const body = req.body || {};
    const userId = req.session.userId;
    const tmpFiles = [];
    try {
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND is_shared = 0 AND deleted_at IS NULL', Number(body.id), userId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (!/\.zip$/i.test(file.filename)) return res.status(400).json({ ok: false, error: '仅支持 ZIP 压缩包' });
      let parentId = null;
      if (body.folderId) {
        const folder = await getOwnedFolder(body.folderId, userId);
        parentId = folder ? folder.id : null;
      }
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).json({ ok: false, error: '文件不存在' });

      const reader = s3Reader(file);
      const entries = await ziplib.readZipEntries(reader);
      if (!entries.length) return res.status(400).json({ ok: false, error: '压缩包内没有内容' });

      // 容量校验（按解压后总大小）
      let total = 0;
      for (const e of entries) total += e.isDir ? 0 : (e.uncompressed || 0);
      const q = await checkQuota(userId, total);
      if (!q.ok) return res.status(413).json({ ok: false, error: quotaErrorMsg(q.remain, q.quota) });

      // 解压出的新文件落在默认存储策略上
      const unzipPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      const unzipBackend = storage.backendForPolicyId(unzipPolicyId);

      const folderCache = new Map();
      const tmpDir = path.join(os.tmpdir(), 'teamcloud-unzip', `user_${userId}`, String(Date.now()));
      fs.mkdirSync(tmpDir, { recursive: true });
      let count = 0, skipped = 0;
      const created = [];

      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        let name = String(e.name || '').replace(/\\/g, '/');
        if (!name || name.indexOf('..') >= 0 || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) { skipped++; continue; }
        const parts = name.split('/').filter(p => p && p !== '.');
        if (!parts.length) { skipped++; continue; }
        if (e.isDir) {
          let cur = parentId;
          for (const p of parts) cur = await ensureSubFolder(userId, cur, sanitizeFilename(p).slice(0, 60) || p, folderCache);
          continue;
        }
        let cur = parentId;
        for (let k = 0; k < parts.length - 1; k++) {
          cur = await ensureSubFolder(userId, cur, sanitizeFilename(parts[k]).slice(0, 60) || parts[k], folderCache);
        }
        const rawName = sanitizeFilename(parts[parts.length - 1]) || ('file-' + (i + 1));
        const stream = await ziplib.openEntryStream(reader, e);
        const { safeName, storedName } = makeStoredName(rawName);
        if (!stream) {
          // 空文件：直接写入 0 字节对象
          const emptyPath = path.join(tmpDir, storedName + '.empty');
          fs.writeFileSync(emptyPath, Buffer.alloc(0));
          tmpFiles.push(emptyPath);
          await unzipBackend.putFile(s3store.userKey(userId, storedName), emptyPath);
          const saved = await recordUploadedFile({ userId, filename: safeName, storedName, fileSize: 0, folderId: cur, policyId: unzipPolicyId });
          created.push({ id: saved.id, name: safeName, folderId: cur, size: 0 });
          count++;
          continue;
        }
        const outPath = path.join(tmpDir, storedName);
        tmpFiles.push(outPath);
        const info = await ziplib.writeStreamToFile(stream, outPath);
        await unzipBackend.putFile(s3store.userKey(userId, storedName), outPath);
        try { fs.unlinkSync(outPath); } catch (err) {}
        const saved = await recordUploadedFile({ userId, filename: safeName, storedName, fileSize: info.size, folderId: cur, policyId: unzipPolicyId });
        created.push({ id: saved.id, name: safeName, folderId: cur, size: info.size });
        count++;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
      audit(req, 'unzip', file.filename, '解压出 ' + count + ' 个文件（跳过 ' + skipped + '）');
      res.json({ ok: true, count, skipped, files: created });
    } catch (err) {
      console.error('[解压失败]', err);
      for (const p of tmpFiles) { try { fs.unlinkSync(p); } catch (e) {} }
      res.status(500).json({ ok: false, error: '解压失败: ' + err.message });
    }
  });

  // ==================== 文件版本历史 ====================
  app.get('/api/file/versions', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', Number(req.query.id), userId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      const versions = await db.all(
        `SELECT v.id, v.stored_name, v.file_size, v.created_at, v.uploader_id, u.username AS uploader_name
         FROM file_versions v LEFT JOIN users u ON u.id = v.uploader_id
         WHERE v.file_id = ? ORDER BY v.id DESC`, file.id);
      res.json({
        ok: true,
        file: { id: file.id, filename: file.filename, file_size: file.file_size, uploaded_at: file.uploaded_at },
        versions
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载版本失败: ' + err.message });
    }
  });

  // 下载某个历史版本（个人/团队文件的版本共用）
  app.get('/api/file/version/download', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const v = await db.get('SELECT * FROM file_versions WHERE id = ?', Number(req.query.id));
      if (!v) return res.status(404).send('版本不存在');
      const file = await db.get('SELECT * FROM files WHERE id = ?', v.file_id);
      if (!file) return res.status(404).send('文件不存在');
      if (file.team_id) {
        if (!(await isTeamMember(file.team_id, userId))) return res.status(403).send('没有访问权限');
      } else if (file.user_id !== userId) {
        return res.status(403).send('没有访问权限');
      }
      // 版本存储策略：优先版本自带 policy_id，其次跟随当前文件
      const vFile = Object.assign({}, file, { stored_name: v.stored_name, policy_id: v.policy_id || file.policy_id });
      const head = await storage.headFile(vFile);
      if (!head.exists) return res.status(404).send('版本文件不存在');
      const url = await storage.presignFile(vFile, file.filename, 600);
      if (url) return res.redirect(302, url);
      const r = await storage.pipeToResponse(vFile, req, res, { download: true, filename: file.filename });
      if (r.notFound) return res.status(404).send('版本文件不存在');
      return;
    } catch (err) {
      console.error('[版本下载失败]', err);
      if (!res.headersSent) res.status(500).send('下载失败: ' + err.message);
    }
  });

  app.post('/api/file/version/restore', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const v = await db.get('SELECT * FROM file_versions WHERE id = ?', Number((req.body || {}).id));
      if (!v) return res.status(404).json({ ok: false, error: '版本不存在' });
      const file = await db.get('SELECT * FROM files WHERE id = ?', v.file_id);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (file.team_id) {
        if (!(await isTeamMember(file.team_id, userId))) return res.status(403).json({ ok: false, error: '没有权限' });
      } else if (file.user_id !== userId) {
        return res.status(403).json({ ok: false, error: '没有权限' });
      }
      // 当前版本入历史，选中的历史版本恢复为当前版本（连同其存储策略一并还原）
      await db.run('INSERT INTO file_versions (file_id, stored_name, file_size, created_at, uploader_id, policy_id) VALUES (?, ?, ?, ?, ?, ?)',
        file.id, file.stored_name, file.file_size, file.uploaded_at, file.user_id, file.policy_id || null);
      await db.run('UPDATE files SET stored_name = ?, file_size = ?, uploaded_at = ?, policy_id = ? WHERE id = ?',
        v.stored_name, v.file_size, dbNow(), v.policy_id || file.policy_id || null, file.id);
      await db.run('DELETE FROM file_versions WHERE id = ?', v.id);
      audit(req, 'version_restore', file.filename, '恢复历史版本 #' + v.id);
      res.json({ ok: true, fileId: file.id, size: v.file_size });
    } catch (err) {
      res.status(500).json({ ok: false, error: '恢复版本失败: ' + err.message });
    }
  });

  // ==================== 在线文本预览 ====================
  app.get('/preview/:id/text', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', req.params.id);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      if (!file.team_id && file.user_id !== userId) return res.status(403).json({ ok: false, error: '没有访问权限' });
      if (file.team_id && !(await isTeamMember(file.team_id, userId))) return res.status(403).json({ ok: false, error: '没有访问权限' });
      const r = await readFileText(file);
      if (r.notFound) return res.status(404).json({ ok: false, error: '文件不存在' });
      res.json({ ok: true, name: file.filename, text: r.text, truncated: r.truncated, size: r.size, limit: 2 * 1024 * 1024 });
    } catch (err) {
      console.error('[文本预览失败]', err);
      res.status(500).json({ ok: false, error: '文本预览失败: ' + err.message });
    }
  });

  // ==================== 收藏 / 星标 ====================
  app.post('/api/star/toggle', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const kind = (req.body || {}).kind === 'folder' ? 'folder' : 'file';
      const id = Number((req.body || {}).id);
      if (!id) return res.status(400).json({ ok: false, error: '参数不完整' });
      if (kind === 'folder') {
        const f = await getOwnedFolder(id, userId);
        if (!f) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      } else {
        const f = await db.get('SELECT id FROM files WHERE id = ? AND user_id = ?', id, userId);
        if (!f) return res.status(404).json({ ok: false, error: '文件不存在' });
      }
      const exist = await db.get('SELECT 1 AS x FROM starred WHERE user_id = ? AND kind = ? AND target_id = ?', userId, kind, id);
      if (exist) {
        await db.run('DELETE FROM starred WHERE user_id = ? AND kind = ? AND target_id = ?', userId, kind, id);
        return res.json({ ok: true, starred: false });
      }
      await db.run('INSERT INTO starred (user_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)', userId, kind, id, dbNow());
      res.json({ ok: true, starred: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '操作失败: ' + err.message });
    }
  });

  // ==================== 标签 ====================
  app.get('/api/tag/list', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const tags = await db.all(`
        SELECT t.id, t.name, t.color,
          (SELECT COUNT(*) FROM file_tags ft WHERE ft.tag_id = t.id) AS count
        FROM tags t WHERE t.user_id = ? ORDER BY t.name ASC`, userId);
      res.json({ ok: true, tags });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载标签失败: ' + err.message });
    }
  });

  app.post('/api/tag/create', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const name = String((req.body || {}).name || '').trim().slice(0, 20);
      const color = String((req.body || {}).color || '').trim().slice(0, 20);
      if (!name) return res.status(400).json({ ok: false, error: '标签名称不能为空' });
      let tag = await db.get('SELECT * FROM tags WHERE user_id = ? AND name = ?', userId, name);
      if (tag) return res.json({ ok: true, tag });
      const r = await db.run('INSERT INTO tags (name, user_id, color, created_at) VALUES (?, ?, ?, ?)', name, userId, color || null, dbNow());
      tag = { id: r.lastID, name, color: color || null };
      res.json({ ok: true, tag });
    } catch (err) {
      res.status(500).json({ ok: false, error: '创建标签失败: ' + err.message });
    }
  });

  app.post('/api/tag/delete', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const id = Number((req.body || {}).id);
      const tag = await db.get('SELECT * FROM tags WHERE id = ? AND user_id = ?', id, userId);
      if (!tag) return res.status(404).json({ ok: false, error: '标签不存在' });
      await db.run('DELETE FROM file_tags WHERE tag_id = ?', id);
      await db.run('DELETE FROM tags WHERE id = ?', id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '删除标签失败: ' + err.message });
    }
  });

  // 覆盖式设置某文件的标签集合
  app.post('/api/tag/assign', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      const fileId = Number(body.fileId);
      const tagIds = (Array.isArray(body.tagIds) ? body.tagIds : []).map(Number).filter(n => n > 0);
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ?', fileId, userId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      const mine = await db.all('SELECT id FROM tags WHERE user_id = ?', userId);
      const mineSet = new Set(mine.map(t => t.id));
      await db.run('DELETE FROM file_tags WHERE file_id = ?', fileId);
      for (const tid of tagIds) {
        if (mineSet.has(tid)) await db.run('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)', fileId, tid);
      }
      res.json({ ok: true, tagIds: tagIds.filter(t => mineSet.has(t)) });
    } catch (err) {
      res.status(500).json({ ok: false, error: '设置标签失败: ' + err.message });
    }
  });

  // ==================== 复制到（S3 CopyObject，文件夹递归） ====================
  app.post('/api/file/copy', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NULL', Number(body.id), userId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在' });
      let targetId = null;
      if (body.folderId) {
        const folder = await getOwnedFolder(body.folderId, userId);
        if (!folder || folder.deleted_at) return res.status(403).json({ ok: false, error: '目标文件夹不存在' });
        targetId = folder.id;
      }
      if (targetId === file.folder_id) return res.status(400).json({ ok: false, error: '文件已在该文件夹中' });
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).json({ ok: false, error: '文件不存在' });
      const q = await checkQuota(userId, head.size || file.file_size || 0);
      if (!q.ok) return res.status(413).json({ ok: false, error: quotaErrorMsg(q.remain, q.quota) });

      // 复制产生的新对象落在默认存储策略（支持跨策略复制）
      const dstPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      const { storedName } = makeStoredName(file.filename);
      const dstKey = s3store.userKey(userId, storedName);
      await storage.copyObjectBetween(file, dstPolicyId, dstKey);
      const newName = await uniqueFileName(userId, targetId, file.filename);
      const r = await db.run(
        'INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, folder_id, file_hash, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        userId, newName, storedName, head.size || file.file_size || 0, targetId, file.file_hash || null, dbNow(), dstPolicyId);
      audit(req, 'copy', newName, '复制文件 ' + file.filename + ' → 文件夹 #' + (targetId || '根目录'));
      res.json({ ok: true, id: r.lastID, name: newName });
    } catch (err) {
      console.error('[复制文件失败]', err);
      res.status(500).json({ ok: false, error: '复制失败: ' + err.message });
    }
  });

  app.post('/api/folder/copy', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      const body = req.body || {};
      const folder = await getOwnedFolder(Number(body.id), userId);
      if (!folder || folder.deleted_at) return res.status(404).json({ ok: false, error: '文件夹不存在' });
      let targetParent = null;
      if (body.parentId) {
        const target = await getOwnedFolder(body.parentId, userId);
        if (!target || target.deleted_at) return res.status(403).json({ ok: false, error: '目标文件夹不存在' });
        targetParent = target.id;
        // 环检测
        let cur = target;
        while (cur) {
          if (cur.id === folder.id) return res.status(400).json({ ok: false, error: '不能复制到自身的子文件夹中' });
          cur = cur.parent_id ? await getOwnedFolder(cur.parent_id, userId) : null;
        }
      }
      const tree = await collectFolderFiles(userId, folder.id);
      let totalBytes = 0;
      for (const f of tree.files) totalBytes += Number(f.file_size) || 0;
      const q = await checkQuota(userId, totalBytes);
      if (!q.ok) return res.status(413).json({ ok: false, error: quotaErrorMsg(q.remain, q.quota) });

      const dstPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      const cache = new Map();
      const newRoot = await ensureSubFolder(userId, targetParent, folder.name, null);
      const map = { [folder.id]: newRoot };
      for (const sub of tree.folders) {
        const parent = map[sub.parent_id] || newRoot;
        map[sub.id] = await ensureSubFolder(userId, parent, sub.name, cache);
      }
      let copied = 0;
      for (const f of tree.files) {
        const parent = map[f.folder_id] || newRoot;
        const { storedName } = makeStoredName(f.filename);
        let head;
        try { head = await storage.headFile(f); } catch (e) { head = { exists: false }; }
        if (!head.exists) continue;
        await storage.copyObjectBetween(f, dstPolicyId, s3store.userKey(userId, storedName));
        const newName = await uniqueFileName(userId, parent, f.filename);
        await db.run(
          'INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, folder_id, file_hash, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
          userId, newName, storedName, head.size || f.file_size || 0, parent, f.file_hash || null, dbNow(), dstPolicyId);
        copied++;
      }
      audit(req, 'copy', folder.name, '复制文件夹（' + (tree.folders.length + 1) + ' 个目录 / ' + copied + ' 个文件）');
      res.json({ ok: true, folderId: newRoot, folders: tree.folders.length + 1, files: copied });
    } catch (err) {
      console.error('[复制文件夹失败]', err);
      res.status(500).json({ ok: false, error: '复制失败: ' + err.message });
    }
  });

  // ==================== 分享增强：有效期 / 提取码 / 文件夹分享 / 下载计数 ====================
  // 分享页错误提示（过期/失效）
  function shareMessagePage(title, message, icon) {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#fff;border-radius:16px;padding:36px 28px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.25);text-align:center;}
  .icon{font-size:42px;margin-bottom:12px;}
  h2{color:#2d3748;font-size:1.15rem;margin-bottom:10px;}
  p{color:#718096;font-size:.9rem;line-height:1.7;}
</style></head>
<body><div class="card"><div class="icon">${icon || '⚠️'}</div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></div></body></html>`;
  }

  // 文件夹分享的密码输入页（与文件分享密码页保持一致的视觉与交互）
  function shareFolderPasswordPage(link, folderName) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta name="referrer" content="no-referrer">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>输入密码 - ${escapeHtml(folderName)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .card { background:#fff; border-radius:16px; padding:32px 28px; width:100%; max-width:420px; box-shadow:0 20px 60px rgba(0,0,0,0.25); }
  .icon { font-size:40px; text-align:center; margin-bottom:12px; }
  h2 { text-align:center; color:#2d3748; font-size:1.15rem; margin-bottom:6px; word-break:break-all; }
  .meta { text-align:center; color:#718096; font-size:0.85rem; margin-bottom:22px; }
  .pwd-wrap { display:flex; gap:8px; margin-bottom:10px; }
  input[type=password] { flex:1; min-width:0; padding:12px 14px; border:2px solid #cbd5e0; border-radius:10px; font-size:1.2rem; letter-spacing:6px; text-align:center; outline:none; }
  input[type=password]:focus { border-color:#667eea; }
  .btn { width:100%; padding:13px; background:linear-gradient(135deg,#667eea,#764ba2); color:#fff; border:none; border-radius:10px; font-size:1rem; font-weight:600; cursor:pointer; }
  .btn:disabled { opacity:0.6; cursor:not-allowed; }
  .err { color:#e53e3e; font-size:0.85rem; text-align:center; min-height:20px; margin-bottom:8px; }
  .tip { color:#a0aec0; font-size:0.78rem; text-align:center; margin-top:14px; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <h2>${escapeHtml(folderName)}</h2>
    <p class="meta">共享文件夹 · 需要访问密码</p>
    <div class="err" id="errMsg"></div>
    <div class="pwd-wrap">
      <input type="password" id="pwd" inputmode="numeric" maxlength="32" placeholder="请输入提取码" autocomplete="off">
    </div>
    <button class="btn" id="submitBtn" onclick="verifyPwd()">验证并进入</button>
    <p class="tip">请输入分享者提供的提取码</p>
  </div>
  <script>
    function verifyPwd() {
      var pwd = document.getElementById('pwd').value.trim();
      var err = document.getElementById('errMsg');
      var btn = document.getElementById('submitBtn');
      if (!pwd) { err.textContent = '请输入提取码'; return; }
      btn.disabled = true; btn.textContent = '验证中...';
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/s/${link.token}/verify', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200) { window.location.href = '/s/${link.token}'; }
        else {
          btn.disabled = false; btn.textContent = '验证并进入';
          try { err.textContent = JSON.parse(xhr.responseText).error || '提取码错误'; }
          catch(e) { err.textContent = '验证失败，请重试'; }
        }
      };
      xhr.send(JSON.stringify({ password: pwd }));
    }
    document.getElementById('pwd').addEventListener('keydown', function(e) { if (e.key === 'Enter') verifyPwd(); });
  </script>
</body>
</html>`;
  }

  // 文件夹分享浏览页
  async function renderFolderSharePage(res, link, folder, folderId) {
    const children = await db.all('SELECT id, name, created_at FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name ASC', link.created_by, folderId);
    const files = await db.all('SELECT id, filename, file_size, uploaded_at FROM files WHERE user_id = ? AND folder_id IS ? AND team_id IS NULL AND is_shared = 0 AND deleted_at IS NULL ORDER BY filename ASC', link.created_by, folderId);
    const crumbs = [];
    let cur = folder;
    let guard = 0;
    while (cur && guard++ < 100) { crumbs.unshift(cur); cur = cur.parent_id ? await db.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', cur.parent_id, link.created_by) : null; }
    const shareBase = '/s/' + link.token;
    const rows = [];
    for (const f of files) {
      rows.push(`<tr><td class="nm"><span class="ic">📄</span>${escapeHtml(f.filename)}</td>
        <td class="sz">${escapeHtml(formatFileSize(f.file_size))}</td>
        <td class="op"><a class="btn-sm" href="${shareBase}/dl/${f.id}">下载</a></td></tr>`);
    }
    for (const c of children) {
      rows.push(`<tr><td class="nm"><span class="ic">📁</span><a href="${shareBase}?folder=${c.id}">${escapeHtml(c.name)}</a></td>
        <td class="sz">—</td><td class="op"><a class="btn-sm" href="${shareBase}?folder=${c.id}">打开</a></td></tr>`);
    }
    const crumbHtml = '<a href="' + shareBase + '">' + escapeHtml('共享文件夹') + '</a>' +
      crumbs.map((c, i) => ' / ' + (i === crumbs.length - 1 ? escapeHtml(c.name) : '<a href="' + shareBase + '?folder=' + c.id + '">' + escapeHtml(c.name) + '</a>')).join('');
    const expired = link.expires_at ? '<div class="meta">有效期至 ' + escapeHtml(link.expires_at) + ' · 已下载 ' + (link.download_count || 0) + ' 次</div>' : '<div class="meta">永久有效 · 已下载 ' + (link.download_count || 0) + ' 次</div>';
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(folder.name)} - 共享文件夹</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;padding:24px;display:flex;justify-content:center;}
  .card{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:760px;box-shadow:0 20px 60px rgba(0,0,0,.25);}
  h2{font-size:1.1rem;color:#2d3748;margin-bottom:6px;word-break:break-all;}
  .meta{color:#a0aec0;font-size:.78rem;margin-bottom:14px;}
  .crumb{font-size:.85rem;color:#718096;margin-bottom:14px;word-break:break-all;}
  .crumb a{color:#667eea;text-decoration:none;}
  table{width:100%;border-collapse:collapse;}
  th,td{padding:10px 8px;border-bottom:1px solid #edf2f7;font-size:.88rem;color:#2d3748;text-align:left;}
  th{color:#a0aec0;font-weight:500;font-size:.78rem;}
  td.sz{color:#718096;white-space:nowrap;}
  td.op{text-align:right;white-space:nowrap;}
  .ic{margin-right:6px;}
  a.btn-sm{display:inline-block;padding:5px 12px;border-radius:8px;background:#667eea;color:#fff;text-decoration:none;font-size:.82rem;}
  .empty{padding:40px 10px;text-align:center;color:#a0aec0;}
</style></head>
<body><div class="card">
  <h2>📁 ${escapeHtml(folder.name)}</h2>
  ${expired}
  <div class="crumb">${crumbHtml}</div>
  ${rows.length ? ('<table><thead><tr><th>名称</th><th>大小</th><th></th></tr></thead><tbody>' + rows.join('') + '</tbody></table>')
      : '<div class="empty">此文件夹为空</div>'}
</div></body></html>`;
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(html);
  }

  // 按 token 撤销分享（我的分享管理页使用）
  app.post('/share/revoke-by-token', requireAuth, express.json(), async (req, res) => {
    try {
      const userId = req.session.userId;
      const token = String((req.body || {}).token || '');
      const link = await db.get('SELECT * FROM share_links WHERE token = ?', token);
      if (!link) return res.status(404).json({ ok: false, error: '分享不存在或已撤销' });
      if (link.created_by !== userId) return res.status(403).json({ ok: false, error: '没有撤销权限' });
      await db.run('DELETE FROM share_links WHERE id = ?', link.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: '撤销失败: ' + err.message });
    }
  });

  // 我的分享管理页
  app.get('/shares', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const links = await db.all('SELECT * FROM share_links WHERE created_by = ? ORDER BY created_at DESC', userId);
      const list = [];
      for (const l of links) {
        let name = '', size = null;
        if (l.folder_id) {
          const fo = await db.get('SELECT name FROM folders WHERE id = ?', l.folder_id);
          name = fo ? fo.name : '（文件夹已删除）';
        } else {
          const f = await db.get('SELECT filename, file_size FROM files WHERE id = ?', l.file_id);
          name = f ? f.filename : '（文件已删除）';
          size = f ? f.file_size : null;
        }
        list.push({
          token: l.token, kind: l.folder_id ? 'folder' : 'file', name, size,
          url: '/s/' + l.token, password: l.password || '',
          expires_at: l.expires_at || null, expired: isShareExpired(l),
          download_count: l.download_count || 0, created_at: l.created_at
        });
      }
      // 移动端走 shares-mobile；桌面端与老设备兼容版仍走 shares（行为/样式完全不变）
      const sharesView = res.locals.isMobile ? 'shares-mobile' : 'shares';
      res.render(sharesView, {
        title: 'CC网盘 - 我的分享',
        crActive: 'shares',
        shares: list,
        shareCount: list.length
      });
    } catch (err) {
      console.error('[我的分享失败]', err);
      res.render(res.locals.isMobile ? 'shares-mobile' : 'shares', { title: 'CC网盘 - 我的分享', crActive: 'shares', shares: [], shareCount: 0 });
    }
  });

  // 文件夹分享的子文件下载
  app.get('/s/:token/dl/:fileId', async (req, res) => {
    try {
      const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
      if (!link) return res.status(404).send('链接不存在或已失效');
      if (isShareExpired(link)) return res.status(410).send(shareMessagePage('分享链接已过期', '该分享链接已超过有效期，请联系分享者重新分享。', '⏰'));
      if (!isShareAuthorized(req, link)) return res.status(403).send('需要密码验证');
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.fileId));
      if (!file) return res.status(404).send('文件不存在或已删除');
      if (!(await fileInFolderShare(file, link))) return res.status(403).send('没有访问权限');
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).send('文件不存在或已删除');
      await countShareDownload(link);
      const url = await storage.presignFile(file, file.filename, 600);
      if (url) return res.redirect(302, url);
      const r = await storage.pipeToResponse(file, req, res, { download: true, filename: file.filename });
      if (r.notFound) return res.status(404).send('文件不存在或已删除');
      return;
    } catch (err) {
      console.error('[分享子文件下载失败]', err);
      if (!res.headersSent) res.status(500).send('获取下载地址失败: ' + err.message);
    }
  });

  // 分享列表接口（供分享页/客户端展示文件夹内容）
  app.get('/s/:token/list', async (req, res) => {
    try {
      const link = await db.get('SELECT * FROM share_links WHERE token = ?', req.params.token);
      if (!link) return res.status(404).json({ ok: false, error: '链接不存在或已失效' });
      if (isShareExpired(link)) return res.status(410).json({ ok: false, error: '链接已过期' });
      const target = await shareTarget(link);
      if (!target) return res.status(404).json({ ok: false, error: '内容不存在或已删除' });
      if (target.kind === 'file') {
        return res.json({ ok: true, kind: 'file', name: target.file.filename, size: target.file.file_size, downloadCount: link.download_count || 0 });
      }
      const folderId = req.query.folder ? Number(req.query.folder) : target.folder.id;
      if (folderId !== target.folder.id) {
        // 仅允许浏览该分享子树内的目录
        const sub = await db.get('SELECT * FROM folders WHERE id = ?', folderId);
        let cur = sub;
        let guard = 0;
        let ok = false;
        while (cur && guard++ < 200) {
          if (cur.id === target.folder.id) { ok = true; break; }
          cur = cur.parent_id ? await db.get('SELECT * FROM folders WHERE id = ?', cur.parent_id) : null;
        }
        if (!ok) return res.status(403).json({ ok: false, error: '没有访问权限' });
      }
      const children = await db.all('SELECT id, name FROM folders WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL ORDER BY name ASC', link.created_by, folderId);
      const files = await db.all('SELECT id, filename, file_size, uploaded_at FROM files WHERE user_id = ? AND folder_id = ? AND team_id IS NULL AND is_shared = 0 AND deleted_at IS NULL ORDER BY filename ASC', link.created_by, folderId);
      res.json({
        ok: true, kind: 'folder', folderId,
        folders: children.map(c => ({ id: c.id, name: c.name, url: '/s/' + link.token + '?folder=' + c.id })),
        files: files.map(f => ({ id: f.id, filename: f.filename, file_size: f.file_size, url: '/s/' + link.token + '/dl/' + f.id })),
        downloadCount: link.download_count || 0
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: '加载失败: ' + err.message });
    }
  });

  // ==================== 阶段三：离线下载（HTTP/HTTPS 直链 + Aria2 磁力对接） ====================
  // 页面：任务列表 + 新建任务弹窗（数据走 /api/offline/*）
  app.get('/offline', requireAuth, (req, res) => {
    res.render(res.locals.isMobile ? 'offline-mobile' : 'offline', { title: '离线下载 - CC网盘' });
  });

  // 任务列表（含 Aria2 可用状态；Aria2 任务状态在此按需刷新）
  app.get('/api/offline/list', requireAuthApi, async (req, res) => {
    try {
      const tasks = await offlineMgr.list(req.session.userId);
      res.json({ ok: true, tasks: tasks, aria2: offlineMgr.aria2Info(), concurrency: offlineMod.MAX_CONCURRENCY });
    } catch (err) {
      console.error('[离线下载] 列表失败', err);
      res.status(500).json({ ok: false, error: '任务列表加载失败: ' + err.message });
    }
  });

  // 新建任务（url 仅允许 http/https 与 magnet:，含 SSRF 校验与配额预检）
  app.post('/api/offline/create', requireAuthApi, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!(await userCan(userId, 'can_upload'))) {
        return res.status(403).json({ ok: false, error: '当前用户组不允许上传/下载文件' });
      }
      const rawUrl = (req.body || {}).url;
      let folderId = null;
      if ((req.body || {}).folderId) {
        const f = await getOwnedFolder((req.body || {}).folderId, userId);
        folderId = f ? f.id : null;
      }
      const task = await offlineMgr.create(userId, rawUrl, folderId);
      audit(req, 'offline_create', task.filename, '新建离线下载任务：' + String(rawUrl).slice(0, 120));
      res.json({ ok: true, task: task });
    } catch (err) {
      const code = err && err.code === 'QUOTA' ? 413 : 400;
      res.status(code).json({ ok: false, error: err.message || '创建任务失败' });
    }
  });

  // 任务操作：暂停 / 继续 / 取消 / 删除记录 / 失败重试
  const offlineActions = {
    '/api/offline/pause': (u, id) => offlineMgr.pause(u, id),
    '/api/offline/resume': (u, id) => offlineMgr.resume(u, id),
    '/api/offline/cancel': (u, id) => offlineMgr.cancel(u, id),
    '/api/offline/delete': (u, id) => offlineMgr.remove(u, id),
    '/api/offline/retry': (u, id) => offlineMgr.retry(u, id)
  };
  Object.keys(offlineActions).forEach(function (path) {
    app.post(path, requireAuthApi, async (req, res) => {
      try {
        const id = Number((req.body || {}).id);
        if (!id) return res.status(400).json({ ok: false, error: '参数不完整' });
        await offlineActions[path](req.session.userId, id);
        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message || '操作失败' });
      }
    });
  });

  // ==================== 阶段三：Office 在线预览（服务端本地解析，只读） ====================
  // 个人：仅上传者本人；团队：需为团队成员
  async function canAccessOfficeFile(userId, file) {
    if (!file || file.deleted_at) return false;
    if (file.team_id) return await isTeamMember(file.team_id, userId);
    return Number(file.user_id) === Number(userId);
  }

  function renderOfficePage(req, res, file, opts) {
    opts = opts || {};
    const oc = onlyoffice.config();
    const kind = officedoc.officeExt(file.filename);
    const kindLabel = kind === 'docx' ? 'Word 文档' : (kind === 'xlsx' ? 'Excel 表格' : (kind === 'pptx' ? 'PowerPoint 演示文稿' : 'Office 文档'));
    res.render('office', {
      title: file.filename + ' - 在线预览',
      fileId: file.id,
      fileName: file.filename,
      kindLabel: kindLabel,
      sizeText: opts.sizeText || formatBytes(Number(file.file_size) || 0),
      backUrl: file.team_id ? '/dashboard?tab=teams' : '/dashboard',
      downloadUrl: file.team_id ? ('/team/' + file.team_id + '/download/' + file.id) : ('/download/' + file.id),
      contentHtml: opts.contentHtml || '<p class="cr-hint">（无内容）</p>',
      editConfigured: !!oc.configured,
      editMsg: onlyoffice.UNCONFIGURED_MSG
    });
  }

  function officeErrorHtml(title, detail) {
    return '<div class="cr-alert cr-alert-error" style="display:block;">'
      + '<strong>' + escapeHtml(title) + '</strong><br>' + escapeHtml(detail) + '</div>'
      + '<p class="cr-hint" style="margin-top:12px;">可返回列表后使用「下载」在本地查看该文件。</p>';
  }

  app.get('/office/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
      if (!file) return res.status(404).type('text/html').send('<h3>文件不存在</h3><p><a href="/dashboard">返回文件列表</a></p>');
      if (!(await canAccessOfficeFile(userId, file))) {
        return res.status(403).type('text/html').send('<h3>没有访问权限</h3><p><a href="/dashboard">返回文件列表</a></p>');
      }
      if (!officedoc.officeExt(file.filename)) {
        return renderOfficePage(req, res, file, { contentHtml: officeErrorHtml('该格式不支持 Office 在线预览', '仅支持 docx / xlsx / pptx（Office Open XML）。') });
      }
      const head = await storage.headFile(file);
      if (!head.exists) {
        return renderOfficePage(req, res, file, { contentHtml: officeErrorHtml('文件不存在', '对象存储中未找到该文件。') });
      }
      if (head.size > officedoc.MAX_OFFICE_BYTES) {
        return renderOfficePage(req, res, file, {
          sizeText: formatBytes(head.size),
          contentHtml: officeErrorHtml('文件过大，请下载后查看', '在线预览上限 ' + Math.round(officedoc.MAX_OFFICE_BYTES / 1024 / 1024) + 'MB，当前文件 ' + formatBytes(head.size) + '。')
        });
      }
      let parsed;
      try {
        const reader = storage.recordReader(file);
        parsed = await officedoc.parseOffice(reader, file.filename);
      } catch (e) {
        console.error('[Office 预览] 解析失败 #' + file.id, e.message);
        return renderOfficePage(req, res, file, {
          sizeText: formatBytes(head.size),
          contentHtml: officeErrorHtml('解析失败，无法在线预览', '该文件可能已损坏或不是标准的 Office Open XML 文档（' + e.message + '）。')
        });
      }
      if (!file.team_id && file.user_id === userId) await recordRecentView(userId, 'file', file.id);
      renderOfficePage(req, res, file, { sizeText: formatBytes(head.size), contentHtml: parsed.html });
    } catch (err) {
      console.error('[Office 预览失败]', err);
      if (!res.headersSent) res.status(500).type('text/html').send('<h3>预览失败</h3><p>' + escapeHtml(err.message) + '</p><p><a href="/dashboard">返回文件列表</a></p>');
    }
  });

  // Document Server 拉取原文件（无会话，使用签名令牌；仅在已配置 ONLYOFFICE_URL 时开放）
  app.get('/office/:id/file', async (req, res) => {
    try {
      const oc = onlyoffice.config();
      if (!oc.configured) return res.status(404).end();
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
      if (!file) return res.status(404).end();
      const key = onlyoffice.buildKey(file);
      if (!onlyoffice.checkFileToken(file.id, key, req.query.t, req.query.e)) return res.status(403).end();
      const r = await storage.pipeToResponse(file, req, res, { download: false, filename: file.filename, contentType: 'application/octet-stream' });
      if (r.notFound) return res.status(404).end();
    } catch (err) {
      console.error('[OnlyOffice] 原文件拉取失败', err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // 在线编辑页：未配置 ONLYOFFICE_URL 时明确降级提示（不加载任何外部脚本）
  app.get('/office/:id/edit', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
      if (!file) return res.status(404).type('text/html').send('<h3>文件不存在</h3><p><a href="/dashboard">返回文件列表</a></p>');
      if (!(await canAccessOfficeFile(userId, file))) {
        return res.status(403).type('text/html').send('<h3>没有访问权限</h3><p><a href="/dashboard">返回文件列表</a></p>');
      }
      const oc = onlyoffice.config();
      const kind = officedoc.officeExt(file.filename);
      const base = {
        title: file.filename + ' - 在线编辑',
        fileId: file.id,
        fileName: file.filename,
        sizeText: formatBytes(Number(file.file_size) || 0),
        backUrl: '/office/' + file.id,
        downloadUrl: file.team_id ? ('/team/' + file.team_id + '/download/' + file.id) : ('/download/' + file.id),
        editConfigured: !!oc.configured,
        editMsg: onlyoffice.UNCONFIGURED_MSG,
        onlyofficeUrl: oc.url,
        editorConfigJson: '{}'
      };
      if (!oc.configured) return res.render('office-edit', base);
      if (!kind) {
        return res.status(400).type('text/html').send('<h3>该格式不支持在线编辑</h3><p>仅支持 docx / xlsx / pptx。</p><p><a href="/office/' + file.id + '">返回预览</a></p>');
      }
      const key = onlyoffice.buildKey(file);
      const tk = onlyoffice.fileToken(file.id, key, 12 * 3600 * 1000);
      const origin = req.protocol + '://' + req.get('host');
      const fileUrl = origin + '/office/' + file.id + '/file?t=' + encodeURIComponent(tk.t) + '&e=' + tk.e;
      const callbackUrl = origin + '/office/' + file.id + '/callback?t=' + encodeURIComponent(tk.t) + '&e=' + tk.e;
      const cu = res.locals.currentUser || {};
      const cfg = {
        documentType: kind === 'xlsx' ? 'spreadsheet' : (kind === 'pptx' ? 'presentation' : 'word'),
        document: {
          fileType: kind,
          key: key,
          title: file.filename,
          url: fileUrl,
          permissions: { edit: true, download: true, print: true }
        },
        editorConfig: {
          callbackUrl: callbackUrl,
          lang: 'zh-CN',
          mode: 'edit',
          user: { id: String(userId), name: cu.nickname || cu.username || ('用户' + userId) },
          customization: { autosave: true, forcesave: true, compactHeader: true }
        },
        width: '100%',
        height: '100%'
      };
      if (oc.jwtSecret) cfg.token = onlyoffice.signJwt(cfg, oc.jwtSecret);
      base.editorConfigJson = JSON.stringify(cfg).replace(/</g, '\\u003c');
      res.render('office-edit', base);
    } catch (err) {
      console.error('[OnlyOffice] 编辑页失败', err);
      if (!res.headersSent) res.status(500).type('text/html').send('<h3>编辑页加载失败</h3><p>' + escapeHtml(err.message) + '</p>');
    }
  });

  // OnlyOffice 保存回调（无会话；令牌校验 + 可选 JWT 校验）
  app.post('/office/:id/callback', async (req, res) => {
    try {
      const oc = onlyoffice.config();
      if (!oc.configured) return res.status(404).json({ error: 1 });
      const file = await db.get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
      if (!file) return res.status(404).json({ error: 1 });
      const key = onlyoffice.buildKey(file);
      if (!onlyoffice.checkFileToken(file.id, key, req.query.t, req.query.e)) return res.status(403).json({ error: 1 });
      const body = req.body || {};
      if (oc.jwtSecret) {
        const payload = body.token ? onlyoffice.verifyJwt(body.token, oc.jwtSecret) : null;
        if (!payload) return res.status(403).json({ error: 1 });
      }
      const status = Number(body.status);
      // 1=编辑中 4=关闭无修改 3/7=保存出错：无需落盘
      if (status !== 2 && status !== 6) {
        if (status === 3 || status === 7) console.warn('[OnlyOffice] 保存回调报错 #' + file.id, body.error || '');
        return res.json({ error: 0 });
      }
      if (!body.url) return res.json({ error: 0 });
      const tmp = path.join(os.tmpdir(), 'teamcloud-onlyoffice-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
      try {
        const dl = await onlyoffice.downloadToFile(body.url, tmp, 180000);
        if (dl.size > 200 * 1024 * 1024) throw new Error('回调文件过大（超过 200MB）');
        const q = await checkQuota(file.user_id, Math.max(0, dl.size - (Number(file.file_size) || 0)));
        if (!q.ok) throw new Error(quotaErrorMsg(q.remain, q.quota));
        const policyId = storage.policyIdOf(file);
        const storedName = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.filename);
        const backend = storage.backendForPolicyId(policyId);
        const keyName = file.team_id ? s3store.teamKey(file.team_id, storedName) : s3store.userKey(file.user_id, storedName);
        await backend.putFile(keyName, tmp);
        try {
          await recordUploadedFile({
            userId: file.user_id, filename: file.filename, storedName: storedName,
            fileSize: dl.size, folderId: file.folder_id, teamId: file.team_id, policyId: policyId
          });
        } catch (e) {
          try { await backend.deleteObject(keyName); } catch (e2) {}
          throw e;
        }
        await writeAudit({
          userId: file.user_id, username: null, action: 'office_edit_save', target: file.filename,
          detail: 'OnlyOffice 保存写回，大小 ' + formatBytes(dl.size), ip: clientIp(req), ua: req.headers['user-agent'] || ''
        });
        console.log('[OnlyOffice] 已保存写回 #' + file.id + ' ' + file.filename + '（' + formatBytes(dl.size) + '）');
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
      }
      res.json({ error: 0 });
    } catch (err) {
      console.error('[OnlyOffice] 保存回调失败', err);
      res.json({ error: 1 });
    }
  });

  // ==================== 阶段二：开放 API v1 ====================
  // 鉴权：Authorization: Bearer <api_key>，密钥来源：api_keys 表（归属创建者的账户）
  // 或环境变量 INTERNAL_API_KEY（默认以内置管理员身份操作，可用 X-User-Id 指定用户）。
  async function resolveApiActor(req) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return { error: 401, message: '缺少 Authorization: Bearer <api_key> 请求头' };
    const key = m[1].trim();
    if (!key) return { error: 401, message: 'API 密钥为空' };
    if (INTERNAL_API_KEY && key === INTERNAL_API_KEY) {
      const wanted = Number(req.headers['x-user-id'] || 0);
      let user = null;
      if (wanted) user = await db.get('SELECT id, username, uid, nickname, role FROM users WHERE id = ?', wanted);
      if (!user) user = await db.get('SELECT id, username, uid, nickname, role FROM users WHERE LOWER(username) = LOWER(?)', 'Administrator');
      if (!user) return { error: 500, message: '内部密钥未绑定可用用户' };
      return { user, keyKind: 'internal' };
    }
    const row = await db.get('SELECT * FROM api_keys WHERE api_key = ?', key);
    if (!row) return { error: 401, message: 'API 密钥无效' };
    if (!row.created_by) return { error: 401, message: '该密钥未绑定用户' };
    const user = await db.get('SELECT id, username, uid, nickname, role FROM users WHERE id = ?', row.created_by);
    if (!user) return { error: 401, message: '密钥所属用户不存在' };
    return { user, keyKind: 'user' };
  }

  async function requireApiV1(req, res, next) {
    try {
      const r = await resolveApiActor(req);
      if (r.error) return res.status(r.error).json({ ok: false, error: r.message });
      const u = await db.get('SELECT banned FROM users WHERE id = ?', r.user.id);
      if (u && u.banned) return res.status(403).json({ ok: false, error: '该账户已被封禁' });
      if (!(await userCan(r.user.id, 'can_use_api'))) return res.status(403).json({ ok: false, error: '当前用户组不允许使用开放 API' });
      req.apiUser = r.user;
      next();
    } catch (e) {
      res.status(500).json({ ok: false, error: '鉴权失败: ' + e.message });
    }
  }

  // 当前用户信息与容量
  app.get('/api/v1/me', requireApiV1, async (req, res) => {
    try {
      const usage = await getUserUsage(req.apiUser.id);
      const g = await getUserGroup(req.apiUser.id);
      res.json({
        ok: true,
        user: { id: req.apiUser.id, username: req.apiUser.username, uid: req.apiUser.uid, nickname: req.apiUser.nickname || req.apiUser.username, role: req.apiUser.role },
        used: usage.used, quota: usage.quota,
        group: g ? { id: g.id, name: g.name } : null
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 列出文件与文件夹
  app.get('/api/v1/files', requireApiV1, async (req, res) => {
    try {
      const userId = req.apiUser.id;
      const cur = await getOwnedFolder(req.query.folderId, userId);
      const folderId = cur ? cur.id : null;
      const folders = await db.all('SELECT id, parent_id, name, created_at FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name ASC', userId, folderId);
      const files = await db.all('SELECT id, filename, file_size, folder_id, uploaded_at FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL AND folder_id IS ? AND deleted_at IS NULL ORDER BY filename ASC', userId, folderId);
      res.json({
        ok: true, folderId,
        path: cur ? (await buildFolderPath(cur)).map(f => ({ id: f.id, name: f.name })) : [],
        folders, files
      });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 新建文件夹
  app.post('/api/v1/folders', requireApiV1, express.json(), async (req, res) => {
    try {
      const userId = req.apiUser.id;
      const name = sanitizeFilename(String((req.body || {}).name || '')).trim().slice(0, 60);
      const parentId = (req.body || {}).parentId ? Number(req.body.parentId) : null;
      if (!name) return res.status(400).json({ ok: false, error: '文件夹名称不能为空' });
      if (parentId) {
        const parent = await getOwnedFolder(parentId, userId);
        if (!parent || parent.deleted_at) return res.status(403).json({ ok: false, error: '父文件夹不存在' });
      }
      let finalName = name;
      const siblings = await db.all('SELECT name FROM folders WHERE user_id = ? AND parent_id IS ?', userId, parentId);
      const names = new Set(siblings.map(s => s.name));
      if (names.has(finalName)) {
        let i = 2;
        while (names.has(finalName + '(' + i + ')')) i++;
        finalName = finalName + '(' + i + ')';
      }
      const r = await db.run('INSERT INTO folders (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)', userId, parentId, finalName, nowStr());
      audit(req, 'mkdir', finalName, '开放 API 新建文件夹（用户 ' + req.apiUser.username + '）', { userId, username: req.apiUser.username });
      res.json({ ok: true, id: r.lastID, name: finalName, parentId });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 上传文件（multipart，字段 file，可选 folderId）
  app.post('/api/v1/upload', requireApiV1, upload.single('file'), async (req, res) => {
    const userId = req.apiUser.id;
    const cleanup = () => { if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (e) {} } };
    try {
      if (!(await userCan(userId, 'can_upload'))) { cleanup(); return res.status(403).json({ ok: false, error: '当前用户组不允许上传文件' }); }
      if (!req.file) return res.status(400).json({ ok: false, error: '缺少文件字段 file' });
      let folderId = null;
      if (req.body && req.body.folderId) {
        const folder = await getOwnedFolder(req.body.folderId, userId);
        if (!folder || folder.deleted_at) { cleanup(); return res.status(403).json({ ok: false, error: '目标文件夹不存在' }); }
        folderId = folder.id;
      }
      const filename = sanitizeFilename(decodeFilename(req.file.originalname));
      const q = await checkQuota(userId, req.file.size);
      if (!q.ok) { cleanup(); return res.status(413).json({ ok: false, error: quotaErrorMsg(q.remain, q.quota) }); }
      const defPolicyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
      try {
        await storage.backendForPolicyId(defPolicyId).putFile(s3store.userKey(userId, req.file.filename), req.file.path);
      } finally { cleanup(); }
      const saved = await recordUploadedFile({ userId, filename, storedName: req.file.filename, fileSize: req.file.size, folderId, policyId: defPolicyId });
      audit(req, 'upload', filename, '开放 API 上传，大小 ' + formatBytes(req.file.size), { userId, username: req.apiUser.username });
      res.json({ ok: true, fileId: saved.id, name: filename, size: req.file.size, folderId, versioned: saved.versioned });
    } catch (e) {
      cleanup();
      res.status(500).json({ ok: false, error: '上传失败: ' + e.message });
    }
  });

  // 获取下载地址（S3 策略 302 到预签名；本地策略 302 到服务器回源）
  app.get('/api/v1/download/:id', requireApiV1, async (req, res) => {
    try {
      const userId = req.apiUser.id;
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL AND deleted_at IS NULL', Number(req.params.id), userId);
      if (!file) return res.status(404).json({ ok: false, error: '文件不存在或无权访问' });
      const head = await storage.headFile(file);
      if (!head.exists) return res.status(404).json({ ok: false, error: '文件不存在' });
      audit(req, 'download', file.filename, '开放 API 下载', { userId, username: req.apiUser.username });
      const url = await storage.presignFile(file, file.filename, 600);
      if (url) return res.redirect(302, url);
      const r = await storage.pipeToResponse(file, req, res, { download: true, filename: file.filename });
      if (r.notFound) return res.status(404).json({ ok: false, error: '文件不存在' });
      return;
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 删除文件（进回收站）
  app.delete('/api/v1/files/:id', requireApiV1, async (req, res) => {
    try {
      const userId = req.apiUser.id;
      const file = await db.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND team_id IS NULL', Number(req.params.id), userId);
      if (!file || file.deleted_at) return res.status(404).json({ ok: false, error: '文件不存在或无权访问' });
      await softDeletePersonalFile(file.id, userId);
      audit(req, 'delete', file.filename, '开放 API 删除（移入回收站）', { userId, username: req.apiUser.username });
      res.json({ ok: true, id: file.id });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ==================== 阶段二：WebDAV（最小可用） ====================
  // 挂载点 /dav，路径映射到用户的个人文件树（/ 为根）。
  // 认证：HTTP Basic，用户名为站点用户名，密码为账户密码 或 该用户创建的 API 密钥。
  function davXmlEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function davHttpDate(v) {
    let t = null;
    if (v instanceof Date) t = v.getTime();
    else if (typeof v === 'number') t = v;
    else if (typeof v === 'string' && v) t = new Date(v.replace(' ', 'T')).getTime();
    if (!t || isNaN(t)) t = Date.now();
    return new Date(t).toUTCString();
  }
  // 解析 /dav 之后的路径，返回 { parts } 或 { bad:true }
  function davParsePath(req) {
    let rest = String(req.path || '');
    if (rest.indexOf('/dav') === 0) rest = rest.slice(4);
    let decoded;
    try { decoded = decodeURIComponent(rest); } catch (e) { return { bad: true }; }
    decoded = decoded.replace(/\\/g, '/');
    if (decoded.indexOf('\0') >= 0) return { bad: true };
    const parts = [];
    for (const p of decoded.split('/')) {
      if (p === '') continue;
      if (p === '.' || p === '..') return { bad: true };
      if (/[:*?"<>|]/.test(p)) return { bad: true };
      parts.push(p);
    }
    return { parts };
  }
  function davHrefFor(parts, isDir) {
    const enc = parts.map(p => encodeURIComponent(p)).join('/');
    return '/dav/' + enc + (isDir && parts.length ? '/' : '');
  }
  async function davAuthenticate(req) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Basic\s+(.+)$/i);
    if (!m) return { error: 401, message: '需要 Basic 认证' };
    let creds;
    try { creds = Buffer.from(m[1], 'base64').toString('utf8'); } catch (e) { return { error: 401, message: '认证信息格式错误' }; }
    const idx = creds.indexOf(':');
    if (idx < 0) return { error: 401, message: '认证信息格式错误' };
    const username = creds.slice(0, idx);
    const password = creds.slice(idx + 1);
    if (!username) return { error: 401, message: '用户名不能为空' };
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) return { error: 401, message: '用户名或密码错误' };
    let ok = false;
    try { ok = bcrypt.compareSync(password, user.password_hash); } catch (e) { ok = false; }
    if (!ok && password) {
      const row = await db.get('SELECT id FROM api_keys WHERE api_key = ? AND created_by = ?', password, user.id);
      if (row) ok = true;
    }
    if (!ok) return { error: 401, message: '用户名或密码错误' };
    if (user.banned) return { error: 403, message: '该账户已被封禁' };
    if (!(await userCan(user.id, 'can_use_webdav'))) return { error: 403, message: '当前用户组未启用 WebDAV' };
    return { user };
  }
  // 路径 → 文件/文件夹记录
  async function davResolve(userId, parts) {
    let parentId = null;
    for (let i = 0; i < parts.length; i++) {
      const isLast = (i === parts.length - 1);
      const name = parts[i];
      if (isLast) {
        const file = await db.get('SELECT * FROM files WHERE user_id = ? AND filename = ? AND is_shared = 0 AND team_id IS NULL AND folder_id IS ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', userId, name, parentId);
        if (file) return { kind: 'file', file, parentId };
        const folder = await db.get('SELECT * FROM folders WHERE user_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', userId, name, parentId);
        if (folder) return { kind: 'folder', folder, parentId };
        return { kind: 'missing', parentId };
      }
      const folder = await db.get('SELECT * FROM folders WHERE user_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', userId, name, parentId);
      if (!folder) return { kind: 'missing-parent', parentId };
      parentId = folder.id;
    }
    return { kind: 'root', parentId: null };
  }
  function davResponseEntry(href, name, isDir, size, mtime, ctype) {
    const ct = isDir ? '' : ('<D:getcontenttype>' + davXmlEsc(ctype || 'application/octet-stream') + '</D:getcontenttype>');
    return '<D:response><D:href>' + davXmlEsc(href) + '</D:href><D:propstat><D:prop>' +
      '<D:displayname>' + davXmlEsc(name) + '</D:displayname>' +
      '<D:resourcetype>' + (isDir ? '<D:collection/>' : '') + '</D:resourcetype>' +
      '<D:getcontentlength>' + (isDir ? 0 : (Number(size) || 0)) + '</D:getcontentlength>' +
      '<D:getlastmodified>' + davXmlEsc(davHttpDate(mtime)) + '</D:getlastmodified>' +
      ct +
      '</D:prop>' +
      '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  }
  function davMime(name) {
    const pk = previewKind(name);
    if (pk) return pk.mime;
    return 'application/octet-stream';
  }

  app.all(['/dav', '/dav/*'], async (req, res) => {
    const method = String(req.method || '').toUpperCase();
    try {
      res.setHeader('DAV', '1, 2');
      res.setHeader('MS-Author-Via', 'DAV');
      if (method === 'OPTIONS') {
        res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY');
        return res.status(200).end();
      }
      const auth = await davAuthenticate(req);
      if (auth.error) {
        if (auth.error === 401) res.setHeader('WWW-Authenticate', 'Basic realm="TeamCloud WebDAV"');
        return res.status(auth.error).type('text/plain; charset=utf-8').send(auth.message || '认证失败');
      }
      const userId = auth.user.id;

      const parsed = davParsePath(req);
      if (parsed.bad) return res.status(400).type('text/plain').send('非法路径');
      const parts = parsed.parts || [];

      if (method === 'PROPFIND') {
        const target = await davResolve(userId, parts);
        if (target.kind === 'missing' || target.kind === 'missing-parent') return res.status(404).type('text/plain').send('资源不存在');
        const depth = String(req.headers.depth || '1').toLowerCase();
        const selfHref = davHrefFor(parts, target.kind === 'root' || target.kind === 'folder');
        let xml = '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">';
        if (target.kind === 'file') {
          xml += davResponseEntry(selfHref, target.file.filename, false, target.file.file_size, target.file.uploaded_at, davMime(target.file.filename));
        } else {
          const folderName = parts.length ? parts[parts.length - 1] : '';
          const folderRow = target.kind === 'folder' ? target.folder : null;
          xml += davResponseEntry(selfHref, folderName, true, 0, folderRow ? folderRow.created_at : new Date(), '');
          if (depth !== '0') {
            const fid = target.kind === 'folder' ? target.folder.id : null;
            const childFolders = await db.all('SELECT id, name, created_at FROM folders WHERE user_id = ? AND parent_id IS ? AND deleted_at IS NULL ORDER BY name ASC', userId, fid);
            const childFiles = await db.all('SELECT id, filename, file_size, uploaded_at FROM files WHERE user_id = ? AND is_shared = 0 AND team_id IS NULL AND folder_id IS ? AND deleted_at IS NULL ORDER BY filename ASC', userId, fid);
            for (const c of childFolders) xml += davResponseEntry(davHrefFor(parts.concat(c.name), true), c.name, true, 0, c.created_at, '');
            for (const f of childFiles) xml += davResponseEntry(davHrefFor(parts.concat(f.filename), false), f.filename, false, f.file_size, f.uploaded_at, davMime(f.filename));
          }
        }
        xml += '</D:multistatus>';
        res.status(207).setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.send(xml);
      }

      const target = await davResolve(userId, parts);

      if (method === 'GET' || method === 'HEAD') {
        if (target.kind === 'file') {
          audit(req, 'download', target.file.filename, 'WebDAV 下载（用户 ' + auth.user.username + '）', { userId, username: auth.user.username });
          const r = await storage.pipeToResponse(target.file, req, res, { download: false, filename: target.file.filename, contentType: davMime(target.file.filename) });
          if (r.notFound) return res.status(404).type('text/plain').send('文件不存在');
          return;
        }
        if (target.kind === 'root' || target.kind === 'folder') return res.status(405).type('text/plain').send('集合不支持 GET');
        return res.status(404).type('text/plain').send('资源不存在');
      }

      if (method === 'PUT') {
        if (!(await userCan(userId, 'can_upload'))) return res.status(403).type('text/plain').send('当前用户组不允许上传文件');
        if (!parts.length) return res.status(405).type('text/plain').send('不能写入根集合');
        if (target.kind === 'folder') return res.status(405).type('text/plain').send('同名集合已存在');
        if (target.kind === 'missing-parent') return res.status(409).type('text/plain').send('父集合不存在');
        const parentId = target.parentId != null ? target.parentId : null;
        const filename = sanitizeFilename(parts[parts.length - 1]);
        if (!filename) return res.status(400).type('text/plain').send('文件名非法');
        const existed = target.kind === 'file';
        const tmp = path.join(os.tmpdir(), 'teamcloud-dav-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
        try {
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(tmp);
            req.on('error', reject);
            ws.on('error', reject);
            ws.on('finish', resolve);
            req.pipe(ws);
          });
          const size = fs.statSync(tmp).size;
          const q = await checkQuota(userId, existed ? Math.max(0, size - (Number(target.file.file_size) || 0)) : size);
          if (!q.ok) return res.status(507).type('text/plain').send(quotaErrorMsg(q.remain, q.quota));
          const policyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
          const storedName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(filename);
          await storage.backendForPolicyId(policyId).putFile(s3store.userKey(userId, storedName), tmp);
          await recordUploadedFile({ userId, filename, storedName, fileSize: size, folderId: parentId, policyId });
          audit(req, 'upload', filename, 'WebDAV 上传（' + formatBytes(size) + '，用户 ' + auth.user.username + '）', { userId, username: auth.user.username });
          return res.status(existed ? 204 : 201).end();
        } finally {
          try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
        }
      }

      if (method === 'MKCOL') {
        if (!parts.length) return res.status(405).type('text/plain').send('根集合已存在');
        if (target.kind === 'file' || target.kind === 'folder') return res.status(405).type('text/plain').send('同名资源已存在');
        if (target.kind === 'missing-parent') return res.status(409).type('text/plain').send('父集合不存在');
        const name = sanitizeFilename(parts[parts.length - 1]).slice(0, 60);
        if (!name) return res.status(400).type('text/plain').send('名称非法');
        await db.run('INSERT INTO folders (user_id, parent_id, name, created_at) VALUES (?, ?, ?, ?)', userId, target.parentId != null ? target.parentId : null, name, nowStr());
        audit(req, 'mkdir', name, 'WebDAV 新建目录（用户 ' + auth.user.username + '）', { userId, username: auth.user.username });
        res.setHeader('Location', davHrefFor(parts, true));
        return res.status(201).end();
      }

      if (method === 'DELETE') {
        if (target.kind === 'missing' || target.kind === 'missing-parent') return res.status(404).type('text/plain').send('资源不存在');
        if (target.kind === 'root') return res.status(403).type('text/plain').send('不能删除根集合');
        if (target.kind === 'file') {
          await softDeletePersonalFile(target.file.id, userId);
          audit(req, 'delete', target.file.filename, 'WebDAV 删除文件（移入回收站）', { userId, username: auth.user.username });
        } else {
          await softDeletePersonalFolder(target.folder.id, userId);
          audit(req, 'delete', target.folder.name, 'WebDAV 删除目录（移入回收站）', { userId, username: auth.user.username });
        }
        return res.status(204).end();
      }

      if (method === 'MOVE' || method === 'COPY') {
        if (target.kind === 'missing' || target.kind === 'missing-parent' || target.kind === 'root') {
          return res.status(404).type('text/plain').send('源资源不存在');
        }
        const destHeader = String(req.headers.destination || '');
        if (!destHeader) return res.status(400).type('text/plain').send('缺少 Destination 头');
        let destPath = destHeader;
        if (/^https?:\/\//i.test(destHeader)) {
          try { destPath = new URL(destHeader).pathname; } catch (e) { return res.status(400).type('text/plain').send('Destination 非法'); }
        }
        if (destPath.indexOf('/dav') !== 0) return res.status(502).type('text/plain').send('目标必须在 /dav 下');
        const fakeReq = { path: destPath };
        const destParsed = davParsePath(fakeReq);
        if (destParsed.bad || !destParsed.parts.length) return res.status(400).type('text/plain').send('目标路径非法');
        const destParts = destParsed.parts;
        const overwrite = String(req.headers.overwrite || 'T').toUpperCase() !== 'F';
        const dest = await davResolve(userId, destParts);
        if (dest.kind === 'missing-parent') return res.status(409).type('text/plain').send('目标父集合不存在');
        const destParentId = dest.parentId != null ? dest.parentId : null;
        const destName = sanitizeFilename(destParts[destParts.length - 1]);
        if (!destName) return res.status(400).type('text/plain').send('目标名称非法');
        const destExists = (dest.kind === 'file' || dest.kind === 'folder');
        if (destExists && !overwrite) return res.status(412).type('text/plain').send('目标已存在');
        if (destExists) {
          if (dest.kind === 'file') await softDeletePersonalFile(dest.file.id, userId);
          else await softDeletePersonalFolder(dest.folder.id, userId);
        }
        const srcName = target.kind === 'file' ? target.file.filename : target.folder.name;
        if (method === 'MOVE') {
          if (target.kind === 'file') {
            await db.run('UPDATE files SET filename = ?, folder_id = ? WHERE id = ?', destName, destParentId, target.file.id);
          } else {
            // 环检测：目标不能是自身子树
            if (destParentId) {
              let cur = destParentId;
              let guard = 0;
              while (cur && guard++ < 500) {
                if (cur === target.folder.id) return res.status(409).type('text/plain').send('不能移动到自身子目录');
                const row = await db.get('SELECT parent_id FROM folders WHERE id = ?', cur);
                cur = row ? row.parent_id : null;
              }
            }
            await db.run('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?', destName, destParentId, target.folder.id);
          }
          audit(req, 'rename', destName, 'WebDAV 移动：' + srcName + ' → ' + destParts.join('/'), { userId, username: auth.user.username });
        } else {
          const policyId = storage.defaultPolicy() ? Number(storage.defaultPolicy().id) : null;
          if (target.kind === 'file') {
            const storedName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(target.file.filename);
            await storage.copyObjectBetween(target.file, policyId, s3store.userKey(userId, storedName));
            await db.run('INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, folder_id, file_hash, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
              userId, destName, storedName, target.file.file_size, destParentId, target.file.file_hash || null, nowStr(), policyId);
          } else {
            // 目录递归复制
            const tree = await collectFolderFiles(userId, target.folder.id);
            const cache = new Map();
            const newRoot = await ensureSubFolder(userId, destParentId, destName, null);
            const map = { [target.folder.id]: newRoot };
            for (const sub of tree.folders) {
              const parent = map[sub.parent_id] || newRoot;
              map[sub.id] = await ensureSubFolder(userId, parent, sub.name, cache);
            }
            for (const f of tree.files) {
              const parent = map[f.folder_id] || newRoot;
              const storedName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(f.filename);
              try {
                await storage.copyObjectBetween(f, policyId, s3store.userKey(userId, storedName));
              } catch (e) { continue; }
              const newName = await uniqueFileName(userId, parent, f.filename);
              await db.run('INSERT INTO files (user_id, filename, stored_name, file_size, is_shared, folder_id, file_hash, uploaded_at, policy_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
                userId, newName, storedName, f.file_size, parent, f.file_hash || null, nowStr(), policyId);
            }
          }
          audit(req, 'copy', destName, 'WebDAV 复制：' + srcName + ' → ' + destParts.join('/'), { userId, username: auth.user.username });
        }
        return res.status(destExists ? 204 : 201).end();
      }

      return res.status(405).setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE, COPY').type('text/plain').send('不支持的方法');
    } catch (err) {
      console.error('[WebDAV]', req.method, req.path, err);
      if (!res.headersSent) res.status(500).type('text/plain').send('WebDAV 内部错误: ' + err.message);
    }
  });

  // Express 路由错误处理：记录所有未捕获错误（便于排查 500）
  app.use((err, req, res, next) => {
    console.error('路由错误:', err && err.stack ? err.stack : err);
    res.status(500).type('text/plain').send('服务器内部错误: ' + (err && err.message ? err.message : String(err)));
  });

  // ==================== 启动服务器 ====================
  // 全局错误处理：防止未捕获异常导致进程崩溃（避免 502）
  process.on('uncaughtException', (err) => {
    console.error('未捕获异常:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('未处理的 Promise 拒绝:', reason);
  });

  app.listen(PORT, HOST, () => {
    console.log(`CC网盘服务器已启动: http://${HOST}:${PORT}`);
  });

})().catch(err => {
  console.error('服务器启动失败:', err);
  process.exit(1);
});
