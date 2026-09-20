package com.cubecute.ccyun.util;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.TranslateAnimation;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.cubecute.ccyun.R;
import com.cubecute.ccyun.net.Constants;
import com.cubecute.ccyun.ui.FilesActivity;
import com.cubecute.ccyun.ui.HomeActivity;
import com.cubecute.ccyun.ui.MeActivity;
import com.cubecute.ccyun.ui.SearchActivity;
import com.cubecute.ccyun.ui.TeamsActivity;
import com.cubecute.ccyun.ui.TransferActivity;
import com.cubecute.ccyun.ui.TrashActivity;

import java.util.WeakHashMap;

/**
 * 主界面壳（Cloudreve 风格）：
 *  - 顶部栏：48~56dp 卡片底色 + 底部 1dp 分隔线；左侧汉堡（主页面）/返回键（子页面）；
 *    中间标题或面包屑；右侧「少而精」——默认最多 搜索、＋（传输进度，带角标）、⋯（溢出菜单）三个，
 *    低频页内操作（排序、列表/网格切换等）收进 ⋯ 弹出的自绘圆角菜单，避免挤占面包屑宽度。
 *    所有顶栏图标按钮统一 44dp 触摸区、4dp 间距、约 24dp 自绘图标、统一按压反馈。
 *  - 左侧抽屉：宽 240dp，遮罩 + 平移动画（0.2s）自绘实现（不依赖 DrawerLayout/support 库）；
 *    菜单项 48dp 高，图标+文字，选中态 = 品牌浅底 + 品牌文字 + 左侧 3dp 品牌色竖条。
 *  - 底部导航与卡片容器沿用旧 API，视觉对齐 Cloudreve 令牌。
 *
 * 兼容：全程仅用 framework API（minSdk 11）；自定义图标用 onDraw 手绘，避免依赖新增 drawable；
 * 动画用 TranslateAnimation/AlphaAnimation（API 1），不使用 ViewPropertyAnimator（API 12+）。
 */
public final class ShellUi {

    /** 应用版本（「关于」弹窗与侧栏底部统一展示） */
    public static final String VERSION = "v6.10";

    // 底部导航 Tab（保持历史取值）
    public static final int TAB_HOME = 0;
    public static final int TAB_FILES = 1;
    public static final int TAB_TEAMS = 2;
    public static final int TAB_ME = 4;

    // 抽屉导航项（取值保持历史语义，显示顺序见 NAV_ORDER）
    public static final int NAV_NONE = -1;
    public static final int NAV_HOME = 0;
    public static final int NAV_FILES = 1;
    public static final int NAV_TEAMS = 2;
    public static final int NAV_TRASH = 3;
    public static final int NAV_SEARCH = 4;
    public static final int NAV_TRANSFER = 5;
    public static final int NAV_ADMIN = 6;
    public static final int NAV_ME = 7;
    /** 我的分享（网页端能力，点击后用系统浏览器打开） */
    public static final int NAV_SHARE = 8;
    /** 离线下载（网页端能力，点击后用系统浏览器打开） */
    public static final int NAV_OFFLINE = 9;

    /**
     * 抽屉显示顺序（与移动网页端条目、顺序、命名完全一致）：
     * 首页 → 文件 → 我的分享 → 离线下载 → 团队 → 回收站 → 搜索 → 上传任务 → 管理后台 → 我的。
     */
    private static final int[] NAV_ORDER = {
            NAV_HOME, NAV_FILES, NAV_SHARE, NAV_OFFLINE, NAV_TEAMS,
            NAV_TRASH, NAV_SEARCH, NAV_TRANSFER, NAV_ADMIN, NAV_ME};

    private static final String[] NAV_LABEL = {
            "首页", "文件", "团队", "回收站", "搜索", "上传任务", "管理后台", "我的", "我的分享", "离线下载"};
    private static final String[] NAV_GLYPH = {
            "首", "文", "队", "回", "搜", "传", "管", "我", "享", "离"};

    /** 是否展示「管理后台」入口（仅管理员；由页面在拿到 /api/me 后写入） */
    private static boolean admin = false;

    private static final WeakHashMap<Activity, Drawer> DRAWERS = new WeakHashMap<Activity, Drawer>();

    private ShellUi() {}

    /** 页面拉到 /api/me 后调用：从返回体识别管理员身份（兼容多种字段命名） */
    public static void setAdminFrom(org.json.JSONObject me) {
        if (me == null) { return; }
        boolean a = me.optBoolean("isAdmin", false) || me.optBoolean("is_admin", false)
                || me.optBoolean("admin", false) || me.optInt("admin", 0) == 1;
        String role = me.optString("role", "");
        String srv = me.optString("srvRole", "");
        if ("admin".equals(role) || "owner".equals(role)) a = true;
        if ("admin".equals(srv) || "owner".equals(srv)) a = true;
        admin = a;
    }

    private static int dp(Context c, float v) {
        return (int) (v * c.getResources().getDisplayMetrics().density + 0.5f);
    }

    private static void bg(View v, android.graphics.drawable.Drawable d) {
        if (d == null) return;
        try {
            if (android.os.Build.VERSION.SDK_INT >= 16) v.setBackground(d);
            else v.setBackgroundDrawable(d);
        } catch (Throwable ignored) {}
    }

    private static GradientDrawable round(int color, float radiusDp, Context c) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(color);
        gd.setCornerRadius(dp(c, radiusDp));
        return gd;
    }

    // ==================================================================
    //  顶部栏
    // ==================================================================

    // ---- 顶栏尺寸令牌（统一触摸区 / 间距 / 图标视觉尺寸） ----
    /** 顶栏内容行高 */
    private static final float BAR_H = 52f;
    /** 顶栏图标按钮触摸区（左右按钮一致） */
    private static final float BTN = 44f;
    /** 顶栏按钮之间的水平间距 */
    private static final float BTN_GAP = 4f;

    /**
     * 顶栏右侧按钮配置（Cloudreve 式「少而精」：右侧最多 搜索 / ＋ / ⋯ 三个）。
     * 低频页内操作（排序、列表/网格切换等）请放进 overflow 弹出的自绘圆角菜单，不要常驻按钮。
     */
    public static final class BarOpts {
        /** 是否显示「搜索」入口（本页已含搜索框时可关掉，如搜索页） */
        public boolean search = true;
        /** 是否显示「＋」传输进度入口（带角标） */
        public boolean plus = true;
        /** 最右侧「⋯」溢出菜单按钮（用 moreBtn 构建；null = 不显示） */
        public View overflow;
    }

    /** 浅色顶部栏（含返回键时 onClick 返回） */
    public static LinearLayout header(Activity a, String title, final boolean back, final View.OnClickListener onBack) {
        return headerEx(a, title, back, onBack, null);
    }

    /** 顶部栏（可追加一个自定义右侧按钮） */
    public static LinearLayout headerEx(Activity a, String title, final boolean back,
                                        final View.OnClickListener onBack, View extraRight) {
        return bar(a, navBtn(a, back, onBack), titleView(a, title), extraRight);
    }

    /** 主页面顶栏（汉堡 + 标题）+ 右上角「＋」传输进度入口（带角标） */
    public static LinearLayout headerT(final Activity a, String title) {
        return headerEx(a, title, false, null, null);
    }

    /**
     * 通用顶部栏：left(左下控件) + center(中间标题/面包屑，占满剩余宽度) + rights(额外右侧控件)。
     * 默认右侧 = 搜索 + rights + ＋。
     */
    public static LinearLayout bar(Activity a, View left, View center, View... rights) {
        return bar(a, left, center, new BarOpts(), rights);
    }

    /**
     * 通用顶部栏（右侧按钮可配置）。
     * 右侧顺序：搜索 → rights → ＋（传输进度）→ ⋯（溢出菜单），最右侧为 ⋯；
     * 统一 44dp 触摸区、4dp 间距、约 24dp 自绘图标，按压反馈统一走 Util.setFeedback
     * （API21+ 轻波纹，低版本透明度）。返回 竖向容器 = 52dp 内容行 + 1dp 分隔线。
     */
    public static LinearLayout bar(Activity a, View left, View center, BarOpts opts, View... rights) {
        final BarOpts o = opts == null ? new BarOpts() : opts;
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(ThemeUi.cBar());

        LinearLayout row = new LinearLayout(a);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(a, 2), 0, dp(a, 4), 0);

        if (left != null) {
            row.addView(left, btnLp(a, 0));
        }
        if (center != null) {
            row.addView(center, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));
        } else {
            View spacer = new View(a);
            row.addView(spacer, new LinearLayout.LayoutParams(0, 1, 1f));
        }
        if (o.search) {
            row.addView(searchBtn(a), btnLp(a, dp(a, BTN_GAP)));
        }
        if (rights != null) {
            for (int i = 0; i < rights.length; i++) {
                if (rights[i] == null) continue;
                row.addView(rights[i], btnLp(a, dp(a, BTN_GAP)));
            }
        }
        if (o.plus) {
            row.addView(plusBtn(a), btnLp(a, dp(a, BTN_GAP)));
        }
        if (o.overflow != null) {
            row.addView(o.overflow, btnLp(a, dp(a, BTN_GAP)));
        }

        box.addView(row, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(a, BAR_H)));

        View line = new View(a);
        line.setBackgroundColor(ThemeUi.cLine());
        box.addView(line, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1));
        return box;
    }

    /** 顶栏图标按钮统一布局参数：44dp 触摸区 + 4dp 左间距 */
    private static LinearLayout.LayoutParams btnLp(Activity a, int gapLeft) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(a, BTN), dp(a, BTN));
        p.leftMargin = gapLeft;
        return p;
    }

    /** 右侧「搜索」入口（跳转搜索页） */
    private static View searchBtn(final Activity a) {
        return iconBtn(a, Ic.SEARCH, new View.OnClickListener() {
            @Override public void onClick(View v) {
                Intent i = new Intent(a, SearchActivity.class);
                a.startActivity(i);
                enter(a);
            }
        }, "搜索");
    }

    /** 顶栏标题：占满剩余宽度，左对齐，20sp 粗体单行省略（规范：页面/顶栏标题 20） */
    public static TextView titleView(Activity a, String title) {
        TextView tv = new TextView(a);
        tv.setText(title == null ? "" : title);
        tv.setTextColor(ThemeUi.cText());
        tv.setTextSize(20);
        tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        tv.setLineSpacing(0, 1.3f);
        tv.setSingleLine(true);
        tv.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tv.setGravity(Gravity.CENTER_VERTICAL);
        tv.setPadding(dp(a, 12), 0, dp(a, 4), 0);
        return tv;
    }

    /** 左侧控件：back=true 显示返回箭头（无 onBack 时默认 finish+退场动画），否则汉堡（打开抽屉） */
    public static View navBtn(final Activity a, boolean back, final View.OnClickListener onBack) {
        final int kind = back ? Ic.BACK : Ic.BURGER;
        View v = iconBtn(a, kind, new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (kind == Ic.BURGER) {
                    toggleDrawer(a);
                    return;
                }
                if (onBack != null) onBack.onClick(v);
                else {
                    a.finish();
                    leave(a);
                }
            }
        }, back ? "返回" : "打开导航");
        return v;
    }

    /** 右侧「⋯」溢出菜单按钮：点击弹出项目自绘圆角菜单（Util.menu），收纳低频页内操作 */
    public static View moreBtn(final Activity a, View.OnClickListener l) {
        return iconBtn(a, Ic.MORE, l, "更多");
    }

    /** 右侧「＋」传输进度入口（带角标；角标由 Transfer 维护，无任务时自动隐藏） */
    public static View plusBtn(final Activity a) {
        FrameLayout wrap = new FrameLayout(a);
        FrameLayout chipWrap = new FrameLayout(a);
        final TextView ic = new TextView(a);
        ic.setText("＋");
        ic.setTextColor(ThemeUi.cBrand());
        ic.setTextSize(19);
        ic.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        ic.setGravity(Gravity.CENTER);
        bg(ic, round(ThemeUi.cBrandChip(), 8, a));
        ic.setContentDescription("上传/下载进度");
        chipWrap.addView(ic, new FrameLayout.LayoutParams(dp(a, 32), dp(a, 32)));

        final TextView badge = new TextView(a);
        badge.setTextColor(0xFFFFFFFF);
        badge.setTextSize(10);
        badge.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        badge.setGravity(Gravity.CENTER);
        badge.setMinWidth(dp(a, 16));
        badge.setMinHeight(dp(a, 16));
        badge.setPadding(dp(a, 4), 0, dp(a, 4), 0);
        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setShape(GradientDrawable.OVAL);
        badgeBg.setColor(ThemeUi.cDanger());
        bg(badge, badgeBg);
        chipWrap.addView(badge, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.RIGHT));
        Transfer.setBadgeView(badge);

        wrap.addView(chipWrap, new FrameLayout.LayoutParams(dp(a, 32), dp(a, 32), Gravity.CENTER));
        wrap.setContentDescription("上传/下载进度");
        wrap.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                a.startActivity(new Intent(a, TransferActivity.class));
            }
        });
        Util.setFeedback(wrap);
        return wrap;
    }

    /** 顶栏图标按钮（44dp 触摸区，自绘图标 + 统一按压反馈） */
    private static View iconBtn(Activity a, int kind, View.OnClickListener l, String desc) {
        Ic ic = new Ic(a, kind, ThemeUi.cSub());
        ic.setOnClickListener(l);
        if (desc != null) ic.setContentDescription(desc);
        Util.setFeedback(ic);
        return ic;
    }

    /** 顶栏图标（纯代码绘制：汉堡/返回/搜索/更多，线宽与视觉尺寸统一） */
    private static final class Ic extends View {
        static final int BURGER = 1, BACK = 2, SEARCH = 3, MORE = 4;
        /** 图标内容盒占触摸区的比例：44dp 按钮 → 约 24dp 视觉尺寸 */
        private static final float BOX_RATIO = 0.55f;
        private final int kind;
        private final Paint p = new Paint();

        Ic(Context c, int kind, int color) {
            super(c);
            this.kind = kind;
            p.setAntiAlias(true);
            p.setColor(color);
            p.setStrokeCap(Paint.Cap.ROUND);
            p.setStrokeJoin(Paint.Join.ROUND);
            p.setStyle(Paint.Style.STROKE);
        }

        @Override
        protected void onDraw(Canvas cv) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            float box = Math.min(w, h) * BOX_RATIO;
            float s = box / 24f;
            float ox = (w - box) / 2f, oy = (h - box) / 2f;
            // 线宽固定为 24 格坐标系下的 2 格（随画布 scale 换算为约 2dp），避免随密度二次放大
            p.setStrokeWidth(2.0f);
            cv.save();
            cv.translate(ox, oy);
            cv.scale(s, s);
            switch (kind) {
                case BURGER:
                    cv.drawLine(3.5f, 6, 20.5f, 6, p);
                    cv.drawLine(3.5f, 12, 20.5f, 12, p);
                    cv.drawLine(3.5f, 18, 20.5f, 18, p);
                    break;
                case BACK:
                    cv.drawLine(15, 4, 7, 12, p);
                    cv.drawLine(7, 12, 15, 20, p);
                    break;
                case SEARCH:
                    cv.drawCircle(10.5f, 10.5f, 6.3f, p);
                    cv.drawLine(15.1f, 15.1f, 20.5f, 20.5f, p);
                    break;
                case MORE:
                    p.setStyle(Paint.Style.FILL);
                    cv.drawCircle(5.5f, 12, 1.9f, p);
                    cv.drawCircle(12, 12, 1.9f, p);
                    cv.drawCircle(18.5f, 12, 1.9f, p);
                    break;
            }
            cv.restore();
        }
    }

    // ==================================================================
    //  左侧抽屉（自绘：遮罩 + 平移面板）
    // ==================================================================

    private static final class Drawer {
        FrameLayout container;
        View mask;
        LinearLayout panel;
        int width;
        boolean open;
    }

    /**
     * 把页面根布局包进"抽屉容器"：内容 + 半透明遮罩 + 左侧 240dp 菜单面板。
     * 返回应交给 setContentView 的容器。
     */
    public static View attachDrawer(final Activity a, View content, int activeNav) {
        Drawer dr = new Drawer();
        dr.width = dp(a, 240);
        dr.container = new FrameLayout(a);
        dr.container.addView(content, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        dr.mask = new View(a);
        dr.mask.setBackgroundColor(0x99000000);
        dr.mask.setVisibility(View.GONE);
        dr.mask.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { closeDrawer(a); }
        });
        dr.container.addView(dr.mask, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        dr.panel = buildSidebar(a, activeNav);
        dr.container.addView(dr.panel, new FrameLayout.LayoutParams(
                dr.width, FrameLayout.LayoutParams.MATCH_PARENT));
        try { dr.panel.setTranslationX(-dr.width); } catch (Throwable ignored) {}
        DRAWERS.put(a, dr);
        return dr.container;
    }

    public static boolean isDrawerOpen(Activity a) {
        Drawer dr = DRAWERS.get(a);
        return dr != null && dr.open;
    }

    /** 主页面返回键先关抽屉；返回 true 表示已消费 */
    public static boolean closeDrawerIfOpen(Activity a) {
        Drawer dr = DRAWERS.get(a);
        if (dr == null || !dr.open) return false;
        closeDrawer(a);
        return true;
    }

    public static void toggleDrawer(Activity a) {
        Drawer dr = DRAWERS.get(a);
        if (dr == null) return;
        if (dr.open) closeDrawer(a);
        else openDrawer(a);
    }

    public static void openDrawer(Activity a) {
        final Drawer dr = DRAWERS.get(a);
        if (dr == null || dr.open) return;
        dr.open = true;
        dr.mask.setVisibility(View.VISIBLE);
        dr.mask.setAlpha(0f);
        AlphaAnimation aa = new AlphaAnimation(0f, 1f);
        aa.setDuration(200);
        aa.setFillAfter(true);
        dr.mask.startAnimation(aa);

        dr.panel.clearAnimation();
        try { dr.panel.setTranslationX(0); } catch (Throwable ignored) {}
        TranslateAnimation ta = new TranslateAnimation(
                Animation.ABSOLUTE, -dr.width, Animation.ABSOLUTE, 0,
                Animation.ABSOLUTE, 0, Animation.ABSOLUTE, 0);
        ta.setDuration(200);
        ta.setFillAfter(true);
        try { ta.setInterpolator(new DecelerateInterpolator()); } catch (Throwable ignored) {}
        ta.setAnimationListener(new Animation.AnimationListener() {
            @Override public void onAnimationStart(Animation x) {}
            @Override public void onAnimationRepeat(Animation x) {}
            @Override public void onAnimationEnd(Animation x) {
                dr.panel.clearAnimation();
                try { dr.panel.setTranslationX(0); } catch (Throwable ignored) {}
            }
        });
        dr.panel.startAnimation(ta);
    }

    public static void closeDrawer(Activity a) {
        final Drawer dr = DRAWERS.get(a);
        if (dr == null || !dr.open) return;
        dr.open = false;

        AlphaAnimation aa = new AlphaAnimation(1f, 0f);
        aa.setDuration(200);
        aa.setFillAfter(true);
        aa.setAnimationListener(new Animation.AnimationListener() {
            @Override public void onAnimationStart(Animation x) {}
            @Override public void onAnimationRepeat(Animation x) {}
            @Override public void onAnimationEnd(Animation x) {
                dr.mask.clearAnimation();
                dr.mask.setVisibility(View.GONE);
                dr.mask.setAlpha(1f);
            }
        });
        dr.mask.startAnimation(aa);

        TranslateAnimation ta = new TranslateAnimation(
                Animation.ABSOLUTE, 0, Animation.ABSOLUTE, -dr.width,
                Animation.ABSOLUTE, 0, Animation.ABSOLUTE, 0);
        ta.setDuration(200);
        ta.setFillAfter(true);
        try { ta.setInterpolator(new DecelerateInterpolator()); } catch (Throwable ignored) {}
        ta.setAnimationListener(new Animation.AnimationListener() {
            @Override public void onAnimationStart(Animation x) {}
            @Override public void onAnimationRepeat(Animation x) {}
            @Override public void onAnimationEnd(Animation x) {
                dr.panel.clearAnimation();
                try { dr.panel.setTranslationX(-dr.width); } catch (Throwable ignored) {}
            }
        });
        dr.panel.startAnimation(ta);
    }

    /** 立即收起（不做动画），用于即将跳转其它页面时 */
    private static void closeDrawerNow(Activity a) {
        Drawer dr = DRAWERS.get(a);
        if (dr == null) return;
        dr.open = false;
        try {
            dr.panel.clearAnimation();
            dr.panel.setTranslationX(-dr.width);
        } catch (Throwable ignored) {}
        dr.mask.clearAnimation();
        dr.mask.setAlpha(1f);
        dr.mask.setVisibility(View.GONE);
    }

    /** 侧栏面板：品牌头 + 菜单项（选中态品牌浅底 + 品牌文字 + 3dp 左侧竖条）+ 底部版本 */
    private static LinearLayout buildSidebar(final Activity a, final int active) {
        LinearLayout panel = new LinearLayout(a);
        panel.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cBar());
        panel.setBackground(gd);

        // 品牌头
        LinearLayout head = new LinearLayout(a);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(a, 16), 0, dp(a, 16), 0);
        TextView logo = new TextView(a);
        logo.setText("云");
        logo.setTextColor(0xFFFFFFFF);
        logo.setTextSize(15);
        logo.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        logo.setGravity(Gravity.CENTER);
        GradientDrawable lg = new GradientDrawable();
        lg.setShape(GradientDrawable.OVAL);
        lg.setColor(ThemeUi.cBrand());
        bg(logo, lg);
        head.addView(logo, new LinearLayout.LayoutParams(dp(a, 28), dp(a, 28)));
        TextView name = Util.text(a, "CC网盘", ThemeUi.cText(), 16, Typeface.BOLD);
        head.addView(name, Util.lpM(-2, -2, dp(a, 10), 0, 0, 0));
        panel.addView(head, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(a, 56)));

        panel.addView(line(a), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1));

        for (int i = 0; i < NAV_ORDER.length; i++) {
            int nav = NAV_ORDER[i];
            if (nav == NAV_ADMIN && !admin) continue;
            panel.addView(sideItem(a, nav, nav == active), new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(a, 48)));
        }

        View flex = new View(a);
        panel.addView(flex, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        panel.addView(line(a), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 1));
        TextView ver = Util.text(a, "CC网盘 " + VERSION, ThemeUi.cMute(), 11, Typeface.NORMAL);
        ver.setGravity(Gravity.CENTER_VERTICAL);
        ver.setPadding(dp(a, 16), 0, dp(a, 16), 0);
        panel.addView(ver, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(a, 44)));
        return panel;
    }

    private static View line(Context a) {
        View v = new View(a);
        v.setBackgroundColor(ThemeUi.cLine());
        return v;
    }

    private static View sideItem(final Activity a, final int nav, boolean sel) {
        LinearLayout item = new LinearLayout(a);
        item.setOrientation(LinearLayout.HORIZONTAL);
        item.setGravity(Gravity.CENTER_VERTICAL);
        if (sel) {
            item.setBackgroundColor(ThemeUi.cBrandChip());
        }

        // 左侧 3dp 品牌色竖条（未选中留透明占位，保持缩进一致）
        View mark = new View(a);
        mark.setBackgroundColor(sel ? ThemeUi.cBrand() : 0x00000000);
        item.addView(mark, new LinearLayout.LayoutParams(dp(a, 3), LinearLayout.LayoutParams.MATCH_PARENT));

        LinearLayout body = new LinearLayout(a);
        body.setOrientation(LinearLayout.HORIZONTAL);
        body.setGravity(Gravity.CENTER_VERTICAL);
        body.setPadding(dp(a, 13), 0, dp(a, 16), 0);
        item.addView(body, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT, 1f));

        TextView icon = new TextView(a);
        icon.setText(NAV_GLYPH[nav]);
        icon.setTextSize(11);
        icon.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        icon.setGravity(Gravity.CENTER);
        if (sel) {
            icon.setTextColor(0xFFFFFFFF);
            bg(icon, round(ThemeUi.cBrand(), 8, a));
        } else {
            icon.setTextColor(ThemeUi.cSub());
            bg(icon, round(ThemeUi.cFill(), 8, a));
        }
        body.addView(icon, new LinearLayout.LayoutParams(dp(a, 20), dp(a, 20)));

        TextView label = Util.text(a, NAV_LABEL[nav], sel ? ThemeUi.cBrand() : ThemeUi.cText(),
                15, sel ? Typeface.BOLD : Typeface.NORMAL);
        label.setSingleLine(true);
        body.addView(label, Util.lpM(-2, -2, dp(a, 12), 0, 0, 0));

        item.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { navTo(a, nav); }
        });
        Util.setFeedback(item);
        return item;
    }

    /** 抽屉跳转：先立即收起，再按页面位置做方向感过渡 */
    private static void navTo(final Activity a, int nav) {
        closeDrawerNow(a);
        if (nav == NAV_ADMIN) {
            Util.openUrl(a, Constants.BASE_URL + "/admin");
            return;
        }
        // 「我的分享」「离线下载」为网页端能力：先说明再用系统浏览器打开
        if (nav == NAV_SHARE || nav == NAV_OFFLINE) {
            final String url = Constants.BASE_URL + (nav == NAV_SHARE ? "/shares" : "/offline");
            Util.info(a, NAV_LABEL[nav], "该功能在网页版中打开", new Util.Btn[]{
                    new Util.Btn("取消", Util.KIND_PLAIN, null),
                    new Util.Btn("打开网页", Util.KIND_PRIMARY, new Util.Cb() {
                        @Override public void run() { Util.openUrl(a, url); }
                    })
            });
            return;
        }
        Class<?> cls;
        if (nav == NAV_HOME) cls = HomeActivity.class;
        else if (nav == NAV_FILES) cls = FilesActivity.class;
        else if (nav == NAV_TEAMS) cls = TeamsActivity.class;
        else if (nav == NAV_TRASH) cls = TrashActivity.class;
        else if (nav == NAV_SEARCH) cls = SearchActivity.class;
        else if (nav == NAV_TRANSFER) cls = TransferActivity.class;
        else if (nav == NAV_ME) cls = MeActivity.class;
        else return;
        if (a.getClass() == cls) return;
        go(a, cls);
    }

    // ==================================================================
    //  底部导航
    // ==================================================================

    /** 底部导航（图标+文字；浮动圆角卡片，API11 兼容；底部预留系统导航栏安全区） */
    public static View bottomNav(final Activity a, final int active) {
        float d = a.getResources().getDisplayMetrics().density;
        LinearLayout outer = new LinearLayout(a);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackgroundColor(0x00000000);
        outer.setPadding((int) (10 * d), 0, (int) (10 * d), (int) (8 * d) + Util.navInsetBottom(a));

        LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cBar());
        gd.setCornerRadius(12 * d);
        gd.setStroke(Math.max(1, (int) (d * 0.5f)), ThemeUi.cLine());
        bg(bar, gd);
        int itemH = (int) (62 * d);

        addItem(a, bar, "首页", TAB_HOME, active, R.drawable.ic_nav_home_on, R.drawable.ic_nav_home_off, itemH, new View.OnClickListener() {
            @Override public void onClick(View v) { if (active != TAB_HOME) go(a, HomeActivity.class); }
        });
        addItem(a, bar, "文件", TAB_FILES, active, R.drawable.ic_nav_files_on, R.drawable.ic_nav_files_off, itemH, new View.OnClickListener() {
            @Override public void onClick(View v) { if (active != TAB_FILES) go(a, FilesActivity.class); }
        });
        addItem(a, bar, "团队", TAB_TEAMS, active, R.drawable.ic_nav_team_on, R.drawable.ic_nav_team_off, itemH, new View.OnClickListener() {
            @Override public void onClick(View v) { if (active != TAB_TEAMS) go(a, TeamsActivity.class); }
        });
        addItem(a, bar, "我的", TAB_ME, active, R.drawable.ic_nav_me_on, R.drawable.ic_nav_me_off, itemH, new View.OnClickListener() {
            @Override public void onClick(View v) { if (active != TAB_ME) go(a, MeActivity.class); }
        });

        outer.addView(bar, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return outer;
    }

    private static void addItem(Activity a, LinearLayout bar, String label, int idx, int active,
                                int iconOn, int iconOff, int h, View.OnClickListener l) {
        float d = a.getResources().getDisplayMetrics().density;
        boolean sel = idx == active;
        LinearLayout item = new LinearLayout(a);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setOnClickListener(l);

        ImageView iv = new ImageView(a);
        iv.setImageResource(sel ? iconOn : iconOff);
        item.addView(iv, Util.lp((int) (24 * d), (int) (24 * d)));

        TextView tv = Util.text(a, label, sel ? ThemeUi.cBrand() : ThemeUi.cMute(), 10, sel ? Typeface.BOLD : Typeface.NORMAL);
        tv.setGravity(Gravity.CENTER);
        item.addView(tv, Util.lpM(-1, -2, 0, (int) (3 * d), 0, 0));

        bar.addView(item, new LinearLayout.LayoutParams(0, h, 1f));
    }

    // ==================================================================
    //  导航与过渡
    // ==================================================================

    private static int indexOf(Class<?> c) {
        if (c == HomeActivity.class) return NAV_HOME;
        if (c == FilesActivity.class) return NAV_FILES;
        if (c == TeamsActivity.class) return NAV_TEAMS;
        if (c == TrashActivity.class) return NAV_TRASH;
        if (c == SearchActivity.class) return NAV_SEARCH;
        if (c == TransferActivity.class) return NAV_TRANSFER;
        if (c == MeActivity.class) return NAV_ME;
        return -1;
    }

    /**
     * 页面切换：按“目标相对当前的位置”做方向感知的横向平移。
     */
    private static void go(Activity a, Class<?> cls) {
        int from = indexOf(a.getClass());
        int to = indexOf(cls);
        Intent i = new Intent(a, cls);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        a.startActivity(i);
        try {
            if (from >= 0 && to >= 0 && to < from) {
                a.overridePendingTransition(R.anim.anim_slide_in_left, R.anim.anim_slide_out_right);
            } else {
                a.overridePendingTransition(R.anim.anim_slide_in_right, R.anim.anim_slide_out_left);
            }
        } catch (Throwable ignored) {}
    }

    /** 进入新页面后的过渡（右滑入+淡出） */
    public static void enter(Activity a) {
        try {
            a.overridePendingTransition(R.anim.anim_slide_in_right, R.anim.anim_fade_out);
        } catch (Throwable ignored) {}
    }

    /** 返回上一页的过渡（淡入淡出） */
    public static void leave(Activity a) {
        try {
            a.overridePendingTransition(R.anim.anim_fade_in, R.anim.anim_fade_out);
        } catch (Throwable ignored) {}
    }

    /** 构建一个页面根容器：header + content + bottomNav */
    public static LinearLayout page(Activity a, String title, boolean showNav, int activeTab, boolean back) {
        LinearLayout root = new LinearLayout(a);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(header(a, title, back, null), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return root;
    }

    /** 卡片容器（规范：卡片 12dp 圆角 + 1px 描边；浅色下用极淡 elevation 近似 0 1px 3px 阴影，深色不投影） */
    public static LinearLayout card(Activity a) {
        return card(a, 12f);
    }

    /** 卡片容器（自定义圆角；面板用 12dp，大弹窗 28dp 见 Util） */
    public static LinearLayout card(Activity a, float radiusDp) {
        LinearLayout c = new LinearLayout(a);
        c.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cCard());
        gd.setCornerRadius(dp(a, radiusDp));
        gd.setStroke(1, ThemeUi.cLine());
        bg(c, gd);
        if (android.os.Build.VERSION.SDK_INT >= 21 && !ThemeUi.isDark(a)) {
            try { c.setElevation(dp(a, 1)); } catch (Throwable ignored) {}
        }
        return c;
    }

    /** 面包屑（可直接放进顶栏中间；返回外层容器，调用方填充分段） */
    public static HorizontalScrollView crumbHost(Activity a, LinearLayout row) {
        HorizontalScrollView hsv = new HorizontalScrollView(a);
        hsv.setHorizontalScrollBarEnabled(false);
        hsv.setFillViewport(true);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        // 左侧留白与标题左内边距对齐，右侧留白避免末段贴住右侧按钮
        row.setPadding(dp(a, 8), 0, dp(a, 4), 0);
        hsv.addView(row, new HorizontalScrollView.LayoutParams(
                HorizontalScrollView.LayoutParams.WRAP_CONTENT,
                HorizontalScrollView.LayoutParams.MATCH_PARENT));
        return hsv;
    }
}
