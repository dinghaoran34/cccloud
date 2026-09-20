package com.cubecute.ccyun.ui;

import android.app.Activity;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;

import com.cubecute.ccyun.util.ThemeUi;

/**
 * 所有已登录主界面的基类：
 *  - onCreate 时把窗口背景直接涂成当前主题页面色（消除浅色闪白），并让状态栏底色/图标随主题；
 *  - onResume 时若"创建时的主题"与当前设置不一致（例如在别的页面切换了外观、或系统深浅色变化），
 *    自动 recreate() 让本页按新主题重建。
 */
public class ThemeActivity extends Activity {

    private boolean themed = false;
    private boolean mode;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mode = ThemeUi.isDark(this);
        ThemeUi.applyStatusBar(this);
        try {
            getWindow().setBackgroundDrawable(new ColorDrawable(ThemeUi.cPage()));
        } catch (Throwable ignored) {}
    }

    @Override
    protected void onResume() {
        super.onResume();
        boolean now = ThemeUi.isDark(this);
        if (themed && now != mode) {
            mode = now;
            ThemeUi.applyStatusBar(this);
            if (!isFinishing()) recreate();
            return;
        }
        themed = true;
    }
}