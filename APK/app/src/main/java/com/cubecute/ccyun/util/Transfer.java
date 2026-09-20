package com.cubecute.ccyun.util;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/** 全局传输中心：记录上传/下载任务与进度，驱动右上角角标与进度页刷新（进程内单例） */
public final class Transfer {

    public static class Item {
        public int id;
        public String name;
        public boolean upload;      // true=上传 false=下载
        public long total;          // 0=未知
        public long done;
        public String note = "";    // 排队中/进行中/已完成/失败：原因
        public long startedAt = System.currentTimeMillis();
        public long lastAt = System.currentTimeMillis();
        public long lastDone = 0;
        public long speed = 0;      // 字节/秒（滑动估算）

        /** 是否已结束（完成或失败） */
        public boolean finished() {
            return "已完成".equals(note) || note.startsWith("失败") || note.startsWith("已转系统下载");
        }
    }

    public interface Listener { void onChanged(); }

    /** 适配 Http 上传进度回调（供后台上传直接使用） */
    public static com.cubecute.ccyun.net.Http.Progress httpProgress(final int id) {
        return new com.cubecute.ccyun.net.Http.Progress() {
            @Override public void onProgress(long done, long total) { progress(id, done); }
        };
    }

    /** 适配 Api 分片上传进度回调 */
    public static com.cubecute.ccyun.net.Api.UpProgress upProgress(final int id) {
        return new com.cubecute.ccyun.net.Api.UpProgress() {
            @Override public void onProgress(long done, long total) { progress(id, done); }
        };
    }

    private static final List<Item> ITEMS = new ArrayList<Item>();
    private static final List<Listener> LISTENERS = new ArrayList<Listener>();
    private static final Handler UI = new Handler(Looper.getMainLooper());
    private static TextView badgeView;
    private static Context appCtx;
    private static int nextId = 1;

    private Transfer() {}

    public static void attach(Context c) { appCtx = c.getApplicationContext(); }

    public static int add(boolean upload, String name, long total) {
        Item it = new Item();
        it.id = nextId++;
        it.upload = upload;
        it.name = name == null ? (upload ? "上传任务" : "下载任务") : name;
        it.total = total;
        it.done = 0;
        it.note = total > 0 ? "进行中" : "准备中";
        synchronized (ITEMS) { ITEMS.add(0, it); }
        notifyChanged();
        return it.id;
    }

    public static void progress(int id, long done) {
        synchronized (ITEMS) {
            for (Item it : ITEMS) {
                if (it.id == id) {
                    long now = System.currentTimeMillis();
                    long dt = now - it.lastAt;
                    if (dt >= 500) {
                        long delta = done - it.lastDone;
                        if (delta >= 0) it.speed = (long) (delta * 1000.0 / dt);
                        it.lastAt = now;
                        it.lastDone = done;
                    }
                    it.done = done;
                    it.note = "进行中";
                    break;
                }
            }
        }
        notifyChanged();
    }

    /** 设置任务总大小（下载前探测到长度后补正） */
    public static void total(int id, long total) {
        synchronized (ITEMS) {
            for (Item it : ITEMS) {
                if (it.id == id) { it.total = total > 0 ? total : it.total; break; }
            }
        }
        notifyChanged();
    }

    public static void note(int id, String n) {
        synchronized (ITEMS) {
            for (Item it : ITEMS) {
                if (it.id == id) { it.note = n == null ? "" : n; break; }
            }
        }
        notifyChanged();
    }

    public static void finish(int id, boolean ok, String note) {
        synchronized (ITEMS) {
            for (Item it : ITEMS) {
                if (it.id == id) {
                    it.done = it.total > 0 ? it.total : it.done;
                    it.note = ok ? "已完成" : (note == null ? "失败" : note);
                    break;
                }
            }
        }
        notifyChanged();
    }

    public static void remove(int id) {
        synchronized (ITEMS) {
            for (int i = 0; i < ITEMS.size(); i++) {
                if (ITEMS.get(i).id == id) { ITEMS.remove(i); break; }
            }
        }
        notifyChanged();
    }

    public static void clearFinished() {
        synchronized (ITEMS) {
            for (int i = ITEMS.size() - 1; i >= 0; i--) {
                if (ITEMS.get(i).finished()) ITEMS.remove(i);
            }
        }
        notifyChanged();
    }

    public static List<Item> snapshot() {
        List<Item> out = new ArrayList<Item>();
        synchronized (ITEMS) { out.addAll(ITEMS); }
        return out;
    }

    public static int activeCount() {
        int n = 0;
        synchronized (ITEMS) {
            for (Item it : ITEMS) if (!it.finished()) n++;
        }
        return n;
    }

    public static void addListener(Listener l) {
        synchronized (LISTENERS) { if (!LISTENERS.contains(l)) LISTENERS.add(l); }
    }

    public static void removeListener(Listener l) {
        synchronized (LISTENERS) { LISTENERS.remove(l); }
    }

    public static void setBadgeView(TextView tv) {
        badgeView = tv;
        refreshBadge();
    }

    private static void notifyChanged() {
        UI.post(new Runnable() {
            @Override public void run() {
                refreshBadge();
                final List<Listener> copy;
                synchronized (LISTENERS) { copy = new ArrayList<Listener>(LISTENERS); }
                for (Listener l : copy) { try { l.onChanged(); } catch (Throwable ignored) {} }
            }
        });
    }

    private static void refreshBadge() {
        if (badgeView == null) return;
        int n = activeCount();
        badgeView.setText(n > 0 ? String.valueOf(n) : "");
        badgeView.setVisibility(n > 0 ? android.view.View.VISIBLE : android.view.View.GONE);
    }
}
