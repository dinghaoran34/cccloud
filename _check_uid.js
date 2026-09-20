const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
open({ filename: 'd:/新建文件夹/teamcloud.db', driver: sqlite3.Database }).then(async db => {
  const rows = await db.all('SELECT uid, username FROM users LIMIT 5');
  console.log(JSON.stringify(rows));
  const st = await db.all("SELECT sql FROM sqlite_master WHERE name='users'");
  console.log(st[0].sql);
  process.exit(0);
});
