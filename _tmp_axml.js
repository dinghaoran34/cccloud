'use strict';
// 调试：列出 aar AndroidManifest.xml 的所有元素和属性
const fs = require('fs');

function parseAxml(buf) {
  let pos = 8;
  const stringPool = [];
  const tags = [];

  function u16(o) { return buf.readUInt16LE(o); }
  function u32(o) { return buf.readUInt32LE(o); }

  while (pos < buf.length) {
    const type = u16(pos);
    const size = u32(pos + 4);
    if (size <= 0) break;

    if (type === 0x0001) { // STRING_POOL
      const stringCount = u32(pos + 8);
      const flags = u32(pos + 16);
      const stringsStart = u32(pos + 20);
      const isUTF8 = (flags & (1 << 8)) !== 0;
      for (let i = 0; i < stringCount; i++) {
        const offset = u32(pos + 28 + i * 4);
        const so = pos + stringsStart + offset;
        let s;
        if (isUTF8) {
          let p = so;
          let l = buf.readUInt8(p); p++;
          if (l & 0x80) { l = ((l & 0x7f) << 8) | buf.readUInt8(p); p++; }
          let bl = buf.readUInt8(p); p++;
          if (bl & 0x80) { bl = ((bl & 0x7f) << 8) | buf.readUInt8(p); p++; }
          s = buf.toString('utf8', p, p + bl);
        } else {
          let p = so;
          let l = u16(p); p += 2;
          if (l & 0x8000) { l = ((l & 0x7fff) << 16) | u16(p); p += 2; }
          s = buf.toString('utf16le', p, p + l * 2);
        }
        stringPool.push(s);
      }
    } else if (type === 0x0102 || type === 0x0103) { // START/END ELEMENT
      const nameIdx = u32(pos + 20);
      const tagName = stringPool[nameIdx] || ('#' + nameIdx);
      if (type === 0x0102) {
        const attrStart = u16(pos + 24) || 0x14;
        const attrCount = u16(pos + 26);
        const attrs = {};
        for (let i = 0; i < attrCount; i++) {
          const ao = pos + attrStart + i * 20;
          const attrNameIdx = u32(ao + 4);
          const dataType = buf.readUInt8(ao + 15);
          const data = u32(ao + 16);
          let value;
          if (dataType === 0x10) value = data;
          else if (dataType === 0x03) value = stringPool[data] !== undefined ? stringPool[data] : data;
          else if (dataType === 0x12) value = !!data;
          else value = 'type' + dataType + ':' + data;
          attrs[stringPool[attrNameIdx] || ('#' + attrNameIdx)] = value;
        }
        tags.push({ tag: tagName, attrs });
      } else {
        tags.push({ tag: '/' + tagName });
      }
    }
    pos += size;
  }
  return tags;
}

function findInZip(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const fname = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (fname === name) {
      const lhNameLen = buf.readUInt16LE(lho + 26);
      const lhExtraLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lhNameLen + lhExtraLen;
      if (method === 0) return buf.slice(dataStart, dataStart + compSize);
      return require('zlib').inflateRawSync(buf.slice(dataStart, dataStart + compSize));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const file = process.argv[2];
const buf = fs.readFileSync(file);
const axml = findInZip(buf, 'AndroidManifest.xml');
if (!axml) { console.log('no manifest'); process.exit(0); }
const tags = parseAxml(axml);
tags.forEach(t => {
  if (t.attrs) console.log('<' + t.tag + '> ' + JSON.stringify(t.attrs));
  else console.log(t.tag);
});
// 也列出所有文件
console.log('--- files ---');
const files = [];
let eocd = -1;
for (let i = buf.length - 22; i >= 0; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
const cdOffset = buf.readUInt32LE(eocd + 16);
const cdCount = buf.readUInt16LE(eocd + 10);
let p = cdOffset;
for (let i = 0; i < cdCount; i++) {
  if (buf.readUInt32LE(p) !== 0x02014b50) break;
  const nameLen = buf.readUInt16LE(p + 28);
  const extraLen = buf.readUInt16LE(p + 30);
  const commentLen = buf.readUInt16LE(p + 32);
  const compSize = buf.readUInt32LE(p + 20);
  files.push(buf.toString('utf8', p + 46, p + 46 + nameLen) + ' (' + compSize + 'b)');
  p += 46 + nameLen + extraLen + commentLen;
}
console.log(files.join('\n'));
