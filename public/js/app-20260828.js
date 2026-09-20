// 团队云 - 多线程分片上传/下载 (现代浏览器版)
// 上传: 文件切成小片, 并发4线程上传, 使用 requestAnimationFrame 优化进度渲染
// 下载: 通过 HTTP Range 并发拉取分片, Blob 合并 (支持个人/共享/团队文件)
// 老浏览器自动降级: 使用原生表单提交和普通链接下载

const CHUNK_SIZE = 4 * 1024 * 1024; // 每片 4MB
const CONCURRENCY = 4;               // 并发线程数

// 兼容性检测：不支持 fetch/Blob/Promise 的老浏览器直接用原生行为
const SUPPORTS_MULTITHREAD = (typeof fetch !== 'undefined' &&
  typeof Blob !== 'undefined' &&
  typeof Promise !== 'undefined' &&
  typeof FormData !== 'undefined' &&
  typeof URL !== 'undefined' && URL.createObjectURL);

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function onReady(cb) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', cb);
  } else {
    cb();
  }
}

// 让出主线程，防止 UI 卡死（在批量上传/下载分片时周期性调用）
function yieldToMain() {
  return new Promise(function(resolve) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function() { resolve(); }, { timeout: 50 });
    } else {
      setTimeout(resolve, 0);
    }
  });
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

async function multiThreadUpload(file, share, onProgress, teamId) {
  var totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  var tracker = createUploadTracker();
  tracker.start();

  if (file.size < CHUNK_SIZE) {
    // 小文件直接单请求上传（fetch 不提供上传进度，用确定性动画模拟）
    var formData = new FormData();
    formData.append('file', file);
    formData.append('share', share);
    if (teamId) formData.append('teamId', teamId);
    var startTime = Date.now();
    var anim = setInterval(function() {
      var elapsed = (Date.now() - startTime) / 1000;
      var simulated = Math.min(0.9, elapsed / 8 * 0.9);
      var speed = file.size * 0.9 / Math.max(8, elapsed);
      onProgress(simulated, speed);
    }, 200);
    try {
      var resp = await fetch('/upload', { method: 'POST', body: formData });
      if (!resp.redirected && !resp.ok) throw new Error('HTTP ' + resp.status);
    } finally {
      clearInterval(anim);
    }
    onProgress(1, 0);
    return;
  }

  // 1. 初始化
  var initResp = await fetch('/upload/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, size: file.size, chunkCount: totalChunks, share: share, teamId: teamId || null })
  });
  if (!initResp.ok) throw new Error('初始化失败: HTTP ' + initResp.status);
  var initData = await initResp.json();
  var sessionId = initData.sessionId;
  var storedName = initData.storedName;

  // 2. 并发上传分片
  var uploaded = 0;
  var queue = [];
  for (var i = 0; i < totalChunks; i++) queue.push(i);

  async function worker() {
    while (queue.length > 0) {
      var index = queue.shift();
      var start = index * CHUNK_SIZE;
      var end = Math.min(start + CHUNK_SIZE, file.size);
      var blob = file.slice(start, end);
      var formData = new FormData();
      formData.append('chunk', blob, 'chunk-' + index);
      formData.append('sessionId', sessionId);
      formData.append('index', index);
      var resp = await fetch('/upload/chunk', { method: 'POST', body: formData });
      if (!resp.ok) throw new Error('分片 ' + index + ' 上传失败: HTTP ' + resp.status);
      uploaded++;
      var speed = tracker.update(CHUNK_SIZE);
      onProgress(uploaded / totalChunks, speed);
      // 每上传 4 个分片让出一次主线程，防止 UI 卡死
      if (uploaded % 4 === 0) {
        await yieldToMain();
      }
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(CONCURRENCY, totalChunks); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // 3. 合并
  var completeResp = await fetch('/upload/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sessionId, storedName: storedName, filename: file.name, size: file.size, chunkCount: totalChunks, share: share, teamId: teamId || null })
  });
  if (!completeResp.ok) {
    var errData = await completeResp.json().catch(function() { return {}; });
    throw new Error('合并失败: ' + (errData.error || ('HTTP ' + completeResp.status)));
  }
  onProgress(1, 0);
}

// ==================== 多线程下载 ====================
// downloadUrl: 完整下载 URL，如 "/download/5" 或 "/team/1/download/5"
async function multiThreadDownload(downloadUrl, fileName, onProgress) {
  // 先探测文件大小 (Range 请求)
  var probeResp = await fetch(downloadUrl, {
    method: 'GET',
    headers: { 'Range': 'bytes=0-0' }
  });
  if (!probeResp.ok) throw new Error('无法读取文件: HTTP ' + probeResp.status);

  var contentRange = probeResp.headers.get('Content-Range');
  var totalSize = contentRange ? parseInt(contentRange.split('/')[1], 10) : 0;
  if (!totalSize) {
    // 服务器不支持 Range，退化为普通下载
    window.location.href = downloadUrl;
    return;
  }

  var chunkSize = 4 * 1024 * 1024;
  var totalChunks = Math.ceil(totalSize / chunkSize);
  var chunks = new Array(totalChunks);
  var downloaded = 0;
  var failed = 0;

  // 目标文件名（优先从 Content-Disposition 解析）
  var finalName = fileName;
  if (!finalName || finalName === '下载' || finalName.indexOf('...') !== -1 || finalName.indexOf('✅') !== -1 || finalName.indexOf('中') !== -1) {
    var cd = probeResp.headers.get('Content-Disposition') || '';
    var m = cd.match(/filename\*=UTF-8''([^;]+)/);
    if (m) {
      finalName = decodeURIComponent(m[1]);
    } else {
      // 从 URL 中提取 fileId 作为后备文件名
      var parts = downloadUrl.split('/');
      finalName = 'file-' + parts[parts.length - 1];
    }
  }

  async function downloadChunk(index) {
    var start = index * chunkSize;
    var end = Math.min(start + chunkSize, totalSize) - 1;
    var resp = await fetch(downloadUrl, {
      headers: { 'Range': 'bytes=' + start + '-' + end }
    });
    if (!resp.ok) throw new Error('分片 ' + index + ' 下载失败: HTTP ' + resp.status);
    var buf = await resp.arrayBuffer();
    chunks[index] = buf;
    downloaded++;
    onProgress(downloaded / totalChunks);
    // 每下载 4 个分片让出一次主线程
    if (downloaded % 4 === 0) {
      await yieldToMain();
    }
  }

  async function safeDownload(index) {
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        await downloadChunk(index);
        return;
      } catch (err) {
        if (attempt === 2) { failed++; throw err; }
        await new Promise(function(r) { setTimeout(r, 500 * (attempt + 1)); });
      }
    }
  }

  var queue = [];
  for (var i = 0; i < totalChunks; i++) queue.push(i);

  async function worker() {
    while (queue.length > 0) {
      var idx = queue.shift();
      await safeDownload(idx);
    }
  }

  var workers = [];
  for (var w = 0; w < Math.min(CONCURRENCY, totalChunks); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (failed > 0) throw new Error(failed + ' 个分片下载失败');

  // 合并 Blob 并触发下载
  var blob = new Blob(chunks, { type: 'application/octet-stream' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = finalName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  onProgress(1);
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
            if (nameSpan) nameSpan.textContent = '📎 ' + e.target.files[0].name;
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

        var shareEl = uploadForm.querySelector('input[name="share"]:checked');
        var share = shareEl ? shareEl.value : 'false';
        // 团队上传：从 action 提取 /team/:teamId/upload 的 teamId
        var action = uploadForm.getAttribute('action') || '';
        var teamMatch = action.match(/\/team\/(\d+)\/upload/);
        var teamId = teamMatch ? teamMatch[1] : null;
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

        multiThreadUpload(file, share, function(progress, speed) {
          renderProgress(progress, speed);
        }, teamId).then(function() {
          bar.style.width = '100%';
          pctEl.textContent = '100%';
          speedEl.textContent = '';
          etaEl.textContent = '✅ 上传完成 ' + fileNameText;
          submitBtn.textContent = '✅ 上传完成!';
          // 停留 1.5 秒让用户看到完成状态，再自动刷新
          setTimeout(function() { window.location.href = '/dashboard'; }, 1500);
        }).catch(function(err) {
          console.error('上传失败:', err);
          bar.classList.add('progress-error');
          etaEl.textContent = '❌ 上传失败: ' + err.message;
          submitBtn.textContent = '❌ 上传失败, 重试';
          submitBtn.disabled = false;
          alert('上传失败: ' + err.message);
        });
      });
    }

    setupUploadForm(document.querySelector('.upload-form'));
    document.querySelectorAll('form[action*="/team/"][action$="/upload"]').forEach(setupUploadForm);

    // ==================== 多线程下载：拦截所有下载链接 ====================
    // 处理个人/共享文件下载链接: /download/:id
    // 处理团队文件下载链接: /team/:teamId/download/:fileId
    function setupDownloadLink(link) {
      if (link.dataset.downloadBound) return;
      link.dataset.downloadBound = '1';
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var href = link.getAttribute('href');
        // 提取文件容器（兼容表格行 tr 和移动卡片 .file-item）
        var container = link.closest('tr') || link.closest('.file-item');
        var nameEl = container ? container.querySelector('.file-name') : null;
        var fileName = nameEl ? nameEl.textContent.trim() : ('file-' + (href.split('/').pop()));
        link.textContent = '下载中...';
        multiThreadDownload(href, fileName, function(progress) {
          link.textContent = progress >= 1 ? '✅ 完成' : ('下载中 ' + Math.round(progress * 100) + '%');
        }).then(function() {
          setTimeout(function() { link.textContent = '下载'; }, 3000);
        }).catch(function(err) {
          console.error('下载失败:', err);
          link.textContent = '下载';
          alert('下载失败: ' + err.message);
        });
      });
    }

    // 匹配所有下载链接：/download/:id 和 /team/:id/download/:id
    document.querySelectorAll('a[href^="/download/"], a[href*="/team/"][href$="/download/"]').forEach(setupDownloadLink);
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
            if (nameSpan) nameSpan.textContent = '📎 ' + e.target.files[0].name;
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
        var shareEl = uploadForm.querySelector('input[name="share"]:checked');
        var share = shareEl ? shareEl.value : 'false';
        var action = uploadForm.getAttribute('action') || '';

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
            if (etaEl) etaEl.textContent = '✅ 上传完成 ' + fileNameText;
            if (submitBtn) submitBtn.textContent = '✅ 上传完成!';
            setTimeout(function() { window.location.href = '/dashboard'; }, 1500);
          } else {
            if (etaEl) etaEl.textContent = '❌ 上传失败: HTTP ' + xhr.status;
            if (submitBtn) {
              submitBtn.disabled = false;
              submitBtn.textContent = '❌ 上传失败, 重试';
            }
          }
        };

        xhr.open('POST', action, true);
        xhr.send(fd);
      });
    });
  });
}