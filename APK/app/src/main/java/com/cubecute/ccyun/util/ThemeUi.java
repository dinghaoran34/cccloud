package com.cubecute.ccyun.util;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 全局主题令牌：浅色 / 深色（应用内手动切换并持久化）。
 *
 * 设计约束：
 *  - 应用为纯 framework、minSdk 11，无法依赖系统 DayNight；故"深色模式"作为用户设置存储。
 *  - 色板对齐 Cloudreve 网页端（cloudreve.org）：
 *      页面 #f5f7fa→#17181c、侧栏/顶栏 #ffffff→#1e2024、卡片 #ffffff→#24262b、
 *      分隔线 #e8eaed→#33363c、正文 #25272b→#e8eaed、次要 #6b7280→#a3a9b3、
 *      弱化 #9aa3af→#7d838d、品牌 #2b7de9→#4c8dff、品牌浅底 #e8f2fe→#1e2a3f、
 *      按压/悬停底 #f2f5f9→#2a2d33、危险 #e5484d→#f2555a、成功 #22c55e→#3ecf6f。
 *  - 深色模式仅切换"语义层"色（页面/卡片/输入底/分割线/正文/次要/弱化/品牌/危险等）；
 *    纯品牌蓝按钮/渐变、彩色头像圆、彩色图标块等强调色保留原样，避免暗底刺眼或信息丢失。
 *
 * 使用方式：
 *  - 外观三选一：ThemeUi.setMode(this, MODE_SYSTEM/MODE_LIGHT/MODE_DARK)（模式持久化到 prefs）；
 *    ThemeUi.MODE_SYSTEM 时实时读取系统 uiMode（API 8+），返回时由 ThemeActivity.recreate() 生效；
 *  - ThemeUi.isDark(this) 返回当前解析结果（含跟随系统）；setDark(this,true/false) 为两态快捷写法；
 *  - 页面直接调 ThemeUi.cPage()/cCard()/cText()... 取当前主题色；
 *  - ThemeUi.applyStatusBar(activity) 让状态栏底色/图标随主题（API 21+ 生效，API 23+ 支持深色图标）。
 */
public final class ThemeUi {

    private static final String PREFS = "teamcloud_theme";
    private static final String KEY_DARK = "dark";
    private static final String KEY_MODE = "mode";
    private static final String KEY_GRID = "files_grid";
    private static final String KEY_SORT = "files_sort";
    private static final String KEY_SORT_ASC = "files_sort_asc";

    /** 排序字段：名称 / 大小 / 修改时间 */
    public static final int SORT_NAME = 0;
    public static final int SORT_SIZE = 1;
    public static final int SORT_TIME = 2;

    /** 外观模式：跟随系统 / 浅色 / 深色（与桌面网页端一致的三选一） */
    public static final int MODE_SYSTEM = 0;
    public static final int MODE_LIGHT = 1;
    public static final int MODE_DARK = 2;

    private static int mode = MODE_SYSTEM;
    private static boolean dark = false;
    private static boolean grid = false;
    private static int sortKey = SORT_NAME;
    private static boolean sortAsc = true;
    private static boolean loaded = false;

    private ThemeUi() {}

    /**
     * 首次调用时从 SharedPreferences 读取；此后进程内缓存，setMode 会同步更新。
     * 每次调用都会按当前模式重新解析 dark（MODE_SYSTEM 时读系统 uiMode），因此系统切换深色后
     * 页面只要再次取色即可拿到新值。
     */
    private static void ensure(Context c) {
        if (!loaded) {
            if (c != null) {
                SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                mode = sp.getInt(KEY_MODE, -1);
                if (mode != MODE_SYSTEM && mode != MODE_LIGHT && mode != MODE_DARK) {
                    // 兼容旧版本的"深色模式"布尔开关；从未设置过则默认「跟随系统」
                    mode = sp.contains(KEY_DARK)
                            ? (sp.getBoolean(KEY_DARK, false) ? MODE_DARK : MODE_LIGHT)
                            : MODE_SYSTEM;
                }
                grid = sp.getBoolean(KEY_GRID, false);
                sortKey = sp.getInt(KEY_SORT, SORT_NAME);
                sortAsc = sp.getBoolean(KEY_SORT_ASC, true);
            }
            loaded = true;
        }
        if (mode == MODE_SYSTEM) dark = c == null ? dark : systemDark(c);
        else dark = (mode == MODE_DARK);
    }

    /** 系统当前是否深色（uiMode 为 API 8+，minSdk 11 安全；异常时按浅色处理） */
    public static boolean systemDark(Context c) {
        try {
            if (c == null) return false;
            int ui = c.getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return ui == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Throwable t) {
            return false;
        }
    }

    public static boolean isDark(Context c) {
        ensure(c);
        return dark;
    }

    /** 进程内当前主题（须先经过某次 isDark(Context)/setMode 初始化） */
    public static boolean isDark() {
        return dark;
    }

    /** 当前外观模式：MODE_SYSTEM / MODE_LIGHT / MODE_DARK */
    public static int mode(Context c) {
        ensure(c);
        return mode;
    }

    /** 设置外观模式（持久化到既有 prefs；模式变化后由页面 recreate() 生效） */
    public static void setMode(Context c, int m) {
        ensure(c);
        if (m != MODE_SYSTEM && m != MODE_LIGHT && m != MODE_DARK) m = MODE_LIGHT;
        mode = m;
        dark = (m == MODE_SYSTEM) ? systemDark(c) : (m == MODE_DARK);
        if (c != null) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putInt(KEY_MODE, m).putBoolean(KEY_DARK, dark).commit();
        }
    }

    /** 外观模式名称（设置项展示用） */
    public static String modeLabel(Context c) {
        switch (mode(c)) {
            case MODE_SYSTEM: return "跟随系统";
            case MODE_DARK: return "深色";
            default: return "浅色";
        }
    }

    /** 两态快捷写法：等同于 setMode(深色/浅色) */
    public static void setDark(Context c, boolean on) {
        setMode(c, on ? MODE_DARK : MODE_LIGHT);
    }

    // ---------- 状态栏（Cloudreve 观感：浅色主题浅底深色图标、深色主题深底浅色图标） ----------

    /** 状态栏跟随主题；低版本（API 21 以下）忽略，不影响功能 */
    public static void applyStatusBar(android.app.Activity a) {
        if (a == null) return;
        if (isDark(a)) {
            applyStatusBarColor(a, cBar(), false);
        } else if (android.os.Build.VERSION.SDK_INT >= 23) {
            applyStatusBarColor(a, cBar(), true);       // 白底 + 深色图标
        } else {
            applyStatusBarColor(a, cBrandDeep(), false); // API21~22 无深色图标 API，用品牌深蓝底
        }
    }

    /**
     * 指定状态栏底色与图标明暗；darkIcons 是 API 23+ 的 SYSTEM_UI_FLAG_LIGHT_STATUS_BAR，
     * 低版本自动忽略（常量按字面量写入，避免低版本运行期引用）。
     */
    public static void applyStatusBarColor(android.app.Activity a, int color, boolean darkIcons) {
        if (a == null || android.os.Build.VERSION.SDK_INT < 21) return;
        try {
            android.view.Window w = a.getWindow();
            if (w == null) return;
            w.setStatusBarColor(color);
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                android.view.View dv = w.getDecorView();
                if (dv == null) return;
                int f = dv.getSystemUiVisibility();
                if (darkIcons) f |= 0x2000;
                else f &= ~0x2000;
                dv.setSystemUiVisibility(f);
            }
        } catch (Throwable ignored) {}
    }

    // ---------- 文件页列表/网格偏好（简易持久化，与主题同一 prefs） ----------

    /** 文件页是否使用网格视图（默认列表） */
    public static boolean isGrid(Context c) {
        ensure(c);
        return grid;
    }

    public static void setGrid(Context c, boolean on) {
        ensure(c);
        if (grid == on) return;
        grid = on;
        if (c != null) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_GRID, on).commit();
        }
    }

    // ---------- 文件页排序偏好（同一 prefs 持久化） ----------

    /** 排序字段：ThemeUi.SORT_NAME / SORT_SIZE / SORT_TIME */
    public static int sortKey(Context c) {
        ensure(c);
        return sortKey;
    }

    public static void setSortKey(Context c, int key) {
        ensure(c);
        if (sortKey == key) return;
        sortKey = key;
        if (c != null) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putInt(KEY_SORT, key).commit();
        }
    }

    /** 是否升序 */
    public static boolean sortAsc(Context c) {
        ensure(c);
        return sortAsc;
    }

    public static void setSortAsc(Context c, boolean asc) {
        ensure(c);
        if (sortAsc == asc) return;
        sortAsc = asc;
        if (c != null) {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_SORT_ASC, asc).commit();
        }
    }

    /** 排序字段名（菜单显示用） */
    public static String sortLabel(Context c) {
        switch (sortKey(c)) {
            case SORT_SIZE: return "大小";
            case SORT_TIME: return "修改时间";
            default: return "名称";
        }
    }

    // ---------- 语义色（Cloudreve 色板） ----------

    /** 页面根背景 */
    public static int cPage() { return dark ? 0xFF17181C : 0xFFF5F7FA; }

    /** 卡片表面（白卡） */
    public static int cCard() { return dark ? 0xFF24262B : 0xFFFFFFFF; }

    /** 侧栏 / 顶栏 / 底栏表面（比卡片略深一档） */
    public static int cBar() { return dark ? 0xFF1E2024 : 0xFFFFFFFF; }

    /** 输入框填充 / 按压（悬停）底色 */
    public static int cFill() { return dark ? 0xFF2A2D33 : 0xFFF2F5F9; }

    /** 按压 / 悬停底色（同 cFill，语义别名） */
    public static int cHover() { return dark ? 0xFF2A2D33 : 0xFFF2F5F9; }

    /** 分割线 / 行分隔 */
    public static int cLine() { return dark ? 0xFF33363C : 0xFFE8EAED; }

    /** 正文文字 */
    public static int cText() { return dark ? 0xFFE8EAED : 0xFF25272B; }

    /** 次要文字（UID/标签等，亮度中等） */
    public static int cSub() { return dark ? 0xFFA3A9B3 : 0xFF6B7280; }

    /** 弱化文字 / 元信息（时间、大小等） */
    public static int cMute() { return dark ? 0xFF7D838D : 0xFF9AA3AF; }

    /** 品牌强调（链接/图标等浮于表面的内容） */
    public static int cBrand() { return dark ? 0xFF4C8DFF : 0xFF2B7DE9; }

    /** 品牌深一档（渐变下端 / 按压态）：浅色 = 规范 primary-hover #1F6FD0 */
    public static int cBrandDeep() { return dark ? 0xFF3B7BE0 : 0xFF1F6FD0; }

    // ---------- 文件类型色块（规范 §1：folder/image/video/doc/archive/other） ----------

    /** 文件类型：文件夹 */
    public static final int TYPE_FOLDER = 0;
    /** 文件类型：图片 */
    public static final int TYPE_IMAGE = 1;
    /** 文件类型：视频 */
    public static final int TYPE_VIDEO = 2;
    /** 文件类型：文档 */
    public static final int TYPE_DOC = 3;
    /** 文件类型：压缩包 */
    public static final int TYPE_ARCHIVE = 4;
    /** 文件类型：其它 */
    public static final int TYPE_OTHER = 5;

    /** 文件类型色块浅色源色（底）：folder #DBEAFE / image #DCFCE7 / video #EDE9FE / doc #FFEDD5 / archive #E2E8F0 / other #F1F5F9 */
    public static int typeChipBg(int type) {
        switch (type) {
            case TYPE_FOLDER: return 0xFFDBEAFE;
            case TYPE_IMAGE: return 0xFFDCFCE7;
            case TYPE_VIDEO: return 0xFFEDE9FE;
            case TYPE_DOC: return 0xFFFFEDD5;
            case TYPE_ARCHIVE: return 0xFFE2E8F0;
            default: return 0xFFF1F5F9;
        }
    }

    /** 文件类型色块浅色源色（字）：folder #1E3A5F / image #14321F / video #2A2440 / doc #3A2A17 / archive #2A2F3A / other #2A2D33 */
    public static int typeChipFg(int type) {
        switch (type) {
            case TYPE_FOLDER: return 0xFF1E3A5F;
            case TYPE_IMAGE: return 0xFF14321F;
            case TYPE_VIDEO: return 0xFF2A2440;
            case TYPE_DOC: return 0xFF3A2A17;
            case TYPE_ARCHIVE: return 0xFF2A2F3A;
            default: return 0xFF2A2D33;
        }
    }

    /** 文件类型色块：{底, 字}（浅色源色，深色由 chipBg/chipFg 自动映射） */
    public static int[] typeChip(int type) {
        return new int[]{typeChipBg(type), typeChipFg(type)};
    }

    /** 品牌浅底（选中项 / 圆钮小块底色） */
    public static int cBrandChip() { return dark ? 0xFF1E2A3F : 0xFFE8F2FE; }

    /** 危险/删除强调（文字或图标） */
    public static int cDanger() { return dark ? 0xFFF2555A : 0xFFE5484D; }

    /** 成功/在线绿 */
    public static int cOk() { return dark ? 0xFF3ECF6F : 0xFF22C55E; }

    /** 品牌主按钮渐变（上、下） */
    public static int[] brandGradient() {
        return dark ? new int[]{0xFF4C8DFF, 0xFF3B7BE0} : new int[]{0xFF3E8BF0, 0xFF2B7DE9};
    }

    /**
     * 单色值直译：浅色返回原值，深色按"近灰"映射表转成更浅的灰阶文字/分隔色。
     * 适合代码里直接以字面量写死的近黑文字、中灰、细线；强调色（品牌蓝/红/彩色）请勿走此函数。
     */
    public static int t(int light) {
        if (!dark) return light;
        switch (light) {
            case 0xFF1F2937: case 0xFF111827: case 0xFF0F172A: case 0xFF374151:
            case 0xFF25272B:
                return 0xFFE8EAED;   // 近黑正文 -> 高亮正文
            case 0xFF475569: case 0xFF4B5563: case 0xFF6B7280:
                return 0xFFA3A9B3;   // 中灰次要文字 -> 亮一档
            case 0xFF64748B:
                return 0xFF8A9099;   // 弱灰
            case 0xFF9CA3AF: case 0xFF94A3B8: case 0xFF9AA3AF:
                return 0xFF7D838D;   // 弱化文字/元信息
            case 0xFFD1D5DB:
                return 0xFF5A5F66;   // 最浅灰（关闭态等）-> 灰弱
            case 0xFFE5E7EB: case 0xFFE8EAED:
                return 0xFF33363C;   // 分割线
            case 0xFFF1F5F9: case 0xFFF2F5F9:
                return 0xFF2A2D33;   // 填充/悬停底
            case 0xFF2563EB: case 0xFF2B7DE9:
                return 0xFF4C8DFF;   // 品牌蓝
            case 0xFFDC2626: case 0xFFE5484D:
                return 0xFFF2555A;   // 危险红
            default:
                return light;
        }
    }

    /**
     * 彩色图标块的底色映射（浅色原值 → 深色同色相暗底）。
     * 深色下若保持浅色底会非常刺眼，故按色相压暗。
     */
    public static int chipBg(int light) {
        if (!dark) return light;
        switch (light) {
            case 0xFFDBEAFE: case 0xFFEFF6FF: case 0xFFE8F2FE:
                return 0xFF1E2A3F;   // 蓝（folder）
            case 0xFFDCFCE7: case 0xFFD1FAE5:
                return 0xFF15322A;   // 绿（image）
            case 0xFFEDE9FE:
                return 0xFF2A2440;   // 紫（video）
            case 0xFFFCE7F3:
                return 0xFF3A2130;   // 粉
            case 0xFFFFEDD5:
                return 0xFF3A2A17;   // 橙（doc）
            case 0xFFE2E8F0: case 0xFF2A2F3A:
                return 0xFF2A2F3A;   // 石板灰（archive）
            case 0xFFFEF3C7:
                return 0xFF3A3316;   // 琥珀
            case 0xFFCCFBF1:
                return 0xFF143230;   // 青
            case 0xFFE5E7EB: case 0xFFF1F5F9: case 0xFFF3F4F6: case 0xFFF2F5F9:
                return 0xFF2A2D33;   // 灰（other）
            default:
                return 0xFF2A2D33;
        }
    }

    /** 彩色图标块的字色映射（浅色原值 → 深色同色相亮字） */
    public static int chipFg(int light) {
        if (!dark) return light;
        switch (light) {
            case 0xFF1E40AF: case 0xFF1D4ED8: case 0xFF1E3A5F:
                return 0xFF7FB0FF;   // 蓝（folder）
            case 0xFF6D28D9: case 0xFF2A2440:
                return 0xFFB39DFF;   // 紫（video）
            case 0xFF047857: case 0xFF14321F:
                return 0xFF4ED8A0;   // 绿（image）
            case 0xFFBE185D:
                return 0xFFF58FC0;   // 粉
            case 0xFFC2410C: case 0xFF3A2A17:
                return 0xFFFFA96B;   // 橙（doc）
            case 0xFFB45309:
                return 0xFFF0C05A;   // 琥珀
            case 0xFF0F766E:
                return 0xFF4ED8C8;   // 青
            case 0xFF2A2F3A:
                return 0xFFA3A9B3;   // 石板灰（archive）
            case 0xFF4B5563: case 0xFF6B7280: case 0xFF2A2D33:
                return 0xFFA3A9B3;   // 灰（other）
            case 0xFF2563EB: case 0xFF2B7DE9:
                return 0xFF4C8DFF;   // 品牌蓝
            case 0xFFDC2626: case 0xFFE5484D:
                return 0xFFF2555A;   // 危险红
            default:
                return 0xFFA3A9B3;
        }
    }

    /** M3 波纹/按压反馈状态色：浅色黑 8%，深色白 10%；其余状态透明 */
    public static android.content.res.ColorStateList rippleState() {
        int pressed = dark ? 0x1AFFFFFF : 0x14000000;
        int focused = dark ? 0x0FFFFFFF : 0x0E000000;
        return new android.content.res.ColorStateList(
                new int[][]{
                        new int[]{android.R.attr.state_pressed},
                        new int[]{android.R.attr.state_focused},
                        new int[]{}},
                new int[]{pressed, focused, 0});
    }
}
