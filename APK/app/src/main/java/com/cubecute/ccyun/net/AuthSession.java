package com.cubecute.ccyun.net;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import com.cubecute.ccyun.ui.LoginActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * 登录状态全局管理（单例，静态入口）。
 *
 * 职责：
 * - 维护"是否已确认服务端会话有效"的内存状态 authenticated；
 * - 向全局组件广播状态变化（addListener/onAuthStateChanged）；
 * - 收到服务端 401 时自动清理本地会话并跳转登录页（去抖，避免并发请求连环跳转）；
 * - 提供 markAuthenticated/markNotAuthenticated 供各层在关键节点校正状态。
 *
 * 进程被杀/设备重启后的登录态恢复：App 启动时 Http.init 从 SecureStore 解密令牌
 * 注入 Cookie 管理器，MainActivity 用 /api/me 探测；若令牌已过期，服务端返回 401，
 * 系统自动清理并引导重新登录（不会进入半个登录态）。
 */
public final class AuthSession {

    public interface Listener {
        void onAuthStateChanged(boolean authenticated);
    }

    private static Context appContext;
    private static volatile boolean authenticated = false;
    private static final List<Listener> listeners = new ArrayList<Listener>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static long lastReloginAt = 0L;

    private AuthSession() {}

    /** 由 Http.init 在 App 启动时调用（只执行一次） */
    public static void attach(Context context) {
        if (appContext == null) {
            appContext = context.getApplicationContext();
            SecureStore.init(appContext);
        }
    }

    /** 当前是否处于"已确认登录"状态（内存态；实际以服务端校验为准） */
    public static boolean isAuthenticated() {
        return authenticated;
    }

    /** 本地是否存在已持久化的会话令牌（快速判断用，不等于服务端仍有效） */
    public static boolean hasRememberedSession() {
        try {
            String s = SecureStore.load();
            return s != null && s.length() > 0;
        } catch (Throwable t) {
            return false;
        }
    }

    public static synchronized void addListener(Listener l) {
        if (l != null && !listeners.contains(l)) listeners.add(l);
    }

    public static synchronized void removeListener(Listener l) {
        listeners.remove(l);
    }

    /** 标记已登录：登录成功回调、任何需要鉴权的请求成功时调用 */
    public static void markAuthenticated() {
        setAuthenticated(true);
    }

    /** 标记已退出（手动退出、账户注销、会话失效清理后调用） */
    public static void markNotAuthenticated() {
        setAuthenticated(false);
    }

    private static void setAuthenticated(final boolean value) {
        final boolean old;
        synchronized (AuthSession.class) {
            old = authenticated;
            if (old == value) return;
            authenticated = value;
        }
        notifyListeners(value);
    }

    private static void notifyListeners(final boolean value) {
        final List<Listener> copy;
        synchronized (AuthSession.class) {
            copy = new ArrayList<Listener>(listeners);
        }
        for (Listener l : copy) {
            try {
                l.onAuthStateChanged(value);
            } catch (Throwable ignored) {}
        }
    }

    /** 处理"服务端会话失效(401)"：清理本地并引导重新登录（已去抖） */
    public static void handleServerUnauthorized() {
        final boolean wasAuth = isAuthenticated();
        // 无论之前是否认为已登录，本地令牌若已不被服务端接受都应清掉
        Http.resetLocalSession();
        if (!wasAuth) return; // 冷启动探测(meQuiet)的401属正常，不弹跳转
        scheduleRelogin();
    }

    private static void scheduleRelogin() {
        if (appContext == null) return;
        long now = System.currentTimeMillis();
        synchronized (AuthSession.class) {
            if (now - lastReloginAt < 1500L) return; // 防抖：多请求并发 401 只跳一次
            lastReloginAt = now;
        }
        MAIN.post(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent i = new Intent(appContext, LoginActivity.class);
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                    i.putExtra("relogin", true);
                    appContext.startActivity(i);
                } catch (Throwable ignored) {}
            }
        });
    }
}
