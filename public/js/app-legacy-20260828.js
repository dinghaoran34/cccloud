// ES3 兼容 - 文件选择显示 + 上传进度条（XMLHttpRequest 版，兼容老浏览器）
function initFileInput() {
  var fileInput = document.getElementById('fileInput');
  if (!fileInput) return;

  var fileNameSpan = document.getElementById('fileName');
  var fileHintSpan = document.getElementById('fileHint');

  // 兼容旧浏览器的事件绑定
  if (fileInput.addEventListener) {
    fileInput.addEventListener('change', onFileChange, false);
  } else if (fileInput.attachEvent) {
    fileInput.attachEvent('onchange', onFileChange);
  } else {
    fileInput.onchange = onFileChange;
  }

  function onFileChange(e) {
    var evt = e || window.event;
    var target = evt.target || evt.srcElement;
    if (target.files && target.files.length > 0) {
      var f = target.files[0];
      if (fileNameSpan) {
        fileNameSpan.innerHTML = '[附件] ' + f.name;
      }
      if (fileHintSpan) {
        fileHintSpan.innerHTML = formatFileSize(f.size);
      }
    } else if (target.value && target.value !== '') {
      // 旧浏览器没有 files 属性，用 value
      var parts = target.value.replace(/\\/g, '/').split('/');
      var fname = parts[parts.length - 1];
      if (fileNameSpan) {
        fileNameSpan.innerHTML = '[附件] ' + fname;
      }
      if (fileHintSpan) {
        fileHintSpan.innerHTML = '已选择文件';
      }
    } else {
      if (fileNameSpan) {
        fileNameSpan.innerHTML = '选择文件';
      }
      if (fileHintSpan) {
        fileHintSpan.innerHTML = '支持单个文件，最大1GB';
      }
    }
  }
}

// ========== 上传进度条（XHR，兼容 IE8+/老浏览器） ==========
function setupLegacyUpload() {
  var forms = document.getElementsByTagName('form');
  for (var i = 0; i < forms.length; i++) {
    var form = forms[i];
    var action = form.getAttribute('action') || '';
    var isUpload = (action === '/upload' || action.indexOf('/team/') !== -1 && action.indexOf('/upload') !== -1);
    if (!isUpload) continue;
    if (form.getAttribute('data-upload-bound')) continue;
    form.setAttribute('data-upload-bound', '1');

    bindLegacyForm(form);
  }
}

function bindLegacyForm(form) {
  if (form.addEventListener) {
    form.addEventListener('submit', handleLegacySubmit, false);
  } else if (form.attachEvent) {
    form.attachEvent('onsubmit', handleLegacySubmit);
  } else {
    form.onsubmit = handleLegacySubmit;
  }

  function handleLegacySubmit(e) {
    var evt = e || window.event;
    var fileInput = form.querySelector ? form.querySelector('input[type="file"]') : null;
    // 老浏览器没有 querySelector，遍历找 file 输入
    if (!fileInput) {
      var inputs = form.getElementsByTagName('input');
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].type === 'file') { fileInput = inputs[i]; break; }
      }
    }
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return; // 无文件时走原生校验

    // 不支持 XHR upload 进度事件的老浏览器，直接原生提交
    if (typeof XMLHttpRequest === 'undefined' || !(new XMLHttpRequest().upload)) return;

    var file = fileInput.files[0];
    var submitBtn = findSubmitButton(form);
    var progressWrap = form.querySelector ? form.querySelector('.upload-progress') : null;
    if (!progressWrap) return; // 无进度条容器，走原生

    if (evt.preventDefault) evt.preventDefault(); else evt.returnValue = false;

    progressWrap.style.display = 'block';
    var bar = progressWrap.getElementsByClassName('progress-bar')[0];
    var pctEl = progressWrap.getElementsByClassName('progress-pct')[0];
    var speedEl = progressWrap.getElementsByClassName('progress-speed')[0];
    var etaEl = progressWrap.getElementsByClassName('progress-eta')[0];
    if (!bar) return;

    var startTime = new Date().getTime();
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '上传中... 0%';
    }

    var xhr = new XMLHttpRequest();
    var formData = new FormData();
    var inputs = form.getElementsByTagName('input');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.type === 'file') continue;
      if (inp.type === 'radio' && !inp.checked) continue;
      if (inp.type === 'checkbox' && !inp.checked) continue;
      if (inp.name) formData.append(inp.name, inp.value);
    }
    formData.append('file', file);

    // 进度事件
    if (xhr.upload && xhr.upload.addEventListener) {
      xhr.upload.addEventListener('progress', function(pe) {
        if (!pe.lengthComputable) return;
        var pct = Math.round(pe.loaded / pe.total * 100);
        var elapsed = (new Date().getTime() - startTime) / 1000;
        var speed = elapsed > 0 ? pe.loaded / elapsed : 0;
        if (bar.style) bar.style.width = pct + '%';
        if (pctEl) pctEl.innerHTML = pct + '%';
        if (submitBtn) submitBtn.innerHTML = '上传中... ' + pct + '%';
        if (speedEl && speed > 0) speedEl.innerHTML = formatFileSize(speed) + '/s';
        if (etaEl && speed > 0) {
          var remain = (pe.total - pe.loaded) / speed;
          if (remain > 0 && isFinite(remain)) {
            etaEl.innerHTML = '剩余 ' + (remain < 60 ? Math.ceil(remain) + '秒' : Math.ceil(remain / 60) + '分钟');
          }
        }
      }, false);
    }

    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 400) {
        // 上传成功
        if (bar.style) bar.style.width = '100%';
        if (pctEl) pctEl.innerHTML = '100%';
        if (speedEl) speedEl.innerHTML = '';
        if (etaEl) etaEl.innerHTML = '✅ 上传完成 ' + file.name;
        if (submitBtn) submitBtn.innerHTML = '✅ 上传完成!';
        // 延迟 1.5 秒后自动刷新页面（让用户看清完成状态）
        setTimeout(function() {
          if (form.getAttribute('action').indexOf('/team/') !== -1) {
            // 团队上传：刷新当前页即可（团队列表在页面内）
            window.location.reload();
          } else {
            window.location.href = '/dashboard';
          }
        }, 1500);
      } else {
        if (bar.className) bar.className = 'progress-bar progress-error';
        if (etaEl) etaEl.innerHTML = '❌ 上传失败: HTTP ' + xhr.status;
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '❌ 上传失败, 重试';
        }
      }
    };

    xhr.open('POST', form.getAttribute('action'), true);
    xhr.send(formData);
  }
}

function findSubmitButton(form) {
  var btns = form.getElementsByTagName('button');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].type === 'submit') return btns[i];
  }
  return null;
}

function formatFileSize(bytes) {
  var b = parseInt(bytes, 10);
  if (isNaN(b)) return '未知大小';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (Math.round((b / 1024) * 10) / 10) + ' KB';
  if (b < 1073741824) return (Math.round((b / 1048576) * 10) / 10) + ' MB';
  return (Math.round((b / 1073741824) * 10) / 10) + ' GB';
}

// 页面加载完成后初始化
function onReady(callback) {
  var state = document.readyState;
  if (state === 'complete' || state === 'interactive') {
    // DOM 已就绪，立即执行
    setTimeout(callback, 0);
  } else if (document.addEventListener) {
    document.addEventListener('DOMContentLoaded', callback, false);
  } else if (window.attachEvent) {
    window.attachEvent('onload', callback);
  } else {
    window.onload = callback;
  }
}

onReady(function() {
  initFileInput();
  setupLegacyUpload();
});
