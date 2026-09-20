// 生成 SVG 图标集 → public/icons/
// 设计语言（原创几何，不参考任何第三方素材）：
//   · 统一画布 viewBox="0 0 24 24"，四周约 2px 内边距
//   · 圆角填充为主（filled + rounded），圆角半径约为图标边长的 22%~25%
//   · 单色功能图标 = 单一实色剪影（便于 CSS mask 重着色）
//   · 文件类型图标 = 类型主色圆角「卡片」+ 镂空类型符号（负形），叠在主题自适应浅底块上
// 配色令牌：见 style.css / style-mobile.css 的 --cr-* 与 --cr-tint-*
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 几何工具 ---------------- */
const f = n => (Math.round(n * 100) / 100);
const pt = p => f(p[0]) + ' ' + f(p[1]);

// 圆角矩形（绝对坐标）
function rr(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const R = f(r);
  return `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${R} ${R} 0 0 1 ${R} ${R}v${f(h - 2 * r)}`
    + `a${R} ${R} 0 0 1 ${f(-r)} ${R}h${f(-(w - 2 * r))}a${R} ${R} 0 0 1 ${f(-r)} ${f(-r)}`
    + `v${f(-(h - 2 * r))}a${R} ${R} 0 0 1 ${R} ${f(-r)}z`;
}
// 圆
function circle(cx, cy, r) {
  return `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0z`;
}
// 椭圆
function ellipse(cx, cy, rx, ry) {
  return `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0z`;
}
// 圆角多边形（二次贝塞尔倒角，保证全图标圆角一致）
function roundPoly(pts, r) {
  const n = pts.length;
  const at = i => pts[((i % n) + n) % n];
  const seg = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L, L];
  };
  let d = '';
  for (let i = 0; i < n; i++) {
    const p = at(i), prev = at(i - 1), next = at(i + 1);
    const [ux, uy, L1] = seg(prev, p), [vx, vy, L2] = seg(p, next);
    const r1 = Math.min(r, L1 / 2), r2 = Math.min(r, L2 / 2);
    const a = [p[0] - ux * r1, p[1] - uy * r1];
    const b = [p[0] + vx * r2, p[1] + vy * r2];
    d += (i === 0 ? 'M' : 'L') + pt(a) + `Q${pt(p)} ${pt(b)}`;
  }
  return d + 'Z';
}
// 旋转圆角矩形（中心 + 尺寸 + 旋转角），用于斜向构件
function rotRR(cx, cy, w, h, r, deg) {
  const a = w / 2, b = h / 2, rad = deg * Math.PI / 180;
  const co = Math.cos(rad), si = Math.sin(rad);
  const T = (x, y) => [cx + x * co - y * si, cy + x * si + y * co];
  const A = `A${f(r)} ${f(r)} 0 0 1 `;
  const p1 = T(-a + r, -b), p2 = T(a - r, -b), p3 = T(a, -b + r), p4 = T(a, b - r),
    p5 = T(a - r, b), p6 = T(-a + r, b), p7 = T(-a, b - r), p8 = T(-a, -b + r);
  return `M${pt(p1)}L${pt(p2)}${A}${pt(p3)}L${pt(p4)}${A}${pt(p5)}L${pt(p6)}${A}${pt(p7)}L${pt(p8)}${A}${pt(p1)}Z`;
}

/* ---------------- 组装 ---------------- */
const NS = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">';
// 单一实色剪影（镂空用 evenodd）
function one(d, color) {
  return `${NS}<path fill="${color}" fill-rule="evenodd" d="${d}"/></svg>\n`;
}
function wrap(inner) {
  return `${NS}${inner}</svg>\n`;
}
// 把若干段 path 数据包成 <path d="..."/>（禁止裸 path 数据）
function pth(d, extra) {
  return `<path d="${d}"${extra ? ' ' + extra : ''}/>`;
}
// 分组并集（同色多段，互不互凿）
function group(ds, color, opacity) {
  return `<g fill="${color}"${opacity ? ` opacity="${opacity}"` : ''}>` + ds.map(d => pth(d)).join('') + '</g>';
}

/* ---------------- 文件类型：主色 + 浅底（浅底由 CSS 令牌 --cr-tint-* 提供） ---------------- */
// 类型卡片（圆角 3.2 / 宽 14 ≈ 23%），镂空符号落在卡面内
const CARD = rr(5, 2.8, 14, 18.4, 3.2);
const card = marks => CARD + marks.join('');

const TYPE_COLOR = {
  folder: '#4C8DFF', image: '#22C55E', video: '#7C5CFC', doc: '#2B7DE9',
  xls: '#16A34A', ppt: '#EA580C', pdf: '#E5484D', audio: '#F59E0B',
  archive: '#EAB308', text: '#64748B', code: '#06B6D4', exe: '#475569',
  other: '#94A3B8'
};

// xls：3×3 圆角格子
const xlsMarks = [];
[7.8, 10.8, 13.8].forEach(y => [7.9, 10.9, 13.9].forEach(x => xlsMarks.push(rr(x, y, 2.2, 2.2, 0.7))));

// code：一对圆角尖括号（dir=+1 为「<」臂向右；dir=-1 为「>」臂向左）
function chevron(dir) {
  const ax = dir > 0 ? 8.5 : 15.5, ay = 12;
  const L = 3.4, t = 1.9, u = 0.7071;
  const ux = dir * u, uy = -u;      // 上臂方向
  const nx = -dir * u, ny = -u;     // 上臂外侧法线
  const dOut = (t / 2) / Math.sin(Math.PI / 4);
  const E1 = [ax + ux * L, ay + uy * L];
  const O1 = [E1[0] + nx * t / 2, E1[1] + ny * t / 2];
  const I1 = [E1[0] - nx * t / 2, E1[1] - ny * t / 2];
  const E2 = [ax + ux * L, ay - uy * L];
  const O2 = [E2[0] + nx * t / 2, E2[1] - ny * t / 2];
  const I2 = [E2[0] - nx * t / 2, E2[1] + ny * t / 2];
  const OA = [ax - dir * dOut, ay];
  const IA = [ax + dir * dOut, ay];
  return roundPoly([O1, OA, O2, I2, IA, I1], 0.6);
}

const fileIcons = {
  // 文档：三行文字（末行短）
  'file-doc': card([rr(8.2, 7.8, 7.6, 1.9, 0.95), rr(8.2, 11.3, 7.6, 1.9, 0.95), rr(8.2, 14.8, 4.6, 1.9, 0.95)]),
  // 文本：四行细文字（末行短）
  'file-text': card([rr(8.2, 7.8, 7.6, 1.5, 0.75), rr(8.2, 10.6, 7.6, 1.5, 0.75), rr(8.2, 13.4, 7.6, 1.5, 0.75), rr(8.2, 16.2, 4.6, 1.5, 0.75)]),
  // 其他：两行 + 短块
  'file-generic': card([rr(8.2, 9.0, 7.6, 1.8, 0.9), rr(8.2, 12.6, 7.6, 1.8, 0.9), rr(8.2, 16.2, 2.6, 1.8, 0.9)]),
  // PDF：字母 P（圆角负形，单条子路径）
  'file-pdf': card(['M8.9 16.4V8.4a1 1 0 0 1 1-1h1.9a3.25 3.25 0 0 1 0 6.5h-.7v2.5a1.1 1.1 0 0 1-2.2 0z']),
  // 表格：3×3 格子
  'file-xls': card(xlsMarks),
  // 演示：屏幕 + 支架 + 底座
  'file-ppt': card([rr(8.2, 7.4, 7.6, 4.9, 1.3), rr(11.1, 13.4, 1.8, 2.5, 0.9), rr(9.6, 15.9, 4.8, 1.1, 0.55)]),
  // 图片：太阳 + 山形
  'file-img': card([circle(10.3, 9.7, 1.6), 'M8.2 17.2l3.6-4.2 2.5 2.8 2-2.3 1.9 3.7z']),
  // 视频：播放三角（圆角）
  'file-video': card([roundPoly([[10.3, 7.9], [16.4, 12], [10.3, 16.1]], 0.9)]),
  // 音频：波形条
  'file-audio': card([rr(8.2, 10.2, 1.6, 3.6, 0.8), rr(10.6, 8.4, 1.6, 7.2, 0.8), rr(13.0, 9.6, 1.6, 4.8, 0.8), rr(15.4, 10.8, 1.6, 2.4, 0.8)]),
  // 压缩包：顶带 + 拉链条
  'file-archive': card([rr(8.2, 7.6, 7.6, 1.6, 0.8), rr(11.1, 10.1, 1.8, 1.8, 0.5), rr(11.1, 12.7, 1.8, 1.8, 0.5), rr(11.1, 15.3, 1.8, 1.8, 0.5)]),
  // 代码：< >
  'file-code': card([chevron(-1), chevron(1)]),
  // 安装包：包裹 + 底座
  'file-exe': card([rr(8.4, 7.8, 7.2, 6.6, 1.9), rr(9.4, 15.6, 5.2, 1.7, 0.85)])
};
// 图标名 → 类型配色键
const KEY = { 'file-img': 'image', 'file-video': 'video', 'file-audio': 'audio' };

// 文件夹需带「页签」轮廓，单独构造（更贴近文件语义）
function folderPath() {
  return 'M2.8 7.6A2.8 2.8 0 0 1 5.6 4.8h3.36c.74 0 1.45.29 1.98.8l1.1 1.1h6.36a2.8 2.8 0 0 1 2.8 2.8v7.1a2.8 2.8 0 0 1-2.8 2.8H5.6a2.8 2.8 0 0 1-2.8-2.8z';
}
function folderOpenPath() {
  const back = 'M2.8 7.6A2.8 2.8 0 0 1 5.6 4.8h3.36c.74 0 1.45.29 1.98.8l1.1 1.1h6.36a2.8 2.8 0 0 1 2.8 2.8v1.6H2.8z';
  const front = 'M3 11.1h17.4a1.6 1.6 0 0 1 1.55 1.98l-1.4 5.9a2.8 2.8 0 0 1-2.72 2.18H6.17a2.8 2.8 0 0 1-2.72-2.18l-1.4-5.9A1.6 1.6 0 0 1 3 11.1z';
  return back + front;
}

/* ---------------- 单色功能图标（实色剪影，便于 mask 重着色） ---------------- */
const UI_COLOR = '#2B7DE9';
const MUTED = '#94A3B8';

const ui = {};

// 品牌：圆角方形底 + 镂空 C（CC网盘首字母，原创几何）
(function brand() {
  const R = 5.4, r = 3.35, gap = 38;
  const P = (rad, deg) => [12 + rad * Math.cos(deg * Math.PI / 180), 12 + rad * Math.sin(deg * Math.PI / 180)];
  const A = P(R, gap), B = P(R, -gap), Bi = P(r, -gap), Ai = P(r, gap);
  ui['cloud'] = one(rr(2.4, 2.4, 19.2, 19.2, 5.2)
    + `M${pt(A)}A${R} ${R} 0 1 1 ${pt(B)}L${pt(Bi)}A${r} ${r} 0 1 0 ${pt(Ai)}Z`, '#2B7DE9');
})();

// 首页
ui['home'] = one('M11.06 3.05a1.6 1.6 0 0 1 1.88 0l7.24 5.73c.4.32.64.8.64 1.32v8.5A2.4 2.4 0 0 1 18.42 21H5.58A2.4 2.4 0 0 1 3.18 18.6v-8.5c0-.52.24-1 .64-1.32z'
  + rr(10.15, 14.6, 3.7, 5.2, 1.85), UI_COLOR);

// 文件夹 / 打开（在写入阶段单独输出）

// 我的分享：三节点（圆的连线）
(function share() {
  const c1 = [17.2, 5.8], c2 = [6.8, 12], c3 = [17.2, 18.2];
  const bar = (a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    return rotRR((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 2.2, L, 1.1, Math.atan2(dy, dx) * 180 / Math.PI + 90);
  };
  ui['share'] = wrap(group([bar(c2, c1), bar(c2, c3)], UI_COLOR)
    + group([circle(c1[0], c1[1], 2.5), circle(c2[0], c2[1], 2.5), circle(c3[0], c3[1], 2.5)], UI_COLOR));
})();

// 离线下载（下箭头）
ui['download'] = one(roundPoly([[9.2, 3.2], [14.8, 3.2], [14.8, 13.2], [18.8, 13.2], [12, 20.8], [5.2, 13.2], [9.2, 13.2]], 1.2), UI_COLOR);
// 上传（上箭头）
ui['upload'] = one(roundPoly([[9.2, 20.8], [14.8, 20.8], [14.8, 10.8], [18.8, 10.8], [12, 3.2], [5.2, 10.8], [9.2, 10.8]], 1.2), UI_COLOR);

// 回收站：盖 + 提手 + 桶身（含两条镂空条纹）
ui['trash'] = one(rr(9.5, 2.6, 5, 1.5, 0.75) + rr(3.6, 4.6, 16.8, 2.5, 1.25)
  + 'M5.6 8h12.8l-.76 10.4a2.9 2.9 0 0 1-2.89 2.5H9.25a2.9 2.9 0 0 1-2.89-2.5z'
  + rr(9.6, 10.6, 1.8, 7.2, 0.9) + rr(12.6, 10.6, 1.8, 7.2, 0.9), UI_COLOR);

// 设置：齿环 + 8 齿（两层同色并集）
(function gear() {
  const ring = circle(12, 12, 7) + circle(12, 12, 3);
  const teeth = [];
  for (let i = 0; i < 8; i++) {
    const A = i * 45 * Math.PI / 180;
    teeth.push(rotRR(12 + 7.6 * Math.cos(A), 12 + 7.6 * Math.sin(A), 3, 3.2, 1, i * 45 - 90));
  }
  ui['gear'] = wrap(`<path fill="${UI_COLOR}" fill-rule="evenodd" d="${ring}"/>`
    + `<path fill="${UI_COLOR}" d="${teeth.join('')}"/>`);
})();

// 搜索：放大镜（环 + 斜柄）
(function search() {
  ui['search'] = wrap(`<path fill="${UI_COLOR}" fill-rule="evenodd" d="${circle(10.8, 10.8, 6) + circle(10.8, 10.8, 3.9)}"/>`
    + `<path fill="${UI_COLOR}" d="${rotRR(17, 17, 2.4, 6.4, 1.2, 45)}"/>`);
})();

// 团队 / 用户
ui['users'] = wrap(group([circle(17.2, 8.8, 2.8),
  'M17.2 12.8a5.8 5.8 0 0 1 5.8 5.8V21.4H11.4V18.6a5.8 5.8 0 0 1 5.8-5.8z'], '#9EC2FF')
  + group([circle(9.2, 8.2, 3.5),
    'M9.2 13a6.6 6.6 0 0 1 6.6 6.6V21.4H2.6v-1.8A6.6 6.6 0 0 1 9.2 13z'], UI_COLOR));
ui['user'] = one(circle(12, 8, 3.8) + 'M12 12.8a7.4 7.4 0 0 1 7.4 7.4V21.4H4.6v-1.2a7.4 7.4 0 0 1 7.4-7.4z', MUTED);
ui['chat'] = one('M5 4.4h14a2.6 2.6 0 0 1 2.6 2.6v8a2.6 2.6 0 0 1-2.6 2.6h-6.3l-4.6 3.7a1.1 1.1 0 0 1-1.8-.86V17.6H5A2.6 2.6 0 0 1 2.4 15V7A2.6 2.6 0 0 1 5 4.4z'
  + circle(8.2, 11, 1.3) + circle(12, 11, 1.3) + circle(15.8, 11, 1.3), UI_COLOR);
ui['crown'] = one(roundPoly([[3.6, 8.2], [7.8, 11.4], [12, 5.6], [16.2, 11.4], [20.4, 8.2], [18.8, 19.4], [5.2, 19.4]], 1), '#F59E0B');

// 密钥：环 + 柄 + 齿
ui['key'] = wrap(`<path fill="${UI_COLOR}" fill-rule="evenodd" d="${circle(7.6, 12, 3.4) + circle(7.6, 12, 1.5)}"/>`
  + `<path fill="${UI_COLOR}" d="${rr(10, 10.9, 10.4, 2.2, 1.1)}${rr(15.6, 12.6, 1.9, 2.8, 0.9)}${rr(18.4, 12.6, 1.9, 2.8, 0.9)}"/>`);

// 锁：锁体（含钥匙孔镂空）+ 锁梁
ui['lock'] = wrap(`<path fill="${UI_COLOR}" fill-rule="evenodd" d="${rr(4.4, 10.2, 15.2, 10.4, 2.8) + circle(12, 14.4, 1.8) + rr(11.15, 16.2, 1.7, 3.2, 0.85)}"/>`
  + `<path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" fill="none" stroke="${UI_COLOR}" stroke-width="2.2" stroke-linecap="round"/>`);

// 开放 API：地球（圆 + 经纬镂空带）
ui['globe'] = one(circle(12, 12, 8.6)
  + ellipse(12, 12, 3.5, 8.6) + ellipse(12, 12, 2.6, 8.6)
  + ellipse(12, 12, 8.6, 3.5) + ellipse(12, 12, 8.6, 2.6), UI_COLOR);

// 列表 / 网格
ui['list'] = one(rr(4, 4.6, 2.8, 2.8, 1) + rr(8.4, 5.05, 11.2, 1.9, 0.95)
  + rr(4, 10.6, 2.8, 2.8, 1) + rr(8.4, 11.05, 11.2, 1.9, 0.95)
  + rr(4, 16.6, 2.8, 2.8, 1) + rr(8.4, 17.05, 11.2, 1.9, 0.95), UI_COLOR);
ui['grid'] = one(rr(3.6, 3.6, 7.4, 7.4, 2.2) + rr(13, 3.6, 7.4, 7.4, 2.2)
  + rr(3.6, 13, 7.4, 7.4, 2.2) + rr(13, 13, 7.4, 7.4, 2.2), UI_COLOR);

// 附件（回形针，极简线性细节）
ui['paperclip'] = wrap(`<path d="M15 6.6l-6.2 6.2a3.4 3.4 0 0 0 4.8 4.8l6.2-6.2a5.4 5.4 0 0 0-7.6-7.6L5.6 10.4a4.4 4.4 0 0 0 0 6.2" fill="none" stroke="${UI_COLOR}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);

// 编辑：笔身（斜向圆角）+ 笔尖
(function edit() {
  const body = rotRR(12, 11.4, 3.6, 12.8, 1.4, 45);
  const tip = roundPoly([[8.75, 17.19], [6.21, 14.65], [6.07, 17.33]], 0.5);
  ui['edit'] = one(body + tip, UI_COLOR);
})();

// 容量：三层圆角盘（含指示灯镂空）
ui['storage'] = one(rr(3.4, 3.2, 17.2, 4.6, 1.8) + rr(3.4, 9.7, 17.2, 4.6, 1.8) + rr(3.4, 16.2, 17.2, 4.6, 1.8)
  + circle(17.2, 5.5, 0.95) + circle(17.2, 12, 0.95) + circle(17.2, 18.5, 0.95), UI_COLOR);

// 空状态：圆角立方箱
ui['empty'] = wrap(`<g><path fill="#CBD5E1" d="${roundPoly([[2.8, 12], [12, 7.4], [21.2, 12], [12, 16.6]], 1.1)}"/>`
  + `<path fill="#9AA3AF" d="${roundPoly([[2.8, 12], [12, 16.6], [12, 21.4], [2.8, 16.8]], 1.1)}"/>`
  + `<path fill="#AEB8C4" d="${roundPoly([[21.2, 12], [12, 16.6], [12, 21.4], [21.2, 16.8]], 1.1)}"/></g>`);

// 警告 / 成功 / 关闭 / 新建
ui['warning'] = one(roundPoly([[12, 3.4], [21.2, 20.2], [2.8, 20.2]], 2.4)
  + rr(11.05, 8.6, 1.9, 6.4, 0.95) + circle(12, 17.2, 1.15), '#F59E0B');
ui['check'] = wrap(`<defs><mask id="crCheck">`
  + `<rect width="24" height="24" fill="#000"/><circle cx="12" cy="12" r="9.4" fill="#fff"/>`
  + group([rotRR(9.6, 13.7, 2.4, 5.4, 1.2, -45), rotRR(13.95, 11.75, 2.4, 9.4, 1.2, -130.6)], '#000')
  + `</mask></defs><circle cx="12" cy="12" r="9.4" fill="#22C55E" mask="url(#crCheck)"/>`);
ui['cross'] = wrap(`<defs><mask id="crCross">`
  + `<rect width="24" height="24" fill="#000"/><circle cx="12" cy="12" r="9.4" fill="#fff"/>`
  + group([rotRR(12, 12, 2.4, 9.4, 1.2, 45), rotRR(12, 12, 2.4, 9.4, 1.2, -45)], '#000')
  + `</mask></defs><circle cx="12" cy="12" r="9.4" fill="#E5484D" mask="url(#crCross)"/>`);
ui['plus'] = one(roundPoly([[10.6, 3.2], [13.4, 3.2], [13.4, 10.6], [20.8, 10.6], [20.8, 13.4], [13.4, 13.4],
  [13.4, 20.8], [10.6, 20.8], [10.6, 13.4], [3.2, 13.4], [3.2, 10.6], [10.6, 10.6]], 1.1), UI_COLOR);

/* ---------------- 写入 ---------------- */
let n = 0;
Object.entries(fileIcons).forEach(([name, d]) => {
  const key = KEY[name] || name.replace('file-', '');
  fs.writeFileSync(path.join(OUT, name + '.svg'), one(d, TYPE_COLOR[key] || TYPE_COLOR.other));
  n++;
});
// 文件夹单独写（含页签轮廓）
fs.writeFileSync(path.join(OUT, 'folder.svg'), one(folderPath(), TYPE_COLOR.folder)); n++;
fs.writeFileSync(path.join(OUT, 'folder-open.svg'), one(folderOpenPath(), TYPE_COLOR.folder)); n++;
Object.entries(ui).forEach(([name, svg]) => {
  fs.writeFileSync(path.join(OUT, name + '.svg'), svg);
  n++;
});
console.log(`已生成 ${n} 个 SVG 图标到 public/icons/`);
