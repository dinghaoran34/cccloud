package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.util.MaterialRing;
import com.cubecute.ccyun.util.ShellUi;
import com.cubecute.ccyun.util.ThemeUi;
import com.cubecute.ccyun.util.Util;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 完整搜索页：输入框+清除/取消、建议/自动完成、搜索历史、结果列表、加载与错误处理 */
public class SearchActivity extends ThemeActivity {

    private static final String PREF = "teamcloud";
    private static final String KEY_HIST = "search_history";

    private EditText input;
    private LinearLayout area;
    private final Handler ui = new Handler();
    private int seq = 0;
    private String currentQ = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());

        // 顶部：统一顶栏外壳（返回 + 搜索输入框 + 搜索/传输入口），底色与分隔线走令牌
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        android.graphics.drawable.GradientDrawable bd = new android.graphics.drawable.GradientDrawable();
        bd.setColor(ThemeUi.cFill());
        bd.setCornerRadius(dp(8));
        box.setBackground(bd);
        box.setPadding(dp(12), 0, dp(4), 0);

        input = new EditText(this);
        input.setHint("搜索文件/文件夹（中英文均可）");
        input.setTextSize(15);
        input.setTextColor(ThemeUi.cText());
        input.setHintTextColor(ThemeUi.cMute());
        input.setSingleLine(true);
        input.setPadding(0, 0, 0, 0);
        input.setBackgroundColor(Color.TRANSPARENT);
        input.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT);
        box.addView(input, new LinearLayout.LayoutParams(0, dp(38), 1f));

        final TextView clearBtn = new TextView(this);
        clearBtn.setText("✕");
        clearBtn.setTextColor(ThemeUi.cMute());
        clearBtn.setTextSize(16);
        clearBtn.setGravity(Gravity.CENTER);
        clearBtn.setVisibility(View.GONE);
        clearBtn.setPadding(dp(8), 0, dp(8), 0);
        clearBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                input.setText("");
                input.requestFocus();
            }
        });
        box.addView(clearBtn, Util.lp(dp(34), dp(36)));

        // 本页即搜索页（顶栏中间已是搜索框），故不再重复显示「搜索」图标入口，右侧只留「＋」传输进度
        ShellUi.BarOpts bopts = new ShellUi.BarOpts();
        bopts.search = false;
        root.addView(ShellUi.bar(this, ShellUi.navBtn(this, true, null), box, bopts),
                new LinearLayout.LayoutParams(-1, -2));

        ScrollView sv = new ScrollView(this);
        sv.setVerticalScrollBarEnabled(false);
        area = new LinearLayout(this);
        area.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        area.setPadding(pp, dp(12), pp, dp(20));
        sv.addView(area);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1f));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_SEARCH));
        input.requestFocus();

        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
                if (actionId == EditorInfo.IME_ACTION_SEARCH
                        || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                    runSearch(input.getText().toString().trim(), false);
                    return true;
                }
                return false;
            }
        });
        input.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) {}
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) {
                clearBtn.setVisibility(s.length() > 0 ? View.VISIBLE : View.GONE);
            }
            @Override public void afterTextChanged(Editable s) {
                final String q = s.toString().trim();
                ui.removeCallbacksAndMessages(null);
                if (q.length() == 0) {
                    seq++;
                    showHome();
                } else {
                    ui.postDelayed(new Runnable() {
                        @Override public void run() { loadSuggest(q); }
                    }, 220);
                }
            }
        });
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                InputMethodManager im = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (im != null) im.showSoftInput(input, 0);
            }
        }, 200);
        showHome();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        ui.removeCallbacksAndMessages(null);
    }

    @Override
    public void onBackPressed() {
        if (ShellUi.closeDrawerIfOpen(this)) return;
        super.onBackPressed();
    }

    // ---------- 工具 ----------

    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private List<String> history() {
        List<String> list = new ArrayList<String>();
        try {
            SharedPreferences p = getSharedPreferences(PREF, MODE_PRIVATE);
            String raw = p.getString(KEY_HIST, "[]");
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) list.add(a.getString(i));
        } catch (Throwable t) {}
        return list;
    }

    private void saveHistory(String q) {
        try {
            List<String> list = history();
            list.remove(q);
            list.add(0, q);
            while (list.size() > 10) list.remove(list.size() - 1);
            JSONArray a = new JSONArray();
            for (String s : list) a.put(s);
            getSharedPreferences(PREF, MODE_PRIVATE).edit().putString(KEY_HIST, a.toString()).apply();
        } catch (Throwable t) {}
    }

    private void clearHistory() {
        getSharedPreferences(PREF, MODE_PRIVATE).edit().remove(KEY_HIST).apply();
        showHome();
    }

    private LinearLayout rowCard() {
        return ShellUi.card(this);
    }

    private TextView sectionTitle(String s) {
        TextView t = Util.text(this, s, ThemeUi.cSub(), 13, Typeface.BOLD);
        t.setPadding(dp(2), dp(4), dp(2), dp(8));
        return t;
    }

    private void areaReset() {
        area.removeAllViews();
    }

    // ---------- 初始/历史 ----------

    private void showHome() {
        areaReset();
        List<String> hist = history();
        if (hist.isEmpty()) {
            area.addView(Util.emptyState(this, "搜", "输入关键词开始搜索",
                    "支持个人文件、文件夹与团队文件，中英文均可", null, null),
                    Util.lpM(-1, -2, 0, dp(48), 0, 0));
            return;
        }
        TextView title = sectionTitle("搜索历史");
        area.addView(title, Util.lpM(-1, -2, 0, 0, 0, 0));

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.HORIZONTAL);
        wrap.setGravity(Gravity.CENTER_VERTICAL);
        TextView del = Util.text(this, "清空历史", ThemeUi.cMute(), 13, Typeface.NORMAL);
        del.setPadding(dp(6), 0, dp(2), dp(8));
        del.setClickable(true);
        del.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Util.confirm(SearchActivity.this, "清空搜索历史", "确定清空全部搜索历史？", new Util.Cb() {
                    @Override public void run() { clearHistory(); }
                });
            }
        });
        wrap.addView(del, new LinearLayout.LayoutParams(-1, -2));
        area.addView(wrap, Util.lpM(-1, -2, 0, dp(4), 0, 0));

        LinearLayout card = rowCard();
        for (final String h : hist) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(4), dp(10), dp(4), dp(10));
            row.setMinimumHeight(dp(56));
            TextView icon = Util.text(this, "↻", ThemeUi.cMute(), 14, Typeface.NORMAL);
            row.addView(icon, Util.lp(-2, -2));
            TextView tv = Util.text(this, h, ThemeUi.cText(), 15, Typeface.NORMAL);
            tv.setSingleLine(true);
            tv.setEllipsize(TextUtils.TruncateAt.END);
            row.addView(tv, new LinearLayout.LayoutParams(0, -2, 1f));
            row.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    input.setText(h);
                    input.setSelection(input.getText().length());
                    runSearch(h, false);
                }
            });
            card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
        }
        area.addView(card, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    // ---------- 建议/自动完成 ----------

    private void loadSuggest(final String q) {
        seq++;
        final int my = seq;
        areaReset();
        TextView line = Util.text(this, "搜索 “" + q + "”", ThemeUi.cBrand(), 15, Typeface.BOLD);
        line.setPadding(dp(2), dp(4), dp(2), dp(8));
        line.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { runSearch(q, false); }
        });
        area.addView(line, Util.lpM(-1, -2, 0, 0, 0, 0));

        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.searchSuggest(q);
                    final JSONArray items = r.optJSONArray("items");
                    Util.onUi(new Runnable() {
                        @Override public void run() {
                            if (my != seq) return;
                            renderSuggest(q, items == null ? new JSONArray() : items);
                        }
                    });
                } catch (Exception ex) {
                    throw new RuntimeException(ex.getMessage() == null ? String.valueOf(ex) : ex.getMessage());
                }
            }
        }, null, new Util.ErrCb() {
            @Override public void run(String e) {
                if (my != seq) return;
                showError(Util.MSG_NET, null);
            }
        });
    }

    private void renderSuggest(String q, JSONArray items) {
        areaReset();
        TextView line = Util.text(this, "搜索 “" + q + "”", ThemeUi.cBrand(), 15, Typeface.BOLD);
        line.setPadding(dp(2), dp(4), dp(2), dp(8));
        line.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { runSearch(input.getText().toString().trim(), false); }
        });
        area.addView(line, Util.lpM(-1, -2, 0, 0, 0, 0));

        if (items.length() == 0) {
            area.addView(Util.emptyState(this, "搜", Util.MSG_EMPTY, "暂无匹配建议，回车直接搜索", null, null),
                    Util.lpM(-1, -2, 0, dp(24), 0, 0));
            return;
        }
        LinearLayout card = rowCard();
        for (int i = 0; i < items.length(); i++) {
            final JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(4), dp(10), dp(4), dp(10));
            row.setMinimumHeight(dp(56));
            TextView icon = Util.text(this, tag(it.optString("type", "")), ThemeUi.chipFg(iconFg(it.optString("type", ""))), 13, Typeface.BOLD);
            icon.setGravity(Gravity.CENTER);
            android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
            gd.setColor(ThemeUi.chipBg(iconBg(it.optString("type", ""))));
            gd.setCornerRadius(dp(8));
            icon.setBackground(gd);
            row.addView(icon, Util.lp(dp(30), dp(30)));
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setPadding(dp(10), 0, 0, 0);
            TextView t1 = Util.text(this, it.optString("text", ""), ThemeUi.cText(), 15, Typeface.NORMAL);
            t1.setSingleLine(true);
            t1.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(1)));
            TextView t2 = Util.text(this, it.optString("sub", ""), ThemeUi.cMute(), 11, Typeface.NORMAL);
            col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
            row.addView(col, new LinearLayout.LayoutParams(0, -2, 1f));
            row.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    input.setText(it.optString("text", ""));
                    input.setSelection(input.getText().length());
                    runSearch(it.optString("text", ""), false);
                }
            });
            card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
        }
        area.addView(card, Util.lpM(-1, -2, 0, 0, 0, 0));
    }

    private String tag(String type) {
        if ("folder".equals(type)) return "夹";
        if ("team".equals(type)) return "队";
        return "文";
    }

    /** 图标块底色（浅色原值，深色由 ThemeUi.chipBg 自动压暗） */
    private int iconBg(String type) {
        if ("folder".equals(type)) return ThemeUi.typeChipBg(ThemeUi.TYPE_FOLDER);
        if ("team".equals(type)) return 0xFFEDE9FE;
        return ThemeUi.typeChipBg(ThemeUi.TYPE_OTHER);
    }

    /** 图标块字色（浅色原值，深色由 ThemeUi.chipFg 自动提亮） */
    private int iconFg(String type) {
        if ("folder".equals(type)) return ThemeUi.typeChipFg(ThemeUi.TYPE_FOLDER);
        if ("team".equals(type)) return 0xFF2A2440;
        return ThemeUi.typeChipFg(ThemeUi.TYPE_OTHER);
    }

    // ---------- 搜索执行与结果 ----------

    private void runSearch(final String q, boolean fromError) {
        if (q.length() == 0) { showHome(); return; }
        currentQ = q;
        saveHistory(q);
        final int my = ++seq;
        areaReset();

        LinearLayout loading = new LinearLayout(this);
        loading.setOrientation(LinearLayout.HORIZONTAL);
        loading.setGravity(Gravity.CENTER);
        loading.setPadding(0, dp(30), 0, dp(30));
        MaterialRing ring = new MaterialRing(this, ThemeUi.cBrand());
        loading.addView(ring, Util.lp(dp(22), dp(22)));
        TextView tv = Util.text(this, "正在搜索 “" + q + "”…", ThemeUi.cSub(), 15, Typeface.NORMAL);
        tv.setPadding(dp(10), 0, 0, 0);
        loading.addView(tv, Util.lp(-2, -2));
        area.addView(loading, Util.lpM(-1, -2, 0, 0, 0, 0));

        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    final JSONObject r = Api.search(q);
                    Util.onUi(new Runnable() {
                        @Override public void run() {
                            if (my != seq) return;
                            renderResults(q, r);
                        }
                    });
                } catch (Exception ex) {
                    throw new RuntimeException(ex.getMessage() == null ? String.valueOf(ex) : ex.getMessage());
                }
            }
        }, null, new Util.ErrCb() {
            @Override public void run(String e) {
                if (my != seq) return;
                showError(e == null || e.length() == 0 ? Util.MSG_NET : e, new Runnable() {
                    @Override public void run() { runSearch(q, true); }
                });
            }
        });
    }

    private void renderResults(String q, JSONObject r) {
        areaReset();
        JSONArray folders = r.optJSONArray("folders");
        JSONArray files = r.optJSONArray("files");
        JSONArray team = r.optJSONArray("teamFiles");
        int n = (folders == null ? 0 : folders.length()) + (files == null ? 0 : files.length()) + (team == null ? 0 : team.length());

        TextView head = Util.text(this, "“" + q + "” 的搜索结果（" + n + "）", ThemeUi.cSub(), 13, Typeface.BOLD);
        head.setPadding(dp(2), dp(2), dp(2), dp(10));
        area.addView(head, Util.lpM(-1, -2, 0, 0, 0, 0));

        if (n == 0) {
            area.addView(Util.emptyState(this, "搜", Util.MSG_EMPTY, "没有找到相关内容，换个关键词试试吧", null, null),
                    Util.lpM(-1, -2, 0, dp(24), 0, 0));
            return;
        }
        if (folders != null) appendGroup("文件夹", folders, "folder");
        if (files != null) appendGroup("文件", files, "file");
        if (team != null) appendGroup("团队文件", team, "team");
    }

    private void appendGroup(String title, JSONArray arr, String type) {
        boolean any = false;
        LinearLayout card = rowCard();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject it = arr.optJSONObject(i);
            if (it == null) continue;
            any = true;
            final String text = "file".equals(type) || "team".equals(type) ? it.optString("filename", "") : it.optString("name", "");
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(4), dp(10), dp(4), dp(10));
            TextView icon = Util.text(this, tag(type), ThemeUi.chipFg(iconFg(type)), 13, Typeface.BOLD);
            icon.setGravity(Gravity.CENTER);
            android.graphics.drawable.GradientDrawable gd = new android.graphics.drawable.GradientDrawable();
            gd.setColor(ThemeUi.chipBg(iconBg(type)));
            gd.setCornerRadius(dp(8));
            icon.setBackground(gd);
            row.addView(icon, Util.lp(dp(32), dp(32)));
            LinearLayout col = new LinearLayout(this);
            col.setOrientation(LinearLayout.VERTICAL);
            col.setPadding(dp(10), 0, 0, 0);
            TextView t1 = Util.text(this, text, ThemeUi.cText(), 15, Typeface.NORMAL);
            t1.setSingleLine(true);
            t1.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, 0));
            row.addView(col, new LinearLayout.LayoutParams(0, -2, 1f));
            final JSONObject rowJson = it;
            final String rowType = type;
            row.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { onResultClick(rowType, rowJson); }
            });
            card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
        }
        if (any) {
            TextView g = sectionTitle(title);
            g.setPadding(dp(2), dp(8), dp(2), dp(6));
            area.addView(g, Util.lpM(-1, -2, 0, dp(6), 0, 0));
            area.addView(card, Util.lpM(-1, -2, 0, 0, 0, 0));
        }
    }

    private void onResultClick(final String type, final JSONObject it) {
        if ("folder".equals(type)) {
            openFolder(it.optLong("id"));
        } else {
            final long id = Util.l(it, "id");
            final String fn = "file".equals(type) ? it.optString("filename", "file") : it.optString("filename", "file");
            // M3 菜单：单条下载（原底部取消保留）
            Util.menu(this, fn, new String[]{"下载"}, -1, true, new Util.MenuCb() {
                @Override public void run(int which) {
                    final Dialog ld = Util.loading(SearchActivity.this, "获取下载地址…");
                    Util.async(new Runnable() {
                        @Override public void run() {
                            final String[] url = {""};
                            try {
                                if ("team".equals(type)) {
                                    url[0] = Api.teamDownloadProxyUrl(it.optLong("teamId"), id);
                                } else {
                                    url[0] = Api.downloadProxyUrl(id);
                                }
                            } catch (Exception e) {
                                url[0] = "";
                            }
                            Util.onUi(new Runnable() {
                                @Override public void run() {
                                    ld.dismiss();
                                    if (url[0].length() > 0) Util.download(SearchActivity.this, url[0], fn);
                                    else Util.toast(SearchActivity.this, "获取下载地址失败");
                                }
                            });
                        }
                    }, null, new Util.ErrCb() {
                        @Override public void run(String e) { ld.dismiss(); Util.toast(SearchActivity.this, e); }
                    });
                }
            });
        }
    }

    private void openFolder(long folderId) {
        if (folderId <= 0) { Util.toast(this, "该文件夹在根目录"); return; }
        Intent i = new Intent(this, FilesActivity.class);
        i.putExtra("folderId", folderId);
        startActivity(i);
    }

    /** 错误状态：页面内空状态占位 + 统一的圆形自绘弹窗（Util.info）提示，可重试 */
    private void showError(String msg, final Runnable retry) {
        areaReset();
        final String text = msg == null || msg.length() == 0 ? Util.MSG_NET : msg;
        area.addView(Util.emptyState(this, "!", "搜索失败", text, null, null),
                Util.lpM(-1, -2, 0, dp(24), 0, 0));
        Util.Btn[] acts;
        if (retry != null) {
            acts = new Util.Btn[]{
                    new Util.Btn("关闭", Util.KIND_PLAIN, null),
                    new Util.Btn("重试", Util.KIND_PRIMARY, new Util.Cb() {
                        @Override public void run() { retry.run(); }
                    })
            };
        } else {
            acts = new Util.Btn[]{new Util.Btn("关闭", Util.KIND_PLAIN, null)};
        }
        Util.info(this, "搜索失败", text, acts);
    }
}
