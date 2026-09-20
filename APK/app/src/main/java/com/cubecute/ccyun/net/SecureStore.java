package com.cubecute.ccyun.net;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 安全存储：会话令牌 + 登录凭据（账号密码）。
 *
 * 安全策略：
 * - Android 6.0 (API 23)+：数据用 AES-256-GCM 加密（密钥存于系统 AndroidKeyStore，
 *   不出设备、防导出），密文+IV 存 SharedPreferences(MODE_PRIVATE)。
 * - Android 6.0 以下：系统无 AndroidKeyStore/GCM，降级为"应用私有 SharedPreferences
 *   保存 + base64 混淆"，仍受 Android 应用沙箱隔离（该级别系统无平台级密钥链可用）。
 * - 解密失败（密钥失效/数据损坏）一律视为无数据，交由上层引导重新登录，绝不崩溃。
 *
 * 登录凭据有效期：365 天。到期后凭据自动清除，用户需重新输入账号密码登录。
 */
public final class SecureStore {

    private static final String PREF_FILE = "teamcloud";
    private static final String KEY_PAYLOAD = "session_payload";
    private static final String KEY_CRED = "cred_payload";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "teamcloud_session_key";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final String LEGACY_PREFIX = "legacy:";

    /** 凭据有效期：一年 */
    private static final long CRED_VALID_MS = 365L * 24 * 60 * 60 * 1000;
    private static final String SEP = "\u0000";

    private static SharedPreferences prefs;

    private SecureStore() {}

    public static void init(Context context) {
        prefs = context.getApplicationContext()
                .getSharedPreferences(PREF_FILE, Context.MODE_PRIVATE);
        migrateIfNeeded();
    }

    /** 当前是否使用系统级 Keystore 加密存储 */
    public static boolean isSecure() {
        return Build.VERSION.SDK_INT >= 23;
    }

    private static boolean keystoreSupported() {
        return Build.VERSION.SDK_INT >= 23;
    }

    private static SecretKey loadOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            SecretKey k = (SecretKey) ks.getKey(ALIAS, null);
            if (k != null) return k;
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    // ---------- 通用加密读写 ----------

    private static void put(String key, String plain) {
        if (prefs == null || plain == null || plain.length() == 0) return;
        try {
            if (keystoreSupported()) {
                SecretKey sk = loadOrCreateKey();
                Cipher cipher = Cipher.getInstance(TRANSFORM);
                cipher.init(Cipher.ENCRYPT_MODE, sk);
                byte[] ct = cipher.doFinal(plain.getBytes("UTF-8"));
                byte[] iv = cipher.getIV(); // 12B
                byte[] out = new byte[iv.length + ct.length];
                System.arraycopy(iv, 0, out, 0, iv.length);
                System.arraycopy(ct, 0, out, iv.length, ct.length);
                prefs.edit().putString(key, Base64.encodeToString(out, Base64.NO_WRAP)).apply();
            } else {
                putLegacy(key, plain);
            }
        } catch (Throwable t) {
            // Keystore 异常（极少数厂商 ROM）：降级为应用私有存储，避免数据丢失
            putLegacy(key, plain);
        }
    }

    private static String get(String key) {
        if (prefs == null) return null;
        String payload = prefs.getString(key, null);
        if (payload == null || payload.length() == 0) return null;
        try {
            if (payload.startsWith(LEGACY_PREFIX)) {
                byte[] d = Base64.decode(payload.substring(LEGACY_PREFIX.length()), Base64.DEFAULT);
                return new String(d, "UTF-8");
            }
            byte[] data = Base64.decode(payload, Base64.DEFAULT);
            if (!keystoreSupported()) return null;
            SecretKey sk = loadOrCreateKey();
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, sk, new GCMParameterSpec(128, data, 0, 12));
            byte[] pt = cipher.doFinal(data, 12, data.length - 12);
            return new String(pt, "UTF-8");
        } catch (Throwable t) {
            return null; // 解密失败按无数据处理
        }
    }

    private static void remove(String key) {
        if (prefs != null) prefs.edit().remove(key).apply();
    }

    private static void putLegacy(String key, String plain) {
        prefs.edit().putString(key, LEGACY_PREFIX
                + Base64.encodeToString(plain.getBytes(), Base64.NO_WRAP)).apply();
    }

    // ---------- 会话令牌 ----------

    /** 加密保存会话令牌 */
    public static void save(String plain) {
        put(KEY_PAYLOAD, plain);
    }

    /** 读取并解密会话令牌；失败返回 null（视为未登录） */
    public static String load() {
        return get(KEY_PAYLOAD);
    }

    /** 清除会话令牌 */
    public static void clear() {
        remove(KEY_PAYLOAD);
    }

    // ---------- 登录凭据（账号 + 密码，有效期一年） ----------

    /** 加密保存账号密码（登录成功时调用），有效期一年 */
    public static void saveCredentials(String username, String password) {
        if (username == null || username.length() == 0 || password == null || password.length() == 0) return;
        put(KEY_CRED, username + SEP + password + SEP + System.currentTimeMillis());
    }

    /**
     * 读取账号密码。返回 {username, password}；
     * 无记录或已超过一年有效期时返回 null（到期记录会被自动清除）。
     */
    public static String[] loadCredentials() {
        String s = get(KEY_CRED);
        if (s == null) return null;
        String[] p = s.split(SEP);
        if (p.length < 3) { clearCredentials(); return null; }
        long savedAt;
        try {
            savedAt = Long.parseLong(p[2]);
        } catch (Exception e) {
            clearCredentials();
            return null;
        }
        if (System.currentTimeMillis() - savedAt > CRED_VALID_MS) {
            clearCredentials();
            return null;
        }
        return new String[]{p[0], p[1]};
    }

    /** 是否存在凭据记录（不论是否过期） */
    public static boolean hasCredentials() {
        return prefs != null && prefs.contains(KEY_CRED);
    }

    /** 清除保存的账号密码（手动退出登录 / 注销账户时调用） */
    public static void clearCredentials() {
        remove(KEY_CRED);
    }

    /** 旧版本曾以明文键 session_cookie 保存，迁移到加密字段后删除明文（安全清理） */
    private static void migrateIfNeeded() {
        try {
            if (prefs.contains(KEY_PAYLOAD)) return;
            String legacy = prefs.getString("session_cookie", "");
            if (legacy != null && legacy.length() > 0) {
                save(legacy);
                prefs.edit().remove("session_cookie").apply();
            }
        } catch (Throwable ignored) {}
    }
}
