package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Http;
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
import java.util.Locale;

/** 团队页：创建/加入团队、团队文件、成员管理（底部导航 active=团队） */
public class TeamsActivity extends ThemeActivity {

    private static final int REQ_PICK = 1001;

    private LinearLayout content;
    private int tab; // 0=团队文件 1=成员

    private JSONObject team;          // 当前团队（每用户限1团队）
    private JSONArray teamFiles = new JSONArray();
    private JSONArray members = new JSONArray();
    private long teamId;
    private boolean isOwner;
    private String teamName = "";
    private String ownerName = "";
    private String ownerUid = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());
        root.addView(ShellUi.headerT(this, "团队"), new LinearLayout.LayoutParams(
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

        root.addView(ShellUi.bottomNav(this, ShellUi.TAB_TEAMS), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_TEAMS));
        load();
    }

    // ---------- 后台数据 ----------

    /** 允许 run() 内抛出受检异常，由 Util.async 统一捕获转 err 回调 */
    private interface Bg { void run() throws Exception; }

    /** 后台线程拉取列表（含团队/文件/成员） */
    private void fetchAll() throws Api.ApiException {
        JSONObject root = Api.list(null);
        JSONArray ts = Util.a(root, "teams");
        if (ts == null || ts.length() == 0) {
            team = null;
            teamFiles = new JSONArray();
            members = new JSONArray();
            teamId = 0;
            isOwner = false;
            teamName = "";
            ownerName = "";
            ownerUid = "";
            tab = 0;
            return;
        }
        team = ts.optJSONObject(0);
        teamFiles = Util.a(team, "files");
        if (teamFiles == null) teamFiles = new JSONArray();
        members = Util.a(team, "members");
        if (members == null) members = new JSONArray();
        teamId = Util.l(team, "id");
        isOwner = Util.b(team, "isOwner");
        teamName = Util.s(team, "name");
        ownerName = Util.s(team, "owner_name");
        ownerUid = Util.s(team, "owner_uid");
    }

    private void load() {
        final Dialog ld = Util.loading(this, "加载中…");
        Util.async(new Runnable() {
            @Override public void run() {
                try { fetchAll(); }
                catch (Exception e) { TeamsActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); render(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                ld.dismiss();
                final String msg = e == null ? "加载失败" : e;
                Util.info(TeamsActivity.this, "加载失败", msg, new Util.Btn[]{
                        new Util.Btn("关闭", Util.KIND_PLAIN, null),
                        new Util.Btn("重试", Util.KIND_PRIMARY, new Util.Cb() {
                            @Override public void run() { load(); }
                        })
                });
                render();
            }
        });
    }

    /** 通用后台操作：bg 内先执行变更再 fetchAll；失败仅 toast，不改动 UI */
    private void op(final String loadingMsg, final Bg bg, final String okMsg) {
        final Dialog ld = Util.loading(this, loadingMsg);
        Util.async(new Runnable() {
            @Override public void run() {
                try { bg.run(); }
                catch (Exception e) { TeamsActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (okMsg != null) Util.toast(TeamsActivity.this, okMsg);
                render();
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                ld.dismiss();
                Util.toast(TeamsActivity.this, e == null ? "操作失败" : e);
            }
        });
    }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T {
        throw (T) t;
    }
    // ---------- 渲染 ----------

    private void render() {
        content.removeAllViews();
        if (team == null) renderNoTeam();
        else renderTeam();
    }

    private void renderNoTeam() {
        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(20), dp(16), dp(20));

        TextView t1 = Util.text(this, "您还未加入团队", ThemeUi.cText(), 17, Typeface.BOLD);
        t1.setGravity(Gravity.CENTER);
        card.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(8)));

        TextView t2 = Util.text(this, "创建团队后即可与成员共享文件，\n或输入队长的UID加入已有团队。",
                ThemeUi.cSub(), 13, Typeface.NORMAL);
        t2.setGravity(Gravity.CENTER);
        card.addView(t2, Util.lpM(-1, -2, 0, 0, 0, dp(20)));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        Button create = Util.solid(this, "创建团队", ThemeUi.cBrand(), 0xFFFFFFFF);
        create.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askCreate(); }
        });
        Button join = Util.outline(this, "加入团队", ThemeUi.cBrand());
        join.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askJoin(); }
        });
        LinearLayout.LayoutParams lp1 = new LinearLayout.LayoutParams(0, dp(44), 1f);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, dp(44), 1f);
        lp2.setMargins(dp(12), 0, 0, 0);
        row.addView(create, lp1);
        row.addView(join, lp2);
        card.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));

        content.addView(card, Util.lpM(-1, -2, 0, dp(4), 0, 0));
    }

    private void renderTeam() {
        LinearLayout card = ShellUi.card(this);
        card.setPadding(dp(16), dp(16), dp(16), dp(12));

        TextView nm = Util.text(this, teamName.length() == 0 ? "我的团队" : teamName,
                ThemeUi.cText(), 20, Typeface.BOLD);
        nm.setSingleLine(true);
        nm.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(nm, Util.lpM(-1, -2, 0, 0, 0, dp(6)));

        LinearLayout meta = new LinearLayout(this);
        meta.setOrientation(LinearLayout.HORIZONTAL);
        meta.setGravity(Gravity.CENTER_VERTICAL);
        TextView m1 = Util.text(this, "队长：" + ownerName, ThemeUi.cSub(), 13, Typeface.NORMAL);
        meta.addView(m1, new LinearLayout.LayoutParams(0, -2, 1f));
        if (isOwner) {
            TextView badge = Util.text(this, "您是队长", ThemeUi.cBrand(), 13, Typeface.BOLD);
            meta.addView(badge, Util.lp(-2, -2));
        }
        card.addView(meta, Util.lpM(-1, -2, 0, 0, 0, dp(10)));

        View dv = new View(this);
        dv.setBackgroundColor(ThemeUi.cLine());
        card.addView(dv, Util.lpM(-1, 1, 0, 0, 0, dp(12)));

        LinearLayout ops = new LinearLayout(this);
        ops.setOrientation(LinearLayout.HORIZONTAL);
        if (isOwner) {
            Button add = Util.solid(this, "添加成员", ThemeUi.cBrand(), 0xFFFFFFFF);
            add.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { askAddMember(); }
            });
            Button pwd = Util.outline(this, "团队密码", ThemeUi.cBrand());
            pwd.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { askTeamPassword(); }
            });
            Button dis = Util.outline(this, "解散团队", ThemeUi.cDanger());
            dis.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { askDissolve(); }
            });
            Button up = Util.solid(this, "上传到团队", ThemeUi.cBrand(), 0xFFFFFFFF);
            up.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { doUpload(); }
            });
            ops.addView(add, weightBtn());
            ops.addView(pwd, weightBtn());
            ops.addView(dis, weightBtn());
            ops.addView(up, weightBtn());
        } else {
            Button quit = Util.outline(this, "退出团队", ThemeUi.cDanger());
            quit.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { askLeave(); }
            });
            Button up = Util.solid(this, "上传到团队", ThemeUi.cBrand(), 0xFFFFFFFF);
            up.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { doUpload(); }
            });
            ops.addView(quit, weightBtn());
            ops.addView(up, weightBtn());
        }
        card.addView(ops, Util.lpM(-1, -2, 0, 0, 0, 0));
        content.addView(card, Util.lpM(-1, -2, 0, dp(4), 0, 0));

        // 页签卡
        LinearLayout body = ShellUi.card(this);
        body.setOrientation(LinearLayout.VERTICAL);

        LinearLayout tabRow = new LinearLayout(this);
        tabRow.setOrientation(LinearLayout.HORIZONTAL);
        tabRow.setGravity(Gravity.CENTER);
        TextView tf = tabText("团队文件", tab == 0);
        tf.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { tab = 0; render(); }
        });
        TextView tm = tabText("成员", tab == 1);
        tm.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { tab = 1; render(); }
        });
        tabRow.addView(tf, new LinearLayout.LayoutParams(0, dp(44), 1f));
        tabRow.addView(tm, new LinearLayout.LayoutParams(0, dp(44), 1f));
        body.addView(tabRow, Util.lpM(-1, -2, 0, 0, 0, 0));

        View line = new View(this);
        line.setBackgroundColor(ThemeUi.cLine());
        body.addView(line, Util.lpM(-1, 1, 0, 0, 0, 0));

        LinearLayout area = new LinearLayout(this);
        area.setOrientation(LinearLayout.VERTICAL);
        body.addView(area, Util.lpM(-1, -2, 0, 0, 0, 0));

        content.addView(body, Util.lpM(-1, -2, 0, dp(10), 0, 0));

        if (tab == 0) buildFilesTab(area);
        else buildMembersTab(area);
    }

    private void buildFilesTab(LinearLayout area) {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        Button up = Util.solid(this, "上传到团队", ThemeUi.cBrand(), 0xFFFFFFFF);
        up.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doUpload(); }
        });
        TextView ref = Util.text(this, "刷新", ThemeUi.cBrand(), 15, Typeface.NORMAL);
        ref.setGravity(Gravity.CENTER);
        ref.setPadding(dp(14), dp(8), dp(10), dp(8));
        ref.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { load(); }
        });
        bar.addView(up, Util.lp(-2, dp(44)));
        bar.addView(ref, new LinearLayout.LayoutParams(0, dp(44), 1f));
        area.addView(bar, Util.lpM(-1, -2, dp(12), dp(12), dp(12), 0));

        if (teamFiles.length() == 0) {
            area.addView(Util.emptyState(this, "文", Util.MSG_EMPTY, "点击上方按钮上传团队文件", null, null),
                    Util.lpM(-1, -2, 0, dp(16), 0, dp(16)));
            return;
        }
        FitListView lv = new FitListView(this);
        lv.setAdapter(new FileAdapter());
        lv.setDivider(null);
        lv.setDividerHeight(0);
        lv.setVerticalScrollBarEnabled(false);
        lv.setOnItemClickListener(new AdapterView.OnItemClickListener() {
            @Override public void onItemClick(AdapterView<?> p, View v, int pos, long id) {
                showFileMenu(pos);
            }
        });
        area.addView(lv, Util.lpM(-1, -2, dp(8), 0, dp(8), 0));
    }

    private void buildMembersTab(LinearLayout area) {
        if (members.length() == 0) {
            area.addView(Util.emptyState(this, "队", Util.MSG_EMPTY, "该团队暂无成员", null, null),
                    Util.lpM(-1, -2, 0, dp(16), 0, dp(16)));
            return;
        }
        FitListView lv = new FitListView(this);
        lv.setAdapter(new MemberAdapter());
        lv.setDivider(null);
        lv.setDividerHeight(0);
        lv.setVerticalScrollBarEnabled(false);
        area.addView(lv, Util.lpM(-1, -2, dp(8), 0, dp(8), 0));
    }

    private TextView tabText(String s, boolean active) {
        TextView t = Util.text(this, s, active ? ThemeUi.cBrand() : ThemeUi.cMute(), 15,
                active ? Typeface.BOLD : Typeface.NORMAL);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    private LinearLayout.LayoutParams weightBtn() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(40), 1f);
        p.setMargins(0, 0, dp(8), 0);
        return p;
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
    // ---------- 团队操作 ----------

    private void askCreate() {
        Util.input(this, "创建团队", "请输入团队名称", "", new Util.InputCb() {
            @Override public void run(String name) {
                if (name.length() == 0) { Util.toast(TeamsActivity.this, "请输入团队名称"); return; }
                askCreatePassword(name);
            }
        });
    }

    private void askCreatePassword(final String name) {
        Util.input(this, "团队密码（可选）", "≥4位；留空则无需密码即可加入", "", new Util.InputCb() {
            @Override public void run(String p) {
                final String pwd = p == null ? "" : p.trim();
                if (pwd.length() > 0 && pwd.length() < 4) { Util.toast(TeamsActivity.this, "团队密码至少4位字符"); return; }
                op("创建中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamCreate(name, pwd);
                        fetchAll();
                    }
                }, "团队创建成功");
            }
        });
    }

    private void askTeamPassword() {
        Util.input(this, "团队密码", "输入新密码（≥4位）；留空=清除密码", "", new Util.InputCb() {
            @Override public void run(String p) {
                final String pwd = p == null ? "" : p.trim();
                if (pwd.length() > 0 && pwd.length() < 4) { Util.toast(TeamsActivity.this, "团队密码至少4位字符"); return; }
                op("保存中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamSetPassword(teamId, pwd);
                        fetchAll();
                    }
                }, pwd.length() == 0 ? "已清除团队密码" : "团队密码已设置");
            }
        });
    }

    private void askJoin() {
        Util.input(this, "加入团队", "请输入创建者UID（自动转大写）", "", new Util.InputCb() {
            @Override public void run(String uid) {
                if (uid.length() == 0) { Util.toast(TeamsActivity.this, "请输入创建者UID"); return; }
                final String u = uid.toUpperCase(Locale.CHINA);
                final boolean[] needPwd = {false};
                final Dialog ld = Util.loading(TeamsActivity.this, "查询团队…");
                Util.async(new Runnable() {
                    @Override public void run() {
                        try {
                            JSONObject info = Api.teamInfo(u);
                            if (!info.optBoolean("exists", false)) throw new Api.ApiException("未找到该UID对应的团队");
                            needPwd[0] = info.optBoolean("hasPassword", false);
                        } catch (Exception e) { TeamsActivity.<RuntimeException>sneaky(e); }
                    }
                }, new Util.Cb() {
                    @Override public void run() {
                        ld.dismiss();
                        if (needPwd[0]) askJoinPassword(u);
                        else doJoin(u, "");
                    }
                }, new Util.ErrCb() {
                    @Override public void run(String e) { ld.dismiss(); Util.toast(TeamsActivity.this, e == null ? "查询失败" : e); }
                });
            }
        });
    }

    private void askJoinPassword(final String u) {
        Util.input(this, "团队密码", "该团队设置了密码，请输入正确密码", "", new Util.InputCb() {
            @Override public void run(String p) {
                final String pwd = p == null ? "" : p.trim();
                if (pwd.length() == 0) { Util.toast(TeamsActivity.this, "请输入团队密码"); return; }
                doJoin(u, pwd);
            }
        });
    }

    private void doJoin(final String u, final String pwd) {
        op("加入中…", new Bg() {
            @Override public void run() throws Exception {
                Api.teamJoin(u, pwd);
                fetchAll();
            }
        }, "加入成功");
    }

    private void askLeave() {
        final String name = teamName;
        Util.confirm(this, "退出团队", "确定退出团队「" + name + "」？退出后将无法访问团队文件。", new Util.Cb() {
            @Override public void run() {
                op("处理中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamLeave(teamId);
                        fetchAll();
                    }
                }, "已退出团队");
            }
        });
    }

    private void askDissolve() {
        Util.password(this, "解散团队", new Util.InputCb() {
            @Override public void run(String pw) {
                if (pw.length() == 0) { Util.toast(TeamsActivity.this, "请输入账户密码"); return; }
                op("处理中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamDissolve(teamId, pw);
                        fetchAll();
                    }
                }, "团队已解散");
            }
        });
    }

    private void askAddMember() {
        Util.input(this, "添加成员", "请输入目标用户UID", "", new Util.InputCb() {
            @Override public void run(String uid) {
                if (uid.length() == 0) { Util.toast(TeamsActivity.this, "请输入目标用户UID"); return; }
                final String u = uid.toUpperCase(Locale.CHINA);
                op("添加中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamAddMember(teamId, u);
                        fetchAll();
                    }
                }, "已添加成员");
            }
        });
    }

    private void removeMember(final JSONObject m) {
        final String name = Util.s(m, "username");
        Util.confirm(this, "移出成员", "确定将「" + name + "」移出团队？", new Util.Cb() {
            @Override public void run() {
                op("处理中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.teamRemoveMember(teamId, Util.l(m, "id"));
                        fetchAll();
                    }
                }, "已移出成员");
            }
        });
    }

    // ---------- 团队文件操作 ----------

    private void showFileMenu(final int pos) {
        final JSONObject f = teamFiles.optJSONObject(pos);
        if (f == null) return;
        final String fn = Util.s(f, "filename");
        final String title = fn.length() == 0 ? "未命名文件" : fn;
        // M3 菜单：预览/下载/删除（删除标红）
        Util.menu(this, title, new String[]{"预览", "下载", "删除"}, 2, false, new Util.MenuCb() {
            @Override public void run(int which) {
                if (which == 0) doPreview(f);
                else if (which == 1) doDownload(f);
                else doDelete(f);
            }
        });
    }

    private void doPreview(final JSONObject f) {
        final Dialog ld = Util.loading(this, "获取预览…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.teamPreview(teamId, Util.l(f, "id"));
                    url[0] = pickUrl(r);
                } catch (Exception e) { TeamsActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(TeamsActivity.this, "该文件暂不支持预览");
                else Util.openUrl(TeamsActivity.this, url[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(TeamsActivity.this, e); }
        });
    }

    private void doDownload(final JSONObject f) {
        final long fileId = Util.l(f, "id");
        final String fn = Util.s(f, "filename");
        if (android.os.Build.VERSION.SDK_INT < 23) {
            Util.download(this, Api.teamDownloadProxyUrl(teamId, fileId), fn.length() == 0 ? "file" : fn);
            return;
        }
        final Dialog ld = Util.loading(this, "获取下载地址…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.teamDownloadPresign(teamId, Util.l(f, "id"));
                    url[0] = pickUrl(r);
                } catch (Exception e) { TeamsActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(TeamsActivity.this, "获取下载地址失败");
                else Util.download(TeamsActivity.this, url[0], fn.length() == 0 ? "file" : fn);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(TeamsActivity.this, e); }
        });
    }

    private void doDelete(final JSONObject f) {
        final String fn = Util.s(f, "filename");
        final String title = fn.length() == 0 ? "未命名文件" : fn;
        Util.confirm(this, "删除文件", "确定删除「" + title + "」？删除后不可恢复。", new Util.Cb() {
            @Override public void run() {
                op("删除中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.fileDelete(Util.l(f, "id"));
                        fetchAll();
                    }
                }, "已删除");
            }
        });
    }

    private String pickUrl(JSONObject r) {
        if (r == null) return "";
        String[] keys = {"uploadUrl", "url", "previewUrl", "downloadUrl"};
        for (String k : keys) {
            String u = r.optString(k, "");
            if (u != null && u.length() > 0) return u;
        }
        return "";
    }
    // ---------- 上传 ----------

    private void doUpload() {
        Util.pickFile(this, REQ_PICK);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK && resultCode == RESULT_OK && data != null && data.getData() != null) {
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

                    JSONObject pre = Api.presignUpload(name, false, teamId, null, mime, len);
                    String url = pickUrl(pre);
                    String stored = pre.optString("storedName", "");
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
                        // 老版本安卓直连对象存储常因 TLS/SNI 兼容失败：回退服务端分片上传（支持团队，带进度）
                        Transfer.note(tId[0], "改用服务端分片上传…");
                        Api.uploadChunked(tmp, name, false, teamId, Transfer.upProgress(tId[0]));
                        Transfer.finish(tId[0], true, null);
                        fetchAll();
                        return;
                    }
                    Api.confirmUpload(stored, name, len, false, teamId, null);
                    Transfer.finish(tId[0], true, null);
                    fetchAll();
                } catch (Exception e) {
                    if (tId[0] != 0) Transfer.finish(tId[0], false, e.getMessage());
                    TeamsActivity.<RuntimeException>sneaky(e);
                } finally {
                    if (tmp != null) tmp.delete();
                }
            }
        }, new Util.Cb() {
            @Override public void run() {
                Util.toast(TeamsActivity.this, Util.MSG_UPLOAD_OK);
                render();
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { Util.toast(TeamsActivity.this, e); }
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
            int heightSpec = android.view.View.MeasureSpec.makeMeasureSpec(
                    Integer.MAX_VALUE >> 2, android.view.View.MeasureSpec.AT_MOST);
            super.onMeasure(widthMeasureSpec, heightSpec);
            if (getLayoutParams() != null) getLayoutParams().height = getMeasuredHeight();
        }
    }

    private class FileAdapter extends BaseAdapter {
        @Override public int getCount() { return teamFiles.length(); }
        @Override public Object getItem(int p) { return teamFiles.opt(p); }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(final int position, View convertView, ViewGroup parent) {
            JSONObject f = teamFiles.optJSONObject(position);
            if (f == null) return new View(TeamsActivity.this);
            String name = Util.s(f, "filename");
            if (name.length() == 0) name = "未命名文件";
            final int pos = position;

            float d = getResources().getDisplayMetrics().density;
            LinearLayout box = new LinearLayout(TeamsActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);

            LinearLayout row = new LinearLayout(TeamsActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding((int) (2 * d), (int) (9 * d), (int) (2 * d), (int) (9 * d));

            // 类型图标块（彩色底 + 扩展名标签；深色自动压暗）
            TextView icon = new TextView(TeamsActivity.this);
            icon.setText(extTag(name));
            icon.setTextColor(ThemeUi.chipFg(ThemeUi.typeChipFg(ThemeUi.TYPE_IMAGE)));
            icon.setTextSize(12);
            icon.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            icon.setGravity(Gravity.CENTER);
            GradientDrawable g = new GradientDrawable();
            g.setColor(ThemeUi.chipBg(ThemeUi.typeChipBg(ThemeUi.TYPE_IMAGE)));
            g.setCornerRadius((int) (8 * d));
            icon.setBackground(g);
            row.addView(icon, Util.lp((int) (34 * d), (int) (34 * d)));
            row.setMinimumHeight((int) (56 * d));

            LinearLayout col = new LinearLayout(TeamsActivity.this);
            col.setOrientation(LinearLayout.VERTICAL);
            TextView t1 = Util.text(TeamsActivity.this, name, ThemeUi.cText(), 15, Typeface.NORMAL);
            t1.setSingleLine(true);
            t1.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, (int) (3 * d)));

            String size = Util.fmtSize(Util.l(f, "file_size"));
            String who = Util.s(f, "uploader_name");
            String when = Util.fmtDbTime(Util.s(f, "uploaded_at"));
            StringBuilder sb = new StringBuilder(size);
            if (who.length() > 0) sb.append(" · ").append(who);
            if (when.length() > 0) sb.append(" · ").append(when);
            TextView t2 = Util.text(TeamsActivity.this, sb.toString(), ThemeUi.cMute(), 12, Typeface.NORMAL);
            t2.setSingleLine(true);
            t2.setEllipsize(TextUtils.TruncateAt.END);
            col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
            cp.setMargins((int) (10 * d), 0, 0, 0);
            row.addView(col, cp);

            TextView more = Util.text(TeamsActivity.this, "⋯", ThemeUi.cMute(), 18, Typeface.BOLD);
            more.setGravity(Gravity.CENTER);
            more.setPadding((int) (6 * d), 0, (int) (6 * d), 0);
            more.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { showFileMenu(pos); }
            });
            Util.setFeedback(more);
            row.addView(more, Util.lp(-2, (int) (34 * d)));

            box.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
            if (position < getCount() - 1) {
                View dv = new View(TeamsActivity.this);
                dv.setBackgroundColor(ThemeUi.cLine());
                box.addView(dv, Util.lpM(-1, 1, (int) (44 * d), 0, 0, 0));
            }
            return box;
        }
    }

    /** 图标标签：扩展名（<=3 大写），无扩展名用「文」 */
    private String extTag(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "文";
        String ext = name.substring(dot + 1).toUpperCase(Locale.CHINA);
        if (ext.length() == 0) return "文";
        return ext.length() > 3 ? ext.substring(0, 3) : ext;
    }

    private class MemberAdapter extends BaseAdapter {
        @Override public int getCount() { return members.length(); }
        @Override public Object getItem(int p) { return members.opt(p); }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(final int position, View convertView, ViewGroup parent) {
            final JSONObject m = members.optJSONObject(position);
            if (m == null) return new View(TeamsActivity.this);
            float d = getResources().getDisplayMetrics().density;
            final String name = Util.s(m, "username");
            final String uid = Util.s(m, "uid");
            final boolean isCap = ownerUid.length() > 0 && uid.equals(ownerUid);

            LinearLayout box = new LinearLayout(TeamsActivity.this);
            box.setOrientation(LinearLayout.VERTICAL);

            LinearLayout row = new LinearLayout(TeamsActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding((int) (2 * d), (int) (11 * d), (int) (2 * d), (int) (11 * d));
            row.setMinimumHeight((int) (56 * d));

            LinearLayout left = new LinearLayout(TeamsActivity.this);
            left.setOrientation(LinearLayout.VERTICAL);
            TextView t1 = Util.text(TeamsActivity.this, name.length() == 0 ? "成员" : name,
                    ThemeUi.cText(), 15, Typeface.NORMAL);
            t1.setSingleLine(true);
            t1.setEllipsize(TextUtils.TruncateAt.END);
            left.addView(t1, Util.lpM(-1, -2, 0, 0, 0, (int) (3 * d)));
            TextView t2 = Util.text(TeamsActivity.this, "UID: " + uid, ThemeUi.cMute(), 12, Typeface.NORMAL);
            t2.setSingleLine(true);
            left.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
            row.addView(left, new LinearLayout.LayoutParams(0, -2, 1f));

            TextView role = Util.text(TeamsActivity.this, isCap ? "队长" : "成员",
                    isCap ? ThemeUi.cBrand() : ThemeUi.cSub(), 13,
                    isCap ? Typeface.BOLD : Typeface.NORMAL);
            role.setGravity(Gravity.CENTER);
            role.setPadding((int) (8 * d), (int) (3 * d), (int) (8 * d), (int) (3 * d));
            row.addView(role, Util.lp(-2, -2));

            if (isOwner && !isCap) {
                TextView rm = Util.text(TeamsActivity.this, "移出", ThemeUi.cDanger(), 13, Typeface.NORMAL);
                rm.setGravity(Gravity.CENTER);
                rm.setClickable(true);
                rm.setPadding((int) (12 * d), (int) (4 * d), 0, (int) (4 * d));
                rm.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { removeMember(m); }
                });
                row.addView(rm, Util.lp(-2, -2));
            }

            row.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    String t = name.length() == 0 ? "成员" : name;
                    // M3 信息弹窗：展示 UID，主操作「复制UID」放最右
                    Util.info(TeamsActivity.this, t, "UID: " + uid, new Util.Btn[]{
                            new Util.Btn("取消", Util.KIND_PLAIN, null),
                            new Util.Btn("复制UID", Util.KIND_PRIMARY, new Util.Cb() {
                                @Override public void run() { Util.copy(TeamsActivity.this, uid); }
                            })
                    });
                }
            });

            box.addView(row, Util.lpM(-1, -2, 0, 0, 0, 0));
            if (position < getCount() - 1) {
                View dv = new View(TeamsActivity.this);
                dv.setBackgroundColor(ThemeUi.cLine());
                box.addView(dv, Util.lpM(-1, 1, 0, 0, 0, 0));
            }
            return box;
        }
    }
}