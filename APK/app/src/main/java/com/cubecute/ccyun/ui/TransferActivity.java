package com.cubecute.ccyun.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Transfer;
import com.cubecute.ccyun.util.Util;

import java.util.List;

/**
 * 传输中心（Cloudreve「上传任务」样式）：
 *  - 任务卡：类型图标块 + 文件名 + 状态 + 自绘进度条 + 百分比/速度/总大小 + 取消（或移除）；
 *  - 顶部汇总卡：任务计数 + 「清除已完成」次要按钮；
 *  - 接入 ShellUi 顶栏与左侧抽屉（NAV_TRANSFER），深浅色两套一致。
 */
public class TransferActivity extends ThemeActivity implements Transfer.Listener {

    private LinearLayout content;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(ShellUi.headerT(this, "上传任务"), new LinearLayout.LayoutParams(-1, -2));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        content.setPadding(pp, dp(12), pp, dp(20));
        sv.addView(content, new ScrollView.LayoutParams(-1, -2));
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1f));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_TRANSFER));
        render();
    }

    @Override protected void onResume() { super.onResume(); Transfer.addListener(this); }
    @Override protected void onPause() { Transfer.removeListener(this); super.onPause(); }

    @Override public void onChanged() { runOnUiThread(new Runnable() { @Override public void run() { render(); } }); }

    @Override
    public void onBackPressed() {
        if (ShellUi.closeDrawerIfOpen(this)) return;
        super.onBackPressed();
    }

    private int dp(float v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private void render() {
        if (content == null) return;
        content.removeAllViews();
        final List<Transfer.Item> items = Transfer.snapshot();

        int up = 0, down = 0;
        for (Transfer.Item it : items) {
            if (it.upload) up++; else down++;
        }

        // 汇总卡
        LinearLayout sum = ShellUi.card(this);
        sum.setOrientation(LinearLayout.HORIZONTAL);
        sum.setGravity(Gravity.CENTER_VERTICAL);
        sum.setPadding(dp(16), dp(12), dp(12), dp(12));
        TextView t = Util.text(this, "共 " + items.size() + " 个任务 · 上传 " + up + " / 下载 " + down,
                ThemeUi.cSub(), 13, Typeface.NORMAL);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        sum.addView(t, new LinearLayout.LayoutParams(0, -2, 1f));
        Button clear = Util.outline(this, "清除已完成", ThemeUi.cBrand());
        clear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Transfer.clearFinished();
                render();
            }
        });
        sum.addView(clear, Util.lp(-2, dp(44)));
        content.addView(sum, Util.lpM(-1, -2, 0, 0, 0, dp(12)));

        if (items.isEmpty()) {
            content.addView(Util.emptyState(this, "⇅", Util.MSG_EMPTY,
                    "开始上传或下载后，右上角会出现进度角标", null, null),
                    Util.lpM(-1, -2, 0, dp(40), 0, 0));
            return;
        }
        for (final Transfer.Item it : items) {
            content.addView(itemCard(it), Util.lpM(-1, -2, 0, 0, 0, dp(12)));
        }
    }

    /** 单个任务卡：图标 + 文件名 + 状态/进度 + 取消或移除 */
    private View itemCard(final Transfer.Item it) {
        LinearLayout card = ShellUi.card(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(12), dp(16), dp(12));

        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        // 类型图标块（上传=品牌蓝 / 下载=绿，走 chip 令牌适配深色）
        int ibg = it.upload ? 0xFFE8F2FE : 0xFFD1FAE5;
        int ifg = it.upload ? 0xFF2563EB : 0xFF047857;
        TextView ic = new TextView(this);
        ic.setText(it.upload ? "↑" : "↓");
        ic.setTextColor(ThemeUi.chipFg(ifg));
        ic.setTextSize(15);
        ic.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        ic.setGravity(Gravity.CENTER);
        android.graphics.drawable.GradientDrawable ig = new android.graphics.drawable.GradientDrawable();
        ig.setColor(ThemeUi.chipBg(ibg));
        ig.setCornerRadius(dp(8));
        ic.setBackground(ig);
        top.addView(ic, Util.lp(dp(36), dp(36)));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView nm = Util.text(this, it.name, ThemeUi.cText(), 15, Typeface.BOLD);
        nm.setSingleLine(true);
        nm.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(nm, Util.lpM(-1, -2, 0, 0, 0, dp(4)));
        TextView st = Util.text(this, statusText(it), statusColor(it), 13, Typeface.NORMAL);
        st.setSingleLine(true);
        st.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(st, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(dp(10), 0, dp(8), 0);
        top.addView(col, cp);

        TextView act = Util.text(this, it.finished() ? "移除" : "取消",
                it.finished() ? ThemeUi.cSub() : ThemeUi.cDanger(), 13, Typeface.NORMAL);
        act.setGravity(Gravity.CENTER);
        act.setPadding(dp(10), dp(6), dp(2), dp(6));
        act.setClickable(true);
        act.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Transfer.remove(it.id);
                render();
            }
        });
        Util.setFeedback(act);
        top.addView(act, Util.lp(-2, -2));
        card.addView(top, Util.lpM(-1, -2, 0, 0, 0, dp(10)));

        // 自绘进度条
        Bar bar = new Bar(this);
        bar.set(ratio(it));
        card.addView(bar, Util.lpM(-1, dp(6), 0, 0, 0, dp(8)));

        // 进度明细：百分比 / 已传大小 / 总大小 / 速度
        LinearLayout meta = new LinearLayout(this);
        meta.setOrientation(LinearLayout.HORIZONTAL);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        TextView left = Util.text(this, progressText(it), ThemeUi.cMute(), 11, Typeface.NORMAL);
        left.setSingleLine(true);
        left.setEllipsize(TextUtils.TruncateAt.END);
        meta.addView(left, new LinearLayout.LayoutParams(0, -2, 1f));
        String p = pct(it);
        TextView right = Util.text(this, p.length() == 0 ? "—" : p,
                it.finished() ? statusColor(it) : ThemeUi.cBrand(), 12, Typeface.BOLD);
        meta.addView(right, Util.lp(-2, -2));
        card.addView(meta, Util.lp(-1, -2));
        return card;
    }

    private String statusText(Transfer.Item it) {
        if (it.finished()) {
            if ("已完成".equals(it.note)) return it.upload ? "上传完成" : "下载完成";
            return it.note;
        }
        return it.note.length() == 0 ? (it.upload ? "上传中" : "下载中") : it.note;
    }

    private int statusColor(Transfer.Item it) {
        if (!it.finished()) return ThemeUi.cBrand();
        if ("已完成".equals(it.note)) return ThemeUi.cOk();
        if (it.note.startsWith("已转系统下载")) return ThemeUi.cSub();
        return ThemeUi.cDanger();
    }

    private String progressText(Transfer.Item it) {
        StringBuilder sb = new StringBuilder();
        if (it.total > 0) {
            sb.append(Util.fmtSize(it.done)).append(" / ").append(Util.fmtSize(it.total));
        } else if (it.done > 0) {
            sb.append(Util.fmtSize(it.done));
        } else {
            sb.append("等待中");
        }
        if (it.speed > 0 && !it.finished()) sb.append(" · ").append(Util.fmtSize(it.speed)).append("/s");
        return sb.toString();
    }

    /** 进度比例（未知总大小时按已传输量给一个"活动态"半格动画） */
    private float ratio(Transfer.Item it) {
        if (it.total > 0) {
            float r = (float) it.done / (float) it.total;
            return r < 0 ? 0 : (r > 1 ? 1 : r);
        }
        if (it.finished()) return 1f;
        return 0.12f;
    }

    private String pct(Transfer.Item it) {
        if (it.total <= 0) return it.finished() ? "完成" : "";
        int p = (int) (it.done * 100 / it.total);
        if (p > 100) p = 100;
        if (p < 0) p = 0;
        return p + "%";
    }

    /** 自绘圆角进度条（深色下轨道自动压暗，避免白条刺眼） */
    private static class Bar extends View {
        private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float ratio = 0f;

        Bar(Context c) { super(c); }

        void set(float r) { ratio = r; invalidate(); }

        @Override protected void onDraw(Canvas cv) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            float rad = h / 2f;
            p.setStyle(Paint.Style.FILL);
            p.setColor(ThemeUi.cFill());
            cv.drawRoundRect(new RectF(0, 0, w, h), rad, rad, p);
            if (ratio <= 0) return;
            float fw = w * ratio;
            if (fw < h) fw = h;
            if (fw > w) fw = w;
            p.setColor(ThemeUi.cBrand());
            cv.drawRoundRect(new RectF(0, 0, fw, h), rad, rad, p);
        }
    }
}
