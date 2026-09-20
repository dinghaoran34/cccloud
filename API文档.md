# CC网盘 API 接口文档

> 本文档覆盖：免极验验证登录接口、管理后台接口（用户管理 / API 密钥管理）、开放 API v1、WebDAV。
> 除特别说明外，所有接口均返回 JSON；请求与响应编码均为 UTF-8。

## 目录

1. [通用说明](#通用说明)
2. [免验证登录接口](#1-免验证登录接口)
3. [管理后台接口](#2-管理后台接口)
4. [开放 API v1](#3-开放-api-v1)
5. [WebDAV](#4-webdav)
6. [附录：错误码](#附录错误码)

---

## 通用说明

### 服务地址

```
http://<服务器地址>:<端口>/
```

- 默认端口：`9178`（可用环境变量 `PORT` 覆盖）
- 文中示例默认使用 `http://127.0.0.1:9178`，请按实际部署地址替换。

### 认证方式

| 接口类别 | 认证方式 |
|----------|----------|
| 免验证登录 `/api/login/no-captcha` | 请求头 `X-Api-Key` 或请求体 `apiKey` 携带有效密钥 |
| 管理后台 `/api/admin/*` | 登录会话（Cookie）+ 当前用户须为管理员（`role=admin`） |
| 开放 API `/api/v1/*` | 请求头 `Authorization: Bearer <api_key>` |
| WebDAV `/dav*` | HTTP Basic：用户名=站点用户名，密码=账户密码 或 该用户的 API 密钥 |

### 密钥类型

免验证登录接口接受两类密钥，任一有效即可：

1. **环境变量密钥**：服务端通过环境变量 `INTERNAL_API_KEY` 配置；
2. **动态密钥**：管理员在管理后台 `/admin` 或通过 `POST /api/admin/apikeys` 生成的密钥。

### 响应格式

```json
{ "ok": true, ... }
{ "ok": false, "error": "错误描述" }
```

---

## 1. 免验证登录接口

### 1.1 登录（跳过极验验证）

跳过极验（GeeTest）行为验证，使用用户名 + 密码直接登录，成功后在服务端建立与正常登录相同的会话（Session）。

**请求**

```
POST /api/login/no-captcha
Content-Type: application/json
```

**请求参数（JSON body）**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `username` | string | 是 | 用户名 |
| `password` | string | 是 | 登录密码 |
| `agree` | string/boolean | 是 | 必须为 `"true"`（同意用户协议） |
| `rememberMe` | string/boolean | 否 | `"true"` 时保持登录 30 天 |
| `apiKey` | string | 条件必填 | 内部密钥（与请求头 `X-Api-Key` 二选一） |

**密钥传递方式（二选一）**

- 请求头：`X-Api-Key: <密钥>`
- 请求体：`"apiKey": "<密钥>"`

**curl 示例**

```bash
# 方式一：密钥放请求头
curl -X POST http://127.0.0.1:9178/api/login/no-captcha \
  -H "X-Api-Key: tc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"123456","agree":"true"}'

# 方式二：密钥放请求体 + 记住我（30 天）
curl -X POST http://127.0.0.1:9178/api/login/no-captcha \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"123456","agree":"true","rememberMe":"true","apiKey":"tc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'
```

**成功响应**（HTTP 200）

```json
{ "ok": true, "uid": "A1B2C3D4", "username": "alice" }
```

同时服务端通过 `Set-Cookie` 下发会话 Cookie；携带该 Cookie 即可直接访问需登录的接口（`/api/me`、`/api/list` 等）与网页端。

**错误响应**

| HTTP 状态 | 场景 | 响应体 error |
|-----------|------|--------------|
| 401 | 未携带密钥或密钥无效 | `内部密钥无效` |
| 400 | 用户名/密码为空 | `用户名和密码不能为空` |
| 400 | 未同意用户协议 | `请先阅读并同意用户协议` |
| 400 | 用户名或密码错误 | `用户名或密码错误` |
| 403 | 账户被封禁 | `该账户已被封禁，请联系管理员` |
| 500 | 服务器内部错误 | `登录失败: <详情>` |

> 注意：该接口绕过人机验证，请务必妥善保管密钥；被封禁用户无法通过本接口登录。

---

## 2. 管理后台接口

> 以下接口均需管理员身份（登录用户 `role=admin`），否则返回：
> - 401 `请先登录CC网盘`（未登录）
> - 403 `无管理员权限`（非管理员）

### 2.1 用户列表

**请求**

```
GET /api/admin/users
```

**成功响应**

```json
{
  "ok": true,
  "users": [
    { "id": 1, "username": "Administrator", "uid": "XXXX", "nickname": "Administrator", "role": "admin", "banned": 0, "created_at": "2026-09-13 10:00:00" },
    { "id": 2, "username": "alice", "uid": "A1B2C3D4", "nickname": "alice", "role": "user", "banned": 1, "created_at": "..." }
  ]
}
```

字段说明：`role` 取值为 `admin` / `user`；`banned` 为 `1`（已封禁）/ `0`（正常）。

### 2.2 封禁 / 解封用户

**请求**

```
POST /api/admin/users/:id/ban
Content-Type: application/json
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `banned` | number | 是 | `1` 封禁，`0` 解封 |

**curl 示例**

```bash
# 封禁 id=2 的用户
curl -X POST http://127.0.0.1:9178/api/admin/users/2/ban \
  -H "Content-Type: application/json" \
  -d '{"banned":1}'

# 解封
curl -X POST http://127.0.0.1:9178/api/admin/users/2/ban \
  -H "Content-Type: application/json" \
  -d '{"banned":0}'
```

**成功响应**

```json
{ "ok": true }
```

**限制**：不能封禁管理员账户（403 `不能封禁管理员账户`）。封禁后该用户无法通过网页、`/api/login`、`/api/login/no-captcha` 任何入口登录。

### 2.3 删除用户

**请求**

```
DELETE /api/admin/users/:id
```

**curl 示例**

```bash
curl -X DELETE http://127.0.0.1:9178/api/admin/users/2
```

**成功响应**

```json
{ "ok": true }
```

**限制**：
- 不能删除自己（400 `不能删除自己`）；
- 不能删除管理员账户（403 `不能删除管理员账户`）。

### 2.4 API 密钥列表

**请求**

```
GET /api/admin/apikeys
```

**成功响应**

```json
{
  "ok": true,
  "keys": [
    { "id": 1, "api_key": "tc_xxxxxxxx...", "label": "自动化脚本", "created_at": "..." }
  ]
}
```

### 2.5 生成 API 密钥

**请求**

```
POST /api/admin/apikeys
Content-Type: application/json
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `label` | string | 否 | 密钥用途备注，默认 `免验证登录密钥` |

**curl 示例**

```bash
curl -X POST http://127.0.0.1:9178/api/admin/apikeys \
  -H "Content-Type: application/json" \
  -d '{"label":"压测脚本"}'
```

**成功响应**

```json
{ "ok": true, "apiKey": "tc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "id": 1 }
```

> 生成的密钥即刻生效，可用于免验证登录接口；请立即保存，接口仅返回一次明文（后续可通过列表接口查看）。

### 2.6 删除 API 密钥

**请求**

```
DELETE /api/admin/apikeys/:id
```

**curl 示例**

```bash
curl -X DELETE http://127.0.0.1:9178/api/admin/apikeys/1
```

**成功响应**

```json
{ "ok": true }
```

> 删除后该密钥立即失效。

### 2.7 常用组合流程

```
1. 管理员登录（网页或 /api/login）获得会话
2. POST /api/admin/apikeys 生成密钥
3. 脚本使用 X-Api-Key: <密钥> 调用 POST /api/login/no-captcha 免验证登录
4. 携带返回的会话 Cookie 访问 /api/* 业务接口
5. 不再使用时 DELETE /api/admin/apikeys/:id 吊销密钥
```

---

## 3. 开放 API v1

**鉴权**：请求头 `Authorization: Bearer <api_key>`。

- `<api_key>` 为管理后台「API 密钥管理」生成的密钥（表 `api_keys`），调用方身份 = 该密钥的创建者账户；
- 也接受服务端环境变量 `INTERNAL_API_KEY`（此时默认以内置管理员 `Administrator` 身份操作，可用请求头 `X-User-Id: <用户id>` 指定其它用户）；
- 密钥缺失/无效返回 `401 {ok:false,error}`；账户被封禁或所属用户组禁用开放 API 返回 `403`。

**统一响应**：`{ "ok": true, ... }` / `{ "ok": false, "error": "描述" }`。

| 接口 | 说明 |
|------|------|
| `GET /api/v1/me` | 当前用户信息（user/group）与容量（used/quota，单位字节） |
| `GET /api/v1/files?folderId=` | 列出指定目录（缺省根目录）下的文件夹与文件 |
| `POST /api/v1/folders` | 新建文件夹，JSON：`{"name":"目录名","parentId":0}` |
| `POST /api/v1/upload` | 上传文件，multipart 字段 `file`，可选 `folderId` |
| `GET /api/v1/download/:id` | 下载（302 跳转到下载地址；本地磁盘策略为服务器流式回源） |
| `DELETE /api/v1/files/:id` | 删除文件（移入回收站，可在回收站恢复） |

**curl 示例**

```bash
KEY=tc_xxxxxxxx
BASE=http://127.0.0.1:9178

curl -H "Authorization: Bearer $KEY" $BASE/api/v1/me
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/files"
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -d '{"name":"api-目录"}' $BASE/api/v1/folders
curl -X POST -H "Authorization: Bearer $KEY" -F "file=@./demo.txt" $BASE/api/v1/upload
curl -L -H "Authorization: Bearer $KEY" -o ./demo.out $BASE/api/v1/download/123
curl -X DELETE -H "Authorization: Bearer $KEY" $BASE/api/v1/files/123
```

**安全说明**：所有接口仅能访问密钥所属用户自己的文件树；上传文件名/存储键由服务端生成与校验，拒绝 `..`、路径分隔符与绝对路径。

---

## 4. WebDAV

**挂载点**：`/dav`（根 = 认证用户的个人文件树根目录）。

**认证**：HTTP Basic，用户名为站点用户名，密码为账户密码或该用户创建的 API 密钥。认证失败返回 `401` 并携带 `WWW-Authenticate: Basic realm="TeamCloud WebDAV"`；账户被封禁或用户组禁用 WebDAV 返回 `403`。

**支持方法**：`OPTIONS`（免认证，返回 `DAV: 1, 2` 与 `Allow`）、`PROPFIND`（`Depth: 0/1`，返回 `207 Multi-Status` XML，含 `resourcetype`/`getcontentlength`/`getlastmodified`/`getcontenttype`）、`GET`/`HEAD`（支持 Range）、`PUT`、`DELETE`（进回收站）、`MKCOL`、`MOVE`、`COPY`。

**状态码约定**：`201` 创建成功、`204` 覆盖/删除成功、`404` 资源不存在、`405` 已存在/集合不支持 GET、`409` 父集合不存在、`412` 目标已存在且 `Overwrite: F`。

**curl 示例**

```bash
BASE=http://127.0.0.1:9178
curl -u "用户名:密码" -X PROPFIND -H "Depth: 1" $BASE/dav/
curl -u "用户名:密码" -T ./demo.txt $BASE/dav/demo.txt
curl -u "用户名:密码" -o ./demo.out $BASE/dav/demo.txt
curl -u "用户名:密码" -X MKCOL $BASE/dav/newdir
curl -u "用户名:密码" -X MOVE -H "Destination: $BASE/dav/newdir/demo.txt" $BASE/dav/demo.txt
```

**rclone 配置示例**

```ini
[teamcloud]
type = webdav
url = http://127.0.0.1:9178/dav
vendor = other
user = 用户名
pass = 密码（或该用户的 API 密钥）
```

**安全说明**：路径逐段校验，拒绝 `..`、`.`、反斜杠、盘符（`C:`）、绝对路径与 NUL/控制字符，合法路径再按用户名精确解析，只能访问该用户个人的文件与文件夹记录。

---

## 附录：错误码

| HTTP 状态码 | 含义 |
|-------------|------|
| 200 | 成功 |
| 201 / 204 | WebDAV：创建成功 / 覆盖·删除成功 |
| 207 | WebDAV：Multi-Status（PROPFIND） |
| 400 | 参数错误 / 业务校验失败 / WebDAV 非法路径 |
| 401 | 未认证（未登录 / 密钥无效 / WebDAV 认证失败） |
| 403 | 无权限（非管理员 / 账户被封禁 / 用户组限制 / 越权访问） |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |
