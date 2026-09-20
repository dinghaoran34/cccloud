# CC网盘

团队协作云盘系统，包含 **服务端 + 网页端 + 安卓客户端** 三部分。服务端为单进程 Node.js 应用，文件本体存放于 S3 兼容对象存储（也支持本地磁盘策略），元数据使用 SQLite。

- 网页端：Cloudreve 风格界面，桌面 / 移动 / 老设备三套模板
- 安卓端：原生 Java 实现，`minSdk 11`，支持 Android 2.3 及以上设备
- 当前安卓版本：**v6.10**（versionCode 41）

---

## 功能一览

### 文件管理
- 上传：小文件直传、大文件分片上传、秒传（哈希去重）、断点续传
- 下载、在线预览（图片 / 视频 / 音频 / PDF / 文本 / 代码）
- 重命名、移动、复制、删除、回收站（恢复 / 彻底删除 / 清空）
- 搜索、标签、收藏、最近访问、版本历史
- zip 打包下载与原位解压

### 协作与分享
- 团队空间、成员管理与权限控制、团队文件
- 分享链接（可设提取码与有效期）、撤销分享

### 离线下载
- HTTP/HTTPS 直链任务：进度与速度、暂停 / 继续 / 取消 / 重试、并发上限与排队、失败重试
- 支持 Range 断点续传（服务端不支持 Range 时自动安全重下）
- 下载前配额校验；仅允许 http/https，默认拒绝内网与 localhost 地址（防 SSRF，可用 `OFFLINE_ALLOW_HOSTS` 放开）
- 磁力链接 / 种子：需对接 Aria2（未部署时会给出明确提示，不会静默失败）

### Office 文档
- 只读预览：`docx` / `xlsx` / `pptx` 由服务端直接解析渲染（**纯本地实现，无需任何外部服务**）
- 在线编辑：需部署 OnlyOffice Document Server 并配置环境变量（未配置时入口会明确提示降级）

### 开放能力
- 开放 API v1：`/api/v1/*`（`me` / `files` / `folders` / `upload` / `download` / `files/:id`）
- WebDAV：挂载点 `/dav`（路径映射到用户个人文件树），可在用户组中开关

### 管理后台
- 概览、审计日志、存储策略（S3 / 本地磁盘，可设默认）、用户组（配额与上传/分享/API/WebDAV 权限）、开放 API 密钥

### 界面
- 浅色 / 深色 / 跟随系统 三选一主题
- 桌面现代版、移动版、老设备兼容版三套模板按 UA 自动分发

---

## 技术栈

| 层次 | 技术 |
|---|---|
| 运行时 | Node.js 18+（推荐 20 LTS） |
| Web 框架 | Express 4 + EJS |
| 数据库 | SQLite（`sqlite3` + `sqlite`） |
| 对象存储 | S3 兼容（`@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`） |
| 其它 | `multer`（上传）、`bcryptjs`（口令哈希）、`express-session`、`iconv-lite` |

无前端构建步骤：模板为 EJS，静态资源为原生 HTML/CSS/JS。

---

## 目录结构

```
server.js            # 主服务入口（路由、中间件、配置）
storage.js           # 存储策略抽象（S3 + 本地磁盘双后端）
s3store.js           # S3 对象存储封装
ziplib.js            # 纯 Node 实现的 ZIP 读写（zip 打包/解压、Office 文档解析复用）
offline.js           # 离线下载管理器（流式下载、断点续传、任务调度）
aria2.js             # Aria2 JSON-RPC 客户端（磁力/种子对接）
officedoc.js         # Office Open XML 只读解析（docx/xlsx/pptx → HTML）
onlyoffice.js        # OnlyOffice 对接层（JWT 签发/校验、文档 key、回调写回）
views/               # EJS 模板（现代版 / 兼容版 / 移动版）
public/              # 静态资源（css / js / icons）
APK/                 # 安卓客户端工程（Gradle）
API文档.md            # 接口文档
服务端部署文档.md      # 部署文档（Nginx、PM2、环境变量、HTTPS）
用户协议.txt / 隐私政策.txt   # 协议文本（GBK 编码，服务端读取时转 UTF-8）
```

---

## 快速开始

```bash
# 1) 安装依赖
npm install

# 2) 配置对象存储（必填）
export TEAMCLOUD_S3_ACCESS_KEY='你的 AK'
export TEAMCLOUD_S3_SECRET_KEY='你的 SK'

# 3) 启动
npm start
# 日志出现以下内容即为成功：
# CC网盘服务器已启动: http://127.0.0.1:9178
```

默认监听 `127.0.0.1:9178`，生产环境建议前置 Nginx 提供 HTTPS 反向代理（详见 `服务端部署文档.md`）。

> SQLite 数据库 `teamcloud.db` 首次启动会自动创建，表结构与字段变更为幂等迁移，老库可平滑升级。

---

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `TEAMCLOUD_S3_ACCESS_KEY` | 是 | — | 对象存储 Access Key |
| `TEAMCLOUD_S3_SECRET_KEY` | 是 | — | 对象存储 Secret Key |
| `TEAMCLOUD_S3_ENDPOINT` | 否 | `https://cn-nb1.rains3.com` | 兼容 MinIO / 腾讯 COS 等，填对应 Endpoint |
| `TEAMCLOUD_S3_BUCKET` | 否 | `teamcloud` | 存储桶名称 |
| `PORT` | 否 | `9178` | 监听端口 |
| `HOST` | 否 | `127.0.0.1` | 监听地址（建议保持仅本机可访问） |
| `ARIA2_RPC_URL` | 否 | `http://127.0.0.1:6800/jsonrpc` | Aria2 RPC 地址，用于磁力/种子 |
| `ARIA2_RPC_SECRET` | 否 | 空 | Aria2 RPC 密钥 |
| `OFFLINE_ALLOW_HOSTS` | 否 | 空 | 离线下载允许的内网主机白名单（逗号分隔） |
| `ONLYOFFICE_URL` | 否 | 空 | OnlyOffice Document Server 地址（配置后启用在线编辑） |
| `ONLYOFFICE_JWT_SECRET` | 否 | 空 | OnlyOffice JWT 密钥 |

---

## 存储策略

- 默认使用 S3 对象存储；可在**管理后台 → 存储策略**中添加并切换默认策略
- 也支持**本地磁盘**策略（对象落盘到本地目录），适合无对象存储的部署环境
- 离线下载与文件上传均写入当前默认策略；若默认策略不可用，相关操作会明确报错

---

## 安卓客户端构建

```bash
cd APK

# 指定 Android SDK 路径（二选一）
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
# 或设置环境变量 ANDROID_HOME

# 构建 Release
./gradlew :app:assembleRelease
```

- 产物：`app/build/outputs/apk/release/app-release.apk`
- 签名：在 `APK/keystore.properties` 中配置密钥库信息即用正式证书签名；**未提供时自动回退调试签名**
- 兼容性：`minSdk 11` / `targetSdk 28`
- 应用内提供浅色 / 深色 / 跟随系统三种外观；顶部栏采用「搜索 / 上传 / 更多」三个入口，低频操作收进溢出菜单

---

## 文档

- [API文档.md](API文档.md) —— 接口说明
- [服务端部署文档.md](服务端部署文档.md) —— 架构、环境要求、部署步骤、Nginx 与 PM2 配置

---

## 仓库说明

本仓库**不包含**以下内容（已在 `.gitignore` 中排除）：

- APK 签名密钥与 `keystore.properties`（防止他人冒名签发）
- SQLite 数据库文件（含用户数据与口令哈希）
- 编译产物、依赖目录与安装包二进制

首次注册的账号即为管理员，请在生产环境部署后**立即修改默认口令**，并将 `server.js` 中的 Session 密钥改为随机长字符串。
