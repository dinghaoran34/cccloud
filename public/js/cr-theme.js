// 团队云 - 现代变体公共交互（浅深色主题 / 侧边栏抽屉 / 用户下拉）
// 仅被现代变体（*.ejs）引用；*-mobile.ejs / *-legacy.ejs 不使用本文件。
(function () {
  'use strict';

  var THEME_KEY = 'cr_theme';

  function root() { return document.documentElement; }

  function readTheme() {
    try {
      var v = localStorage.getItem(THEME_KEY);
      return (v === 'dark' || v === 'light') ? v : null;
    } catch (e) { return null; }
  }

  function writeTheme(v) {
    try { localStorage.setItem(THEME_KEY, v); } catch (e) { /* 隐私模式忽略 */ }
  }

  function applyTheme(v) {
    if (v) { root().setAttribute('data-theme', v); }
    else { root().removeAttribute('data-theme'); }
  }

  // 页面 head 中的内联脚本已提前应用一次，这里再同步一次（避免被其它脚本覆盖）
  applyTheme(readTheme());

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function isDarkNow() {
    var t = readTheme();
    if (t === 'dark') { return true; }
    if (t === 'light') { return false; }
    return systemDark();
  }

  // 通知页面其它部分（如聊天页需要同步 body.dark）
  function notify() {
    try {
      document.dispatchEvent(new CustomEvent('cr:themechange', {
        detail: { theme: readTheme() || 'system', dark: isDarkNow() }
      }));
    } catch (e) { /* 老浏览器忽略 */ }
  }

  // 设置主题：'light' | 'dark' | 'system'
  function setTheme(v) {
    if (v === 'light' || v === 'dark') { writeTheme(v); applyTheme(v); }
    else { try { localStorage.removeItem(THEME_KEY); } catch (e) { } applyTheme(null); }
    notify();
  }

  function toggleTheme() {
    setTheme(isDarkNow() ? 'light' : 'dark');
  }

  window.crToggleTheme = toggleTheme;
  window.crSetTheme = setTheme;
  window.crGetTheme = function () { return readTheme() || 'system'; };
  window.crIsDark = isDarkNow;

  // 未手动选择时跟随系统变化
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (!readTheme()) { applyTheme(null); notify(); }
    };
    if (mq.addEventListener) { mq.addEventListener('change', onChange); }
    else if (mq.addListener) { mq.addListener(onChange); }
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else { fn(); }
  }

  onReady(function () {
    // 主题切换按钮（事件委托，支持动态插入）
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-cr-theme-toggle]') : null;
      if (btn) { e.preventDefault(); toggleTheme(); return; }

      // 侧边栏抽屉
      var burger = e.target.closest ? e.target.closest('[data-cr-drawer-open]') : null;
      if (burger) {
        e.preventDefault();
        var app = document.querySelector('.cr-app');
        if (app) { app.classList.toggle('cr-drawer-open'); }
        return;
      }
      var mask = e.target.closest ? e.target.closest('.cr-mask') : null;
      if (mask) {
        var appEl = document.querySelector('.cr-app');
        if (appEl) { appEl.classList.remove('cr-drawer-open'); }
        return;
      }

      // 用户下拉
      var userBtn = e.target.closest ? e.target.closest('.cr-user-btn') : null;
      var menus = document.querySelectorAll('.cr-menu.is-open');
      if (userBtn) {
        e.preventDefault();
        var menu = userBtn.parentNode.querySelector('.cr-menu');
        for (var i = 0; i < menus.length; i++) {
          if (menus[i] !== menu) { menus[i].classList.remove('is-open'); }
        }
        if (menu) { menu.classList.toggle('is-open'); }
        return;
      }
      for (var j = 0; j < menus.length; j++) {
        if (!menus[j].contains(e.target)) { menus[j].classList.remove('is-open'); }
      }
    });

    // 点击侧边栏导航后自动收起抽屉（移动端）
    var nav = document.querySelector('.cr-side .cr-nav');
    if (nav) {
      nav.addEventListener('click', function (e) {
        if (!e.target.closest || !e.target.closest('.cr-nav-item')) { return; }
        var app = document.querySelector('.cr-app');
        if (app) { app.classList.remove('cr-drawer-open'); }
      });
    }

    // Esc 关闭抽屉 / 下拉
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' && e.keyCode !== 27) { return; }
      var app = document.querySelector('.cr-app');
      if (app) { app.classList.remove('cr-drawer-open'); }
      var open = document.querySelectorAll('.cr-menu.is-open');
      for (var i = 0; i < open.length; i++) { open[i].classList.remove('is-open'); }
    });
  });
})();
