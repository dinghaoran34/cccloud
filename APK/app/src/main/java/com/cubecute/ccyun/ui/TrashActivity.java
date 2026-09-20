package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Util;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 回收站：列出个人已删除的文件/文件夹，支持恢复 / 彻底删除 / 清空 */
public class TrashActivity extends ThemeActivity {

    private LinearLayout content;
    private JSONArray folders;
    private JSONArray files;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(ShellUi.headerT(this, "回收站"), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        content.setPadding(pp, dp(12), pp, dp(16));
        sv.addView(content, new ScrollView.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1f));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_TRASH));
        load();
    }

    @Override
    public void onBackPressed() {
        if (ShellUi.closeDrawerIfOpen(this)) return;
        super.onBackPressed();
    }

    private int dp(int v) { return (int) (getResources().getDisplayMetrics().density * v); }
    private int px(int v) { return dp(v); }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T { throw (T) t; }

    private void load() {
        final Dialog ld = Util.loading(this, "加载中…");
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject j = Api.trashList();
                    folders = Util.a(j, "folders");
                    files = Util.a(j, "files");
                } catch (Exception e) {
                    TrashActivity.<RuntimeException>sneaky(e);
                }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); render(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                ld.dismiss();
                final String msg = e == null ? "加载失败" : e;
                Util.info(TrashActivity.this, "加载失败", msg, new Util.Btn[]{
                        new Util.Btn("关闭", Util.KIND_PLAIN, null),
                        new Util.Btn("重试", Util.KIND_PRIMARY, new Util.Cb() {
                            @Override public void run() { load(); }
                        })
                });
                render();
            }
        });
    }

    private void render() {
        content.removeAllViews();
        boolean empty = (folders == null || folders.length() == 0) && (files == null || files.length() == 0);
        if (empty) {
            content.addView(Util.emptyState(this, "回", Util.MSG_EMPTY,
                    "删除个人文件后会进入这里，可随时恢复", null, null),
                    Util.lpM(-1, -2, 0, px(48), 0, 0));
            return;
        }

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        TextView tip = Util.text(this, "共 " + ((folders == null ? 0 : folders.length()) + (files == null ? 0 : files.length())) + " 项", ThemeUi.cSub(), 13, Typeface.NORMAL);
        bar.addView(tip, new LinearLayout.LayoutParams(0, -2, 1f));
        Button restoreAll = Util.outline(this, "全部恢复", ThemeUi.cBrand());
        restoreAll.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Util.confirm(TrashActivity.this, "恢复全部", "确定恢复回收站中的全部项目？", new Util.Cb() {
                    @Override public void run() { op("恢复中…", new Runnable() {
                        @Override public void run() {
                            try { Api.trashRestore(folderIds(true), fileIds(true)); } catch (Exception ex) { TrashActivity.<RuntimeException>sneaky(ex); }
                        }
                    }, "已全部恢复"); }
                });
            }
        });
        bar.addView(restoreAll, Util.lp(-2, px(34)));
        Button clear = Util.solid(this, "清空回收站", ThemeUi.cDanger(), 0xFFFFFFFF);
        clear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Util.confirm(TrashActivity.this, "清空回收站", "将彻底删除回收站中的全部文件，不可恢复！", new Util.Cb() {
                    @Override public void run() { op("清空中…", new Runnable() {
                        @Override public void run() { try { Api.trashEmpty(); } catch (Exception ex) { TrashActivity.<RuntimeException>sneaky(ex); } }
                    }, "回收站已清空"); }
                });
            }
        });
        bar.addView(clear, Util.lpM(-2, px(34), px(8), 0, 0, 0));
        content.addView(bar, Util.lpM(-1, -2, 0, 0, 0, dp(8)));

        if (folders != null) {
            for (int i = 0; i < folders.length(); i++) {
                JSONObject fo = folders.optJSONObject(i);
                if (fo == null) continue;
                content.addView(folderRow(fo), Util.lpM(-1, -2, 0, 0, 0, dp(6)));
            }
        }
        if (files != null) {
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.optJSONObject(i);
                if (f == null) continue;
                content.addView(fileRow(f), Util.lpM(-1, -2, 0, 0, 0, dp(6)));
            }
        }
    }

    private long[] folderIds(boolean onlyDeleted) {
        List<Long> list = new ArrayList<Long>();
        if (folders != null) for (int i = 0; i < folders.length(); i++) list.add(folders.optJSONObject(i).optLong("id"));
        long[] r = new long[list.size()];
        for (int i = 0; i < r.length; i++) r[i] = list.get(i);
        return r;
    }

    private long[] fileIds(boolean onlyDeleted) {
        List<Long> list = new ArrayList<Long>();
        if (files != null) for (int i = 0; i < files.length(); i++) list.add(files.optJSONObject(i).optLong("id"));
        long[] r = new long[list.size()];
        for (int i = 0; i < r.length; i++) r[i] = list.get(i);
        return r;
    }

    private View rowShell(String iconText, int[] chip, String name, String sub, View.OnClickListener l) {
        LinearLayout card = ShellUi.card(this);
        card.setPadding(px(12), px(10), px(12), px(10));
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);

        TextView icon = new TextView(this);
        icon.setText(iconText);
        icon.setTextColor(ThemeUi.chipFg(chip[1]));
        icon.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        icon.setGravity(Gravity.CENTER);
        android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
        gd.setColor(ThemeUi.chipBg(chip[0]));
        gd.setCornerRadius(dp(8));
        icon.setBackground(gd);
        card.addView(icon, Util.lp(px(38), px(38)));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        TextView t1 = Util.text(this, name, ThemeUi.cText(), 15, Typeface.NORMAL);
        t1.setSingleLine(true);
        t1.setEllipsize(android.text.TextUtils.TruncateAt.END);
        col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(2)));
        TextView t2 = Util.text(this, sub, ThemeUi.cMute(), 11, Typeface.NORMAL);
        t2.setSingleLine(true);
        col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(px(12), 0, 0, 0);
        card.addView(col, cp);

        TextView chev = Util.text(this, "⋯", ThemeUi.cMute(), 17, Typeface.BOLD);
        chev.setGravity(Gravity.CENTER);
        chev.setPadding(px(6), 0, px(4), 0);
        card.addView(chev, Util.lp(-2, px(36)));
        if (l != null) card.setOnClickListener(l);
        Util.setFeedback(card);
        return card;
    }

    private View folderRow(final JSONObject fo) {
        View v = rowShell("夹", new int[]{0xFFFEF3C7, 0xFFB45309}, Util.s(fo, "name"),
                "文件夹 · 删除于 " + Util.fmtDbTime(Util.s(fo, "deleted_at")), new View.OnClickListener() {
            @Override public void onClick(View v) { showActions(true, fo.optLong("id"), Util.s(fo, "name")); }
        });
        return v;
    }

    private View fileRow(final JSONObject f) {
        View v = rowShell("文", new int[]{0xFFDBEAFE, 0xFF1E40AF}, Util.s(f, "filename"),
                Util.fmtSize(Util.l(f, "file_size")) + " · 删除于 " + Util.fmtDbTime(Util.s(f, "deleted_at")),
                new View.OnClickListener() {
            @Override public void onClick(View v) { showActions(false, f.optLong("id"), Util.s(f, "filename")); }
        });
        return v;
    }

    private void showActions(final boolean isFolder, final long id, final String name) {
        Util.menu(this, name, new String[]{"恢复", "彻底删除"}, 1, true, new Util.MenuCb() {
            @Override public void run(int which) {
                if (which == 0) {
                    op("恢复中…", new Runnable() {
                        @Override public void run() { try { Api.trashRestore(isFolder ? new long[]{id} : new long[]{}, isFolder ? new long[]{} : new long[]{id}); } catch (Exception ex) { TrashActivity.<RuntimeException>sneaky(ex); } }
                    }, "已恢复");
                } else {
                    Util.confirm(TrashActivity.this, "彻底删除", "将永久删除「" + name + "」，不可恢复。确定？", new Util.Cb() {
                        @Override public void run() {
                            op("删除中…", new Runnable() {
                                @Override public void run() { try { Api.trashPurge(isFolder ? new long[]{id} : new long[]{}, isFolder ? new long[]{} : new long[]{id}); } catch (Exception ex) { TrashActivity.<RuntimeException>sneaky(ex); } }
                            }, "已彻底删除");
                        }
                    });
                }
            }
        });
    }

    private void op(final String loadingMsg, final Runnable bg, final String okMsg) {
        final Dialog ld = Util.loading(this, loadingMsg);
        Util.async(new Runnable() {
            @Override public void run() {
                try { bg.run(); } catch (Exception e) { TrashActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); load(); Util.toast(TrashActivity.this, okMsg); }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(TrashActivity.this, e == null ? "操作失败" : e); }
        });
    }
}
