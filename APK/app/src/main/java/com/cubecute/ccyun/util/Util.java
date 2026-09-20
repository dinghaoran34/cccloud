package com.cubecute.ccyun.util;

import android.Manifest;
import android.app.Activity;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.net.Uri;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.view.MotionEvent;
import android.view.Window;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.cubecute.ccyun.R;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/** UI / 通用小工具 */
public final class Util {
    private static final Handler UI = new Handler(Looper.getMainLooper());

    /** 交流与支持信息（主页 / 我的 / 关于 统一展示） */
    public static final String SUPPORT_TEXT =
            "欢迎加入QQ群交流：433785327，有意向者请使用微信手机号转账，收款账号为18724785279";

    // ---------- 统一文案（跨端逐字一致） ----------
    /** 登录失效 */
    public static final String MSG_RELOGIN = "登录状态已失效，请重新登录";
    /** 空列表 */
    public static final String MSG_EMPTY = "暂无内容";
    /** 网络失败 */
    public static final String MSG_NET = "网络异常，请重试";
    /** 上传成功 */
    public static final String MSG_UPLOAD_OK = "上传完成";

    private Util() {}

    /** 页面左右内边距：常规 16dp；窄屏（≤360dp）12dp —— 规范 §3 */
    public static int pagePad(Context c) {
        int wDp = 360;
        try {
            android.util.DisplayMetrics dm = c.getResources().getDisplayMetrics();
            if (dm != null && dm.density > 0) wDp = Math.round(dm.widthPixels / dm.density);
        } catch (Throwable ignored) {}
        return wDp <= 360 ? mdDp(c, 12) : mdDp(c, 16);
    }

    /**
     * 底部安全区高度：窗口真正绘制到系统导航栏之下时返回其高度，否则 0（不透明导航栏时
     * 内容本就在导航栏之上，再加 padding 会出现双倍留白）。API 11 兼容：低版本仅在
     * 设置了半透明导航栏/无限制布局标志时回退读系统 dimen。
     */
    public static int navInsetBottom(Activity a) {
        if (a == null) return 0;
        try {
            android.view.Window w = a.getWindow();
            if (w == null) return 0;
            final View dv = w.getDecorView();
            if (dv == null) return 0;
            if (Build.VERSION.SDK_INT >= 23) return InsetsHolder.bottom(dv);
            int flags = w.getAttributes().flags;
            boolean behind = (flags & 0x08000000) != 0 || (flags & 0x00000200) != 0;
            if (!behind) return 0;
            int id = a.getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            if (id > 0) return a.getResources().getDimensionPixelSize(id);
        } catch (Throwable ignored) {}
        return 0;
    }

    /** API 23+ 的 WindowInsets 读取独立成类，避免低版本 Dalvik 校验缺失类 */
    private static final class InsetsHolder {
        static int bottom(View v) {
            try {
                android.view.WindowInsets wi = v.getRootWindowInsets();
                return wi == null ? 0 : wi.getSystemWindowInsetBottom();
            } catch (Throwable t) {
                return 0;
            }
        }
    }

    public static void onUi(Runnable r) { UI.post(r); }

    /**
     * 关闭按钮文字大写（安卓默认按钮可能全大写）。
     * TextView.setAllCaps 需要 API 14+，低版本（API 11~13）直接忽略，避免 NoSuchMethodError。
     */
    public static void noCaps(android.widget.TextView t) {
        if (t == null) return;
        if (Build.VERSION.SDK_INT >= 14) {
            try { t.setAllCaps(false); } catch (Throwable ignored) {}
        }
    }

    /** 后台线程执行（结果回主线程） */
    public interface Cb { void run(); }
    public interface ErrCb { void run(String err); }

    public static void async(final Runnable task, final Cb ok, final ErrCb err) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    task.run();
                    if (ok != null) UI.post(new Runnable() { public void run() { ok.run(); } });
                } catch (final Exception e) {
                    if (err != null) UI.post(new Runnable() {
                        public void run() {
                            err.run(e.getMessage() == null ? String.valueOf(e) : e.getMessage());
                        }
                    });
                }
            }
        }).start();
    }

    public static void toast(Context c, String s) {
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show();
    }

    /** 当前是否有可用网络（含 Wi-Fi/移动数据）；异常时返回 true 以免误拦 */
    public static boolean isOnline(Context c) {
        try {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            NetworkInfo ni = cm.getActiveNetworkInfo();
            return ni != null && ni.isConnectedOrConnecting();
        } catch (Throwable t) {
            return true;
        }
    }

    // ---------- Material 3 风格弹窗 ----------
    /** API16 前用 setBackgroundDrawable，保证 API14 可用 */
    private static void setBg(View v, android.graphics.drawable.Drawable d) {
        if (Build.VERSION.SDK_INT >= 16) v.setBackground(d);
        else v.setBackgroundDrawable(d);
    }

    private static int mdDp(Context c, int v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    private static android.graphics.drawable.GradientDrawable mdBg(Context c, int color, float radiusDp) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(mdDp(c, Math.round(radiusDp)));
        return g;
    }

    private static Dialog mdDialog(Context c) {
        Dialog d = new Dialog(c, R.style.TeamCloudDialog);
        d.setCanceledOnTouchOutside(false);
        try {
            Window w = d.getWindow();
            if (w != null) {
                w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
                w.setDimAmount(0.40f);
            }
        } catch (Throwable ignored) {}
        return d;
    }

    /** M3 titleLarge：20sp、粗体、行高 1.3（API14 无 medium 字重，以 Bold 近似） */
    private static TextView mdTitle(Context c, String t) {
        TextView tv = new TextView(c);
        tv.setText(t);
        tv.setTextColor(ThemeUi.cText());
        tv.setTextSize(20);
        tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        tv.setLineSpacing(0, 1.3f);
        return tv;
    }

    /** M3 bodyMedium：15sp、次要色、行高 1.5，可选中复制 */
    private static TextView mdBody(Context c, String m) {
        TextView tv = new TextView(c);
        tv.setText(m);
        tv.setTextColor(ThemeUi.cSub());
        tv.setTextSize(15);
        tv.setLineSpacing(0, 1.5f);
        return tv;
    }

    // ---------- M3 交互反馈：API21+ 波纹（保留原背景），API14~20 透明度反馈 ----------

    /** 给可点控件套统一按压反馈（已有背景作为波纹内容保留，不被覆盖） */
    public static void setFeedback(final View v) {
        v.setClickable(true);
        if (Build.VERSION.SDK_INT >= 21) {
            try {
                android.content.res.ColorStateList cs = ThemeUi.rippleState();
                android.graphics.drawable.Drawable cur = null;
                try { cur = v.getBackground(); } catch (Throwable ignored) {}
                v.setBackground(new android.graphics.drawable.RippleDrawable(cs, cur, null));
                return;
            } catch (Throwable ignored) {}
        }
        setAlphaFeedback(v);
    }

    /** 禁用态：不透明度 0.5 且不可点（规范 §6） */
    public static void setEnabledState(View v, boolean on) {
        if (v == null) return;
        v.setEnabled(on);
        v.setClickable(on);
        v.setAlpha(on ? 1f : 0.5f);
    }

    /** API14~20：无 RippleDrawable，用按压缩放透明度模拟即时反馈（已有自定义背景的控件适用） */
    public static void setAlphaFeedback(final View v) {
        v.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View view, MotionEvent e) {
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN: v.setAlpha(0.45f); break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL: v.setAlpha(1f); break;
                }
                return false;
            }
        });
    }

    /** M3 文本按钮（无填充）：高度≥48dp、内边距 18dp、按压反馈、可选加粗 */
    private static TextView mdTextBtn(final Context c, String text, int color, boolean primary) {
        final TextView tv = new TextView(c);
        tv.setText(text);
        tv.setTextColor(color);
        tv.setTextSize(15);
        tv.setTypeface(Typeface.DEFAULT, primary ? Typeface.BOLD : Typeface.NORMAL);
        tv.setGravity(Gravity.CENTER);
        tv.setMinHeight(mdDp(c, 48));
        tv.setMinWidth(mdDp(c, 72));
        tv.setPadding(mdDp(c, 18), 0, mdDp(c, 18), 0);
        setFeedback(tv);
        return tv;
    }

    private static void showMdBase(final Context c, final Dialog d, final LinearLayout root, int widthLimitDp) {
        int w = Math.min((int) (c.getResources().getDisplayMetrics().widthPixels * 0.92f), mdDp(c, widthLimitDp));
        d.setContentView(root, new android.view.ViewGroup.LayoutParams(w, android.view.ViewGroup.LayoutParams.WRAP_CONTENT));
        try {
            if (d.getWindow() != null) d.getWindow().setLayout(w, android.view.ViewGroup.LayoutParams.WRAP_CONTENT);
        } catch (Throwable ignored) {}
        d.show();
    }

    /** 自适应宽高显示（用于加载框等小体量内容） */
    private static void showMdWrap(final Dialog d, final View root) {
        d.setContentView(root);
        try {
            if (d.getWindow() != null) {
                d.getWindow().setLayout(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            }
        } catch (Throwable ignored) {}
        d.show();
    }

    /** M3 Dialog 容器：surfaceContainer 卡色、28dp 大圆角、24/26/24/18 内边距 */
    private static LinearLayout mdBaseRoot(Context c) {
        LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.VERTICAL);
        setBg(root, mdBg(c, ThemeUi.cCard(), 28));
        root.setPadding(mdDp(c, 24), mdDp(c, 26), mdDp(c, 24), mdDp(c, 18));
        return root;
    }

    /** 标题 + 正文：M3 排印间距（标题后 12dp/24dp，正文后 26dp） */
    private static void mdAddHeader(Context c, LinearLayout root, String title, String message) {
        if (title != null && title.length() > 0) {
            TextView t = mdTitle(c, title);
            root.addView(t, lpM(-1, -2, 0, 0, 0,
                    mdDp(c, message != null && message.length() > 0 ? 12 : 24)));
        }
        if (message != null && message.length() > 0) {
            TextView b = mdBody(c, message);
            b.setTextIsSelectable(true);
            root.addView(b, lpM(-1, -2, 0, 0, 0, mdDp(c, 26)));
        }
    }

    /** M3 动作行：靠右文本按钮（取消在左、主按钮在右，间距 8dp），触摸区 ≥48dp */
    private static void mdActionRow(Context c, final LinearLayout root, final Dialog d,
                                    String okText, final Cb onYes, String cancelText, final Cb onNo,
                                    int okColor) {
        LinearLayout row = new LinearLayout(c);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        if (cancelText != null) {
            TextView no = mdTextBtn(c, cancelText, ThemeUi.cSub(), false);
            no.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { d.dismiss(); if (onNo != null) onNo.run(); }
            });
            row.addView(no, lp(-2, mdDp(c, 48)));
        }
        if (okText != null) {
            TextView ok = mdTextBtn(c, okText, okColor, true);
            ok.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { d.dismiss(); if (onYes != null) onYes.run(); }
            });
            row.addView(ok, lpM(-2, mdDp(c, 48), mdDp(c, 8), 0, 0, 0));
        }
        root.addView(row, lpM(-1, -2, 0, mdDp(c, 8), 0, 0));
    }

    /** 危险操作标题启发式：命中即把“确定”标红（M3 错误色语义） */
    private static boolean isDangerTitle(String t) {
        if (t == null) return false;
        return t.indexOf("删除") >= 0 || t.indexOf("清空") >= 0 || t.indexOf("退出") >= 0
                || t.indexOf("移出") >= 0 || t.indexOf("解散") >= 0 || t.indexOf("注销") >= 0;
    }

    /** M3 确认框：确定（普通=品牌色 / 危险标题=红）＋ 取消 */
    public static void confirm(Context c, String title, String msg, final Cb onYes) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, msg);
        mdActionRow(c, root, d, "确定", onYes, "取消", null,
                isDangerTitle(title) ? ThemeUi.cDanger() : ThemeUi.cBrand());
        showMdBase(c, d, root, 420);
    }

    public interface InputCb { void run(String text); }

    public static void input(Context c, String title, String hint, String preset, final InputCb cb) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, null);

        final EditText et = new EditText(c);
        et.setHint(hint);
        if (preset != null) et.setText(preset);
        et.setSingleLine(true);
        et.setTextSize(15);
        et.setTextColor(ThemeUi.cText());
        et.setHintTextColor(ThemeUi.cMute());
        et.setPadding(mdDp(c, 14), 0, mdDp(c, 14), 0);
        setBg(et, mdBg(c, ThemeUi.cFill(), 8));
        et.setMinHeight(mdDp(c, 48));
        root.addView(et, lpM(-1, mdDp(c, 48), 0, mdDp(c, 2), 0, mdDp(c, 12)));

        mdActionRow(c, root, d, "确定", new Cb() {
            @Override public void run() { cb.run(et.getText().toString().trim()); }
        }, "取消", null, ThemeUi.cBrand());
        showMdBase(c, d, root, 420);
        et.postDelayed(new Runnable() {
            @Override public void run() {
                InputMethodManager imm = (InputMethodManager) c.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(et, 0);
            }
        }, 160);
    }

    public static void password(Context c, String title, final InputCb cb) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, null);

        final EditText et = new EditText(c);
        et.setHint("请输入账户密码");
        et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        et.setSingleLine(true);
        et.setTextSize(15);
        et.setTextColor(ThemeUi.cText());
        et.setHintTextColor(ThemeUi.cMute());
        et.setPadding(mdDp(c, 14), 0, mdDp(c, 14), 0);
        setBg(et, mdBg(c, ThemeUi.cFill(), 8));
        et.setMinHeight(mdDp(c, 48));
        root.addView(et, lpM(-1, mdDp(c, 48), 0, mdDp(c, 2), 0, mdDp(c, 12)));

        mdActionRow(c, root, d, "确定", new Cb() {
            @Override public void run() { cb.run(et.getText().toString()); }
        }, "取消", null, ThemeUi.cBrand());
        showMdBase(c, d, root, 420);
        et.postDelayed(new Runnable() {
            @Override public void run() {
                InputMethodManager imm = (InputMethodManager) c.getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(et, 0);
            }
        }, 160);
    }

    // ---------- M3 扩展弹窗：列表菜单 / 自定义内容 / 消息+动作 ----------

    /** 菜单项点击回调：which = 条目索引 */
    public interface MenuCb { void run(int which); }

    public static final int KIND_PRIMARY = 0;
    public static final int KIND_PLAIN = 1;
    public static final int KIND_DANGER = 2;

    /** M3 动作按钮描述：文本 + 类型(主操作/次要/危险) + 回调(null=仅关闭) */
    public static final class Btn {
        public final String label;
        public final int kind;
        public final Cb cb;
        public Btn(String label, int kind, Cb cb) { this.label = label; this.kind = kind; this.cb = cb; }
    }

    private static int btnColor(int kind) {
        switch (kind) {
            case KIND_PRIMARY: return ThemeUi.cBrand();
            case KIND_DANGER: return ThemeUi.cDanger();
            default: return ThemeUi.cSub();
        }
    }

    /** M3 动作按钮行：靠右排布，按钮间 8dp；每个触摸区 ≥48dp、带按压反馈 */
    private static void mdActionList(Context c, final Dialog d, LinearLayout root, final Btn[] acts) {
        if (acts == null || acts.length == 0) return;
        LinearLayout row = new LinearLayout(c);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        for (int i = 0; i < acts.length; i++) {
            final Btn b = acts[i];
            TextView tv = mdTextBtn(c, b.label, btnColor(b.kind),
                    b.kind == KIND_PRIMARY || b.kind == KIND_DANGER);
            tv.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    d.dismiss();
                    if (b.cb != null) b.cb.run();
                }
            });
            row.addView(tv, i == 0 ? lp(-2, mdDp(c, 48))
                    : lpM(-2, mdDp(c, 48), mdDp(c, 8), 0, 0, 0));
        }
        root.addView(row, lpM(-1, -2, 0, mdDp(c, 16), 0, 0));
    }

    /** M3 列表菜单：可选标题；dangerIdx 指定红色警示条目(-1无)；cancel 是否在底部补“取消” */
    public static void menu(Context c, String title, String[] items, int dangerIdx, boolean cancel, final MenuCb cb) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, null);
        LinearLayout list = new LinearLayout(c);
        list.setOrientation(LinearLayout.VERTICAL);
        if (items != null) {
            for (int i = 0; i < items.length; i++) {
                final int idx = i;
                String it = items[i];
                TextView tv = new TextView(c);
                tv.setText(it == null ? "" : it);
                tv.setTextSize(15);
                tv.setTextColor(idx == dangerIdx ? ThemeUi.cDanger() : ThemeUi.cText());
                tv.setGravity(Gravity.CENTER_VERTICAL);
                tv.setSingleLine(false);
                tv.setMinHeight(mdDp(c, 56));
                tv.setPadding(0, mdDp(c, 6), 0, mdDp(c, 6));
                setFeedback(tv);
                tv.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { d.dismiss(); if (cb != null) cb.run(idx); }
                });
                list.addView(tv, lpM(-1, -2, 0, 0, 0, 0));
            }
        }
        root.addView(list, lpM(-1, -2, 0, 0, 0, mdDp(c, 6)));
        if (cancel) {
            TextView no = mdTextBtn(c, "取消", ThemeUi.cSub(), false);
            no.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { d.dismiss(); }
            });
            LinearLayout cr = new LinearLayout(c);
            cr.setOrientation(LinearLayout.HORIZONTAL);
            cr.setGravity(Gravity.RIGHT);
            cr.addView(no, lp(-2, mdDp(c, 48)));
            root.addView(cr, lpM(-1, -2, 0, mdDp(c, 4), 0, 0));
        }
        showMdBase(c, d, root, 400);
    }

    /** M3 自定义内容弹窗：标题 + content + 底部动作；适合表单/链接展示 */
    public static void custom(Context c, String title, View content, Btn[] acts) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, null);
        if (content != null) root.addView(content, lpM(-1, -2, 0, mdDp(c, 2), 0, 0));
        if (acts != null && acts.length > 0) mdActionList(c, d, root, acts);
        showMdBase(c, d, root, 440);
    }

    /** M3 信息弹窗：标题 + 可选中正文 + 动作 */
    public static void info(Context c, String title, String msg, Btn[] acts) {
        Dialog d = mdDialog(c);
        LinearLayout root = mdBaseRoot(c);
        mdAddHeader(c, root, title, msg);
        if (acts != null && acts.length > 0) mdActionList(c, d, root, acts);
        showMdBase(c, d, root, 440);
    }

    /**
     * 底部弹出面板（Cloudreve 手机端详情/分享卡）：贴底显示、仅顶部两角 12dp 圆角、
     * 内容自绘，仍属统一圆角弹窗体系（非系统 AlertDialog）；底部预留系统导航栏安全区。
     */
    public static void sheet(Context c, String title, View content, Btn[] acts) {
        final Dialog d = mdDialog(c);
        d.setCanceledOnTouchOutside(true);

        LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cCard());
        float r = mdDp(c, 12);
        gd.setCornerRadii(new float[]{r, r, r, r, 0, 0, 0, 0});
        setBg(root, gd);
        int safeBottom = c instanceof Activity ? navInsetBottom((Activity) c) : 0;
        root.setPadding(mdDp(c, 20), mdDp(c, 16), mdDp(c, 20), mdDp(c, 12) + safeBottom);

        if (title != null && title.length() > 0) {
            TextView t = mdTitle(c, title);
            t.setTextSize(17);
            t.setSingleLine(true);
            t.setEllipsize(android.text.TextUtils.TruncateAt.END);
            root.addView(t, lpM(-1, -2, 0, 0, 0, mdDp(c, 14)));
        }
        if (content != null) root.addView(content, lpM(-1, -2, 0, 0, 0, mdDp(c, 8)));
        if (acts != null && acts.length > 0) mdActionList(c, d, root, acts);

        d.setContentView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        try {
            Window w = d.getWindow();
            if (w != null) {
                w.setGravity(Gravity.BOTTOM);
                w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                w.setDimAmount(0.40f);
            }
        } catch (Throwable ignored) {}
        d.show();
    }

    /** 详情面板一行：左侧固定宽标签（次要色）+ 右侧可换行值（正文色） */
    public static LinearLayout detailRow(Context c, String label, String value) {
        LinearLayout row = new LinearLayout(c);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.TOP);
        row.setPadding(0, mdDp(c, 7), 0, mdDp(c, 7));

        TextView l = text(c, label == null ? "" : label, ThemeUi.cSub(), 13, Typeface.NORMAL);
        l.setSingleLine(true);
        row.addView(l, lp(mdDp(c, 72), -2));

        TextView v = text(c, value == null ? "—" : value, ThemeUi.cText(), 13, Typeface.NORMAL);
        v.setLineSpacing(0, 1.5f);
        v.setTextIsSelectable(true);
        row.addView(v, new LinearLayout.LayoutParams(0, -2, 1f));
        return row;
    }

    /** 主按钮：品牌/指定色实底 + 6dp 圆角 + 浅色文字 + 加粗（触摸区 ≥44dp） */
    public static android.widget.Button solid(Context c, String s, int bgColor, int textColor) {
        android.widget.Button b = new android.widget.Button(c);
        b.setText(s);
        noCaps(b);
        b.setTextColor(textColor);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setPadding(mdDp(c, 14), 0, mdDp(c, 14), 0);
        b.setMinHeight(mdDp(c, 44));
        setBg(b, mdBg(c, bgColor, 6));
        return b;
    }

    /** 次要按钮：1px 描边 + 透明底 + 8dp 圆角（触摸区 ≥44dp） */
    public static android.widget.Button outline(Context c, String s, int color) {
        android.widget.Button b = new android.widget.Button(c);
        b.setText(s);
        noCaps(b);
        b.setTextColor(color);
        b.setTextSize(15);
        b.setPadding(mdDp(c, 14), 0, mdDp(c, 14), 0);
        b.setMinHeight(mdDp(c, 44));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(0x00000000);
        gd.setCornerRadius(mdDp(c, 8));
        gd.setStroke(Math.max(1, mdDp(c, 1)), color);
        setBg(b, gd);
        return b;
    }

    /**
     * 页面级空状态（各页统一）：56dp 圆形浅底图标 + 主文案 15 + 说明 13 muted + 可选主按钮（品牌实底）。
     */
    public static LinearLayout emptyState(Context c, String glyph, String msg) {
        return emptyState(c, glyph, msg, null, null, null);
    }

    /** 空状态（含说明文案与主按钮）：desc 与 btnText 可为 null */
    public static LinearLayout emptyState(Context c, String glyph, String title, String desc,
                                          String btnText, final Cb onBtn) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView ic = new TextView(c);
        ic.setText(glyph == null || glyph.length() == 0 ? "空" : glyph);
        ic.setTextColor(ThemeUi.cMute());
        ic.setTextSize(19);
        ic.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        ic.setGravity(Gravity.CENTER);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(ThemeUi.cFill());
        setBg(ic, g);
        box.addView(ic, lp(mdDp(c, 56), mdDp(c, 56)));

        TextView t = text(c, title == null ? "" : title, ThemeUi.cText(), 15, Typeface.NORMAL);
        t.setGravity(Gravity.CENTER);
        t.setLineSpacing(0, 1.3f);
        box.addView(t, lpM(-1, -2, 0, mdDp(c, 12), 0, 0));

        if (desc != null && desc.length() > 0) {
            TextView d = text(c, desc, ThemeUi.cMute(), 13, Typeface.NORMAL);
            d.setGravity(Gravity.CENTER);
            d.setLineSpacing(0, 1.5f);
            box.addView(d, lpM(-1, -2, 0, mdDp(c, 4), 0, 0));
        }
        if (btnText != null && btnText.length() > 0) {
            final android.widget.Button b = solid(c, btnText, ThemeUi.cBrand(), 0xFFFFFFFF);
            b.setPadding(mdDp(c, 20), 0, mdDp(c, 20), 0);
            if (onBtn != null) {
                b.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { onBtn.run(); }
                });
            }
            box.addView(b, lpM(-2, mdDp(c, 44), 0, mdDp(c, 16), 0, 0));
        }
        return box;
    }

    /** M3 填充式输入域（随主题）：供自定义内容弹窗 / 页面内输入统一风格 */
    public static EditText field(Context c, String hint, boolean multiline) {
        EditText et = new EditText(c);
        et.setHint(hint);
        et.setTextSize(15);
        et.setTextColor(ThemeUi.cText());
        et.setHintTextColor(ThemeUi.cMute());
        et.setPadding(mdDp(c, 16), mdDp(c, multiline ? 12 : 0), mdDp(c, 16), mdDp(c, multiline ? 12 : 0));
        if (multiline) {
            et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            et.setGravity(Gravity.TOP);
        } else {
            et.setSingleLine(true);
        }
        setBg(et, mdBg(c, ThemeUi.cFill(), 8));
        et.setMinHeight(mdDp(c, multiline ? 96 : 52));
        return et;
    }

    // ---------- 格式化 ----------
    public static String fmtSize(long bytes) {
        if (bytes >= 1024L * 1024 * 1024) return String.format(Locale.CHINA, "%.2f GB", bytes / 1024.0 / 1024 / 1024);
        if (bytes >= 1024 * 1024) return String.format(Locale.CHINA, "%.1f MB", bytes / 1024.0 / 1024);
        if (bytes >= 1024) return String.format(Locale.CHINA, "%.1f KB", bytes / 1024.0);
        return bytes + " B";
    }

    /** 服务器日期串 yyyy-MM-dd HH:mm:ss */
    public static String fmtDbTime(String s) {
        if (s == null || s.length() == 0) return "";
        if (s.length() >= 16) return s.substring(5, 16);
        return s;
    }

    /** 下载到公共 Downloads 目录需 WRITE_EXTERNAL_STORAGE；API 23+ 在此统一请求（各主界面 onCreate 调用一次） */
    public static void ensureStorage(Activity a) {
        if (Build.VERSION.SDK_INT >= 23 && a.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            try {
                a.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 9001);
            } catch (Exception ignored) {}
        }
    }

    // ---------- 下载 / 打开 ----------

    /** 下载缓冲区 512KB */
    private static final int DL_BUF = 512 * 1024;
    /** 分段并发连接数 */
    private static final int DL_CONNS = 4;
    /** 启用多连接分段下载的最小体积（4MB） */
    private static final long DL_PARALLEL_MIN = 4L * 1024 * 1024;

    public static void download(Context c, String url, String fileName) {
        final int tId = Transfer.add(false, fileName, 0);
        directDownload(c, url, fileName, tId);
    }

    /** 自行下载到公共 Downloads：可见进度；大文件走多连接分段并发（提速） */
    private static void directDownload(final Context c, final String url, final String fileName, final int tId) {
        toast(c, "开始下载：" + fileName);
        async(new Runnable() {
            @Override public void run() {
                java.io.File dir = android.os.Environment.getExternalStoragePublicDirectory(
                        android.os.Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                java.io.File target = uniqueTarget(dir, sanitize(fileName));
                try {
                    long total = probeLength(url);
                    if (total > 0) Transfer.total(tId, total);
                    boolean ok = false;
                    if (total >= DL_PARALLEL_MIN) {
                        Transfer.note(tId, "多线程下载中");
                        ok = parallelDownload(url, target, total, tId);
                    }
                    if (!ok) singleDownload(url, target, tId);
                    Transfer.finish(tId, true, null);
                    final String dn = target.getName();
                    onUi(new Runnable() {
                        @Override public void run() { toast(c, "下载完成：" + dn); }
                    });
                } catch (Throwable t) {
                    // 兜底：交给系统下载管理器（不占前台）
                    if (!systemDownload(c, url, fileName, tId)) {
                        Transfer.finish(tId, false, "下载失败");
                        onUi(new Runnable() {
                            @Override public void run() { toast(c, "下载失败，请重试"); }
                        });
                    }
                }
            }
        }, null, null);
    }

    /**
     * 探测是否支持分段下载并取文件总长度：
     * 仅当服务端对 Range 请求返回 206 时返回长度（可用于多连接加速）；
     * 返回 200（不支持 Range）或异常时返回 -1，交由单连接下载。
     */
    private static long probeLength(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setRequestProperty("Range", "bytes=0-0");
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            int code = conn.getResponseCode();
            if (code == 206) {
                String cr = conn.getHeaderField("Content-Range");
                if (cr != null) {
                    int slash = cr.lastIndexOf('/');
                    if (slash > 0) {
                        try { return Long.parseLong(cr.substring(slash + 1).trim()); } catch (Exception ignored) {}
                    }
                }
            }
        } catch (Throwable ignored) {
        } finally {
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
        return -1;
    }

    /** 多连接分段并发下载；任一分段失败返回 false（由调用方回退单连接） */
    private static boolean parallelDownload(final String url, final java.io.File target, final long total, final int tId) {
        long part = (total + DL_CONNS - 1) / DL_CONNS;
        final java.io.File[] parts = new java.io.File[DL_CONNS];
        final java.util.concurrent.atomic.AtomicLong done =
                new java.util.concurrent.atomic.AtomicLong(0);
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(DL_CONNS);
        final boolean[] failed = {false};
        for (int i = 0; i < DL_CONNS; i++) {
            final long start = i * part;
            final long end = Math.min(total, start + part) - 1;
            if (start > end) { latch.countDown(); continue; }
            final int idx = i;
            parts[idx] = new java.io.File(target.getAbsolutePath() + ".part" + idx);
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        rangeDownload(url, parts[idx], start, end, done, tId);
                    } catch (Throwable t) {
                        failed[0] = true;
                    } finally {
                        latch.countDown();
                    }
                }
            }).start();
        }
        try { latch.await(); } catch (InterruptedException e) { failed[0] = true; }
        if (failed[0]) { cleanup(parts); target.delete(); return false; }

        // 按序合并分段
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(target);
            byte[] buf = new byte[DL_BUF];
            long written = 0;
            try {
                for (int i = 0; i < DL_CONNS; i++) {
                    if (parts[i] == null) continue;
                    java.io.FileInputStream in = new java.io.FileInputStream(parts[i]);
                    try {
                        int n;
                        while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); written += n; }
                    } finally { in.close(); }
                }
                out.flush();
            } finally { out.close(); }
            if (written != total) { cleanup(parts); target.delete(); return false; }
        } catch (Throwable t) {
            cleanup(parts); target.delete(); return false;
        }
        cleanup(parts);
        return true;
    }

    /** 下载单个字节区间（要求服务端支持 Range 且返回 206，否则视为失败） */
    private static void rangeDownload(String url, java.io.File dst, long start, long end,
                                      java.util.concurrent.atomic.AtomicLong done, int tId) throws Exception {
        java.net.HttpURLConnection conn = null;
        java.io.InputStream in = null;
        java.io.FileOutputStream out = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setRequestProperty("Range", "bytes=" + start + "-" + end);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            int code = conn.getResponseCode();
            if (code != 206) throw new java.io.IOException("HTTP " + code);
            String cr = conn.getHeaderField("Content-Range");
            if (cr != null && !cr.startsWith("bytes " + start + "-")) throw new java.io.IOException("bad range");
            in = conn.getInputStream();
            out = new java.io.FileOutputStream(dst);
            byte[] buf = new byte[DL_BUF];
            int n;
            long got = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                Transfer.progress(tId, done.addAndGet(n));
            }
            if (got != (end - start + 1)) throw new java.io.IOException("short part");
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
            if (out != null) try { out.close(); } catch (Throwable ignored) {}
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** 单连接流式下载（带进度） */
    private static void singleDownload(String url, java.io.File target, int tId) throws Exception {
        java.net.HttpURLConnection conn = null;
        java.io.InputStream in = null;
        java.io.FileOutputStream out = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            if (code >= 400) throw new java.io.IOException("HTTP " + code);
            long total = conn.getContentLength();
            if (total > 0) Transfer.total(tId, total);
            in = conn.getInputStream();
            out = new java.io.FileOutputStream(target);
            byte[] buf = new byte[DL_BUF];
            int n;
            long done = 0, last = 0;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                done += n;
                if (done - last >= 256 * 1024) { last = done; Transfer.progress(tId, done); }
            }
            out.flush();
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) {}
            if (out != null) try { out.close(); } catch (Throwable ignored) {}
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** 回退：系统下载管理器（无进度，但可后台完成） */
    private static boolean systemDownload(Context c, String url, String fileName, int tId) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle(fileName);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, sanitize(fileName));
            DownloadManager dm = (DownloadManager) c.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return false;
            dm.enqueue(req);
            Transfer.note(tId, "已转系统下载");
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 目标文件：同名自动追加 (1)(2)… */
    private static java.io.File uniqueTarget(java.io.File dir, String name) {
        java.io.File f = new java.io.File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        int i = 1;
        while (f.exists()) { f = new java.io.File(dir, stem + "(" + (i++) + ")" + ext); }
        return f;
    }

    private static void cleanup(java.io.File[] parts) {
        for (java.io.File p : parts) {
            if (p != null) try { p.delete(); } catch (Throwable ignored) {}
        }
    }

    private static String sanitize(String name) {
        String n = name == null ? "file" : name.replaceAll("[/\\\\:*?\"<>|]", "_");
        return n.length() == 0 ? "file" : n;
    }

    public static void openUrl(Context c, String url) {
        try {
            c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast(c, "没有可用的应用打开链接");
        }
    }

    public static void copy(Context c, String text) {
        ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
        cm.setPrimaryClip(ClipData.newPlainText("text", text));
        toast(c, "已复制");
    }

    /** 打开系统文件选择器（返回在 onActivityResult 的 data.getData()） */
    public static void pickFile(Activity a, int requestCode) {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        try {
            a.startActivityForResult(Intent.createChooser(i, "选择文件"), requestCode);
        } catch (Exception e) {
            toast(a, "无法打开文件选择器");
        }
    }

    /**
     * 显示圆角现代风加载框（与 confirm/input 等同一套自绘弹窗，非系统原生 AlertDialog）：
     * 半透明遮罩 + 悬浮卡（自绘进度环 + 文案），API 14+ 观感一致。返回后 dismiss()。
     */
    public static Dialog loading(Activity a, String text) {
        final Dialog d = mdDialog(a);
        d.setCancelable(false);

        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        setBg(box, mdBg(a, ThemeUi.cCard(), 28));
        box.setPadding(mdDp(a, 32), mdDp(a, 26), mdDp(a, 32), mdDp(a, 26));

        box.addView(new MaterialRing(a),
                new LinearLayout.LayoutParams(mdDp(a, 48), mdDp(a, 48)));

        if (text != null && text.length() != 0) {
            TextView tv = text(a, text, ThemeUi.cText(), 13, 0);
            tv.setGravity(Gravity.CENTER);
            box.addView(tv, lpM(-2, -2, 0, mdDp(a, 12), 0, 0));
        }

        showMdWrap(d, box);
        return d;
    }

    public static void hideIme(Activity a) {
        InputMethodManager imm = (InputMethodManager) a.getSystemService(Context.INPUT_METHOD_SERVICE);
        View v = a.getCurrentFocus();
        if (v != null && imm != null) imm.hideSoftInputFromWindow(v.getWindowToken(), 0);
    }

    // ---------- JSON 安全取值 ----------
    public static String s(JSONObject o, String k) { return o == null ? "" : o.optString(k, ""); }
    public static long l(JSONObject o, String k) { return o == null ? 0 : o.optLong(k, 0); }
    public static int i(JSONObject o, String k) { return o == null ? 0 : o.optInt(k, 0); }
    public static boolean b(JSONObject o, String k) { return o != null && o.optBoolean(k, false); }
    public static JSONArray a(JSONObject o, String k) { return o == null ? new JSONArray() : o.optJSONArray(k); }

    // ---------- 视图工具 ----------
    public static TextView text(Context c, String s, int color, float sp, int style) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(sp);
        t.setTypeface(android.graphics.Typeface.DEFAULT, style);
        return t;
    }

    public static LinearLayout.LayoutParams lp(int w, int h) {
        return new LinearLayout.LayoutParams(w, h);
    }

    public static LinearLayout.LayoutParams lpM(int w, int h, int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(w, h);
        p.setMargins(l, t, r, b);
        return p;
    }

    /** 品牌色圆角按钮（品牌色 + 6dp 圆角） */
    public static android.widget.Button button(Context c, String s) {
        android.widget.Button b = new android.widget.Button(c);
        b.setText(s);
        noCaps(b);
        try {
            b.setTextColor(0xFFFFFFFF);
            b.setTextSize(15);
            b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            b.setMinHeight(mdDp(c, 44));
            android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
            gd.setColor(ThemeUi.cBrand());
            gd.setCornerRadius(6 * c.getResources().getDisplayMetrics().density);
            setBg(b, gd);
        } catch (Exception ignored) {}
        return b;
    }

    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(ThemeUi.cLine());
        return v;
    }
}
