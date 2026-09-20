// 团队云 - 多线程分片上传/下载 (现代浏览器版)
// 上传: 文件切成小片, 并发4线程上传, 使用 requestAnimationFrame 优化进度渲染
// 下载: 通过 HTTP Range 并发拉取分片, Blob 合并 (支持个人/共享/团队文件)
// 老浏览器自动降级: 使用原生表单提交和普通链接下载

const CHUNK_SIZE = 4 * 1024 * 1024; // 每片 4MB
const CONCURRENCY = 4;               // 并发线程数
const CHUNK_UPLOAD_THRESHOLD = 8 * 1024 * 1024; // ≥8MB 走分片上传（可断点续传）
const CHUNK_CONCURRENCY = 3;         // 分片并发数
const HASH_MAX_BYTES = 256 * 1024 * 1024; // 超过 256MB 不计算内容哈希（避免整文件进内存），改用 名称+大小+修改时间 作为续传标识
const RESUME_KEY_PREFIX = 'cr_up_';

// 兼容性检测：不支持 fetch/Blob/Promise 的老浏览器直接用原生行为
const SUPPORTS_MULTITHREAD = (typeof fetch !== 'undefined' &&
  typeof Blob !== 'undefined' &&
  typeof Promise !== 'undefined' &&
  typeof FormData !== 'undefined' &&
  typeof URL !== 'undefined' && URL.createObjectURL);

const SUPPORTS_HASH = (typeof crypto !== 'undefined' && crypto.subtle &&
  typeof crypto.subtle.digest === 'function' && typeof FileReader !== 'undefined');

// ==================== 内容哈希（秒传）与续传标识 ====================
// 计算 SHA-256（不可用 / 超大 / 空文件时返回 null，调用方静默降级为普通上传）
function computeFileHash(file) {
  return new Promise(function (resolve) {
    if (!SUPPORTS_HASH || !file || !file.size || file.size > HASH_MAX_BYTES) { resolve(null); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        crypto.subtle.digest('SHA-256', reader.result).then(function (buf) {
          var arr = new Uint8Array(buf), hex = '';
          for (var i = 0; i < arr.length; i++) { hex += ('0' + arr[i].toString(16)).slice(-2); }
          resolve(hex);
        }).catch(function () { resolve(null); });
      } catch (e) { resolve(null); }
    };
    reader.onerror = reader.onabort = function () { resolve(null); };
    try { reader.readAsArrayBuffer(file); } catch (e) { resolve(null); }
  });
}

// 续传标识：有内容哈希用哈希；否则退化为 名称+大小+修改时间
function resumeKeyOf(file, hash) {
  if (hash) return 'h_' + hash + '_' + file.size;
  return 'm_' + file.name + '_' + file.size + '_' + (file.lastModified || 0);
}

function readResumeState(key) {
  try {
    var raw = localStorage.getItem(RESUME_KEY_PREFIX + key);
    if (!raw) return null;
    var st = JSON.parse(raw);
    if (!st || !st.sessionId || !st.storedName || !st.chunkCount) return null;
    return st;
  } catch (e) { return null; }
}

function writeResumeState(key, st) {
  try { localStorage.setItem(RESUME_KEY_PREFIX + key, JSON.stringify(st)); } catch (e) { }
}

function clearResumeState(key) {
  try { localStorage.removeItem(RESUME_KEY_PREFIX + key); } catch (e) { }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function setIconMsg(el, icon, text) {
  if (!el) return;
  el.textContent = '';
  var img = document.createElement('img');
  img.src = '/icons/' + icon + '.svg';
  img.width = 14;
  img.height = 14;
  img.alt = '';
  img.style.verticalAlign = 'middle';
  el.appendChild(img);
  el.appendChild(document.createTextNode(' ' + text));
}

function onReady(cb) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cb);
  } else {
    cb();
  }
}


// 使用 requestAnimationFrame 批量更新 DOM，避免布局抖动
function createProgressRenderer(barEl, pctEl, speedEl, etaEl, submitBtn) {
  var pending = null;
  function flush() {
    if (!pending) return;
    var p = pending;
    pending = null;
    if (barEl) barEl.style.width = p.pct + '%';
    if (pctEl) pctEl.textContent = p.pct + '%';
    if (submitBtn) submitBtn.textContent = '上传中... ' + p.pct + '%';
    if (speedEl && p.speedText !== undefined) speedEl.textContent = p.speedText;
    if (etaEl && p.etaText !== undefined) etaEl.textContent = p.etaText;
  }
  return function render(progress, speed) {
    var pct = Math.round(progress * 100);
    var speedText = '';
    var etaText = '';
    if (speed && speed > 0) {
      speedText = formatFileSize(speed) + '/s';
      var fileSize = parseInt(barEl && barEl.dataset.fileSize) || 0;
      if (fileSize > 0) {
        var remain = (fileSize * (1 - progress)) / speed;
        if (remain > 0 && isFinite(remain)) {
          etaText = '剩余 ' + (remain < 60 ? Math.ceil(remain) + '秒' : Math.ceil(remain / 60) + '分钟');
        }
      }
    }
    // 合并 DOM 更新，通过 rAF 批量提交
    pending = { pct: pct, speedText: speedText, etaText: etaText };
    requestAnimationFrame(flush);
  };
}

// ==================== 多线程上传 ====================
// onProgress(progress, speedBytesPerSec) - progress: 0~1, speed: 实时速度(字节/秒)
function createUploadTracker() {
  return {
    startTime: 0,
    lastTime: 0,
    lastBytes: 0,
    speed: 0,
    start: function() { this.startTime = this.lastTime = Date.now(); this.lastBytes = 0; this.speed = 0; },
    // 上报新增字节数，返回当前平滑速度（字节/秒）
    update: function(bytes) {
      var now = Date.now();
      var dt = (now - this.lastTime) / 1000;
      if (dt >= 0.3) { // 每300ms采样一次
        this.speed = bytes / dt;
        this.lastTime = now;
        this.lastBytes = 0;
      }
      return this.speed;
    }
  };
}

async function multiThreadUpload(file, share, onProgress, teamId, folderId, hash) {
  var tracker = createUploadTracker();
  tracker.start();

  // 获取预签名上传地址（服务器只签名不中转数据）
  var presignResp = await fetch('/upload/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, share: share, teamId: teamId || null, folderId: folderId || null, contentType: file.type || 'application/octet-stream' })
  });
  if (!presignResp.ok) {
    var perr = await presignResp.json().catch(function() { return {}; });
    throw new Error(perr.error || ('获取上传地址失败: HTTP ' + presignResp.status));
  }
  var presignData = await presignResp.json();
  var uploadUrl = presignData.uploadUrl;
  var storedName = presignData.storedName;

  // 单请求直传 S3（S3 单 PUT 最大 5GB，网站限制 2GB 足够；XHR 提供真实上传进度）
  var putResult = await new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl, true);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var p = e.loaded / e.total;
        var speed = tracker.update(e.loaded - (xhr._lastLoaded || 0));
        xhr._lastLoaded = e.loaded;
        onProgress(p, speed);
      }
    };
    xhr.onload = function() {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error('直传失败: HTTP ' + xhr.status));
    };
    xhr.onerror = function() { reject(new Error('直传失败: 网络错误')); };
    xhr.send(file);
  });

  // 通知服务器入库
  var confirmResp = await fetch('/upload/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storedName: storedName, filename: file.name, size: file.size, share: share, teamId: teamId || null, folderId: folderId || null, hash: hash || null })
  });
  if (!confirmResp.ok) {
    var cerr = await confirmResp.json().catch(function() { return {}; });
    throw new Error(cerr.error || ('确认上传失败: HTTP ' + confirmResp.status));
  }
  onProgress(1, 0);
}

// ==================== 分片上传（可断点续传） ====================
// 上传单个分片
function putChunk(file, sessionId, index, start, end, onBytes) {
  return new Promise(function (resolve, reject) {
    var blob = file.slice(start, end);
    var fd = new FormData();
    fd.append('sessionId', sessionId);
    fd.append('index', String(index));
    fd.append('chunk', blob, 'chunk');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload/chunk', true);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable && onBytes) { onBytes(e.loaded, index); }
    };
    xhr.onload = function () {
      var j = null;
      try { j = JSON.parse(xhr.responseText); } catch (e) { }
      if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) { resolve({ index: index, size: blob.size }); return; }
      reject(new Error((j && j.error) || ('分片 ' + index + ' 上传失败: HTTP ' + xhr.status)));
    };
    xhr.onerror = function () { reject(new Error('分片 ' + index + ' 网络错误')); };
    xhr.send(fd);
  });
}

// 分片上传主流程：init → 查询已传分片 → 补齐 → complete（中断后再次选择同一文件可续传）
async function chunkedUpload(file, opt, onProgress) {
  var key = opt.key;
  var st = readResumeState(key);
  var isResume = false;
  var chunkCount, chunkSize, sessionId, storedName;

  if (st && st.size === file.size && st.name === file.name) {
    sessionId = st.sessionId;
    storedName = st.storedName;
    chunkCount = st.chunkCount;
    chunkSize = st.chunkSize || Math.ceil(file.size / chunkCount);
    isResume = true;
  } else {
    var initCount = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    var initResp = await fetch('/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, size: file.size, chunkCount: initCount, share: opt.share, teamId: opt.teamId || null })
    });
    var initData = await initResp.json().catch(function () { return {}; });
    if (!initResp.ok || !initData.sessionId) {
      throw new Error(initData.error || ('初始化分片上传失败: HTTP ' + initResp.status));
    }
    sessionId = initData.sessionId;
    storedName = initData.storedName;
    chunkCount = initData.chunkCount || initCount;
    chunkSize = initData.chunkSize || Math.ceil(file.size / chunkCount);
    st = { sessionId: sessionId, storedName: storedName, chunkCount: chunkCount, chunkSize: chunkSize, size: file.size, name: file.name };
    writeResumeState(key, st);
  }

  // 查询服务端已存在的分片（断点续传：已传分片不重复上传）
  var done = {};
  var finished = 0;
  try {
    var q = await fetch('/upload/chunks?sessionId=' + encodeURIComponent(sessionId), { credentials: 'same-origin' });
    var qj = await q.json();
    if (qj && qj.ok && qj.uploaded) {
      for (var k = 0; k < qj.uploaded.length; k++) {
        var idx = qj.uploaded[k];
        if (idx >= 0 && idx < chunkCount && !done[idx]) {
          var s0 = idx * chunkSize;
          var e0 = Math.min(file.size, s0 + chunkSize);
          done[idx] = true;
          finished += (e0 - s0);
        }
      }
    }
  } catch (e) { }
  if (isResume && finished > 0 && onProgress) { onProgress(Math.min(0.99, finished / file.size), 0); }

  var todo = [];
  for (var i = 0; i < chunkCount; i++) { if (!done[i]) { todo.push(i); } }

  var tracker = createUploadTracker();
  tracker.start();
  var inflight = {};

  async function worker() {
    while (todo.length) {
      var index = todo.shift();
      var start = index * chunkSize;
      var end = Math.min(file.size, start + chunkSize);
      var res = await putChunk(file, sessionId, index, start, end, function (loaded, idx) {
        var prev = inflight[idx] || 0;
        inflight[idx] = loaded;
        finished += (loaded - prev);
        var speed = tracker.update(loaded - prev);
        if (onProgress) { onProgress(Math.min(0.99, finished / file.size), speed); }
      });
      if (inflight[index] !== undefined) { delete inflight[index]; }
      if (onProgress) { onProgress(Math.min(0.99, finished / file.size), 0); }
      void res;
    }
  }
  var workerCount = Math.max(1, Math.min(CHUNK_CONCURRENCY, todo.length));
  var workers = [];
  for (var w = 0; w < workerCount; w++) { workers.push(worker()); }
  await Promise.all(workers);

  // 合并入库（失败时保留续传记录，用户可重试）
  var compResp = await fetch('/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sessionId, storedName: storedName, filename: file.name, size: file.size,
      chunkCount: chunkCount, share: opt.share, teamId: opt.teamId || null,
      folderId: opt.folderId || null, hash: opt.hash || null
    })
  });
  var compData = await compResp.json().catch(function () { return {}; });
  if (!compResp.ok || !compData.ok) {
    throw new Error(compData.error || ('合并分片失败: HTTP ' + compResp.status));
  }
  clearResumeState(key);
  if (onProgress) { onProgress(1, 0); }
  return { fileId: compData.fileId };
}

// ==================== 智能上传：秒传 → 分片（可续传）→ 直传 ====================
async function uploadFileSmart(file, share, onProgress, teamId, folderId) {
  var hash = await computeFileHash(file);
  var key = resumeKeyOf(file, hash);

  // 1) 秒传：命中已存在文件则直接入库，跳过上传
  if (hash) {
    try {
      var chk = await fetch('/upload/check-hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash: hash, size: file.size, filename: file.name, folderId: folderId || null, teamId: teamId || null })
      });
      var cj = await chk.json().catch(function () { return {}; });
      if (chk.ok && cj && cj.instant) {
        if (onProgress) { onProgress(1, 0); }
        return { instant: true, fileId: cj.fileId };
      }
    } catch (e) { /* 秒传校验异常 → 走普通上传 */ }
  }

  // 2) 大文件：分片上传（支持断点续传）
  if (file.size >= CHUNK_UPLOAD_THRESHOLD) {
    return chunkedUpload(file, { key: key, hash: hash, share: share, teamId: teamId, folderId: folderId }, onProgress);
  }

  // 3) 小文件：预签名直传
  await multiThreadUpload(file, share, onProgress, teamId, folderId, hash);
  clearResumeState(key);
  return {};
}

// ==================== 初始化 ====================
if (SUPPORTS_MULTITHREAD) {
  onReady(function() {
    // 文件名显示 - 处理所有文件输入框（包括团队上传表单）
    document.querySelectorAll('input[type="file"]').forEach(function(fileInput) {
      if (fileInput.dataset.fileBound) return;
      fileInput.dataset.fileBound = '1';
      fileInput.addEventListener('change', function(e) {
        var label = this.closest('.file-input-wrapper');
        if (!label) {
          // 兼容没有 wrapper 的纯文件输入框（如团队表单）
          label = this.parentElement;
        }
        if (label) {
          var nameSpan = label.querySelector('.file-input-label span:first-child, .file-label-text');
          var hintSpan = label.querySelector('.file-hint');
          if (e.target.files.length > 0) {
            if (nameSpan) nameSpan.textContent = e.target.files[0].name;
            if (hintSpan) hintSpan.textContent = formatFileSize(e.target.files[0].size);
          }
        }
      });
    });

    // 多线程上传：拦截所有上传表单（个人/共享/团队）
    function setupUploadForm(uploadForm) {
      if (!uploadForm || uploadForm.dataset.uploadBound) return;
      uploadForm.dataset.uploadBound = '1';
      uploadForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var fileInput = uploadForm.querySelector('input[type="file"]');
        var file = fileInput.files[0];
        if (!file) return;

        var shareEl = uploadForm.querySelector('input[name="share"]:checked') || uploadForm.querySelector('input[name="share"]');
        var share = shareEl ? shareEl.value : 'false';
        // 团队上传：从 action 提取 /team/:teamId/upload 的 teamId
        var action = uploadForm.getAttribute('action') || '';
        var teamMatch = action.match(/\/team\/(\d+)\/upload/);
        var teamId = teamMatch ? teamMatch[1] : null;
        // 个人上传：从隐藏域读取目标文件夹（上传后跳回原文件夹）
        var folderInput = uploadForm.querySelector('input[name="folderId"]');
        var folderId = folderInput && folderInput.value ? folderInput.value : null;
        var dashboardUrl = '/dashboard' + (folderId ? '?folder=' + folderId : '');
        var submitBtn = uploadForm.querySelector('button[type="submit"]');

        // 进度条容器：优先用表单内的 .upload-progress，否则动态创建
        var progressWrap = uploadForm.querySelector('.upload-progress');
        if (!progressWrap) {
          progressWrap = document.createElement('div');
          progressWrap.className = 'upload-progress';
          progressWrap.style.display = 'none';
          uploadForm.appendChild(progressWrap);
        }
        progressWrap.style.display = 'block';
        progressWrap.innerHTML =
          '<div class="progress-track"><div class="progress-bar"></div></div>' +
          '<div class="progress-info">' +
            '<span class="progress-pct">0%</span>' +
            '<span class="progress-speed">--</span>' +
            '<span class="progress-eta"></span>' +
          '</div>';
        var bar = progressWrap.querySelector('.progress-bar');
        var pctEl = progressWrap.querySelector('.progress-pct');
        var speedEl = progressWrap.querySelector('.progress-speed');
        var etaEl = progressWrap.querySelector('.progress-eta');
        var fileNameText = file.name.length > 20 ? file.name.slice(0, 20) + '…' : file.name;

        // 存储文件大小到进度条，供 rAF renderer 计算 ETA
        bar.dataset.fileSize = file.size;

        submitBtn.disabled = true;
        submitBtn.textContent = '上传中... 0%';

        // 使用 rAF 驱动的进度渲染器
        var renderProgress = createProgressRenderer(bar, pctEl, speedEl, etaEl, submitBtn);

        uploadFileSmart(file, share, function(progress, speed) {
          renderProgress(progress, speed);
        }, teamId, folderId).then(function() {
          bar.style.width = '100%';
          pctEl.textContent = '100%';
          speedEl.textContent = '';
          setIconMsg(etaEl, 'check', '上传完成 ' + fileNameText);
          setIconMsg(submitBtn, 'check', '上传完成!');
          // 移动版：统一文案短提示「上传完成」
          if (window.mbToast) { window.mbToast('上传完成', 'ok'); }
          // 停留 1.5 秒让用户看到完成状态，再自动刷新（回到原文件夹）
          setTimeout(function() { window.location.href = dashboardUrl; }, 1500);
        }).catch(function(err) {
          console.error('上传失败:', err);
          bar.classList.add('progress-error');
          setIconMsg(etaEl, 'cross', '上传失败: ' + err.message);
          setIconMsg(submitBtn, 'cross', '上传失败, 重试');
          submitBtn.disabled = false;
          if (window.crAlert) { window.crAlert('上传失败: ' + err.message, '上传失败'); }
          else { alert('上传失败: ' + err.message); }
        });
      });
    }

    setupUploadForm(document.querySelector('.upload-form'));
    document.querySelectorAll('form[action*="/team/"][action$="/upload"]').forEach(setupUploadForm);

  });
} else {
  // 老浏览器降级：用 XMLHttpRequest 实现上传进度条（XHR 比 fetch 兼容性更广）
  onReady(function() {
    // 文件名显示
    document.querySelectorAll('input[type="file"]').forEach(function(fileInput) {
      if (fileInput.dataset.fileBound) return;
      fileInput.dataset.fileBound = '1';
      fileInput.addEventListener('change', function(e) {
        var label = this.closest('.file-input-wrapper');
        if (!label) label = this.parentElement;
        if (label) {
          var nameSpan = label.querySelector('.file-input-label span:first-child, .file-label-text');
          if (e.target.files.length > 0) {
            if (nameSpan) nameSpan.textContent = e.target.files[0].name;
          }
        }
      });
    });

    // 上传拦截：XHR + 进度条（所有上传表单：个人/共享/团队）
    if (typeof XMLHttpRequest === 'undefined' || typeof FormData === 'undefined') return;
    var xhrUploadSupported = false;
    try { xhrUploadSupported = !!(new XMLHttpRequest().upload); } catch (e) {}
    if (!xhrUploadSupported) return;

    document.querySelectorAll('form[action="/upload"], form[action*="/team/"][action$="/upload"]').forEach(function(uploadForm) {
      if (uploadForm.dataset.uploadBound) return;
      uploadForm.dataset.uploadBound = '1';
      uploadForm.addEventListener('submit', function(e) {
        var fileInput = uploadForm.querySelector('input[type="file"]');
        var file = fileInput && fileInput.files ? fileInput.files[0] : null;
        if (!file) return; // 无文件，走原生校验

        var progressWrap = uploadForm.querySelector('.upload-progress');
        if (!progressWrap) return; // 无进度条容器，走原生
        if (e.preventDefault) e.preventDefault(); else e.returnValue = false;

        // 读取 share 值
        var shareEl = uploadForm.querySelector('input[name="share"]:checked') || uploadForm.querySelector('input[name="share"]');
        var share = shareEl ? shareEl.value : 'false';
        var action = uploadForm.getAttribute('action') || '';
        // 个人上传：从隐藏域读取目标文件夹（上传后跳回原文件夹）
        var folderInput2 = uploadForm.querySelector('input[name="folderId"]');
        var legacyDashboardUrl = '/dashboard' + (folderInput2 && folderInput2.value ? '?folder=' + folderInput2.value : '');

        progressWrap.style.display = 'block';
        var bar = progressWrap.querySelector('.progress-bar');
        var pctEl = progressWrap.querySelector('.progress-pct');
        var speedEl = progressWrap.querySelector('.progress-speed');
        var etaEl = progressWrap.querySelector('.progress-eta');
        var submitBtn = uploadForm.querySelector('button[type="submit"]');
        var fileNameText = file.name.length > 20 ? file.name.slice(0, 20) + '…' : file.name;
        var startTime = Date.now();

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = '上传中... 0%';
        }

        var xhr = new XMLHttpRequest();
        var fd = new FormData();
        var inputs = uploadForm.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          var inp = inputs[i];
          if (inp.type === 'file') continue;
          if (inp.type === 'radio' && !inp.checked) continue;
          if (inp.type === 'checkbox' && !inp.checked) continue;
          if (inp.name) fd.append(inp.name, inp.value);
        }
        fd.append('file', file);

        if (xhr.upload && xhr.upload.addEventListener) {
          xhr.upload.addEventListener('progress', function(pe) {
            if (!pe.lengthComputable) return;
            var pct = Math.round(pe.loaded / pe.total * 100);
            var elapsed = (Date.now() - startTime) / 1000;
            var speed = elapsed > 0 ? pe.loaded / elapsed : 0;
            if (bar) bar.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
            if (submitBtn) submitBtn.textContent = '上传中... ' + pct + '%';
            if (speedEl && speed > 0) speedEl.textContent = formatFileSize(speed) + '/s';
            if (etaEl && speed > 0) {
              var remain = (pe.total - pe.loaded) / speed;
              if (remain > 0 && isFinite(remain)) {
                etaEl.textContent = '剩余 ' + (remain < 60 ? Math.ceil(remain) + '秒' : Math.ceil(remain / 60) + '分钟');
              }
            }
          }, false);
        }

        xhr.onreadystatechange = function() {
          if (xhr.readyState !== 4) return;
          if (xhr.status >= 200 && xhr.status < 400) {
            if (bar) bar.style.width = '100%';
            if (pctEl) pctEl.textContent = '100%';
            if (speedEl) speedEl.textContent = '';
            if (etaEl) setIconMsg(etaEl, 'check', '上传完成 ' + fileNameText);
            if (submitBtn) setIconMsg(submitBtn, 'check', '上传完成!');
            // 移动版：统一文案短提示「上传完成」
            if (window.mbToast) { window.mbToast('上传完成', 'ok'); }
            setTimeout(function() { window.location.href = legacyDashboardUrl; }, 1500);
          } else {
            setIconMsg(etaEl, 'cross', '上传失败: HTTP ' + xhr.status);
            if (submitBtn) {
              submitBtn.disabled = false;
              setIconMsg(submitBtn, 'cross', '上传失败, 重试');
            }
          }
        };

        xhr.open('POST', action, true);
        xhr.send(fd);
      });
    });
  });
}

// ==================== 拖拽上传：递归收集文件（供 dashboard 使用） ====================
// 返回 Promise<File[]>；支持拖入文件夹（webkitGetAsEntry 递归，深度上限 12 层）
function readAllEntries(entries) {
  var results = [];
  function walkEntry(entry, depth) {
    return new Promise(function (resolve) {
      if (!entry || depth > 12) { resolve(); return; }
      if (entry.isFile) {
        entry.file(function (f) { results.push(f); resolve(); }, function () { resolve(); });
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        var acc = [];
        (function readMore() {
          reader.readEntries(function (batch) {
            if (!batch.length) {
              Promise.all(acc.map(function (e) { return walkEntry(e, depth + 1); })).then(function () { resolve(); });
              return;
            }
            for (var i = 0; i < batch.length; i++) { acc.push(batch[i]); }
            readMore();
          }, function () { resolve(); });
        })();
      } else { resolve(); }
    });
  }
  return Promise.all(entries.map(function (e) { return walkEntry(e, 0); })).then(function () { return results; });
}

function collectDroppedFiles(dt) {
  return new Promise(function (resolve) {
    if (!dt) { resolve([]); return; }
    var entries = [];
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        var it = dt.items[i];
        if (it.kind !== 'file') { continue; }
        var en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
        if (en) { entries.push(en); }
      }
    }
    if (entries.length) {
      readAllEntries(entries).then(resolve).catch(function () { resolve([]); });
      return;
    }
    var out = [];
    var files = dt.files;
    if (files && files.length) { for (var j = 0; j < files.length; j++) { out.push(files[j]); } }
    resolve(out);
  });
}

if (typeof window !== 'undefined') {
  window.crCollectDroppedFiles = collectDroppedFiles;
  window.crComputeFileHash = computeFileHash;
  window.crUploadFileSmart = uploadFileSmart;
}