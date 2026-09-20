'use strict';
const fs = require('fs');
(async () => {
  const url = 'https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip';
  console.log('downloading', url);
  const r = await fetch(url);
  if (!r.ok) { console.log('HTTP', r.status); process.exit(1); }
  const total = +(r.headers.get('content-length') || 0);
  console.log('size:', (total / 1024 / 1024).toFixed(1), 'MB');
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync('d:/新建文件夹/_tmp_jdk17.zip', buf);
  console.log('saved', buf.length, 'bytes');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
