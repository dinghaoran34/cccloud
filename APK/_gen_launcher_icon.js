#!/usr/bin/env node
/**
 * CC网盘 Android 启动图标生成器（纯 Node 内置模块：fs / path / zlib，零第三方依赖）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node _gen_launcher_icon.js           # 生成 5 个密度的传统图标 + 圆形图标
 *   node _gen_launcher_icon.js verify    # 解码回读生成的 PNG，输出尺寸/位深/采样点
 *
 * 原创性声明：
 *   本脚本用纯几何构图（圆 / 圆角矩形 / 三角形）自行绘制图标，
 *   不包含、不描摹、不引用任何第三方位图或商标（含百度网盘）。
 *   风格取向仅借鉴通用做法：高饱和蓝色底 + 圆角方块 + 白色云形 + 下载箭头。
 *
 * ===== 配色参数 =====
 *   背景渐变： 顶  #2B7DE9 (43,125,233)  →  底 #1F6FD0 (31,111,208)   竖向线性渐变
 *   主体前景： 纯白 #FFFFFF
 *   渐变方向： 垂直（v=0 为顶色，v=1 为底色），与自适应图标背景 angle=270 保持一致
 *   圆角率：   0.22 × 边长（满版方形图标，四角外部完全透明）
 *
 * ===== 几何参数（设计空间：归一化 0..1，原点左上，y 向下）=====
 *   云 = 1 个圆角矩形底 + 3 个圆 的并集（左右对称，非第三方云朵轮廓）
 *     base    圆角矩形 x[0.225,0.775]  y[0.375,0.480]  corner r=0.0525
 *     中圆    c(0.500,0.330) r=0.150   （云头，最高点 y=0.180）
 *     左圆    c(0.335,0.372) r=0.108
 *     右圆    c(0.665,0.372) r=0.108   （左右对称）
 *     云底部为平直边 y=0.480
 *   下载箭头 = 竖杆矩形 + 等腰三角箭头 的并集
 *     竖杆    x[0.4375,0.5625]  y[0.550,0.645]
 *     箭头底  y=0.645  x[0.340,0.660]，顶点 (0.500,0.820)
 *     云底(0.480) → 箭杆顶(0.550) 留 0.070 视觉间隙，保证小尺寸可辨识
 *   整体内容包围盒： x[0.225,0.775] y[0.180,0.820] → 恰好居中，宽 0.550 高 0.640
 *
 * ===== 抗锯齿 =====
 *   每个输出像素按 4×4 = 16 个子采样点做覆盖率统计（超采样），
 *   再对颜色做平均，输出 8bit RGBA（PNG colorType=6, bitDepth=8）。
 *
 * ===== 自适应图标换算（API 26+，108×108 viewport，安全区中心 66×66）=====
 *   传统图标 0..1 映射到自适应图标可见区 72×72： X = 54 + (u-0.5)*72
 *   内容落点 x[34.2,73.8] y[31.32,77.4]，全部位于安全区 [21,87] 之内。
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ============================ 设计参数 ============================ */

const BG_TOP = [0x2b, 0x7d, 0xe9]; // #2B7DE9
const BG_BOTTOM = [0x1f, 0x6f, 0xd0]; // #1F6FD0
const CORNER_RATIO = 0.22;

const CLOUD = {
  base: { x0: 0.225, y0: 0.375, x1: 0.775, y1: 0.480, r: 0.0525 },
  circles: [
    { cx: 0.5, cy: 0.33, r: 0.15 },
    { cx: 0.335, cy: 0.372, r: 0.108 },
    { cx: 0.665, cy: 0.372, r: 0.108 }
  ]
};

const ARROW = {
  shaft: { x0: 0.4375, x1: 0.5625, y0: 0.55, y1: 0.645 },
  head: { x0: 0.34, x1: 0.66, y0: 0.645, apexX: 0.5, apexY: 0.82 }
};

// 5 个密度：目录 → 边长（px）
const DENSITIES = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
];

const SS = 4; // 超采样倍率（4×4 = 16 子采样/像素）
const RES = path.resolve(__dirname, 'app', 'src', 'main', 'res');

/* ========================= 几何布尔判定（纯函数） ========================= */

function inCircle(u, v, cx, cy, r) {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

// 圆角矩形（对内部与外部均正确：最近点落在内缩矩形上）
function inRoundRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r);
  const cy = Math.min(Math.max(v, y0 + r), y1 - r);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(u, v, p1, p2, p3) {
  const s = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  const d1 = s([u, v], p1, p2);
  const d2 = s([u, v], p2, p3);
  const d3 = s([u, v], p3, p1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 白色主体（云 + 箭头）并集；u,v 为设计空间坐标
function insideWhite(u, v) {
  const b = CLOUD.base;
  if (inRoundRect(u, v, b.x0, b.y0, b.x1, b.y1, b.r)) return true;
  for (const c of CLOUD.circles) {
    if (inCircle(u, v, c.cx, c.cy, c.r)) return true;
  }
  const s = ARROW.shaft;
  if (inRoundRect(u, v, s.x0, s.y0, s.x1, s.y1, 0)) return true;
  const h = ARROW.head;
  if (inTriangle(u, v, [h.x0, h.y0], [h.x1, h.y0], [h.apexX, h.apexY])) return true;
  return false;
}

/* ============================ 位图渲染 ============================ */

/**
 * @param {number} size  输出边长 px
 * @param {'square'|'round'} shape 背景形状：满版圆角方块 / 内切圆
 * @param {number} contentScale 主体相对设计空间的缩放（绕中心）
 * @returns {Buffer} RGBA 像素（size*size*4，非预乘）
 */
function render(size, shape, contentScale) {
  const out = Buffer.alloc(size * size * 4);
  const r = CORNER_RATIO; // 圆角率，圆角半径 = r * size
  const inv = 1 / contentScale;
  const step = 1 / SS;
  const n = SS * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHit = 0;
      let fgHit = 0;

      for (let j = 0; j < SS; j++) {
        const v = (py + (j + 0.5) * step) / size;
        for (let i = 0; i < SS; i++) {
          const u = (px + (i + 0.5) * step) / size;

          // 背景
          let bg;
          if (shape === 'round') {
            bg = inCircle(u, v, 0.5, 0.5, 0.5);
          } else {
            bg = inRoundRect(u, v, 0, 0, 1, 1, r);
          }
          // 前景（设计空间按 contentScale 反算）
          const du = 0.5 + (u - 0.5) * inv;
          const dv = 0.5 + (v - 0.5) * inv;
          const fg = insideWhite(du, dv);

          if (bg) bgHit++;
          if (fg && bg) fgHit++;
        }
      }

      const bgCov = bgHit / n;
      const fgCov = fgHit / n;
      const v = (py + 0.5) / size;
      const o = (py * size + px) * 4;

      if (bgCov <= 0) {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
        out[o + 3] = 0;
        continue;
      }

      // 背景竖直线性渐变
      const br = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * v;
      const bgc = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * v;
      const bb = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * v;

      // 白色前景覆盖在背景上（straight alpha：底色即背景色）
      out[o] = Math.round(br + (255 - br) * fgCov);
      out[o + 1] = Math.round(bgc + (255 - bgc) * fgCov);
      out[o + 2] = Math.round(bb + (255 - bb) * fgCov);
      out[o + 3] = Math.round(255 * bgCov);
    }
  }
  return out;
}

/* ============================ PNG 编码 ============================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================ 生成 ============================ */

function generate() {
  const jobs = [
    { name: 'ic_launcher.png', shape: 'square', scale: 1.0 },
    { name: 'ic_launcher_round.png', shape: 'round', scale: 1.06 }
  ];
  console.log('生成启动图标 → ' + RES);
  for (const [dir, size] of DENSITIES) {
    const outDir = path.join(RES, dir);
    fs.mkdirSync(outDir, { recursive: true });
    for (const job of jobs) {
      const rgba = render(size, job.shape, job.scale);
      const png = encodePNG(size, rgba);
      const file = path.join(outDir, job.name);
      fs.writeFileSync(file, png);
      console.log(
        `  ${dir}/${job.name}  ${size}x${size}  ${String(png.length).padStart(7)} bytes`
      );
    }
  }
}

/* ============================ 校验（解码回读） ============================ */

function readPNG(file) {
  const buf = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('bad signature: ' + file);
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let val = line[x];
      if (f === 1) val += a;
      else if (f === 2) val += b;
      else if (f === 3) val += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        val += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = val & 0xff;
    }
  }
  return { width, height, depth, colorType, pixels: px, bytes: buf.length, bpp };
}

function sample(img, u, v) {
  const x = Math.min(img.width - 1, Math.max(0, Math.round(u * img.width - 0.5)));
  const y = Math.min(img.height - 1, Math.max(0, Math.round(v * img.height - 0.5)));
  const o = (y * img.width + x) * img.bpp;
  return [img.pixels[o], img.pixels[o + 1], img.pixels[o + 2], img.pixels[o + 3]];
}

function verify() {
  const COLOR = { 0: 'Grayscale', 2: 'RGB', 3: 'Palette', 4: 'Gray+Alpha', 6: 'RGBA' };
  let allOk = true;
  const rows = [];

  for (const [dir, size] of DENSITIES) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const file = path.join(RES, dir, name);
      const img = readPNG(file);
      const ok = img.width === size && img.height === size;

      // 采样点（设计空间坐标，见文件头几何参数）
      const corner = sample(img, 0.02, 0.02); // 左上角 → 应全透明
      const center = sample(img, 0.5, 0.33); // 云头圆心 → 应为白
      const cloudL = sample(img, 0.335, 0.372); // 左圆圆心
      const cloudR = sample(img, 0.665, 0.372); // 右圆圆心
      const arrow = sample(img, 0.5, 0.72); // 箭头三角内部
      const gap = sample(img, 0.5, 0.515); // 云底与箭杆之间 → 应为蓝
      const bgTop = sample(img, 0.5, 0.06); // 顶部背景
      const bgBot = sample(img, 0.5, 0.94); // 底部背景

      const isWhite = (p) => p[0] > 240 && p[1] > 240 && p[2] > 240 && p[3] > 250;
      const isBlue = (p) => p[2] > 120 && p[0] < 120 && p[3] > 250;
      const isClear = (p) => p[3] === 0;

      const checks = {
        size: ok,
        corner_transparent: isClear(corner),
        center_white: isWhite(center),
        cloud_left_white: isWhite(cloudL),
        cloud_right_white: isWhite(cloudR),
        arrow_white: isWhite(arrow),
        gap_blue: isBlue(gap),
        bg_top_blue: isBlue(bgTop),
        bg_bottom_blue: isBlue(bgBot),
        // 渐变方向：顶部应比底部亮（B 通道不一定，比 R/G 亮度）
        gradient: bgTop[0] + bgTop[1] + bgTop[2] > bgBot[0] + bgBot[1] + bgBot[2]
      };
      if (Object.values(checks).some((c) => !c)) allOk = false;

      rows.push({
        file: path.relative(RES, file).replace(/\\/g, '/'),
        size: `${img.width}x${img.height}`,
        expect: size,
        depth: img.depth,
        colorType: `${img.colorType}(${COLOR[img.colorType]})`,
        bytes: img.bytes,
        ok,
        checks,
        samples: {
          corner,
          center,
          arrow,
          gap,
          bgTop,
          bgBot
        }
      });
    }
  }

  for (const r of rows) {
    const failed = Object.entries(r.checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.log(
      `${r.ok ? 'OK ' : 'BAD'} ${r.file.padEnd(38)} ${r.size.padEnd(9)} (期望 ${r.expect})  ` +
        `depth=${r.depth} colorType=${r.colorType} ${r.bytes} bytes` +
        (failed.length ? '  ✗ ' + failed.join(',') : '')
    );
    console.log(
      `      corner=${JSON.stringify(r.samples.corner)} center=${JSON.stringify(
        r.samples.center
      )} arrow=${JSON.stringify(r.samples.arrow)} gap=${JSON.stringify(
        r.samples.gap
      )} bgTop=${JSON.stringify(r.samples.bgTop)} bgBot=${JSON.stringify(r.samples.bgBot)}`
    );
  }
  console.log(allOk ? '\n全部校验通过' : '\n存在校验失败项');
  if (!allOk) process.exitCode = 1;
}

/* ============================ 入口 ============================ */

if (require.main === module) {
  if (process.argv[2] === 'verify') verify();
  else generate();
}

module.exports = { render, encodePNG, readPNG, CLOUD, ARROW, DENSITIES };
