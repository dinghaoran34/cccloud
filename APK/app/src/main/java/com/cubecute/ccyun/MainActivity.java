package com.cubecute.ccyun;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Http;
import com.cubecute.ccyun.net.SecureStore;
import com.cubecute.ccyun.ui.CrashActivity;
import com.cubecute.ccyun.ui.HomeActivity;
import com.cubecute.ccyun.ui.LoginActivity;
import com.cubecute.ccyun.util.MaterialRing;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Util;
import com.cubecute.ccyun.util.CrashReporter;

/** 启动页：检测登录态（/api/me）后进入 首页 或 登录页 */
public class MainActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 临时诊断：存在上次崩溃堆栈则先展示（定位安卓5.0启动崩溃）
        String crash = CrashReporter.consume(this);
        if (crash != null && !getIntent().getBooleanExtra("fromCrash", false)) {
            Intent ci = new Intent(this, CrashActivity.class);
            ci.putExtra("stack", crash);
            startActivity(ci);
            finish();
            return;
        }
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);

        // 先加载外观偏好（含"跟随系统"），再让启动页与状态栏都走品牌色，避免深浅色模式下取到过期主题色
        ThemeUi.isDark(this);
        root.setBackgroundColor(ThemeUi.cBrand());
        ThemeUi.applyStatusBarColor(this, ThemeUi.cBrand(), false);

        TextView tv = Util.text(this, "CC网盘", 0xFFFFFFFF, 26, 1);
        tv.setGravity(Gravity.CENTER);
        root.addView(tv, Util.lpM(-1, -2, 0, -100, 0, 0));

        // Android16 风格自绘加载环（白色弧），API14 一致
        MaterialRing ring = new MaterialRing(this, 0xFFFFFFFF);
        root.addView(ring, Util.lp(-2, -2));
        setContentView(root);

        final boolean[] logged = {false};
        final boolean[] expired = {false};
        Util.async(new Runnable() {
            @Override
            public void run() {
                if (Api.meQuiet() != null) { logged[0] = true; return; } // 会话仍有效
                // 会话失效：若本地存有"一年内"的加密账号密码，则自动重新登录校验
                String[] cred = SecureStore.loadCredentials();
                if (cred != null) {
                    try {
                        Http.setRememberPersistence(true);
                        Api.login(cred[0], cred[1], true);
                        logged[0] = true;
                    } catch (Exception ignored) {
                        logged[0] = false;
                    }
                } else if (SecureStore.hasCredentials()) {
                    expired[0] = true; // 凭据存在但已过期（满一年）
                }
            }
        }, new Util.Cb() {
            @Override
            public void run() {
                go(logged[0], expired[0]);
            }
        }, new Util.ErrCb() {
            @Override
            public void run(String err) {
                go(false, expired[0]);
            }
        });
    }

    private void go(boolean logged, boolean credExpired) {
        Intent i = new Intent(this, logged ? HomeActivity.class : LoginActivity.class);
        if (!logged && credExpired) i.putExtra("credExpired", true);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(i);
        ShellUi.enter(this);
        finish();
    }
}
