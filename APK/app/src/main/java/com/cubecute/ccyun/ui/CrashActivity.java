package com.cubecute.ccyun.ui;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Process;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.MainActivity;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Util;

/** 崩溃堆栈展示页（临时诊断用，定位后移除） */
public class CrashActivity extends ThemeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        final String stack = getIntent().getStringExtra("stack");
        final String text = stack == null ? "（无堆栈内容）" : stack;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(ShellUi.header(this, "错误报告", true, null), new LinearLayout.LayoutParams(-1, -2));

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(12), dp(12), dp(12), dp(12));
        root.addView(body, new LinearLayout.LayoutParams(-1, 0, 1f));

        LinearLayout card = ShellUi.card(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(12), dp(16), dp(12));

        TextView title = Util.text(this, "检测到崩溃，请复制下面日志发给开发者", ThemeUi.cDanger(), 15, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title, Util.lpM(-1, -2, 0, 0, 0, dp(10)));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(11);
        tv.setTextColor(ThemeUi.cText());
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setPadding(dp(6), dp(6), dp(6), dp(6));
        tv.setTextIsSelectable(true);
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
        gd.setColor(ThemeUi.cFill());
        gd.setCornerRadius(dp(8));
        tv.setBackground(gd);
        sv.addView(tv);
        card.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1f));
        body.addView(card, new LinearLayout.LayoutParams(-1, 0, 1f));

        LinearLayout btns = new LinearLayout(this);
        btns.setOrientation(LinearLayout.HORIZONTAL);
        btns.setGravity(Gravity.CENTER_VERTICAL);

        Button copy = Util.outline(this, "复制日志", ThemeUi.cBrand());
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("crash", text));
                    Util.toast(CrashActivity.this, "已复制，请粘贴发给开发者");
                } catch (Throwable t) {
                    Util.toast(CrashActivity.this, "复制失败，请手动截图");
                }
            }
        });
        btns.addView(copy, new LinearLayout.LayoutParams(0, dp(42), 1f));

        Button next = Util.solid(this, "忽略并继续", ThemeUi.cBrand(), 0xFFFFFFFF);
        next.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Intent i = new Intent(CrashActivity.this, MainActivity.class);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
                startActivity(i);
                finish();
            }
        });
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(0, dp(42), 1f);
        np.setMargins(dp(8), 0, dp(8), 0);
        btns.addView(next, np);

        Button exit = Util.outline(this, "退出", ThemeUi.cDanger());
        exit.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                finish();
                Process.killProcess(Process.myPid());
            }
        });
        btns.addView(exit, new LinearLayout.LayoutParams(0, dp(42), 1f));

        body.addView(btns, Util.lpM(-1, -2, 0, dp(12), 0, 0));
        setContentView(root);
    }

    private int dp(float v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }
}
