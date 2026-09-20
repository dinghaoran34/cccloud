package com.cubecute.ccyun.ui;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Constants;
import com.cubecute.ccyun.net.Http;
import com.cubecute.ccyun.net.SecureStore;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Util;

/** 登录页：百度网盘风格（白底简洁 + 品牌蓝渐变主按钮 + 圆角浅灰输入框） */
public class LoginActivity extends Activity {

    private EditText userEt, passEt;
    private CheckBox rememberCb, agreeCb;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 先解析外观偏好（含"跟随系统"），让登录页底色与状态栏按当前主题渲染
        ThemeUi.applyStatusBar(this);

        if (getIntent() != null && getIntent().getBooleanExtra("relogin", false)) {
            Util.toast(this, Util.MSG_RELOGIN);
        }
        if (getIntent() != null && getIntent().getBooleanExtra("credExpired", false)) {
            Util.toast(this, "登录有效期已满一年，请重新登录");
        }

        final float d = getResources().getDisplayMetrics().density;
        final int fieldH = (int) (52 * d);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(ThemeUi.cPage());
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding((int) (24 * d), (int) (8 * d), (int) (24 * d), (int) (28 * d));

        // ---------- 顶部品牌区（约占屏幕 40% 高度，内部垂直居中） ----------
        int screenDp = (int) (getResources().getDisplayMetrics().heightPixels / d);
        int zoneH = (int) (Math.min(330, screenDp * 0.42f) * d);
        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        brand.setGravity(Gravity.CENTER);
        brand.setMinimumHeight(zoneH);

        TextView logo = new TextView(this);
        logo.setText("云");
        logo.setTextColor(0xFFFFFFFF);
        logo.setTextSize(26);
        logo.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        logo.setGravity(Gravity.CENTER);
        int[] lgcol = ThemeUi.brandGradient();
        GradientDrawable logoBg = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{lgcol[0], lgcol[1]});
        logoBg.setCornerRadius(28 * d);
        bg(logo, logoBg);
        int logoSize = (int) (56 * d);
        brand.addView(logo, Util.lp(logoSize, logoSize));

        TextView app = Util.text(this, "CC网盘", ThemeUi.cText(), 24, Typeface.BOLD);
        app.setGravity(Gravity.CENTER);
        brand.addView(app, Util.lpM(-1, -2, 0, (int) (14 * d), 0, 0));

        TextView slogan = Util.text(this, "安全·便捷的团队协作云盘", ThemeUi.cMute(), 13, Typeface.NORMAL);
        slogan.setGravity(Gravity.CENTER);
        brand.addView(slogan, Util.lpM(-1, -2, 0, (int) (6 * d), 0, 0));
        root.addView(brand, Util.lp(-1, -2));

        // ---------- 居中卡片（Cloudreve 风格：卡片表面 + 8~12dp 圆角 + 极浅描边） ----------
        LinearLayout form = ShellUi.card(this, 12);
        form.setPadding((int) (16 * d), (int) (16 * d), (int) (16 * d), (int) (12 * d));
        root.addView(form, Util.lpM(-1, -2, 0, 0, 0, 0));

        // ---------- 输入区 ----------
        userEt = field("请输入用户名", InputType.TYPE_CLASS_TEXT);
        // 若本地存有"一年内"的加密凭据，自动回填用户名，减少重复输入
        final String[] savedCred = SecureStore.loadCredentials();
        if (savedCred != null && savedCred[0] != null) userEt.setText(savedCred[0]);
        form.addView(userEt, Util.lpM(-1, fieldH, 0, (int) (6 * d), 0, 0));

        passEt = field("请输入密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        form.addView(passEt, Util.lpM(-1, fieldH, 0, (int) (12 * d), 0, 0));

        // ---------- 用户协议行（小复选框 + 链接，必须勾选后才可登录） ----------
        agreeCb = new CheckBox(this);
        agreeCb.setText("我已阅读并同意");
        agreeCb.setTextSize(13);
        agreeCb.setTextColor(ThemeUi.cSub());
        LinearLayout agreeRow = new LinearLayout(this);
        agreeRow.setOrientation(LinearLayout.HORIZONTAL);
        agreeRow.setGravity(Gravity.CENTER_VERTICAL);
        agreeRow.addView(agreeCb, Util.lp(-2, -2));
        TextView agreeLink = Util.text(this, "《用户协议》", ThemeUi.cBrand(), 13, Typeface.NORMAL);
        agreeLink.setClickable(true);
        agreeLink.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Util.openUrl(LoginActivity.this, Constants.BASE_URL + "/agreement");
            }
        });
        agreeRow.addView(agreeLink, Util.lpM(-2, -2, 0, (int) (2 * d), 0, 0));
        form.addView(agreeRow, Util.lpM(-1, -2, 0, (int) (4 * d), 0, 0));

        // ---------- 登录主按钮（品牌蓝 + 6dp 圆角 + 按压反馈） ----------
        Button btn = capsuleButton("登 录");
        btn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                doLogin();
            }
        });
        form.addView(btn, Util.lpM(-1, fieldH, 0, (int) (14 * d), 0, 0));

        // ---------- 记住我 / 注册账号 行 ----------
        rememberCb = new CheckBox(this);
        rememberCb.setText("记住我");
        rememberCb.setTextSize(13);
        rememberCb.setTextColor(ThemeUi.cSub());
        rememberCb.setChecked(true);
        LinearLayout bottomRow = new LinearLayout(this);
        bottomRow.setOrientation(LinearLayout.HORIZONTAL);
        bottomRow.setGravity(Gravity.CENTER_VERTICAL);
        bottomRow.addView(rememberCb, new LinearLayout.LayoutParams(0, -2, 1f));
        TextView reg = Util.text(this, "注册账号", ThemeUi.cBrand(), 15, Typeface.NORMAL);
        reg.setClickable(true);
        reg.setPadding((int) (8 * d), (int) (10 * d), 0, (int) (10 * d));
        reg.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // 注册转到浏览器进行（使用网页端的人机验证），完成后网页提示「注册完成，请返回APP」
                Util.openUrl(LoginActivity.this, Constants.BASE_URL + "/register?from=app");
            }
        });
        bottomRow.addView(reg, Util.lp(-2, -2));
        form.addView(bottomRow, Util.lpM(-1, -2, 0, (int) (2 * d), 0, 0));

        scroll.addView(root, new ScrollView.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(scroll);
    }

    /** 圆角填充输入框（随主题；Cloudreve 输入底 + 8dp 圆角） */
    private EditText field(String hint, int inputType) {
        float d = getResources().getDisplayMetrics().density;
        EditText et = new EditText(this);
        et.setHint(hint);
        et.setHintTextColor(ThemeUi.cMute());
        et.setTextColor(ThemeUi.cText());
        et.setTextSize(15);
        et.setSingleLine(true);
        et.setInputType(inputType);
        et.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cFill());
        gd.setCornerRadius(8 * d);
        bg(et, gd);
        et.setPadding((int) (18 * d), 0, (int) (18 * d), 0);
        return et;
    }

    /** 全宽主按钮：品牌蓝渐变 + 6dp 圆角 + 统一按压反馈（API21+ 轻波纹） */
    private Button capsuleButton(final String text) {
        final float d = getResources().getDisplayMetrics().density;
        final Button b = new Button(this);
        b.setText(text);
        b.setTextSize(15);
        b.setTextColor(0xFFFFFFFF);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        Util.noCaps(b);
        b.setPadding(0, 0, 0, 0);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight((int) (44 * d));
        int[] col = ThemeUi.brandGradient();
        GradientDrawable gd = new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{col[0], col[1]});
        gd.setCornerRadius(6 * d);
        bg(b, gd);
        Util.setFeedback(b);
        return b;
    }

    /** API16 前用 setBackgroundDrawable，保证 API14 可用 */
    private static void bg(View v, Drawable dr) {
        if (android.os.Build.VERSION.SDK_INT >= 16) {
            v.setBackground(dr);
        } else {
            v.setBackgroundDrawable(dr);
        }
    }

    private void doLogin() {
        final String u = userEt.getText().toString().trim();
        final String p = passEt.getText().toString();
        if (u.length() == 0) { Util.toast(this, "请输入用户名"); return; }
        if (p.length() == 0) { Util.toast(this, "请输入密码"); return; }
        if (!agreeCb.isChecked()) { Util.toast(this, "请先阅读并勾选同意用户协议"); return; }
        submit(u, p);
    }

    private void submit(final String u, final String p) {
        Http.setRememberPersistence(rememberCb.isChecked()); // 勾选“记住我”才将会话持久化(30天)
        final Dialog loading = Util.loading(this, "登录中…");
        Util.async(new Runnable() {
            @Override
            public void run() {
                try {
                    Api.login(u, p, rememberCb.isChecked());
                } catch (Exception e) {
                    LoginActivity.<RuntimeException>sneaky(e);
                }
            }
        }, new Util.Cb() {
            @Override
            public void run() {
                loading.dismiss();
                // 登录成功：加密保存账号密码（有效期一年），下次启动自动登录校验
                SecureStore.saveCredentials(u, p);
                Util.toast(LoginActivity.this, "欢迎回来");
                Intent i = new Intent(LoginActivity.this, HomeActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(i);
                ShellUi.enter(LoginActivity.this);
                finish();
            }
        }, new Util.ErrCb() {
            @Override
            public void run(String err) {
                loading.dismiss();
                Util.toast(LoginActivity.this, err == null ? "登录失败" : err);
            }
        });
    }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T {
        throw (T) t;
    }
}
