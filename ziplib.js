// ziplib.js - 纯 Node 内置模块实现的 ZIP 读写（不引入任何第三方依赖）
// 依赖：zlib（deflateRaw / inflateRaw / createDeflateRaw / createInflateRaw）、stream
// 设计目标：
//   1. 写入：流式写出，条目数据边读边压缩，支持超大文件（数据描述符 Data Descriptor 方案，不缓存整文件）
//   2. 读取：基于随机读接口（read / createReadStream），只需少量内存即可解析中央目录并按需解压条目
'use strict';

const zlib = require('zlib');
const { PassThrough, Readable } = require('stream');

// ==================== CRC32 ====================
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
function crc32Start() { return 0xFFFFFFFF; }
function crc32Update(crc, buf) {
  const t = crcTable();
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = (t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return c;
}
function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

// ==================== DOS 时间 ====================
function dosDateTime(d) {
  const dt = d || new Date();
  const year = dt.getFullYear() >= 1980 ? dt.getFullYear() : 1980;
  return {
    time: ((dt.getHours() & 31) << 11) | ((dt.getMinutes() & 63) << 5) | ((Math.floor(dt.getSeconds() / 2)) & 31),
    date: (((year - 1980) & 127) << 9) | (((dt.getMonth() + 1) & 15) << 5) | (dt.getDate() & 31)
  };
}

const FLAG_UTF8 = 0x0800;        // 文件名为 UTF-8
const FLAG_DATA_DESCRIPTOR = 0x0008; // 长度/CRC 写在数据描述符中（流式必需）
const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

// ==================== ZIP 写入（流式） ====================
class ZipWriter {
  /**
   * @param {Writable} out 输出流（不会被 end，由调用方决定）
   */
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
    this.finished = false;
  }

  _write(buf) {
    return new Promise((resolve, reject) => {
      this.offset += buf.length;
      this.out.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * 追加一个条目（流式）
   * @param {string} name 条目名（目录以 / 结尾）
   * @param {Function} getStream 返回可读流（未压缩数据）；目录可传 null
   * @param {Object} opts { date, store(是否仅存储不压缩) }
   */
  async addEntry(name, getStream, opts) {
    opts = opts || {};
    const isDir = /\/$/.test(name);
    const method = (isDir || opts.store) ? 0 : 8;
    const nameBuf = Buffer.from(name, 'utf8');
    const { time, date } = dosDateTime(opts.date);
    const flags = FLAG_UTF8 | FLAG_DATA_DESCRIPTOR;
    const localOffset = this.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);           // crc32（延后，写数据描述符）
    local.writeUInt32LE(0, 18);           // compressed size
    local.writeUInt32LE(0, 22);           // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    await this._write(local);
    await this._write(nameBuf);

    let crcU = crc32Start();
    let uncompressed = 0;
    let compressed = 0;

    if (!isDir && getStream) {
      await new Promise((resolve, reject) => {
        // getStream 可能返回 null（空文件）→ 视为空数据流，仍写出合法的 deflate 空块
        const src = getStream() || Readable.from([]);
        const tr = (method === 8) ? zlib.createDeflateRaw({ level: opts.level || 6 }) : new PassThrough();
        let done = false;
        const fail = (e) => { if (!done) { done = true; reject(e); } };

        src.on('data', (chunk) => {
          crcU = crc32Update(crcU, chunk);
          uncompressed += chunk.length;
        });
        src.on('error', fail);
        tr.on('error', fail);

        tr.on('data', (chunk) => {
          compressed += chunk.length;
          this.offset += chunk.length;
          if (this.out.write(chunk) === false) {
            tr.pause();
            this.out.once('drain', () => tr.resume());
          }
        });
        tr.on('end', () => { if (!done) { done = true; resolve(); } });
        src.pipe(tr);
      });
    }

    // 数据描述符（带签名）
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(SIG_DESCRIPTOR, 0);
    desc.writeUInt32LE(crc32Final(crcU), 4);
    desc.writeUInt32LE(compressed, 8);
    desc.writeUInt32LE(uncompressed, 12);
    await this._write(desc);

    this.entries.push({
      name: nameBuf,
      flags, method, time, date,
      crc: crc32Final(crcU),
      compressed, uncompressed,
      localOffset,
      isDir
    });
    return { name, uncompressed, compressed };
  }

  /** 写入中央目录 + EOCD（必须在所有条目追加完成后调用） */
  async finalize() {
    if (this.finished) return;
    this.finished = true;
    const cdOffset = this.offset;
    for (const e of this.entries) {
      const central = Buffer.alloc(46);
      central.writeUInt32LE(SIG_CENTRAL, 0);
      central.writeUInt16LE(20, 4);          // version made by
      central.writeUInt16LE(20, 6);          // version needed
      central.writeUInt16LE(e.flags, 8);
      central.writeUInt16LE(e.method, 10);
      central.writeUInt16LE(e.time, 12);
      central.writeUInt16LE(e.date, 14);
      central.writeUInt32LE(e.crc, 16);
      central.writeUInt32LE(e.compressed, 20);
      central.writeUInt32LE(e.uncompressed, 24);
      central.writeUInt16LE(e.name.length, 28);
      central.writeUInt16LE(0, 30);          // extra
      central.writeUInt16LE(0, 32);          // comment
      central.writeUInt16LE(0, 34);          // disk number start
      central.writeUInt16LE(0, 36);          // internal attrs
      central.writeUInt32LE(e.isDir ? 0x10 : 0x20, 38); // external attrs（低字节：目录位/普通文件）
      central.writeUInt32LE(e.localOffset, 42);
      await this._write(central);
      await this._write(e.name);
    }
    const cdSize = this.offset - cdOffset;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);                // disk number
    eocd.writeUInt16LE(0, 6);                // disk with CD
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xFFFF), 8);
    eocd.writeUInt16LE(Math.min(this.entries.length, 0xFFFF), 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);               // comment length
    await this._write(eocd);
  }
}

// ==================== ZIP 读取 ====================
/**
 * reader 接口：
 *   size(): Promise<number>
 *   read(offset, length): Promise<Buffer>            // 精确读取
 *   createReadStream(offset, length): Promise<Readable|null>
 */
async function readZipEntries(reader) {
  const size = await reader.size();
  if (size < 22) throw new Error('不是有效的 ZIP 文件（文件过小）');
  const tailLen = Math.min(size, 66000);
  const tail = await reader.read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（未找到中央目录）');
  const total = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (total === 0xFFFF || cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
    throw new Error('暂不支持 ZIP64 格式的压缩包');
  }
  if (!cdSize || cdOffset + cdSize > size) throw new Error('ZIP 中央目录损坏');

  const cd = await reader.read(cdOffset, cdSize);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length) {
    if (cd.readUInt32LE(p) !== SIG_CENTRAL) break;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed = cd.readUInt32LE(p + 20);
    const uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localOffset = cd.readUInt32LE(p + 42);
    const nameBuf = cd.slice(p + 46, p + 46 + nameLen);
    const utf8 = (flags & FLAG_UTF8) !== 0;
    const name = utf8 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    entries.push({ name, method, crc, compressed, uncompressed, localOffset, isDir: /\/$/.test(name) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解析本地头，返回数据区起始偏移 */
async function entryDataOffset(reader, entry) {
  const head = await reader.read(entry.localOffset, 30);
  if (head.length < 30 || head.readUInt32LE(0) !== SIG_LOCAL) throw new Error('ZIP 条目本地头损坏: ' + entry.name);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  return entry.localOffset + 30 + nameLen + extraLen;
}

/**
 * 解压单个条目 → 可读流（未压缩数据）
 * 若条目为空文件返回 null
 */
async function openEntryStream(reader, entry) {
  if (entry.isDir || entry.compressed === 0) return null;
  const start = await entryDataOffset(reader, entry);
  const raw = await reader.createReadStream(start, entry.compressed);
  if (!raw) return null;
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    const inflate = zlib.createInflateRaw();
    const out = new PassThrough();
    raw.pipe(inflate).pipe(out);   // 出错由 out 转发
    raw.on('error', (e) => out.destroy(e));
    inflate.on('error', (e) => out.destroy(e));
    return out;
  }
  throw new Error('不支持的压缩方式 method=' + entry.method + '（' + entry.name + '）');
}

/** 校验 ZIP 条目 CRC32 是否与解压数据一致（可选，用于完整性校验） */
function verifyEntryCrc(chunks, expected) {
  let crc = crc32Start();
  let len = 0;
  for (const c of chunks) { crc = crc32Update(crc, c); len += c.length; }
  return crc32Final(crc) === expected;
}

// 把可读流写入本地文件，返回 {size, crc}
function writeStreamToFile(readable, filePath) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const ws = fs.createWriteStream(filePath);
    let size = 0;
    let crc = crc32Start();
    readable.on('data', (c) => { size += c.length; crc = crc32Update(crc, c); });
    readable.on('error', (e) => { ws.destroy(); reject(e); });
    ws.on('error', reject);
    ws.on('finish', () => resolve({ size, crc: crc32Final(crc) }));
    readable.pipe(ws);
  });
}

module.exports = {
  ZipWriter,
  readZipEntries,
  openEntryStream,
  entryDataOffset,
  writeStreamToFile,
  crc32Start, crc32Update, crc32Final, verifyEntryCrc,
  SIG_EOCD, SIG_CENTRAL, SIG_LOCAL, SIG_DESCRIPTOR
};
