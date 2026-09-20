package com.cubecute.ccyun.util;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;

/**
 * 崩溃诊断（临时）：把未捕获异常堆栈写入内部存储，
 * 下次启动由 MainActivity 展示给用户（无需 adb 即可把堆栈发回）。
 * 定位完 Android 5.0 启动崩溃后应移除。
 */
public final class CrashReporter {

    private static final String FILE = "last_crash.txt";

    private CrashReporter() {}

    /** 应用启动时调用一次：接管未捕获异常 -> 落盘 -> 交回系统默认处理器终止进程 */
    public static void install(final Context ctx) {
        final Thread.UncaughtExceptionHandler def = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable ex) {
                try {
                    StringWriter sw = new StringWriter();
                    ex.printStackTrace(new PrintWriter(sw));
                    String stack = "崩溃线程: " + thread.getName() + "\n\n" + sw.toString();
                    File f = new File(ctx.getFilesDir(), FILE);
                    FileOutputStream fos = new FileOutputStream(f);
                    try {
                        fos.write(stack.getBytes("UTF-8"));
                    } finally {
                        fos.close();
                    }
                } catch (Throwable ignored) {}
                if (def != null) def.uncaughtException(thread, ex);
            }
        });
    }

    /** 读取并清除上次崩溃堆栈；无崩溃返回 null */
    public static String consume(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE);
            if (!f.exists()) return null;
            byte[] b = new byte[(int) f.length()];
            FileInputStream fis = new FileInputStream(f);
            try {
                int off = 0;
                while (off < b.length) {
                    int n = fis.read(b, off, b.length - off);
                    if (n < 0) break;
                    off += n;
                }
            } finally {
                fis.close();
            }
            f.delete();
            return new String(b, "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }
}
