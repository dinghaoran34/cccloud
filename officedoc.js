// officedoc.js - Office Open XML（docx / xlsx / pptx）只读解析为 HTML
// 依赖 ziplib.js 的随机读（storage.recordReader 适配器），按需读取 zip 条目，不整文件进内存。
// 说明：不引入任何 XML 库，采用针对 OOXML 结构的稳健正则提取（简单可靠优先）。
'use strict';

const ziplib = require('./ziplib');

const MAX_OFFICE_BYTES = 30 * 1024 * 1024;  // 预览对象大小上限 30MB
const MAX_ENTRY_BYTES = 48 * 1024 * 1024;   // 单个 XML 条目解压上限
const MAX_ROWS = 3000;                      // xlsx 最大渲染行数
const MAX_COLS = 120;                       // xlsx 最大渲染列数
const MAX_SLIDES = 300;                     // pptx 最大页数

const OFFICE_EXTS = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

function officeExt(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return Object.prototype.hasOwnProperty.call(OFFICE_EXTS, ext) ? ext : null;
}

// ---------- 基础工具 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeXmlEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// 读取一个 zip 条目为 Buffer（带解压上限）
async function readEntryBuffer(reader, entries, name, cap) {
  const e = entries.find(x => x.name === name && !x.isDir);
  if (!e) return null;
  const stream = await ziplib.openEntryStream(reader, e);
  if (!stream) return Buffer.alloc(0);
  const limit = cap || MAX_ENTRY_BYTES;
  const chunks = [];
  let total = 0;
  try {
    for await (const c of stream) {
      total += c.length;
      if (total > limit) { try { stream.destroy(); } catch (err) {} throw new Error('条目内容过大: ' + name); }
      chunks.push(c);
    }
  } finally {
    try { stream.destroy(); } catch (e) {}
  }
  return Buffer.concat(chunks);
}

async function readEntryText(reader, entries, name) {
  const buf = await readEntryBuffer(reader, entries, name);
  return buf == null ? null : buf.toString('utf8');
}

// 收集 `<tag ...>text</tag>` 形式的文本（含 w:t / a:t / t）
function collectTexts(xml, tagRe) {
  const out = [];
  let m;
  const re = new RegExp(tagRe, 'g');
  while ((m = re.exec(xml)) !== null) out.push(decodeXmlEntities(m[1]));
  return out;
}

// ==================== docx ====================
function renderDocxTable(tblXml) {
  const rows = tblXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  let h = '<table class="cr-office-table">';
  for (const r of rows) {
    const cells = r.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
    h += '<tr>';
    for (const c of cells) {
      // 单元格内：段落之间用 <br> 分隔
      const paras = c.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
      const texts = paras.length
        ? paras.map(p => collectTexts(p, '<w:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:t>').join(''))
        : [collectTexts(c, '<w:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/w:t>').join('')];
      h += '<td>' + escapeHtml(texts.join('\n')).replace(/\n/g, '<br>') + '</td>';
    }
    h += '</tr>';
  }
  return h + '</table>';
}

function docxParagraphHtml(pXml) {
  const styleMatch = pXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/);
  const style = styleMatch ? styleMatch[1] : '';
  const headingMatch = style.match(/^(?:Heading|heading|\u6807\u9898)\s*(\d)$/);
  const level = headingMatch ? Math.min(6, Math.max(1, Number(headingMatch[1]))) : 0;
  // 段落文本：保留 <w:tab/> 与 <w:br/> 语义
  let text = '';
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let m;
  while ((m = tokenRe.exec(pXml)) !== null) {
    if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
    else if (m[0].indexOf('tab') >= 0) text += '\t';
    else text += '\n';
  }
  if (!text.trim()) return '<div class="cr-office-gap"></div>';
  const bold = /<w:b\s*\/>|<w:b\s+[^>]*\/>/.test(pXml);
  const body = escapeHtml(text).replace(/\n/g, '<br>');
  if (level) return '<h' + level + ' class="cr-office-h">' + body + '</h' + level + '>';
  if (bold) return '<p class="cr-office-p cr-office-strong">' + body + '</p>';
  return '<p class="cr-office-p">' + body + '</p>';
}

async function parseDocx(reader, entries) {
  const xml = await readEntryText(reader, entries, 'word/document.xml');
  if (xml == null) throw new Error('缺少 word/document.xml（不是有效的 .docx）');
  const bodyMatch = xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : xml;

  const re = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
  let html = '';
  let m;
  while ((m = re.exec(body)) !== null) {
    const chunk = m[0];
    if (chunk.indexOf('<w:tbl') === 0) html += renderDocxTable(chunk);
    else html += docxParagraphHtml(chunk);
  }
  if (!html.trim()) html = '<p class="cr-office-p">（文档正文为空）</p>';
  return { html: html, meta: { paragraphs: true } };
}

// ==================== xlsx ====================
function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) continue;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const texts = collectTexts(m[1], '<t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/t>');
    out.push(texts.join(''));
  }
  return out;
}

// workbook.xml + rels → [{name, target}]
async function readSheetNames(reader, entries, sheetEntries) {
  const out = [];
  const map = {};
  try {
    const wb = await readEntryText(reader, entries, 'xl/workbook.xml');
    const rels = await readEntryText(reader, entries, 'xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const relMap = {};
      const rre = /<Relationship\b[^>]*\/?>/g;
      let rm;
      while ((rm = rre.exec(rels)) !== null) {
        const id = (rm[0].match(/Id="([^"]*)"/) || [])[1];
        const target = (rm[0].match(/Target="([^"]*)"/) || [])[1];
        if (id && target) relMap[id] = target;
      }
      const sre = /<sheet\b[^>]*\/?>/g;
      let sm;
      while ((sm = sre.exec(wb)) !== null) {
        const name = (sm[0].match(/name="([^"]*)"/) || [])[1];
        const rid = (sm[0].match(/r:id="([^"]*)"/) || [])[1] || (sm[0].match(/id="([^"]*)"/) || [])[1];
        if (!rid || !relMap[rid]) continue;
        let target = relMap[rid].replace(/^\.\//, '');
        if (target.charAt(0) === '/') target = target.slice(1);
        else if (target.indexOf('xl/') !== 0) target = 'xl/' + target;
        map[target] = decodeXmlEntities(name || '');
      }
    }
  } catch (e) { /* 名称解析失败则回退 sheetN */ }
  sheetEntries.forEach((e, i) => {
    out.push({ name: map[e.name] || ('工作表 ' + (i + 1)), entry: e });
  });
  return out;
}

function renderSheet(xml, sst) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  let truncated = false;
  while ((rm = rowRe.exec(xml)) !== null) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const rowXml = rm[1] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g;
    let cm;
    let autoCol = 0;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1] !== undefined ? cm[1] : cm[2];
      const inner = cm[3] || '';
      const rAttr = (attrs.match(/\sr="([A-Z]+)\d+"/) || [])[1];
      const col = rAttr ? colLetterToIndex(rAttr) : autoCol;
      autoCol = col + 1;
      if (col < 0 || col >= MAX_COLS) continue;
      const t = (attrs.match(/\st="([^"]+)"/) || [])[1] || 'n';
      const fm = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
      let val = '';
      if (t === 'inlineStr') {
        val = collectTexts(inner, '<t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/t>').join('');
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? decodeXmlEntities(v[1]) : '';
        if (t === 's') {
          const idx = Number(raw);
          val = (sst && sst[idx] != null) ? String(sst[idx]) : '';
        } else if (t === 'b') {
          val = raw === '1' ? 'TRUE' : (raw === '0' ? 'FALSE' : raw);
        } else {
          val = raw;
        }
      }
      cells.push({ col: col, text: val, formula: fm ? decodeXmlEntities(fm[1]).trim() : '' });
    }
    rows.push(cells);
  }
  return { rows: rows, truncated: truncated };
}

async function parseXlsx(reader, entries) {
  const sstXml = await readEntryText(reader, entries, 'xl/sharedStrings.xml');
  const sst = parseSharedStrings(sstXml);
  let sheetEntries = entries
    .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name) && !e.isDir)
    .sort((a, b) => (Number((a.name.match(/(\d+)/) || [])[1]) || 0) - (Number((b.name.match(/(\d+)/) || [])[1]) || 0));
  if (!sheetEntries.length) throw new Error('缺少工作表（不是有效的 .xlsx）');
  if (sheetEntries.length > 50) sheetEntries = sheetEntries.slice(0, 50);
  const sheets = await readSheetNames(reader, entries, sheetEntries);

  const tabs = [];
  const panes = [];
  let totalTruncated = false;
  for (let i = 0; i < sheets.length; i++) {
    const s = sheets[i];
    const xml = await readEntryText(reader, entries, s.entry.name);
    const parsed = renderSheet(xml || '', sst);
    totalTruncated = totalTruncated || parsed.truncated;
    // 计算实际最大列
    let maxCol = -1;
    parsed.rows.forEach(r => r.forEach(c => { if (c.col > maxCol) maxCol = c.col; }));
    if (maxCol >= MAX_COLS) maxCol = MAX_COLS - 1;
    let body = '<div class="cr-office-tablewrap"><table class="cr-office-table cr-office-sheet"><tbody>';
    if (!parsed.rows.length) {
      body += '<tr><td class="cr-office-cell">（空工作表）</td></tr>';
    } else {
      parsed.rows.forEach((cells) => {
        body += '<tr>';
        for (let ci = 0; ci <= maxCol; ci++) {
          const cell = cells.find(c => c.col === ci);
          // 公式显示为文本（=公式）
          const text = cell ? (cell.formula ? '=' + cell.formula : cell.text) : '';
          body += '<td class="cr-office-cell">' + (text ? escapeHtml(text) : '') + '</td>';
        }
        body += '</tr>';
      });
    }
    body += '</tbody></table></div>';
    if (parsed.truncated) body += '<p class="cr-hint">表格过大，仅显示前 ' + MAX_ROWS + ' 行。</p>';
    tabs.push('<button type="button" class="cr-seg-btn' + (i === 0 ? ' is-active' : '') + '" data-sheet="' + i + '">' + escapeHtml(s.name) + '</button>');
    panes.push('<div class="cr-office-pane" data-pane="' + i + '"' + (i === 0 ? '' : ' hidden') + '>' + body + '</div>');
  }
  return {
    html: '<div class="cr-office-tabs" id="crOfficeTabs">' + tabs.join('') + '</div>' + panes.join(''),
    meta: { sheets: sheets.length, truncated: totalTruncated, sharedStrings: sst.length }
  };
}

// ==================== pptx ====================
async function parsePptx(reader, entries) {
  let slideEntries = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name) && !e.isDir)
    .sort((a, b) => (Number((a.name.match(/slide(\d+)/) || [])[1]) || 0) - (Number((b.name.match(/slide(\d+)/) || [])[1]) || 0));
  if (!slideEntries.length) throw new Error('缺少幻灯片（不是有效的 .pptx）');
  const truncated = slideEntries.length > MAX_SLIDES;
  if (truncated) slideEntries = slideEntries.slice(0, MAX_SLIDES);

  const cards = [];
  for (let i = 0; i < slideEntries.length; i++) {
    const xml = (await readEntryText(reader, entries, slideEntries[i].name)) || '';
    const paras = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) || [];
    const lines = [];
    if (paras.length) {
      paras.forEach(p => {
        const t = collectTexts(p, '<a:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/a:t>').join('');
        if (t.trim()) lines.push(t);
      });
    } else {
      const all = collectTexts(xml, '<a:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/a:t>');
      all.forEach(t => { if (String(t).trim()) lines.push(t); });
    }
    cards.push(
      '<section class="cr-office-slide">' +
      '<div class="cr-office-slide-no">第 ' + (i + 1) + ' 页</div>' +
      '<div class="cr-office-slide-body">' + (lines.length ? escapeHtml(lines.join('\n')).replace(/\n/g, '<br>') : '<span class="cr-hint">（本页无文本内容）</span>') + '</div>' +
      '</section>');
  }
  return {
    html: '<div class="cr-office-slides">' + cards.join('') + '</div>' + (truncated ? '<p class="cr-hint">幻灯片较多，仅显示前 ' + MAX_SLIDES + ' 页。</p>' : ''),
    meta: { slides: slideEntries.length, truncated: truncated }
  };
}

/**
 * 解析 Office 文件为 HTML
 * @param {Object} reader  ziplib 随机读适配器（storage.recordReader）
 * @param {string} filename 原始文件名（用于判定类型）
 * @returns {Promise<{kind:string, html:string, meta:Object}>}
 */
async function parseOffice(reader, filename) {
  const kind = officeExt(filename);
  if (!kind) throw new Error('不支持的文件类型（仅支持 docx / xlsx / pptx）');
  const size = await reader.size();
  if (size > MAX_OFFICE_BYTES) {
    const err = new Error('文件过大，请下载后查看（在线预览上限 ' + Math.round(MAX_OFFICE_BYTES / 1024 / 1024) + 'MB）');
    err.code = 'TOO_LARGE';
    err.size = size;
    throw err;
  }
  const entries = await ziplib.readZipEntries(reader);
  if (kind === 'docx') { const r = await parseDocx(reader, entries); return { kind: kind, html: r.html, meta: r.meta }; }
  if (kind === 'xlsx') { const r = await parseXlsx(reader, entries); return { kind: kind, html: r.html, meta: r.meta }; }
  const r = await parsePptx(reader, entries);
  return { kind: kind, html: r.html, meta: r.meta };
}

module.exports = {
  parseOffice, officeExt, OFFICE_EXTS, MAX_OFFICE_BYTES, escapeHtml, decodeXmlEntities
};
