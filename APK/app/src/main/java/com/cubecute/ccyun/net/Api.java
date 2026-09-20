package com.cubecute.ccyun.net;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;

/**
 * 服务端接口封装。所有方法必须在后台线程调用。
 * 失败（HTTP非2xx 或 ok=false）抛出 ApiException（message 为服务器 error 文案）。
 */
public final class Api {

    public static class ApiException extends Exception {
        public ApiException(String m) { super(m); }
    }

    private Api() {}

    private static JSONObject exec(Http.Result r) throws ApiException {
        if (r.ok()) {
            JSONObject j = r.json();
            if (!j.optBoolean("ok", false) && j.has("ok")) {
                throw new ApiException(j.optString("error", "操作失败"));
            }
            return j;
        }
        throw new ApiException(r.error());
    }

    // ---------- 认证 ----------
    public static JSONObject login(String username, String password, boolean rememberMe) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("username", username);
            b.put("password", password);
            b.put("rememberMe", rememberMe);
            b.put("agree", true);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/login", b));
    }

    public static JSONObject register(String username, String password, String confirm) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("username", username);
            b.put("password", password);
            b.put("confirmPassword", confirm);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/register", b));
    }

    public static void logout() throws ApiException {
        exec(Http.post("/api/logout", new JSONObject()));
        Http.clearSession();
        SecureStore.clearCredentials(); // 主动退出：清除一年期免登录凭据
    }

    // ---------- 账户资料：昵称 + 头像 ----------
    public static JSONObject accountProfile() throws ApiException {
        return exec(Http.get("/api/account/profile"));
    }

    public static JSONObject updateNickname(String nickname) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("nickname", nickname); } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/account/profile", b));
    }

    /** 上传头像（服务端中转 ≤5MB 图片，multipart 字段 avatar） */
    public static JSONObject uploadAvatar(InputStream in, String fileName) throws ApiException {
        return exec(Http.uploadMultipart("/api/account/avatar",
                new String[]{}, new String[]{}, "avatar", fileName, in));
    }

    // ---------- 回收站 / 批量 / 移动 / 搜索 ----------
    private static JSONArray ids(long[] ids) {
        JSONArray a = new JSONArray();
        for (long id : ids) a.put(id);
        return a;
    }

    public static JSONObject trashList() throws ApiException {
        return exec(Http.get("/api/trash/list"));
    }

    public static JSONObject trashRestore(long[] folderIds, long[] fileIds) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("folderIds", ids(folderIds));
            b.put("fileIds", ids(fileIds));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/trash/restore", b));
    }

    public static JSONObject trashPurge(long[] folderIds, long[] fileIds) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("folderIds", ids(folderIds));
            b.put("fileIds", ids(fileIds));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/trash/purge", b));
    }

    public static JSONObject trashEmpty() throws ApiException {
        return exec(Http.post("/api/trash/empty", new JSONObject()));
    }

    public static JSONObject batchDelete(long[] folderIds, long[] fileIds) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("folderIds", ids(folderIds));
            b.put("fileIds", ids(fileIds));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/batch/delete", b));
    }

    public static JSONObject batchShare(long[] fileIds) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("fileIds", ids(fileIds)); } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/batch/share", b));
    }

    public static JSONObject fileMove(long id, long targetFolderId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); b.put("folderId", targetFolderId); } catch (Exception e) {}
        return exec(Http.post("/api/file/move", b));
    }

    public static JSONObject folderMove(long id, long targetParentId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); b.put("parentId", targetParentId); } catch (Exception e) {}
        return exec(Http.post("/api/folder/move", b));
    }

    public static JSONObject search(String q) throws ApiException {
        try {
            return exec(Http.get("/api/search?q=" + java.net.URLEncoder.encode(q, "UTF-8")));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
    }

    /** 搜索建议/自动完成（≤8 条） */
    public static JSONObject searchSuggest(String q) throws ApiException {
        try {
            return exec(Http.get("/api/search/suggest?q=" + java.net.URLEncoder.encode(q, "UTF-8")));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
    }

    // ---------- 团队密码 ----------
    public static JSONObject teamInfo(String ownerUid) throws ApiException {
        try {
            return exec(Http.get("/api/team/info?ownerUid=" + java.net.URLEncoder.encode(ownerUid, "UTF-8")));
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
    }

    /** password 为空=清除密码 */
    public static JSONObject teamSetPassword(long teamId, String password) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("teamId", teamId);
            b.put("password", password == null ? "" : password);
        } catch (Exception e) {}
        return exec(Http.post("/api/team/password", b));
    }

    /** 登录态探测。返回 null 表示未登录。 */
    public static JSONObject meQuiet() {
        Http.Result r = Http.get("/api/me");
        if (r.ok()) {
            JSONObject j = r.json();
            return j.optBoolean("ok", false) ? j : null;
        }
        return null;
    }

    public static JSONObject me() throws ApiException {
        return exec(Http.get("/api/me"));
    }

    // ---------- 网盘 ----------
    public static JSONObject list(Long folderId) throws ApiException {
        String p = "/api/list";
        if (folderId != null && folderId > 0) p += "?folderId=" + folderId;
        return exec(Http.get(p));
    }

    public static JSONObject folderCreate(String name, Long parentId) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("name", name);
            if (parentId != null) b.put("parentId", parentId);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/folder/create", b));
    }

    public static JSONObject folderRename(long id, String name) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); b.put("name", name); } catch (Exception e) {}
        return exec(Http.post("/api/folder/rename", b));
    }

    public static JSONObject folderDelete(long id) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); } catch (Exception e) {}
        return exec(Http.post("/api/folder/delete", b));
    }

    public static JSONObject fileRename(long id, String name) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); b.put("name", name); } catch (Exception e) {}
        return exec(Http.post("/api/file/rename", b));
    }

    public static JSONObject fileDelete(long id) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("id", id); } catch (Exception e) {}
        return exec(Http.post("/api/file/delete", b));
    }

    public static JSONObject presignUpload(String filename, boolean shared, Long teamId,
                                           Long folderId, String contentType, long size) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("filename", filename);
            b.put("share", shared);
            if (teamId != null) b.put("teamId", teamId);
            if (folderId != null) b.put("folderId", folderId);
            if (contentType == null) contentType = "application/octet-stream";
            b.put("contentType", contentType);
            b.put("size", size);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/upload/presign", b));
    }

    public static JSONObject confirmUpload(String storedName, String filename, long size,
                                           boolean shared, Long teamId, Long folderId) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("storedName", storedName);
            b.put("filename", filename);
            b.put("size", size);
            b.put("share", shared);
            if (teamId != null) b.put("teamId", teamId);
            if (folderId != null) b.put("folderId", folderId);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/upload/confirm", b));
    }

    public static JSONObject downloadPresign(long id) throws ApiException {
        return exec(Http.get("/download/presign/" + id));
    }

    public static JSONObject teamDownloadPresign(long teamId, long fileId) throws ApiException {
        return exec(Http.get("/team/" + teamId + "/download/presign/" + fileId));
    }

    // ---------- 中转代理（低版本安卓直连 S3 失败时的回退） ----------
    public static String downloadProxyUrl(long id) {
        return Constants.BASE_URL + "/api/download/proxy/" + id;
    }

    public static String teamDownloadProxyUrl(long teamId, long fileId) {
        return Constants.BASE_URL + "/api/team/" + teamId + "/download/proxy/" + fileId;
    }

    /** 服务端中转上传（multipart 字段 file + 可选 folderId），成功后已入库 */
    public static JSONObject relayUpload(InputStream in, String fileName, Long folderId) throws ApiException {
        return relayUpload(in, fileName, folderId, -1, null);
    }

    /** 服务端中转上传（带文件长度与进度；老版本安卓回退通道） */
    public static JSONObject relayUpload(InputStream in, String fileName, Long folderId,
                                         long fileLength, Http.Progress progress) throws ApiException {
        String[] names = folderId != null ? new String[]{"folderId"} : new String[]{};
        String[] vals = folderId != null ? new String[]{String.valueOf(folderId)} : new String[]{};
        return exec(Http.uploadMultipart("/api/upload/relay", names, vals, "file", fileName,
                in, fileLength, progress));
    }

    /** 分片上传进度回调 */
    public interface UpProgress { void onProgress(long done, long total); }

    /**
     * 服务端分片中转上传（/upload/init → /upload/chunk → /upload/complete）。
     *
     * 用途：老版本安卓直连对象存储（S3 预签名 URL）常因 TLS/SNI 兼容问题失败，
     * 该通道只与本站服务器通信（与登录同一链路），并支持团队上传。
     *
     * @param file     本地待上传文件
     * @param teamId   非空表示团队上传
     */
    public static JSONObject uploadChunked(java.io.File file, String fileName, boolean shared,
                                           Long teamId, UpProgress cb) throws ApiException {
        final long size = file.length();
        if (size <= 0) throw new ApiException("文件为空或无法读取");
        final int chunk = 4 * 1024 * 1024;
        final int chunkCount = (int) ((size + chunk - 1) / chunk);

        // 1) 初始化分片会话
        JSONObject initBody = new JSONObject();
        try {
            initBody.put("filename", fileName);
            initBody.put("size", size);
            initBody.put("chunkCount", chunkCount);
            initBody.put("share", shared);
            if (teamId != null) initBody.put("teamId", teamId);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        JSONObject init = exec(Http.post("/upload/init", initBody));
        final String sessionId = init.optString("sessionId", "");
        final String storedName = init.optString("storedName", "");
        if (sessionId.length() == 0 || storedName.length() == 0) throw new ApiException("服务端未返回上传会话");

        // 2) 逐片上传（每片独立请求，避免内存峰值）
        java.io.RandomAccessFile raf = null;
        try {
            raf = new java.io.RandomAccessFile(file, "r");
            byte[] buf = new byte[chunk];
            long done = 0;
            for (int i = 0; i < chunkCount; i++) {
                int read = 0;
                while (read < chunk) {
                    int n = raf.read(buf, read, chunk - read);
                    if (n < 0) break;
                    read += n;
                }
                if (read <= 0) break;
                Http.Result r = Http.uploadMultipart("/upload/chunk",
                        new String[]{"sessionId", "index"},
                        new String[]{sessionId, String.valueOf(i)},
                        "chunk", "chunk" + i,
                        new java.io.ByteArrayInputStream(buf, 0, read), read, null);
                if (!r.ok()) throw new ApiException("分片上传失败（HTTP " + r.code + "）");
                done += read;
                if (cb != null) cb.onProgress(done, size);
            }
        } catch (ApiException ae) {
            throw ae;
        } catch (Exception e) {
            throw new ApiException("分片上传失败：" + e.getMessage());
        } finally {
            if (raf != null) try { raf.close(); } catch (Exception ignored) {}
        }

        // 3) 合并入库
        JSONObject body = new JSONObject();
        try {
            body.put("sessionId", sessionId);
            body.put("storedName", storedName);
            body.put("filename", fileName);
            body.put("size", size);
            body.put("chunkCount", chunkCount);
            body.put("share", shared);
            if (teamId != null) body.put("teamId", teamId);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/upload/complete", body));
    }

    public static JSONObject preview(long id) throws ApiException {
        return exec(Http.get("/preview/" + id));
    }

    public static JSONObject teamPreview(long teamId, long fileId) throws ApiException {
        return exec(Http.get("/team/" + teamId + "/preview/" + fileId));
    }

    public static JSONObject shareCreate(long fileId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("fileId", fileId); } catch (Exception e) {}
        return exec(Http.post("/share/create", b));
    }

    public static JSONObject shareRevoke(long fileId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("fileId", fileId); } catch (Exception e) {}
        return exec(Http.post("/share/revoke", b));
    }

    // ---------- 团队 ----------
    public static JSONObject teamCreate(String name) throws ApiException {
        return teamCreate(name, "");
    }

    public static JSONObject teamCreate(String name, String password) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("name", name);
            if (password != null && password.length() > 0) b.put("password", password);
        } catch (Exception e) {}
        return exec(Http.post("/api/team/create", b));
    }

    public static JSONObject teamJoin(String ownerUid) throws ApiException {
        return teamJoin(ownerUid, "");
    }

    public static JSONObject teamJoin(String ownerUid, String password) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("ownerUid", ownerUid);
            if (password != null && password.length() > 0) b.put("password", password);
        } catch (Exception e) { throw new ApiException(e.getMessage()); }
        return exec(Http.post("/api/team/join", b));
    }

    public static JSONObject teamLeave(long teamId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("teamId", teamId); } catch (Exception e) {}
        return exec(Http.post("/api/team/leave", b));
    }

    public static JSONObject teamAddMember(long teamId, String targetUid) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("teamId", teamId); b.put("targetUid", targetUid); } catch (Exception e) {}
        return exec(Http.post("/api/team/add-member", b));
    }

    public static JSONObject teamRemoveMember(long teamId, long memberUserId) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("teamId", teamId); b.put("memberUserId", memberUserId); } catch (Exception e) {}
        return exec(Http.post("/api/team/remove-member", b));
    }

    public static JSONObject teamDissolve(long teamId, String password) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("teamId", teamId); b.put("password", password); } catch (Exception e) {}
        return exec(Http.post("/api/team/dissolve", b));
    }

    // ---------- 账户 ----------
    public static JSONObject accountPassword(String oldP, String newP, String confirm) throws ApiException {
        JSONObject b = new JSONObject();
        try {
            b.put("oldPassword", oldP);
            b.put("newPassword", newP);
            b.put("confirmPassword", confirm);
        } catch (Exception e) {}
        return exec(Http.post("/api/account/password", b));
    }

    public static JSONObject accountDelete(String password) throws ApiException {
        JSONObject b = new JSONObject();
        try { b.put("password", password); } catch (Exception e) {}
        JSONObject r = exec(Http.post("/api/account/delete", b));
        // 账户已注销：清除本地会话与一年期免登录凭据
        Http.clearSession();
        SecureStore.clearCredentials();
        return r;
    }
}
