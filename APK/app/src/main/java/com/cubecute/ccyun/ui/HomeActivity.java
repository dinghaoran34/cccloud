package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Http;
import com.cubecute.ccyun.util.Avatars;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Transfer;
import com.cubecute.ccyun.util.Util;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.Locale;

/** 首页：123云盘式网盘风格 —— 顶部用户卡 + 渐变容量卡 + 快捷功能 + 最近文件；并支持按类型浏览全部个人文件 */
public class HomeActivity extends ThemeActivity {

    private static final int REQ_UP = 1001;
    private static final int MAX_RECENT = 8;

    // 类型浏览扩展名
    private static final String EXTS_IMG = ",jpg,jpeg,png,gif,bmp,webp,heic,heif,";
    private static final String EXTS_VIDEO = ",mp4,mkv,avi,mov,wmv,flv,webm,m4v,rm,rmvb,";
    private static final String EXTS_DOC = ",doc,docx,xls,xlsx,ppt,pptx,pdf,txt,md,csv,html,rtf,";
    private static final String EXTS_AUDIO = ",mp3,wav,flac,aac,ogg,m4a,ape,wma,amr,";

    private ScrollView sv;
    private LinearLayout content;

    private JSONObject meJson;      // /api/me
    private JSONObject listJson;    // /api/list 根目录
    private JSONArray allFiles;     // 全局个人全部文件缓存（懒加载，null 表示未拉取）
    private int mode;               // 0=首页 1=类型浏览
    private String curKind = "";    // image/video/doc/audio
    private JSONArray kindFiles = new JSONArray(); // 当前类型匹配结果

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());

        // 顶栏：右上角加号（点击查看上传/下载进度）
        root.addView(ShellUi.headerT(this, "首页"), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        content.setPadding(pp, dp(12), pp, dp(16));
        sv.addView(content, new ScrollView.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(ShellUi.bottomNav(this, ShellUi.TAB_HOME), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_HOME));
        Util.ensureStorage(this);
        load();
    }

    @Override
    public void onBackPressed() {
        if (ShellUi.closeDrawerIfOpen(this)) return;
        super.onBackPressed();
    }

    // ---------- 后台数据 ----------

    /** 允许 run() 内抛出受检异常，由 Util.async 统一捕获转 err 回调 */
    private interface Bg { void run() throws Exception; }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T {
        throw (T) t;
    }

    /** me() 与 list() 并行拉取一次，全部返回后再填充界面 */
    private void load() {
        final Dialog ld = Util.loading(this, "加载中…");
        final int[] done = {0};
        final String[] errs = {null, null};
        final Runnable check = new Runnable() {
            @Override public void run() {
                if (done[0] < 2) return;
                ld.dismiss();
                String e = errs[0] != null ? errs[0] : errs[1];
                if (e != null) Util.toast(HomeActivity.this, e);
                render();
            }
        };
        Util.async(new Runnable() {
            @Override public void run() {
                try { meJson = Api.me(); }
                catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ShellUi.setAdminFrom(meJson); done[0]++; check.run(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { errs[0] = e; done[0]++; check.run(); }
        });
        Util.async(new Runnable() {
            @Override public void run() {
                try { listJson = Api.list(null); }
                catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { done[0]++; check.run(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { errs[1] = e; done[0]++; check.run(); }
        });
    }

    /** 通用后台操作：失败仅 toast */
    private void op(final String loadingMsg, final Bg bg, final String okMsg) {
        final Dialog ld = Util.loading(this, loadingMsg);
        Util.async(new Runnable() {
            @Override public void run() {
                try { bg.run(); }
                catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); if (okMsg != null) Util.toast(HomeActivity.this, okMsg); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(HomeActivity.this, e == null ? "操作失败" : e); }
        });
    }

    /** BFS 拉取个人全部文件（根目录开始逐层扫描） */
    private JSONArray fetchAllFiles() throws Api.ApiException {
        JSONArray all = new JSONArray();
        ArrayDeque<Long> queue = new ArrayDeque<Long>();
        JSONObject root = Api.list(null);
        collectFiles(root, all);
        enqueueFolders(root, queue);
        while (!queue.isEmpty()) {
            Long fid = queue.poll();
            if (fid == null || fid <= 0) continue;
            JSONObject r = Api.list(fid);
            collectFiles(r, all);
            enqueueFolders(r, queue);
        }
        return all;
    }

    private void enqueueFolders(JSONObject r, ArrayDeque<Long> queue) {
        JSONArray fs = Util.a(r, "folders");
        if (fs == null) return;
        for (int i = 0; i < fs.length(); i++) {
            JSONObject fo = fs.optJSONObject(i);
            if (fo == null) continue;
            long id = Util.l(fo, "id");
            if (id > 0) queue.add(id);
        }
    }

    private void collectFiles(JSONObject r, JSONArray all) {
        JSONArray files = Util.a(r, "files");
        if (files == null) return;
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f == null) continue;
            JSONObject copy = new JSONObject();
            try {
                copy.put("id", Util.l(f, "id"));
                copy.put("filename", Util.s(f, "filename"));
                copy.put("file_size", Util.l(f, "file_size"));
                copy.put("uploaded_at", Util.s(f, "uploaded_at"));
            } catch (Exception ignored) {}
            all.put(copy);
        }
    }

    // ---------- 渲染 ----------

    private void render() {
        content.removeAllViews();
        if (mode == 1 && allFiles != null) renderCategory();
        else renderHome();
    }

    /** 首页渲染：用户卡 → 容量卡 → 快捷功能 → 最近文件 → 交流信息 */
    private void renderHome() {
        content.removeAllViews();
        content.addView(userCard(), Util.lpM(-1, -2, 0, dp(2), 0, 0));
        content.addView(storageCard(), Util.lpM(-1, -2, 0, dp(12), 0, 0));
        content.addView(quickCard(), Util.lpM(-1, -2, 0, dp(12), 0, 0));
        content.addView(recentCard(), Util.lpM(-1, -2, 0, dp(12), 0, 0));
        content.addView(noticeCard(), Util.lpM(-1, -2, 0, dp(12), 0, 0));
    }

    /** 交流群 / 支持信息卡片 */
    private View noticeCard() {
        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        TextView tv = Util.text(this, Util.SUPPORT_TEXT, ThemeUi.cSub(), 13, Typeface.NORMAL);
        tv.setLineSpacing(0, 1.5f);
        card.addView(tv, Util.lpM(-1, -2, 0, 0, 0, 0));
        return card;
    }

    // ----- 1) 顶部用户白卡 -----

    private View userCard() {
        String username = meJson == null ? "" : Util.s(meJson, "username");
        String nickname = meJson == null ? "" : Util.s(meJson, "nickname");
        String avatar = meJson == null ? "" : Util.s(meJson, "avatar");
        String uid = meJson == null ? "" : Util.s(meJson, "uid");
        if (username.length() == 0) username = "未登录";
        if (nickname.length() == 0) nickname = username;
        String head = username.substring(0, 1).toUpperCase(Locale.CHINA);

        LinearLayout card = whiteCard(12);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);

        // 头像：字母圆为底，上传过图片则覆盖显示
        final int avPx = dp(40);
        FrameLayout avWrap = new FrameLayout(this);
        TextView letter = new TextView(this);
        letter.setText(head);
        letter.setTextColor(0xFFFFFFFF);
        letter.setTextSize(17);
        letter.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        letter.setGravity(Gravity.CENTER);
        GradientDrawable gd = new GradientDrawable();
        gd.setShape(GradientDrawable.OVAL);
        gd.setColor(ThemeUi.cBrand());
        letter.setBackground(gd);
        avWrap.addView(letter, new FrameLayout.LayoutParams(avPx, avPx));
        ImageView avImg = new ImageView(this);
        avImg.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avWrap.addView(avImg, new FrameLayout.LayoutParams(avPx, avPx));
        card.addView(avWrap, Util.lp(avPx, avPx));
        Avatars.load(this, uid, avatar, avImg, avPx);

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        TextView t1 = Util.text(this, "你好，" + nickname, ThemeUi.cText(), 17, Typeface.BOLD);
        t1.setSingleLine(true);
        t1.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(4)));
        String sub = uid.length() > 0 ? "UID " + uid : "CC网盘";
        TextView t2 = Util.text(this, sub, ThemeUi.cMute(), 13, Typeface.NORMAL);
        t2.setSingleLine(true);
        col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(dp(12), 0, 0, 0);
        card.addView(col, cp);

        card.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { go(MeActivity.class); }
        });
        return card;
    }

    // ----- 2) 渐变容量卡 -----

    private View storageCard() {
        long used = 0, quota = 0;
        if (meJson != null) {
            used = Util.l(meJson, "used");
            quota = Util.l(meJson, "quota");
        }
        if ((used <= 0 || quota <= 0) && listJson != null) {
            JSONObject usage = listJson.optJSONObject("usage");
            if (usage != null) {
                if (used <= 0) used = Util.l(usage, "used");
                if (quota <= 0) quota = Util.l(usage, "quota");
            }
        }
        if (quota < 0) quota = 0;
        int percent = 0;
        if (quota > 0) {
            percent = (int) (used * 100 / quota);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
        }

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        int[] gcol = ThemeUi.brandGradient();
        GradientDrawable gd = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{gcol[0], gcol[1]});
        gd.setCornerRadius(dp(12));
        card.setBackground(gd);
        card.setPadding(dp(16), dp(16), dp(16), dp(14));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = Util.text(this, "存储空间", 0xFFFFFFFF, 15, Typeface.NORMAL);
        top.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView pct = Util.text(this, percent + "%", 0xFFFFFFFF, 24, Typeface.BOLD);
        top.addView(pct, Util.lp(-2, -2));
        card.addView(top, Util.lpM(-1, -2, 0, 0, 0, dp(14)));

        ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pb.setMax(100);
        pb.setProgressDrawable(buildProgress());
        pb.setProgress(percent);
        card.addView(pb, Util.lpM(-1, dp(6), 0, 0, 0, dp(10)));

        LinearLayout sub = new LinearLayout(this);
        sub.setOrientation(LinearLayout.HORIZONTAL);
        sub.setGravity(Gravity.CENTER_VERTICAL);
        String qs = quota > 0 ? Util.fmtSize(quota) : "—";
        TextView cap = Util.text(this, "已用 " + Util.fmtSize(used) + " / 共 " + qs,
                0xFFDBEAFE, 13, Typeface.NORMAL);
        cap.setSingleLine(true);
        sub.addView(cap, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView mgr = Util.text(this, "管理 ›", 0xFFFFFFFF, 13, Typeface.NORMAL);
        mgr.setSingleLine(true);
        mgr.setGravity(Gravity.CENTER_VERTICAL);
        mgr.setPadding(dp(6), dp(4), 0, dp(4));
        mgr.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { go(FilesActivity.class); }
        });
        sub.addView(mgr, Util.lp(-2, -2));
        card.addView(sub, Util.lpM(-1, -2, 0, 0, 0, 0));
        return card;
    }

    /** 白色自绘横向进度：半透明白圆角轨道 + 白色圆角进度（兼容 API14） */
    private Drawable buildProgress() {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x4DFFFFFF);
        bg.setCornerRadius(dp(3));
        GradientDrawable fg = new GradientDrawable();
        fg.setColor(0xFFFFFFFF);
        fg.setCornerRadius(dp(3));
        ClipDrawable clip = new ClipDrawable(fg, Gravity.LEFT, ClipDrawable.HORIZONTAL);
        return new LayerDrawable(new Drawable[]{bg, clip});
    }

    // ----- 3) 快捷功能网格 2行x4 -----

    private View quickCard() {
        LinearLayout card = whiteCard(12);
        card.setPadding(dp(12), dp(16), dp(12), dp(8));

        TextView title = Util.text(this, "快捷功能", ThemeUi.cText(), 17, Typeface.BOLD);
        card.addView(title, Util.lpM(-1, -2, dp(8), 0, 0, dp(4)));

        LinearLayout r1 = new LinearLayout(this);
        r1.setOrientation(LinearLayout.HORIZONTAL);
        r1.addView(quickItem("传", "上传文件", 0xFFEFF6FF, 0xFF2563EB, new View.OnClickListener() {
            @Override public void onClick(View v) { Util.pickFile(HomeActivity.this, REQ_UP); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        r1.addView(quickItem("夹", "新建文件夹", 0xFFFEF3C7, 0xFFB45309, new View.OnClickListener() {
            @Override public void onClick(View v) { askNewFolder(); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        r1.addView(quickItem("图", "图片", 0xFFDBEAFE, 0xFF1E40AF, new View.OnClickListener() {
            @Override public void onClick(View v) { showCategory("image"); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        r1.addView(quickItem("视", "视频", 0xFFEDE9FE, 0xFF6D28D9, new View.OnClickListener() {
            @Override public void onClick(View v) { showCategory("video"); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        card.addView(r1, Util.lpM(-1, -2, 0, 0, 0, 0));

        LinearLayout r2 = new LinearLayout(this);
        r2.setOrientation(LinearLayout.HORIZONTAL);
        r2.addView(quickItem("文", "文档", 0xFFD1FAE5, 0xFF047857, new View.OnClickListener() {
            @Override public void onClick(View v) { showCategory("doc"); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        r2.addView(quickItem("乐", "音乐", 0xFFFCE7F3, 0xFFBE185D, new View.OnClickListener() {
            @Override public void onClick(View v) { showCategory("audio"); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        r2.addView(quickItem("团", "我的团队", 0xFFFFEDD5, 0xFFC2410C, new View.OnClickListener() {
            @Override public void onClick(View v) { go(TeamsActivity.class); }
        }), new LinearLayout.LayoutParams(0, -2, 1f));
        // 占位格：保持与首行一致的 4 等分列宽（第二行仅 3 项）
        r2.addView(new View(this), new LinearLayout.LayoutParams(0, -2, 1f));
        card.addView(r2, Util.lpM(-1, -2, 0, 0, 0, 0));

        return card;
    }

    /** 单个快捷项：44dp 圆形浅底 + 汉字 + 下方标签 */
    private LinearLayout quickItem(final String tag, String label, int bg, int fg, View.OnClickListener l) {
        LinearLayout it = new LinearLayout(this);
        it.setOrientation(LinearLayout.VERTICAL);
        it.setGravity(Gravity.CENTER_HORIZONTAL);
        it.setPadding(0, dp(8), 0, dp(10));

        TextView ic = new TextView(this);
        ic.setText(tag);
        ic.setTextColor(ThemeUi.chipFg(fg));
        ic.setTextSize(15);
        ic.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        ic.setGravity(Gravity.CENTER);
        GradientDrawable gd = new GradientDrawable();
        gd.setShape(GradientDrawable.OVAL);
        gd.setColor(ThemeUi.chipBg(bg));
        ic.setBackground(gd);
        it.addView(ic, Util.lp(dp(44), dp(44)));

        TextView lb = Util.text(this, label, ThemeUi.cSub(), 11, Typeface.NORMAL);
        lb.setGravity(Gravity.CENTER);
        lb.setSingleLine(true);
        it.addView(lb, Util.lpM(-1, -2, 0, dp(6), 0, 0));

        it.setOnClickListener(l);
        return it;
    }

    // ----- 4) 最近文件 -----

    private View recentCard() {
        LinearLayout card = whiteCard(12);
        card.setPadding(dp(16), dp(8), dp(16), dp(12));

        TextView title = Util.text(this, "最近文件", ThemeUi.cText(), 17, Typeface.BOLD);
        card.addView(title, Util.lpM(-1, -2, 0, dp(12), 0, dp(4)));

        JSONArray files = listJson == null ? null : listJson.optJSONArray("files");
        int total = files == null ? 0 : files.length();
        if (total == 0) {
            TextView empty = Util.text(this, Util.MSG_EMPTY, ThemeUi.cMute(), 13, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(26), 0, dp(22));
            card.addView(empty, Util.lpM(-1, -2, 0, 0, 0, 0));
        } else {
            int shown = Math.min(total, MAX_RECENT);
            for (int i = 0; i < shown; i++) {
                final JSONObject f = files.optJSONObject(i);
                if (f == null) continue;
                LinearLayout box = (LinearLayout) fileRow(f, ThemeUi.cLine(), i < shown - 1);
                box.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { showFileMenu(f); }
                });
                card.addView(box, Util.lpM(-1, -2, 0, 0, 0, 0));
            }
            if (total > shown) {
                TextView more = Util.text(this, "查看全部 ›", ThemeUi.cSub(), 13, Typeface.NORMAL);
                more.setGravity(Gravity.RIGHT);
                more.setPadding(0, dp(8), 0, dp(4));
                more.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { go(FilesActivity.class); }
                });
                card.addView(more, Util.lpM(-1, -2, 0, 0, 0, 0));
            }
        }
        return card;
    }

    /** 文件行：38dp 圆角扩展名方块 + 文件名 + 大小·时间（可带分隔线） */
    private View fileRow(JSONObject f, int lineColor, boolean withLine) {
        String name = f == null ? "" : Util.s(f, "filename");
        if (name.length() == 0) name = "未命名文件";

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        int[] cs = extColors(name);
        TextView ic = iconBox(extTag(name), cs[0], cs[1]);
        row.addView(ic, Util.lp(dp(38), dp(38)));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView t1 = Util.text(this, name, ThemeUi.cText(), 15, Typeface.NORMAL);
        t1.setSingleLine(true);
        t1.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(2)));
        String size = Util.fmtSize(f == null ? 0 : Util.l(f, "file_size"));
        String when = Util.fmtDbTime(f == null ? "" : Util.s(f, "uploaded_at"));
        TextView t2 = Util.text(this, size + " · " + when, ThemeUi.cMute(), 12, Typeface.NORMAL);
        t2.setSingleLine(true);
        t2.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(dp(10), 0, 0, 0);
        row.addView(col, cp);

        box.addView(row, Util.lpM(-1, dp(56), 0, 0, 0, 0));
        if (withLine) {
            View dv = new View(this);
            dv.setBackgroundColor(lineColor);
            box.addView(dv, Util.lpM(-1, 1, 0, 0, 0, 0));
        }
        return box;
    }

    // ----- 类型浏览 -----

    private void showCategory(final String kind) {
        if (allFiles == null) {
            mode = 1;
            curKind = kind;
            final Dialog ld = Util.loading(this, "扫描全部文件…");
            Util.async(new Runnable() {
                @Override public void run() {
                    try { allFiles = fetchAllFiles(); }
                    catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
                }
            }, new Util.Cb() {
                @Override public void run() {
                    ld.dismiss();
                    renderCategory();
                    sv.smoothScrollTo(0, 0);
                }
            }, new Util.ErrCb() {
                @Override public void run(String e) {
                    ld.dismiss();
                    mode = 0;
                    Util.toast(HomeActivity.this, e);
                    renderHome();
                }
            });
            return;
        }
        mode = 1;
        curKind = kind;
        renderCategory();
        sv.smoothScrollTo(0, 0);
    }

    /** 类型浏览：顶行[返回+标题+数量] + FitListView 或空态 */
    private void renderCategory() {
        content.removeAllViews();
        if (allFiles == null) return;
        kindFiles = matchKind(curKind);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView back = Util.text(this, "‹ 返回", ThemeUi.cBrand(), 15, Typeface.NORMAL);
        back.setGravity(Gravity.CENTER);
        back.setPadding(0, dp(10), dp(14), dp(10));
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                mode = 0;
                renderHome();
                sv.smoothScrollTo(0, 0);
            }
        });
        bar.addView(back, Util.lp(-2, -2));
        String label = kindLabel(curKind);
        TextView title = Util.text(this, label + "文件", ThemeUi.cText(), 17, Typeface.BOLD);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        bar.addView(title, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView count = Util.text(this, "共 " + kindFiles.length() + " 个", ThemeUi.cMute(), 13, Typeface.NORMAL);
        count.setGravity(Gravity.CENTER_VERTICAL);
        bar.addView(count, Util.lp(-2, -2));
        content.addView(bar, Util.lpM(-1, -2, dp(2), 0, dp(2), dp(8)));

        if (kindFiles.length() == 0) {
            TextView empty = Util.text(this, Util.MSG_EMPTY, ThemeUi.cMute(), 13, Typeface.NORMAL);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(0, dp(40), 0, dp(40));
            content.addView(empty, Util.lpM(-1, -2, 0, 0, 0, 0));
            return;
        }

        LinearLayout body = whiteCard(12);
        body.setPadding(dp(8), dp(4), dp(8), dp(4));
        FitListView lv = new FitListView(this);
        lv.setAdapter(new KindAdapter());
        lv.setDivider(null);
        lv.setDividerHeight(0);
        lv.setVerticalScrollBarEnabled(false);
        lv.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override public void onItemClick(AdapterView<?> p, View v, int pos, long id) {
                showFileMenu(kindFiles.optJSONObject(pos));
            }
        });
        body.addView(lv, Util.lpM(-1, -2, 0, 0, 0, 0));
        content.addView(body, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    private JSONArray matchKind(String kind) {
        JSONArray out = new JSONArray();
        if (allFiles == null) return out;
        for (int i = 0; i < allFiles.length(); i++) {
            JSONObject f = allFiles.optJSONObject(i);
            if (f == null) continue;
            if (kindMatch(kind, Util.s(f, "filename"))) out.put(f);
        }
        return out;
    }

    private boolean kindMatch(String kind, String name) {
        String ext = extOf(name);
        if (ext.length() == 0) return false;
        if ("image".equals(kind)) return inExt(EXTS_IMG, ext);
        if ("video".equals(kind)) return inExt(EXTS_VIDEO, ext);
        if ("doc".equals(kind)) return inExt(EXTS_DOC, ext);
        if ("audio".equals(kind)) return inExt(EXTS_AUDIO, ext);
        return false;
    }

    private String kindLabel(String kind) {
        if ("image".equals(kind)) return "图片";
        if ("video".equals(kind)) return "视频";
        if ("doc".equals(kind)) return "文档";
        if ("audio".equals(kind)) return "音乐";
        return "";
    }

    // ----- 文件行公共样式（照抄 FilesActivity 规则简化） -----

    private String extOf(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "";
        return name.substring(dot + 1).toLowerCase(Locale.CHINA);
    }

    private boolean inExt(String list, String ext) {
        return ext.length() > 0 && list.indexOf("," + ext + ",") >= 0;
    }

    private String extTag(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "文";
        String ext = name.substring(dot + 1).toUpperCase(Locale.CHINA);
        if (ext.length() == 0) return "文";
        return ext.length() > 3 ? ext.substring(0, 3) : ext;
    }

    private int[] extColors(String name) {
        String ext = extOf(name);
        if (inExt(EXTS_IMG, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_IMAGE);
        if (inExt(EXTS_VIDEO, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_VIDEO);
        if (inExt(EXTS_DOC, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_DOC);
        if (inExt(EXTS_AUDIO, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_OTHER);
        String zip = ",zip,rar,7z,tar,gz,bz2,xz,iso,";
        if (inExt(zip, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_ARCHIVE);
        return ThemeUi.typeChip(ThemeUi.TYPE_OTHER);
    }

    private TextView iconBox(String tag, int bg, int fg) {
        TextView t = new TextView(this);
        t.setText(tag);
        t.setTextColor(ThemeUi.chipFg(fg));
        t.setTextSize(13);
        t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        t.setGravity(Gravity.CENTER);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.chipBg(bg));
        gd.setCornerRadius(dp(8));
        t.setBackground(gd);
        return t;
    }

    // ---------- 文件操作 ----------

    private void showFileMenu(final JSONObject f) {
        if (f == null) return;
        final String fn = Util.s(f, "filename");
        final String title = fn.length() == 0 ? "未命名文件" : fn;
        // M3 菜单：预览/下载
        Util.menu(this, title, new String[]{"预览", "下载"}, -1, false, new Util.MenuCb() {
            @Override public void run(int which) {
                if (which == 0) doPreview(f);
                else doDownload(f);
            }
        });
    }

    private void doPreview(final JSONObject f) {
        final Dialog ld = Util.loading(this, "获取预览…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.preview(Util.l(f, "id"));
                    url[0] = r == null ? "" : r.optString("url", "");
                } catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(HomeActivity.this, "该文件暂不支持预览");
                else Util.openUrl(HomeActivity.this, url[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(HomeActivity.this, e); }
        });
    }

    private void doDownload(final JSONObject f) {
        final long id = Util.l(f, "id");
        final String fn = Util.s(f, "filename");
        if (android.os.Build.VERSION.SDK_INT < 23) {
            Util.download(this, Api.downloadProxyUrl(id), fn);
            return;
        }
        final Dialog ld = Util.loading(this, "获取下载地址…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.downloadPresign(Util.l(f, "id"));
                    url[0] = r == null ? "" : r.optString("downloadUrl", "");
                } catch (Exception e) { HomeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(HomeActivity.this, "获取下载地址失败");
                else Util.download(HomeActivity.this, url[0], fn.length() == 0 ? "file" : fn);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(HomeActivity.this, e); }
        });
    }

    // ---------- 新建文件夹（根目录） ----------

    private void askNewFolder() {
        Util.input(this, "新建文件夹", "请输入文件夹名称", "", new Util.InputCb() {
            @Override public void run(String name) {
                if (name.length() == 0) { Util.toast(HomeActivity.this, "请输入文件夹名称"); return; }
                op("创建中…", new Bg() {
                    @Override public void run() throws Exception { Api.folderCreate(name, null); }
                }, "已创建");
            }
        });
    }

    // ---------- 上传（个人根目录） ----------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_UP && resultCode == RESULT_OK && data != null && data.getData() != null) {
            startUpload(data.getData());
        }
    }

    private void startUpload(final Uri uri) {
        final int[] tId = {0};
        Util.async(new Runnable() {
            @Override public void run() {
                File tmp = null;
                try {
                    final String name = queryName(uri);
                    String mime0 = getContentResolver().getType(uri);
                    final String mime = (mime0 == null || mime0.length() == 0)
                            ? "application/octet-stream" : mime0;

                    tmp = new File(getCacheDir(), "up_" + System.currentTimeMillis());
                    copyTo(uri, tmp);
                    final long len = tmp.length();
                    if (len <= 0) throw new Api.ApiException("文件为空或无法读取");
                    tId[0] = Transfer.add(true, name, len); // 非阻塞：右上角 ⇅ 角标

                    JSONObject pre = Api.presignUpload(name, false, null, null, mime, len);
                    String url = pre == null ? "" : pre.optString("uploadUrl", "");
                    String stored = pre == null ? "" : pre.optString("storedName", "");
                    if (url.length() == 0 || stored.length() == 0)
                        throw new Api.ApiException("服务器返回异常，请重试");

                    FileInputStream fin = new FileInputStream(tmp);
                    int code;
                    try {
                        code = Http.putBinary(url, mime, fin, len, new Http.Progress() {
                            @Override public void onProgress(long done, long total) {
                                Transfer.progress(tId[0], done);
                            }
                        });
                    } finally {
                        try { fin.close(); } catch (Exception ignored) {}
                    }
                    if (code < 200 || code >= 300) {
                        // 老版本安卓直连对象存储常因 TLS/SNI 兼容失败：回退服务端中转上传（带进度）
                        Transfer.note(tId[0], "改用服务端中转上传…");
                        try {
                            FileInputStream rf = new FileInputStream(tmp);
                            try {
                                Api.relayUpload(rf, name, null, len, Transfer.httpProgress(tId[0]));
                            } finally { rf.close(); }
                        } catch (Exception re) {
                            // 中转也失败时再试服务端分片通道
                            Transfer.note(tId[0], "改用服务端分片上传…");
                            Api.uploadChunked(tmp, name, false, null, Transfer.upProgress(tId[0]));
                        }
                        Transfer.finish(tId[0], true, null);
                        return;
                    }
                    Api.confirmUpload(stored, name, len, false, null, null);
                    Transfer.finish(tId[0], true, null);
                } catch (Exception e) {
                    if (tId[0] != 0) Transfer.finish(tId[0], false, e.getMessage());
                    HomeActivity.<RuntimeException>sneaky(e);
                } finally {
                    if (tmp != null) tmp.delete();
                }
            }
        }, new Util.Cb() {
            @Override public void run() {
                Util.toast(HomeActivity.this, Util.MSG_UPLOAD_OK);
                allFiles = null; // 新文件上传后失效全部文件缓存
                load();
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { Util.toast(HomeActivity.this, e); }
        });
    }

    private void copyTo(Uri uri, File dst) throws Exception {
        InputStream in = null;
        FileOutputStream fo = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) throw new Api.ApiException("无法读取所选文件");
            fo = new FileOutputStream(dst);
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) fo.write(buf, 0, n);
        } finally {
            if (in != null) { try { in.close(); } catch (Exception ignored) {} }
            if (fo != null) { try { fo.close(); } catch (Exception ignored) {} }
        }
    }

    private String queryName(Uri uri) {
        String name = null;
        Cursor cur = null;
        try {
            cur = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (cur != null && cur.moveToFirst()) {
                int idx = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) name = cur.getString(idx);
            }
        } catch (Exception ignored) {
        } finally {
            if (cur != null) { try { cur.close(); } catch (Exception ignored) {} }
        }
        if (name == null || name.length() == 0) {
            String p = uri.getLastPathSegment();
            name = (p == null || p.length() == 0) ? "file" : p;
        }
        return name;
    }

    // ---------- 跳转 ----------

    private void go(Class<?> cls) {
        Intent i = new Intent(HomeActivity.this, cls);
        i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(i);
    }

    // ---------- 通用样式 ----------

    /** 白色圆角卡（规范：12dp 圆角 + 1px 描边） */
    private LinearLayout whiteCard(float radiusDp) {
        LinearLayout c = ShellUi.card(this, radiusDp);
        return c;
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    // ---------- 列表 ----------

    /** 使 ListView 在 ScrollView 内按内容完整展开（数据量小，随整页滚动） */
    private static class FitListView extends ListView {
        public FitListView(Context c) { super(c); }

        @Override
        protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
            if (getAdapter() == null || getAdapter().getCount() == 0) {
                super.onMeasure(widthMeasureSpec, heightMeasureSpec);
                return;
            }
            int heightSpec = View.MeasureSpec.makeMeasureSpec(
                    Integer.MAX_VALUE >> 2, View.MeasureSpec.AT_MOST);
            super.onMeasure(widthMeasureSpec, heightSpec);
            if (getLayoutParams() != null) getLayoutParams().height = getMeasuredHeight();
        }
    }

    private class KindAdapter extends BaseAdapter {
        @Override public int getCount() { return kindFiles.length(); }
        @Override public Object getItem(int p) { return kindFiles.opt(p); }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            JSONObject f = kindFiles.optJSONObject(position);
            return fileRow(f, ThemeUi.cLine(), position < getCount() - 1);
        }
    }
}
