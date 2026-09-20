package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.Typeface;
import android.graphics.drawable.ClipDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Constants;
import com.cubecute.ccyun.net.Http;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Avatars;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.Util;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/** 我的页：账户信息、存储容量、设置菜单（底部导航 active=我的） */
public class MeActivity extends ThemeActivity {

    private LinearLayout content;
    private JSONObject meJson;
    private JSONObject listJson;
    private int menuRows;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(ShellUi.headerT(this, "我的"), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        content.setPadding(pp, dp(12), pp, dp(16));
        sv.addView(content, new ScrollView.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(ShellUi.bottomNav(this, ShellUi.TAB_ME), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_ME));
        load();
    }

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
                if (e != null) Util.toast(MeActivity.this, e);
                render();
            }
        };
        Util.async(new Runnable() {
            @Override public void run() {
                try { meJson = Api.me(); }
                catch (Exception e) { MeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ShellUi.setAdminFrom(meJson); done[0]++; check.run(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { errs[0] = e; done[0]++; check.run(); }
        });
        Util.async(new Runnable() {
            @Override public void run() {
                try { listJson = Api.list(null); }
                catch (Exception e) { MeActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { done[0]++; check.run(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { errs[1] = e; done[0]++; check.run(); }
        });
    }

    // ---------- 渲染 ----------

    private void render() {
        content.removeAllViews();
        renderAccountCard();
        renderStorageCard();
        renderMenuCard();
        renderNoticeCard();
    }

    /** 交流群 / 支持信息卡片 */
    private void renderNoticeCard() {
        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        TextView tv = Util.text(this, Util.SUPPORT_TEXT, ThemeUi.cSub(), 13, Typeface.NORMAL);
        tv.setLineSpacing(0, 1.5f);
        card.addView(tv, Util.lpM(-1, -2, 0, 0, 0, 0));
        content.addView(card, Util.lpM(-1, -2, 0, dp(12), 0, 0));
    }

    private void renderAccountCard() {
        String username = meJson == null ? "" : Util.s(meJson, "username");
        String uid = meJson == null ? "" : Util.s(meJson, "uid");
        String nickname = meJson == null ? "" : Util.s(meJson, "nickname");
        String avatar = meJson == null ? "" : Util.s(meJson, "avatar");
        if (nickname.length() == 0) nickname = username;
        if (username.length() == 0) username = "未登录";

        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout topRow = new LinearLayout(this);
        topRow.setOrientation(LinearLayout.HORIZONTAL);
        topRow.setGravity(Gravity.CENTER_VERTICAL);

        // 头像（字母占位 + 图片覆盖）
        final int avSize = dp(64);
        FrameLayout avWrap = new FrameLayout(this);
        TextView letter = new TextView(this);
        letter.setText(username.length() > 0 ? username.substring(0, 1).toUpperCase() : "云");
        letter.setTextColor(0xFFFFFFFF);
        letter.setTextSize(24);
        letter.setGravity(Gravity.CENTER);
        GradientDrawable lg = new GradientDrawable();
        lg.setColor(ThemeUi.cBrand());
        lg.setCornerRadius(avSize / 2f);
        letter.setBackground(lg);
        avWrap.addView(letter, new FrameLayout.LayoutParams(avSize, avSize));
        final ImageView av = new ImageView(this);
        av.setScaleType(ImageView.ScaleType.CENTER_CROP);
        avWrap.addView(av, new FrameLayout.LayoutParams(avSize, avSize));
        topRow.addView(avWrap, Util.lp(avSize, avSize));
        Avatars.load(this, uid, avatar, av, avSize);

        // 昵称 / 登录名 / 操作列
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        TextView nm = Util.text(this, nickname, ThemeUi.cText(), 20, Typeface.BOLD);
        nm.setSingleLine(true);
        nm.setEllipsize(android.text.TextUtils.TruncateAt.END);
        col.addView(nm, Util.lpM(-1, -2, 0, 0, 0, 0));
        TextView sub = Util.text(this, "@" + username + " · UID " + uid, ThemeUi.cSub(), 13, Typeface.NORMAL);
        sub.setSingleLine(true);
        sub.setEllipsize(android.text.TextUtils.TruncateAt.END);
        col.addView(sub, Util.lpM(-1, -2, 0, dp(3), 0, 0));

        LinearLayout ops = new LinearLayout(this);
        ops.setOrientation(LinearLayout.HORIZONTAL);
        Button nb = chip("改昵称", ThemeUi.cBrand());
        nb.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String cur = meJson == null ? "" : Util.s(meJson, "nickname");
                if (cur.length() == 0) cur = Util.s(meJson, "username");
                editNickname(cur);
            }
        });
        Button ab = chip("换头像", ThemeUi.cBrand());
        ab.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Util.pickFile(MeActivity.this, REQ_AVATAR); }
        });
        ops.addView(nb, Util.lp(-2, dp(44)));
        ops.addView(ab, Util.lpM(-2, dp(44), dp(8), 0, 0, 0));
        col.addView(ops, Util.lpM(-1, -2, 0, dp(8), 0, 0));
        topRow.addView(col, new LinearLayout.LayoutParams(0, -2, 1f));

        card.addView(topRow, Util.lpM(-1, -2, 0, 0, 0, 0));
        content.addView(card, Util.lpM(-1, -2, 0, dp(4), 0, 0));
    }

    // ---------- 头像 / 昵称 ----------
    private static final int REQ_AVATAR = 7001;

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_AVATAR && resultCode == RESULT_OK && data != null && data.getData() != null) {
            uploadAvatar(data.getData());
        }
    }

    private void uploadAvatar(final Uri uri) {
        final Dialog ld = Util.loading(this, "上传头像…");
        Util.async(new Runnable() {
            @Override public void run() {
                File tmp = null;
                try {
                    String name = queryDisplayName(uri);
                    if (name == null || name.length() == 0) name = "avatar";
                    tmp = new File(getCacheDir(), "av_" + System.currentTimeMillis());
                    copyToFile(uri, tmp);
                    FileInputStream fin = new FileInputStream(tmp);
                    try { Api.uploadAvatar(fin, name); } finally { fin.close(); }
                    meJson = Api.me();
                } catch (Exception e) {
                    MeActivity.<RuntimeException>sneaky(e);
                } finally {
                    if (tmp != null) tmp.delete();
                }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                render();
                Util.toast(MeActivity.this, "头像已更新");
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(MeActivity.this, e == null ? "上传失败" : e); }
        });
    }

    private void editNickname(final String cur) {
        Util.input(this, "修改昵称", "新昵称（≤20字）", cur, new Util.InputCb() {
            @Override public void run(final String v) {
                if (v == null || v.length() == 0) { Util.toast(MeActivity.this, "昵称不能为空"); return; }
                final Dialog ld = Util.loading(MeActivity.this, "保存中…");
                Util.async(new Runnable() {
                    @Override public void run() {
                        try {
                            Api.updateNickname(v);
                            meJson = Api.me();
                        } catch (Exception e) {
                            MeActivity.<RuntimeException>sneaky(e);
                        }
                    }
                }, new Util.Cb() {
                    @Override public void run() { ld.dismiss(); render(); Util.toast(MeActivity.this, "昵称已更新"); }
                }, new Util.ErrCb() {
                    @Override public void run(String e) { ld.dismiss(); Util.toast(MeActivity.this, e == null ? "保存失败" : e); }
                });
            }
        });
    }

    private String queryDisplayName(Uri uri) {
        try {
            Cursor c = getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                try {
                    if (c.moveToFirst()) {
                        int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (idx >= 0) return c.getString(idx);
                    }
                } finally { c.close(); }
            }
        } catch (Throwable ignored) {}
        return uri.getLastPathSegment();
    }

    private void copyToFile(Uri uri, File dst) throws Exception {
        InputStream in = null;
        FileOutputStream fo = null;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) throw new Api.ApiException("无法读取所选图片");
            fo = new FileOutputStream(dst);
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) fo.write(buf, 0, n);
        } finally {
            if (in != null) { try { in.close(); } catch (Exception ignored) {} }
            if (fo != null) { try { fo.close(); } catch (Exception ignored) {} }
        }
    }

    private void renderStorageCard() {
        long used = 0, quota = 0;
        if (meJson != null) {
            used = Util.l(meJson, "used");
            quota = Util.l(meJson, "quota");
        }
        if (used <= 0 && listJson != null) used = Util.l(listJson, "usage");
        if (quota < 0) quota = 0;
        int percent = 0;
        if (quota > 0) {
            percent = (int) (used * 100 / quota);
            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
        }

        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        TextView t1 = Util.text(this, "存储空间", ThemeUi.cText(), 15, Typeface.BOLD);
        top.addView(t1, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView pct = Util.text(this, percent + "%", ThemeUi.cBrand(), 13, Typeface.BOLD);
        top.addView(pct, Util.lp(-2, -2));
        card.addView(top, Util.lpM(-1, -2, 0, 0, 0, dp(12)));

        ProgressBar pb = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        pb.setMax(100);
        pb.setProgressDrawable(themedProgress());
        pb.setProgress(percent);
        card.addView(pb, Util.lpM(-1, dp(6), 0, 0, 0, dp(8)));

        String qs = quota > 0 ? Util.fmtSize(quota) : "—";
        TextView cap = Util.text(this, "已用 " + Util.fmtSize(used) + " / 共 " + qs,
                ThemeUi.cMute(), 13, Typeface.NORMAL);
        card.addView(cap, Util.lpM(-1, -2, 0, 0, 0, 0));

        content.addView(card, Util.lpM(-1, -2, 0, dp(12), 0, 0));
    }

    private void renderMenuCard() {
        menuRows = 0;
        LinearLayout card = ShellUi.card(this);
        card.setOrientation(LinearLayout.VERTICAL);

        addMenuRow(card, "修改密码", android.R.drawable.ic_lock_idle_lock, ThemeUi.cText(), false, new View.OnClickListener() {
            @Override public void onClick(View v) { changePassword(); }
        });
        addMenuRow(card, "用户协议", android.R.drawable.ic_menu_edit, ThemeUi.cText(), false, new View.OnClickListener() {
            @Override public void onClick(View v) {
                Util.openUrl(MeActivity.this, Constants.BASE_URL + "/agreement");
            }
        });
        addMenuValueRow(card, "外观", android.R.drawable.ic_menu_view, ThemeUi.modeLabel(this),
                new View.OnClickListener() {
                    @Override public void onClick(View v) { chooseAppearance(); }
                });
        addMenuRow(card, "关于", android.R.drawable.ic_menu_info_details, ThemeUi.cText(), false, new View.OnClickListener() {
            @Override public void onClick(View v) {
                Util.confirm(MeActivity.this, "关于",
                        "CC网盘 " + ShellUi.VERSION + "\n原生安卓客户端（全链路HTTPS）\nCloudreve 风格界面 · 外观可跟随系统/浅色/深色\n\n" + Util.SUPPORT_TEXT, null);
            }
        });
        addMenuRow(card, "注销账户", android.R.drawable.ic_menu_delete, ThemeUi.cDanger(), true, new View.OnClickListener() {
            @Override public void onClick(View v) { deleteAccount(); }
        });
        addMenuRow(card, "退出登录", android.R.drawable.ic_menu_close_clear_cancel, ThemeUi.cDanger(), true, new View.OnClickListener() {
            @Override public void onClick(View v) { logout(); }
        });

        content.addView(card, Util.lpM(-1, -2, 0, dp(12), 0, 0));
    }

    /** 菜单行：左侧图标+标题，右侧 ">"；danger=true 时标题红色 */
    private void addMenuRow(LinearLayout card, String title, int icon, int color, boolean danger,
                            View.OnClickListener l) {
        if (menuRows > 0) {
            View dv = new View(this);
            dv.setBackgroundColor(ThemeUi.cLine());
            card.addView(dv, Util.lpM(-1, 1, dp(16), 0, dp(16), 0));
        }
        menuRows++;

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), 0, dp(16), 0);

        TextView t = Util.text(this, title, color, 15, Typeface.NORMAL);
        t.setCompoundDrawablesWithIntrinsicBounds(tintIcon(icon, color), null, null, null);
        t.setCompoundDrawablePadding(dp(12));
        t.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(t, new LinearLayout.LayoutParams(0, dp(56), 1f));

        TextView chev = Util.text(this, ">", ThemeUi.cMute(), 15, Typeface.NORMAL);
        chev.setGravity(Gravity.CENTER);
        row.addView(chev, Util.lp(-2, -2));

        row.setOnClickListener(l);
        card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    /** 深色模式开关菜单行：左侧图标+文案，右侧放 Switch；先 setChecked 再挂监听，避免初始触发切换 */
    private void addMenuSwitchRow(LinearLayout card, String title, int icon, boolean checked,
                                  android.widget.CompoundButton.OnCheckedChangeListener l) {
        if (menuRows > 0) {
            View dv = new View(this);
            dv.setBackgroundColor(ThemeUi.cLine());
            card.addView(dv, Util.lpM(-1, 1, dp(16), 0, dp(16), 0));
        }
        menuRows++;

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), 0, dp(16), 0);

        TextView t = Util.text(this, title, ThemeUi.cText(), 15, Typeface.NORMAL);
        t.setCompoundDrawablesWithIntrinsicBounds(tintIcon(icon, ThemeUi.cSub()), null, null, null);
        t.setCompoundDrawablePadding(dp(12));
        t.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(t, new LinearLayout.LayoutParams(0, dp(56), 1f));

        // Switch 需要 API 14+；低版本（API 11~13）用 ToggleButton 兼容，保证不崩溃
        android.widget.CompoundButton sw;
        if (android.os.Build.VERSION.SDK_INT >= 14) {
            sw = new android.widget.Switch(this);
        } else {
            sw = new android.widget.ToggleButton(this);
        }
        sw.setChecked(checked);
        sw.setOnCheckedChangeListener(l);
        row.addView(sw, Util.lp(-2, -2));

        card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    /** 菜单行（右侧显示当前设置值 + ">"），用于「外观」等需要回显当前选择的项 */
    private void addMenuValueRow(LinearLayout card, String title, int icon, String value,
                                 View.OnClickListener l) {
        if (menuRows > 0) {
            View dv = new View(this);
            dv.setBackgroundColor(ThemeUi.cLine());
            card.addView(dv, Util.lpM(-1, 1, dp(16), 0, dp(16), 0));
        }
        menuRows++;

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), 0, dp(16), 0);

        TextView t = Util.text(this, title, ThemeUi.cText(), 15, Typeface.NORMAL);
        t.setCompoundDrawablesWithIntrinsicBounds(tintIcon(icon, ThemeUi.cSub()), null, null, null);
        t.setCompoundDrawablePadding(dp(12));
        t.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(t, new LinearLayout.LayoutParams(0, dp(56), 1f));

        TextView val = Util.text(this, value == null ? "" : value, ThemeUi.cSub(), 13, Typeface.NORMAL);
        val.setSingleLine(true);
        val.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(val, Util.lpM(-2, -2, 0, 0, dp(6), 0));

        TextView chev = Util.text(this, ">", ThemeUi.cMute(), 15, Typeface.NORMAL);
        chev.setGravity(Gravity.CENTER);
        row.addView(chev, Util.lp(-2, -2));

        row.setOnClickListener(l);
        card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    /**
     * 外观三选一（跟随系统 / 浅色 / 深色），与桌面网页端一致：
     * 用统一的自绘菜单弹窗选择，模式写入既有 prefs 后 recreate() 立即生效。
     */
    private void chooseAppearance() {
        final int cur = ThemeUi.mode(this);
        Util.menu(this, "外观", new String[]{"跟随系统", "浅色", "深色"}, -1, true, new Util.MenuCb() {
            @Override public void run(int which) {
                int m = which == 0 ? ThemeUi.MODE_SYSTEM
                        : (which == 1 ? ThemeUi.MODE_LIGHT : ThemeUi.MODE_DARK);
                if (m == cur) return;
                ThemeUi.setMode(MeActivity.this, m);
                recreate();
            }
        });
    }

    /** 系统内置图标按当前主题色着色（Holo 位图为深灰，深色主题下直接用会看不清） */
    private Drawable tintIcon(int resId, int color) {
        try {
            Drawable d = getResources().getDrawable(resId);
            if (d == null) return null;
            d.mutate();
            d.setColorFilter(color, PorterDuff.Mode.SRC_ATOP);
            return d;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 主题化横向进度条：cFill 圆角轨道 + cBrand 圆角进度（替代 Holo 默认浅灰轨道） */
    private Drawable themedProgress() {
        GradientDrawable track = new GradientDrawable();
        track.setColor(ThemeUi.cFill());
        track.setCornerRadius(dp(3));
        GradientDrawable fill = new GradientDrawable();
        fill.setColor(ThemeUi.cBrand());
        fill.setCornerRadius(dp(3));
        ClipDrawable clip = new ClipDrawable(fill, Gravity.LEFT, ClipDrawable.HORIZONTAL);
        return new LayerDrawable(new Drawable[]{track, clip});
    }

    private Button chip(String s, int bgColor) {
        Button b = new Button(this);
        b.setText(s);
        Util.noCaps(b);
        b.setTextColor(Color.WHITE);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setMinHeight(dp(44));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(bgColor);
        gd.setCornerRadius(dp(6));
        b.setBackground(gd);
        return b;
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
    // ---------- 修改密码 ----------

    private void changePassword() {
        askSecret("修改密码", "请输入原密码", new Util.InputCb() {
            @Override public void run(String oldP) {
                if (oldP.length() == 0) { Util.toast(MeActivity.this, "请输入原密码"); return; }
                askSecret("修改密码", "请输入新密码", new Util.InputCb() {
                    @Override public void run(String newP) {
                        if (newP.length() == 0) { Util.toast(MeActivity.this, "请输入新密码"); return; }
                        askSecret("修改密码", "请再次输入新密码", new Util.InputCb() {
                            @Override public void run(String confirm) {
                                if (!confirm.equals(newP)) { Util.toast(MeActivity.this, "两次输入的新密码不一致"); return; }
                                submitPassword(oldP, newP, confirm);
                            }
                        });
                    }
                });
            }
        });
    }

    /** 密码输入弹窗（掩码） */
    private void askSecret(String title, final String hint, final Util.InputCb cb) {
        final EditText et = Util.field(this, hint, false);
        et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        et.setMinHeight(dp(52));
        // M3 自定义弹窗：密码输入框 + 确定/取消（主操作「确定」放最右）
        Util.custom(this, title, et, new Util.Btn[]{
                new Util.Btn("取消", Util.KIND_PLAIN, null),
                new Util.Btn("确定", Util.KIND_PRIMARY, new Util.Cb() {
                    @Override public void run() {
                        cb.run(et.getText().toString());
                    }
                })
        });
    }

    private void submitPassword(final String oldP, final String newP, final String confirm) {
        final Dialog ld = Util.loading(this, "提交中…");
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    Api.accountPassword(oldP, newP, confirm);
                } catch (Exception e) {
                    MeActivity.<RuntimeException>sneaky(e);
                }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); Util.toast(MeActivity.this, "密码已修改"); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(MeActivity.this, e); }
        });
    }

    // ---------- 注销 / 退出 ----------

    private void deleteAccount() {
        Util.confirm(this, "注销账户",
                "注销后将永久删除账户及全部数据，且无法恢复。\n确定要继续吗？", new Util.Cb() {
            @Override public void run() {
                Util.password(MeActivity.this, "注销账户", new Util.InputCb() {
                    @Override public void run(String pw) {
                        if (pw.length() == 0) { Util.toast(MeActivity.this, "请输入账户密码"); return; }
                        final Dialog ld = Util.loading(MeActivity.this, "注销中…");
                        Util.async(new Runnable() {
                            @Override public void run() {
                                try {
                                    Api.accountDelete(pw);
                                    Http.clearSession();
                                } catch (Exception e) {
                                    MeActivity.<RuntimeException>sneaky(e);
                                }
                            }
                        }, new Util.Cb() {
                            @Override public void run() {
                                ld.dismiss();
                                Util.toast(MeActivity.this, "账户已注销");
                                goLogin();
                            }
                        }, new Util.ErrCb() {
                            @Override public void run(String e) { ld.dismiss(); Util.toast(MeActivity.this, e); }
                        });
                    }
                });
            }
        });
    }

    private void logout() {
        Util.confirm(this, "退出登录", "确定退出当前账户？", new Util.Cb() {
            @Override public void run() {
                final Dialog ld = Util.loading(MeActivity.this, "退出中…");
                Util.async(new Runnable() {
                    @Override public void run() {
                        try {
                            Api.logout();
                        } catch (Exception e) {
                            MeActivity.<RuntimeException>sneaky(e);
                        }
                    }
                }, new Util.Cb() {
                    @Override public void run() {
                        ld.dismiss();
                        goLogin();
                    }
                }, new Util.ErrCb() {
                    @Override public void run(String e) {
                        ld.dismiss();
                        Util.toast(MeActivity.this, e == null ? "退出失败" : e);
                    }
                });
            }
        });
    }

    private void goLogin() {
        Intent i = new Intent(MeActivity.this, LoginActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(i);
        finish();
    }
}