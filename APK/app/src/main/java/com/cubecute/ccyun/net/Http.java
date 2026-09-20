package com.cubecute.ccyun.net;

import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookieStore;
import java.net.HttpCookie;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.List;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 极简 HTTP 封装（HttpURLConnection，无第三方依赖）。
 * - 自动携带/保存会话 Cookie：令牌经 AuthSession/SecureStore 加密持久化，支持免登录
 * - 会话失效(401)自动清理并引导重新登录（AuthSession.handleServerUnauthorized）
 * - 兼容 Android 4.0+：显式启用 TLS1.2（4.4+），失败回退系统默认
 * - 所有方法在调用线程执行，请勿在主线程调用
 */
public final class Http {

    public static final int TIMEOUT = 30000;

    /** 传输缓冲区：256KB（旧值 8KB 会导致大量小包写入，吞吐明显偏低） */
    public static final int IO_BUFFER = 256 * 1024;

    /** 大文件传输放宽超时，避免慢网络下中途被判超时 */
    public static final int TIMEOUT_LARGE = 120000;

    private static CookieManager cookieManager;

    private Http() {}

    public static void init(Context context) {
        AuthSession.attach(context); // 内含 SecureStore.init（安全存储）
        cookieManager = new CookieManager();
        cookieManager.setCookiePolicy(java.net.CookiePolicy.ACCEPT_ALL);
        CookieHandler.setDefault(cookieManager);
        enableTls12();
        // 恢复解密后的持久化会话令牌（进程被杀/重启后仍可自动登录）
        String saved = SecureStore.load();
        if (saved != null && saved.length() > 0) {
            addSessionCookie(saved);
            setRememberPersistence(true); // 恢复自持久化存储=“记住我”会话
        }
    }

    private static void addSessionCookie(String pair) {
        try {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                HttpCookie ck = new HttpCookie(pair.substring(0, eq), pair.substring(eq + 1));
                ck.setPath("/");
                ck.setVersion(0);
                cookieManager.getCookieStore().add(new URI(Constants.BASE_URL), ck);
            }
        } catch (Exception ignored) {}
    }

    /** 仅清空本地会话（Cookie + 加密令牌 + 状态），不访问网络 */
    public static void resetLocalSession() {
        try {
            CookieStore store = cookieManager.getCookieStore();
            for (HttpCookie c : store.getCookies()) {
                store.remove(null, c);
            }
        } catch (Exception ignored) {}
        SecureStore.clear();
        AuthSession.markNotAuthenticated();
    }

    private static void enableTls12() {
        try {
            SSLContext ctx = SSLContext.getInstance("TLSv1.2");
            ctx.init(null, null, null);
            HttpsURLConnection.setDefaultSSLSocketFactory(ctx.getSocketFactory());
        } catch (Exception ignored) {
        }
    }

    /** 通用响应 */
    public static class Result {
        public int code;
        public String body = "";
        public String exception;

        public boolean ok() {
            return code >= 200 && code < 300;
        }

        public JSONObject json() {
            try {
                if (body == null || body.trim().length() == 0) return new JSONObject();
                JSONObject o = new JSONObject(body);
                return o;
            } catch (Exception e) {
                JSONObject o = new JSONObject();
                try { o.put("ok", false); o.put("error", "服务器响应异常"); } catch (Exception ignored) {}
                return o;
            }
        }

        public String error() {
            String e = json().optString("error", "");
            if (e.length() > 0) return e;
            if (exception != null) return exception;
            return code > 0 ? "请求失败（HTTP " + code + "）" : "无法连接服务器";
        }
    }

    public static Result get(String path) {
        return request("GET", path, null);
    }

    public static Result post(String path, JSONObject body) {
        return request("POST", path, body);
    }

    public static Result request(String method, String path, JSONObject body) {
        Result r = new Result();
        HttpURLConnection conn = null;
        try {
            String url = path.startsWith("http") ? path : Constants.BASE_URL + path;
            conn = open(new URL(url));
            conn.setRequestMethod(method);
            conn.setConnectTimeout(TIMEOUT);
            conn.setReadTimeout(TIMEOUT);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("Accept", "application/json");
            if (body != null) {
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = body.toString().getBytes("UTF-8");
                conn.setFixedLengthStreamingMode(bytes.length);
                DataOutputStream out = new DataOutputStream(conn.getOutputStream());
                out.write(bytes);
                out.flush();
                out.close();
            }
            r.code = conn.getResponseCode();
            if (r.code == 401) {
                // 会话已失效：清理本地令牌，自动引导重新登录（冷启动探测除外，见 AuthSession）
                AuthSession.handleServerUnauthorized();
            } else if (r.code >= 200 && r.code < 300) {
                if (path != null && path.contains("/api/logout")) {
                    AuthSession.markNotAuthenticated();
                } else if (!isPublicPath(path)) {
                    AuthSession.markAuthenticated();
                }
            }
            persistCookies();
            InputStream in = r.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            r.body = readAll(in);
        } catch (Exception e) {
            r.exception = e.getMessage();
            r.code = 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
        return r;
    }

    /** 无需登录即可访问、不应标记已登录的路径 */
    private static boolean isPublicPath(String path) {
        if (path == null) return false;
        return path.contains("/api/login")
                || path.contains("/api/register");
    }

    /** 最近一次 putBinary 失败的具体原因（诊断用，HTTP0 时展示给用户） */
    public static String lastPutError = "";

    /** 是否持久化会话到加密存储：仅登录时勾选“记住我”才写盘（长久登录语义） */
    private static boolean persistSession = false;

    /** 设置“记住我”：true=会话持久化跨进程/重启；false=仅本次进程有效 */
    public static void setRememberPersistence(boolean on) {
        persistSession = on;
    }

    public static boolean isRememberPersistence() {
        return persistSession;
    }

    /** 上次直传失败是否属 TLS/证书类（决定是否回退到服务端中转） */
    public static boolean isTlsIssue() {
        String s = lastPutError == null ? "" : lastPutError.toUpperCase();
        return s.contains("SSL") || s.contains("CERTIFICATE") || s.contains("CERTPATH")
                || s.contains("TRUST") || s.contains("HANDSHAKE") || s.contains("UNKNOWN CA")
                || s.contains("CIPHER");
    }

    /** PUT 二进制（S3 直传），支持进度回调，返回 HTTP 状态码 */
    public interface Progress { void onProgress(long done, long total); }

    public static int putBinary(String url, String contentType, InputStream in, long length, Progress progress) {
        HttpURLConnection conn = null;
        lastPutError = "";
        try {
            url = checkHttps(url);
            conn = open(new URL(url));
            conn.setRequestMethod("PUT");
            conn.setConnectTimeout(TIMEOUT);
            conn.setReadTimeout(TIMEOUT_LARGE);
            if (contentType != null) conn.setRequestProperty("Content-Type", contentType);
            conn.setRequestProperty("Connection", "keep-alive");
            conn.setDoOutput(true);
            if (length > 0) {
                if (Build.VERSION.SDK_INT >= 19) {
                    conn.setFixedLengthStreamingMode(length);
                } else {
                    // API<19 无 long 重载：大文件截断保护
                    conn.setFixedLengthStreamingMode((int) Math.min(length, Integer.MAX_VALUE - 8L));
                }
            } else {
                conn.setChunkedStreamingMode(0);
            }
            DataOutputStream out = new DataOutputStream(conn.getOutputStream());
            byte[] buf = new byte[IO_BUFFER];
            long done = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (progress != null) progress.onProgress(done, length);
            }
            out.flush();
            out.close();
            return conn.getResponseCode();
        } catch (Exception e) {
            try {
                lastPutError = String.valueOf(e);
                if (e.getMessage() != null && e.getMessage().length() > 0) {
                    lastPutError += "：" + e.getMessage();
                }
            } catch (Throwable ignored) {}
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** multipart 表单上传（体积未知；内部会退化为分块传输） */
    public static Result uploadMultipart(String path, String[] fieldNames, String[] fieldValues,
                                         String fileField, String fileName, InputStream fileIn) {
        return uploadMultipart(path, fieldNames, fieldValues, fileField, fileName, fileIn, -1, null);
    }

    /**
     * multipart 表单上传（可指定文件长度与进度）。
     *
     * 兼容性要点：
     * - 已知长度时使用 setFixedLengthStreamingMode 精确声明 Content-Length。
     *   老版本安卓（API 11~18）的分块传输（chunked）实现有缺陷，服务端会一直等待
     *   body 结束而挂住（表现为"卡死"），因此优先走定长发送。
     * - 不调用任何 StreamingMode 时 HttpURLConnection 会把整个 body 缓冲进内存，
     *   老机型上传大文件会 OOM，故未知长度时仍用分块，避免内存占用。
     *
     * @param fileLength 文件字节数；&lt;0 表示未知
     * @param progress   上传进度回调，可为 null
     */
    public static Result uploadMultipart(String path, String[] fieldNames, String[] fieldValues,
                                         String fileField, String fileName, InputStream fileIn,
                                         long fileLength, Progress progress) {
        Result r = new Result();
        HttpURLConnection conn = null;
        try {
            String boundary = "----teamcloud" + System.currentTimeMillis();
            String CRLF = "\r\n";
            StringBuilder sb = new StringBuilder();
            if (fieldNames != null) {
                for (int i = 0; i < fieldNames.length && i < fieldValues.length; i++) {
                    sb.append("--").append(boundary).append(CRLF);
                    sb.append("Content-Disposition: form-data; name=\"").append(fieldNames[i]).append("\"").append(CRLF).append(CRLF);
                    sb.append(fieldValues[i]).append(CRLF);
                }
            }
            sb.append("--").append(boundary).append(CRLF);
            sb.append("Content-Disposition: form-data; name=\"").append(fileField).append("\"; filename=\"").append(fileName).append("\"").append(CRLF);
            sb.append("Content-Type: application/octet-stream").append(CRLF).append(CRLF);
            byte[] prefix = sb.toString().getBytes("UTF-8");
            byte[] suffix = (CRLF + "--" + boundary + "--" + CRLF).getBytes("UTF-8");

            URL url = new URL(path.startsWith("http") ? path : Constants.BASE_URL + path);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(TIMEOUT);
            conn.setReadTimeout(TIMEOUT_LARGE);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

            long total = fileLength >= 0 ? (prefix.length + fileLength + suffix.length) : -1L;
            boolean fixed = false;
            if (total >= 0) {
                if (Build.VERSION.SDK_INT >= 19) {
                    conn.setFixedLengthStreamingMode(total);
                    fixed = true;
                } else if (total <= Integer.MAX_VALUE - 8L) {
                    conn.setFixedLengthStreamingMode((int) total);
                    fixed = true;
                }
            }
            if (!fixed) conn.setChunkedStreamingMode(IO_BUFFER);

            DataOutputStream out = new DataOutputStream(conn.getOutputStream());
            out.write(prefix);
            byte[] buf = new byte[IO_BUFFER];
            int n;
            long done = 0;
            while ((n = fileIn.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (progress != null) progress.onProgress(done, fileLength);
            }
            out.write(suffix);
            out.flush();
            out.close();
            r.code = conn.getResponseCode();
            InputStream in = r.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            r.body = readAll(in);
        } catch (Exception e) {
            r.code = 0;
            r.exception = e.getMessage();
        } finally {
            if (conn != null) conn.disconnect();
        }
        return r;
    }

    /** 仅允许 HTTPS：遇到明文 http:// 直接拒绝（保证 App 与服务器全链路加密传输） */
    private static String checkHttps(String url) throws IOException {
        if (url != null && url.regionMatches(true, 0, "http://", 0, 7)) {
            throw new IOException("已拒绝明文HTTP请求，请使用HTTPS");
        }
        return url;
    }

    private static HttpURLConnection open(URL url) throws IOException {
        return (HttpURLConnection) url.openConnection();
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        try {
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Exception ignored) {}
        }
        return new String(bo.toByteArray(), "UTF-8");
    }

    private static byte[] readAllBytes(InputStream in) throws IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Exception ignored) {}
        }
        return bo.toByteArray();
    }

    /** GET 原始字节（头像等小体积二进制；自动携带会话 Cookie） */
    public static byte[] getBytes(String path) throws IOException {
        String url = path.startsWith("http") ? path : Constants.BASE_URL + path;
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(TIMEOUT);
        conn.setReadTimeout(TIMEOUT);
        try {
            int code = conn.getResponseCode();
            if (code >= 400) throw new IOException("HTTP " + code);
            InputStream in = conn.getInputStream();
            return readAllBytes(in);
        } finally {
            conn.disconnect();
        }
    }

    /** 保存会话 cookie（connect.sid）以便重启后免登录（经 SecureStore 加密持久化）
     *  仅在“记住我”时写盘；未勾选则清除历史持久会话，避免意外长期登录 */
    private static void persistCookies() {
        try {
            if (cookieManager == null) return;
            List<HttpCookie> cks = cookieManager.getCookieStore().getCookies();
            String sid = null;
            for (HttpCookie c : cks) {
                if ("connect.sid".equals(c.getName())) {
                    sid = c.getName() + "=" + c.getValue();
                    break;
                }
            }
            if (sid == null || sid.length() == 0) return;
            if (persistSession) {
                SecureStore.save(sid);
            } else {
                SecureStore.clear();
            }
            AuthSession.markAuthenticated();
        } catch (Exception ignored) {}
    }

    /** 登出/注销时清空本地会话（Cookie + 加密令牌 + 内存状态） */
    public static void clearSession() {
        resetLocalSession();
    }
}
