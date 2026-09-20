package com.cubecute.ccyun.ui;

import android.app.Dialog;
import android.database.Cursor;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
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
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import com.cubecute.ccyun.net.Api;
import com.cubecute.ccyun.net.Constants;
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

/** 文件页：我的文件（Cloudreve 风格目录浏览：顶栏面包屑 + 列表/网格切换 + 批量操作栏） */
public class FilesActivity extends ThemeActivity {

    private static final int REQ_PICK = 1001;

    private static final String EXTS_IMG = ",jpg,jpeg,png,gif,bmp,webp,ico,svg,heic,";
    private static final String EXTS_VIDEO = ",mp4,avi,mkv,mov,wmv,flv,3gp,webm,ts,";
    private static final String EXTS_ZIP = ",zip,rar,7z,tar,gz,bz2,xz,iso,";
    private static final String EXTS_DOC = ",pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,csv,odt,rtf,";

    private LinearLayout topHost;
    private LinearLayout content;
    private Long curFolderId; // null=根目录
    private JSONArray folderPath = new JSONArray();
    private JSONArray folders = new JSONArray();
    private JSONArray files = new JSONArray();
    private ListView listView;
    private TextView selCount;
    private boolean selMode = false;
    private final java.util.HashSet<String> selSet = new java.util.HashSet<String>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(ThemeUi.cPage());

        topHost = new LinearLayout(this);
        topHost.setOrientation(LinearLayout.VERTICAL);
        root.addView(topHost, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pp = Util.pagePad(this);
        content.setPadding(pp, dp(12), pp, dp(8));
        root.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(ShellUi.bottomNav(this, ShellUi.TAB_FILES), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        setContentView(ShellUi.attachDrawer(this, root, ShellUi.NAV_FILES));
        Util.ensureStorage(this);
        // 搜索结果直达某文件夹
        long openId = getIntent().getLongExtra("folderId", 0L);
        if (openId > 0) curFolderId = openId;
        load();
    }

    // ---------- 后台数据 ----------

    /** 允许 run() 内抛出受检异常，由 Util.async 统一捕获转 err 回调 */
    private interface Bg { void run() throws Exception; }

    @SuppressWarnings("unchecked")
    private static <T extends Throwable> void sneaky(Throwable t) throws T {
        throw (T) t;
    }

    private void fetch() throws Api.ApiException {
        JSONObject r = Api.list(curFolderId);
        folders = Util.a(r, "folders");
        if (folders == null) folders = new JSONArray();
        files = Util.a(r, "files");
        if (files == null) files = new JSONArray();
        folderPath = Util.a(r, "folderPath");
        if (folderPath == null) folderPath = new JSONArray();
    }

    private void load() {
        final Dialog ld = Util.loading(this, "加载中…");
        Util.async(new Runnable() {
            @Override public void run() {
                try { fetch(); }
                catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() { ld.dismiss(); render(); }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                ld.dismiss();
                final String msg = e == null ? "加载失败" : e;
                Util.info(FilesActivity.this, "加载失败", msg, new Util.Btn[]{
                        new Util.Btn("关闭", Util.KIND_PLAIN, null),
                        new Util.Btn("重试", Util.KIND_PRIMARY, new Util.Cb() {
                            @Override public void run() { load(); }
                        })
                });
            }
        });
    }

    /** 通用后台操作：bg 内先执行变更再 fetch；失败仅 toast，不改动 UI */
    private void op(final String loadingMsg, final Bg bg, final String okMsg) {
        final Dialog ld = Util.loading(this, loadingMsg);
        Util.async(new Runnable() {
            @Override public void run() {
                try { bg.run(); }
                catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (okMsg != null) Util.toast(FilesActivity.this, okMsg);
                render();
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                ld.dismiss();
                Util.toast(FilesActivity.this, e == null ? "操作失败" : e);
            }
        });
    }

    // ---------- 渲染 ----------

    private void render() {
        if (topHost == null || content == null) return;
        sortData();
        topHost.removeAllViews();
        topHost.addView(buildTopBar(), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        content.removeAllViews();
        content.addView(selMode ? buildSelBar() : buildToolbar(), Util.lpM(-1, -2, 0, 0, 0, 0));
        if (folders.length() == 0 && files.length() == 0) {
            addEmpty(selMode ? "当前目录暂无可选择的项目" : "点击上方「上传」或「新建文件夹」添加内容");
            return;
        }
        ListView lv = new ListView(this);
        lv.setDivider(new ColorDrawable(0x00000000));
        lv.setDividerHeight(dp(6));
        lv.setVerticalScrollBarEnabled(false);
        lv.setCacheColorHint(0x00000000);
        lv.setSelector(new ColorDrawable(0x00000000));
        final boolean grid = ThemeUi.isGrid(this);
        lv.setAdapter(grid ? new GridAdapter() : new MineAdapter());
        listView = lv;
        if (!grid) {
            lv.setOnItemClickListener(new AdapterView.OnItemClickListener() {
                @Override public void onItemClick(AdapterView<?> p, View v, int pos, long id) {
                    boolean isFolder = pos < folders.length();
                    JSONObject o = isFolder ? folders.optJSONObject(pos) : files.optJSONObject(pos - folders.length());
                    onItemTap(isFolder, o);
                }
            });
            lv.setOnItemLongClickListener(new AdapterView.OnItemLongClickListener() {
                @Override public boolean onItemLongClick(AdapterView<?> p, View v, int pos, long id) {
                    if (selMode) return true;
                    if (pos < folders.length()) {
                        showFolderMenu(folders.optJSONObject(pos));
                        return true;
                    }
                    showFileMenu(files.optJSONObject(pos - folders.length()));
                    return true;
                }
            });
        }
        addList(lv);
    }

    /** 条目点击：多选态=切换选中；文件夹=进入；文件=菜单 */
    private void onItemTap(boolean isFolder, JSONObject o) {
        if (o == null) return;
        if (selMode) {
            toggleSel(isFolder, Util.l(o, "id"));
            return;
        }
        if (isFolder) enterFolder(o);
        else showFileMenu(o);
    }

    // ---------- 排序（纯 UI 层，排序偏好持久化在 ThemeUi） ----------

    private void sortData() {
        if (folders != null) folders = sortArray(folders, true);
        if (files != null) files = sortArray(files, false);
    }

    private JSONArray sortArray(JSONArray src, final boolean folder) {
        if (src == null) return new JSONArray();
        if (src.length() <= 1) return src;
        final int key = ThemeUi.sortKey(this);
        final boolean asc = ThemeUi.sortAsc(this);
        java.util.List<JSONObject> list = new java.util.ArrayList<JSONObject>();
        for (int i = 0; i < src.length(); i++) {
            JSONObject o = src.optJSONObject(i);
            if (o != null) list.add(o);
        }
        java.util.Collections.sort(list, new java.util.Comparator<JSONObject>() {
            @Override public int compare(JSONObject a, JSONObject b) {
                int r;
                if (key == ThemeUi.SORT_SIZE && !folder) {
                    long x = Util.l(a, "file_size"), y = Util.l(b, "file_size");
                    r = x < y ? -1 : (x > y ? 1 : 0);
                } else if (key == ThemeUi.SORT_TIME) {
                    String x = folder ? Util.s(a, "created_at") : Util.s(a, "uploaded_at");
                    String y = folder ? Util.s(b, "created_at") : Util.s(b, "uploaded_at");
                    r = x.compareTo(y);
                } else {
                    String x = folder ? Util.s(a, "name") : Util.s(a, "filename");
                    String y = folder ? Util.s(b, "name") : Util.s(b, "filename");
                    r = x.compareToIgnoreCase(y);
                }
                return asc ? r : -r;
            }
        });
        JSONArray out = new JSONArray();
        for (int i = 0; i < list.size(); i++) out.put(list.get(i));
        return out;
    }

    private void showSortMenu() {
        final int cur = ThemeUi.sortKey(this);
        final boolean asc = ThemeUi.sortAsc(this);
        String arrow = asc ? " ↑" : " ↓";
        String[] items = {
                "按名称" + (cur == ThemeUi.SORT_NAME ? arrow : ""),
                "按大小" + (cur == ThemeUi.SORT_SIZE ? arrow : ""),
                "按修改时间" + (cur == ThemeUi.SORT_TIME ? arrow : ""),
                "切换为" + (asc ? "降序" : "升序")
        };
        Util.menu(this, "排序方式（文件夹优先显示）", items, -1, true, new Util.MenuCb() {
            @Override public void run(int which) {
                if (which == 0) ThemeUi.setSortKey(FilesActivity.this, ThemeUi.SORT_NAME);
                else if (which == 1) ThemeUi.setSortKey(FilesActivity.this, ThemeUi.SORT_SIZE);
                else if (which == 2) ThemeUi.setSortKey(FilesActivity.this, ThemeUi.SORT_TIME);
                else ThemeUi.setSortAsc(FilesActivity.this, !asc);
                render();
            }
        });
    }

    // ---------- 顶栏（汉堡 + 面包屑 + 搜索/＋传输进度/⋯溢出菜单） ----------

    private View buildTopBar() {
        LinearLayout crumbRow = new LinearLayout(this);
        HorizontalScrollView crumb = ShellUi.crumbHost(this, crumbRow);

        final int n = folderPath.length();
        addCrumbPiece(crumbRow, "文件", n == 0, 0);
        for (int i = 1; i <= n; i++) {
            TextView sep = Util.text(this, "/", ThemeUi.cMute(), 13, Typeface.NORMAL);
            sep.setGravity(Gravity.CENTER_VERTICAL);
            sep.setPadding(dp(4), 0, dp(4), 0);
            crumbRow.addView(sep, Util.lp(-2, -1));
            JSONObject fo = folderPath.optJSONObject(i - 1);
            String nm = fo == null ? "" : Util.s(fo, "name");
            if (nm.length() == 0) nm = "…";
            addCrumbPiece(crumbRow, nm, i == n, i);
        }

        // 右侧收敛为「搜索 / ＋ / ⋯」三个；排序与列表/网格切换收进 ⋯ 溢出菜单
        ShellUi.BarOpts opts = new ShellUi.BarOpts();
        opts.overflow = ShellUi.moreBtn(this, new View.OnClickListener() {
            @Override public void onClick(View v) { showMoreMenu(); }
        });
        return ShellUi.bar(this, ShellUi.navBtn(this, false, null), crumb, opts);
    }

    /**
     * ⋯ 溢出菜单（Cloudreve 式「少而精」）：收纳排序与列表/网格切换等低频页内操作，
     * 条目文案直接显示当前状态（排序字段/方向、当前视图），选中后走原有逻辑。
     */
    private void showMoreMenu() {
        final boolean grid = ThemeUi.isGrid(this);
        String[] items = {
                "排序：按" + ThemeUi.sortLabel(this) + (ThemeUi.sortAsc(this) ? " ↑" : " ↓"),
                "视图：" + (grid ? "网格" : "列表")
        };
        Util.menu(this, "更多", items, -1, true, new Util.MenuCb() {
            @Override public void run(int which) {
                if (which == 0) {
                    showSortMenu();
                } else {
                    ThemeUi.setGrid(FilesActivity.this, !grid);
                    render();
                }
            }
        });
    }

    private void addCrumbPiece(LinearLayout row, final String label, boolean isCurrent, final int idx) {
        TextView t = Util.text(this, label, isCurrent ? ThemeUi.cText() : ThemeUi.cBrand(), 15,
                isCurrent ? Typeface.BOLD : Typeface.NORMAL);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.CENTER_VERTICAL);
        t.setPadding(dp(2), 0, dp(2), 0);
        if (!isCurrent) {
            t.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { jumpBreadcrumb(idx); }
            });
            Util.setFeedback(t);
        }
        row.addView(t, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.MATCH_PARENT));
    }

    private void jumpBreadcrumb(int idx) {
        if (idx == 0) curFolderId = null;
        else {
            JSONObject fo = folderPath.optJSONObject(idx - 1);
            curFolderId = fo == null ? null : Util.l(fo, "id");
        }
        load();
    }

    // ---------- 多选模式 ----------

    private void setSelMode(boolean on) {
        selMode = on;
        selSet.clear();
        listView = null;
        render();
    }

    private String selKey(boolean folder, long id) { return (folder ? "d:" : "f:") + id; }

    private void toggleSel(boolean folder, long id) {
        String k = selKey(folder, id);
        if (!selSet.remove(k)) selSet.add(k);
        if (selCount != null) selCount.setText("已选 " + selSet.size() + " 项");
        if (listView != null) listView.invalidateViews();
    }

    private long[] selIds(final boolean folder) {
        java.util.List<Long> a = new java.util.ArrayList<Long>();
        for (String k : selSet) {
            if ((folder && k.startsWith("d:")) || (!folder && k.startsWith("f:"))) {
                try { a.add(Long.valueOf(k.substring(2))); } catch (Exception ignored) {}
            }
        }
        long[] r = new long[a.size()];
        for (int i = 0; i < r.length; i++) r[i] = a.get(i);
        return r;
    }

    private GradientDrawable roundCardSel() {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cBrandChip()); // 多选选中行底色
        gd.setCornerRadius(dp(8));
        gd.setStroke(Math.max(1, (int) (getResources().getDisplayMetrics().density * 0.5f)), ThemeUi.cBrand());
        return gd;
    }

    private void doSelDelete() {
        final long[] fd = selIds(true), ff = selIds(false);
        if (fd.length == 0 && ff.length == 0) { Util.toast(this, "请先选择要删除的项目"); return; }
        String desc = "将 ";
        if (fd.length > 0) desc += fd.length + " 个文件夹";
        if (fd.length > 0 && ff.length > 0) desc += "、";
        if (ff.length > 0) desc += ff.length + " 个文件";
        desc += " 移入回收站（可在回收站恢复）？";
        Util.confirm(this, "批量删除", desc, new Util.Cb() {
            @Override public void run() {
                final Dialog ld = Util.loading(FilesActivity.this, "删除中…");
                Util.async(new Runnable() {
                    @Override public void run() {
                        try { Api.batchDelete(fd, ff); }
                        catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
                    }
                }, new Util.Cb() {
                    @Override public void run() { ld.dismiss(); setSelMode(false); load(); Util.toast(FilesActivity.this, "已移入回收站"); }
                }, new Util.ErrCb() {
                    @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e == null ? "删除失败" : e); }
                });
            }
        });
    }

    /** 批量下载：逐个取预签名地址后交给传输中心（保持与单文件下载同一链路） */
    private void doSelDownload() {
        final long[] ff = selIds(false);
        if (ff.length == 0) { Util.toast(this, "请先选择要下载的文件（文件夹不支持直接下载）"); return; }
        final String[] names = new String[ff.length];
        for (int i = 0; i < ff.length; i++) names[i] = nameOfFile(ff[i]);
        Util.toast(this, "开始下载 " + ff.length + " 个文件");
        dlNext(ff, names, 0);
    }

    private String nameOfFile(long id) {
        for (int i = 0; i < files.length(); i++) {
            JSONObject f = files.optJSONObject(i);
            if (f != null && Util.l(f, "id") == id) {
                String n = Util.s(f, "filename");
                return n.length() == 0 ? "file" : n;
            }
        }
        return "file";
    }

    private void dlNext(final long[] ids, final String[] names, final int i) {
        if (i >= ids.length) return;
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try { url[0] = Api.downloadPresign(ids[i]).optString("downloadUrl", ""); }
                catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                if (url[0].length() > 0) Util.download(FilesActivity.this, url[0], names[i]);
                else Util.toast(FilesActivity.this, "「" + names[i] + "」获取下载地址失败");
                dlNext(ids, names, i + 1);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) {
                Util.toast(FilesActivity.this, e == null ? "获取下载地址失败" : e);
                dlNext(ids, names, i + 1);
            }
        });
    }

    private void doSelShare() {
        final long[] ff = selIds(false);
        if (ff.length == 0) { Util.toast(this, "批量分享仅支持文件，请先选择文件"); return; }
        final Dialog ld = Util.loading(this, "生成分享…");
        final JSONArray[] items = {new JSONArray()};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.batchShare(ff);
                    JSONArray it = Util.a(r, "items");
                    if (it != null) items[0] = it;
                } catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (items[0].length() == 0) Util.toast(FilesActivity.this, "所选文件无法分享");
                else showBatchShareDialog(items[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e == null ? "分享失败" : e); }
        });
    }

    private void showBatchShareDialog(JSONArray items) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < items.length() && i < 15; i++) {
            JSONObject it = items.optJSONObject(i);
            if (it == null) continue;
            sb.append("《").append(Util.s(it, "filename")).append("》\n");
            sb.append("链接：").append(Constants.BASE_URL).append(Util.s(it, "url")).append("\n");
            sb.append("提取码：").append(Util.s(it, "password")).append("\n\n");
        }
        if (items.length() > 15) sb.append("…等共 ").append(items.length()).append(" 项");
        final String text = sb.toString();
        Util.info(this, "批量分享成功", text, new Util.Btn[]{
                new Util.Btn("关闭", Util.KIND_PLAIN, null),
                new Util.Btn("复制全部", Util.KIND_PRIMARY, new Util.Cb() {
                    @Override public void run() { Util.copy(FilesActivity.this, text); }
                })
        });
    }

    // ---------- 移动到 ----------

    private void openFolder(long id) {
        curFolderId = id;
        load();
    }

    private void pickMoveTarget(final boolean isFolder, final long id) {
        final Dialog ld = Util.loading(this, "加载文件夹…");
        final java.util.List<String> labels = new java.util.ArrayList<String>();
        final java.util.List<Long> tids = new java.util.ArrayList<Long>();
        Util.async(new Runnable() {
            @Override public void run() {
                try { collectDirs(null, labels, tids); }
                catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (labels.isEmpty()) { Util.toast(FilesActivity.this, "没有可移动到的文件夹"); return; }
                final String[] items = labels.toArray(new String[labels.size()]);
                Util.menu(FilesActivity.this, "移动到…", items, -1, true, new Util.MenuCb() {
                    @Override public void run(int which) {
                        final long target = tids.get(which);
                        op("移动中…", new Bg() {
                            @Override public void run() throws Exception {
                                if (isFolder) Api.folderMove(id, target);
                                else Api.fileMove(id, target);
                                fetch();
                            }
                        }, "已移动");
                    }
                });
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e == null ? "加载失败" : e); }
        });
    }

    private void collectDirs(Long folderId, java.util.List<String> labels, java.util.List<Long> tids) throws Exception {
        if (folderId == null) {
            labels.add("根目录");
            tids.add(0L);
        }
        JSONObject r = Api.list(folderId);
        JSONArray arr = Util.a(r, "folders");
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject fo = arr.optJSONObject(i);
            if (fo == null) continue;
            long fid = Util.l(fo, "id");
            String name = Util.s(fo, "name");
            // 显示路径前缀
            String p = name;
            for (int j = 0; j < labels.size(); j++) {
                Long l = tids.get(j);
                if (l != null && folderId != null && l.longValue() == folderId.longValue()) {
                    p = labels.get(j) + "/" + name;
                    break;
                }
            }
            labels.add(p);
            tids.add(fid);
            collectDirs(fid, labels, tids);
        }
    }

    // ---------- 搜索 ----------

    private void doSearch() {
        // 完整搜索页（输入框/建议/历史/结果/加载与错误）
        startActivity(new android.content.Intent(FilesActivity.this, SearchActivity.class));
    }

    private void searchGo(final String q) {
        final Dialog ld = Util.loading(this, "搜索中…");
        final JSONArray[] filesA = {new JSONArray()};
        final JSONArray[] foldersA = {new JSONArray()};
        final JSONArray[] teamA = {new JSONArray()};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.search(q);
                    JSONArray t;
                    t = Util.a(r, "files"); if (t != null) filesA[0] = t;
                    t = Util.a(r, "folders"); if (t != null) foldersA[0] = t;
                    t = Util.a(r, "teamFiles"); if (t != null) teamA[0] = t;
                } catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                showSearchResults(filesA[0], foldersA[0], teamA[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e == null ? "搜索失败" : e); }
        });
    }

    private void showSearchResults(JSONArray filesA, JSONArray foldersA, JSONArray teamA) {
        final java.util.List<String> labels = new java.util.ArrayList<String>();
        final java.util.List<Runnable> acts = new java.util.ArrayList<Runnable>();
        if (foldersA != null) {
            for (int i = 0; i < foldersA.length(); i++) {
                final JSONObject fo = foldersA.optJSONObject(i);
                if (fo == null) continue;
                final long fid = Util.l(fo, "id");
                labels.add("文件夹：" + Util.s(fo, "name"));
                acts.add(new Runnable() {
                    @Override public void run() { openFolder(fid); }
                });
            }
        }
        if (filesA != null) {
            for (int i = 0; i < filesA.length(); i++) {
                final JSONObject f = filesA.optJSONObject(i);
                if (f == null) continue;
                labels.add(Util.s(f, "filename"));
                acts.add(new Runnable() {
                    @Override public void run() { showFileMenu(f); }
                });
            }
        }
        if (teamA != null) {
            for (int i = 0; i < teamA.length(); i++) {
                final JSONObject t = teamA.optJSONObject(i);
                if (t == null) continue;
                final long fileId = Util.l(t, "id");
                final long teamId = Util.l(t, "teamId");
                final String fn = Util.s(t, "filename");
                final String teamName = Util.s(t, "teamName");
                labels.add("[" + teamName + "] " + fn);
                acts.add(new Runnable() {
                    @Override public void run() {
                        final Dialog ld2 = Util.loading(FilesActivity.this, "获取下载地址…");
                        final String[] url = {""};
                        Util.async(new Runnable() {
                            @Override public void run() {
                                try { url[0] = Api.teamDownloadPresign(teamId, fileId).optString("downloadUrl", ""); }
                                catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
                            }
                        }, new Util.Cb() {
                            @Override public void run() {
                                ld2.dismiss();
                                if (url[0].length() == 0) Util.toast(FilesActivity.this, "获取下载地址失败");
                                else Util.download(FilesActivity.this, url[0], fn);
                            }
                        }, new Util.ErrCb() {
                            @Override public void run(String e) { ld2.dismiss(); Util.toast(FilesActivity.this, e); }
                        });
                    }
                });
            }
        }
        if (labels.isEmpty()) {
            Util.toast(this, "未找到相关文件");
            return;
        }
        Util.menu(this, "搜索结果", labels.toArray(new String[labels.size()]), -1, true, new Util.MenuCb() {
            @Override public void run(int which) {
                acts.get(which).run();
            }
        });
    }

    /** 批量选择栏：已选 N 项 + 下载/分享/删除/取消 */
    private View buildSelBar() {
        LinearLayout card = ShellUi.card(this);
        LinearLayout ops = new LinearLayout(this);
        ops.setOrientation(LinearLayout.HORIZONTAL);
        ops.setGravity(Gravity.CENTER_VERTICAL);
        ops.setPadding(dp(14), dp(2), dp(6), dp(2));

        TextView cnt = Util.text(this, "已选 " + selSet.size() + " 项", ThemeUi.cText(), 15, Typeface.BOLD);
        cnt.setSingleLine(true);
        selCount = cnt;
        ops.addView(cnt, new LinearLayout.LayoutParams(0, dp(44), 1f));

        ops.addView(actionText("下载", ThemeUi.cBrand(), new View.OnClickListener() {
            @Override public void onClick(View v) { doSelDownload(); }
        }), Util.lp(-2, dp(44)));
        ops.addView(actionText("分享", ThemeUi.cBrand(), new View.OnClickListener() {
            @Override public void onClick(View v) { doSelShare(); }
        }), Util.lpM(-2, dp(44), dp(2), 0, 0, 0));
        ops.addView(actionText("删除", ThemeUi.cDanger(), new View.OnClickListener() {
            @Override public void onClick(View v) { doSelDelete(); }
        }), Util.lpM(-2, dp(44), dp(2), 0, 0, 0));
        ops.addView(actionText("取消", ThemeUi.cSub(), new View.OnClickListener() {
            @Override public void onClick(View v) { setSelMode(false); }
        }), Util.lpM(-2, dp(44), dp(2), 0, 0, 0));

        card.addView(ops, Util.lpM(-1, -2, 0, 0, 0, 0));
        return card;
    }

    /** 顶部工具条：上传 / 新建文件夹 （右侧：回收站、选择） */
    private View buildToolbar() {
        LinearLayout card = ShellUi.card(this);
        LinearLayout ops = new LinearLayout(this);
        ops.setOrientation(LinearLayout.HORIZONTAL);
        ops.setGravity(Gravity.CENTER_VERTICAL);
        ops.setPadding(dp(12), dp(10), dp(8), dp(10));

        Button up = Util.solid(this, "上传", ThemeUi.cBrand(), 0xFFFFFFFF);
        up.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doUpload(); }
        });
        ops.addView(up, Util.lp(-2, dp(36)));
        Button nf = Util.outline(this, "新建文件夹", ThemeUi.cBrand());
        nf.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askNewFolder(); }
        });
        ops.addView(nf, Util.lpM(-2, dp(36), dp(8), 0, 0, 0));

        View flex = new View(this);
        ops.addView(flex, new LinearLayout.LayoutParams(0, 1, 1f));

        ops.addView(actionText("回收站", ThemeUi.cSub(), new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new android.content.Intent(FilesActivity.this, TrashActivity.class));
            }
        }), Util.lp(-2, dp(40)));
        ops.addView(actionText("选择", ThemeUi.cBrand(), new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (folders.length() + files.length() == 0) Util.toast(FilesActivity.this, "当前没有可选择的项目");
                else setSelMode(true);
            }
        }), Util.lpM(-2, dp(40), dp(2), 0, 0, 0));

        card.addView(ops, Util.lpM(-1, -2, 0, 0, 0, 0));
        return card;
    }

    /** 顶栏文本动作按钮（按压反馈） */
    private TextView actionText(String label, int color, View.OnClickListener l) {
        TextView tv = Util.text(this, label, color, 15, Typeface.NORMAL);
        tv.setGravity(Gravity.CENTER);
        tv.setSingleLine(true);
        tv.setPadding(dp(10), 0, dp(10), 0);
        tv.setOnClickListener(l);
        Util.setFeedback(tv);
        return tv;
    }

    private void addEmpty(String desc) {
        LinearLayout box = Util.emptyState(this, "空", Util.MSG_EMPTY, desc,
                selMode ? null : "上传文件", new Util.Cb() {
                    @Override public void run() { doUpload(); }
                });
        content.addView(box, Util.lpM(-1, -2, 0, dp(40), 0, 0));
    }

    private void addList(ListView lv) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        p.setMargins(0, dp(6), 0, 0);
        content.addView(lv, p);
    }

    // ---------- 列表 / 网格 ----------

    private class MineAdapter extends BaseAdapter {
        @Override public int getCount() { return folders.length() + files.length(); }
        @Override public Object getItem(int p) { return p; }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            int fc = folders.length();
            boolean isFolder = position < fc;
            JSONObject o = isFolder ? folders.optJSONObject(position) : files.optJSONObject(position - fc);
            LinearLayout row = isFolder ? folderRow(o) : itemFileRow(o);
            if (o != null && selMode && selSet.contains(selKey(isFolder, Util.l(o, "id")))) {
                row.setBackground(roundCardSel());
            }
            return row;
        }
    }

    /** 网格（每行 2 个卡片；文件夹+文件混排） */
    private class GridAdapter extends BaseAdapter {
        private static final int COLS = 2;

        @Override public int getCount() {
            int n = folders.length() + files.length();
            return (n + COLS - 1) / COLS;
        }
        @Override public Object getItem(int p) { return p; }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout row = new LinearLayout(FilesActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            for (int c = 0; c < COLS; c++) {
                final int idx = position * COLS + c;
                int fc = folders.length();
                int total = fc + files.length();
                if (idx >= total) {
                    View sp = new View(FilesActivity.this);
                    row.addView(sp, new LinearLayout.LayoutParams(0, 1, 1f));
                    continue;
                }
                final boolean isFolder = idx < fc;
                final JSONObject o = isFolder ? folders.optJSONObject(idx) : files.optJSONObject(idx - fc);
                boolean sel = o != null && selMode && selSet.contains(selKey(isFolder, Util.l(o, "id")));
                View cell = gridCell(isFolder, o, sel);
                LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, dp(128), 1f);
                if (c == 0) cp.setMargins(0, 0, dp(3), 0);
                else cp.setMargins(dp(3), 0, 0, 0);
                row.addView(cell, cp);
            }
            return row;
        }
    }

    /** 网格单元：上方彩色类型图标块，下方名称 + 副信息 */
    private View gridCell(final boolean isFolder, final JSONObject o, boolean sel) {
        String name = isFolder ? Util.s(o, "name") : Util.s(o, "filename");
        if (name == null || name.length() == 0) name = isFolder ? "未命名文件夹" : "未命名文件";
        String sub = isFolder ? "文件夹" : Util.fmtSize(Util.l(o, "file_size"));

        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER_HORIZONTAL);
        cell.setPadding(dp(8), dp(12), dp(8), dp(10));
        GradientDrawable gd = new GradientDrawable();
        gd.setCornerRadius(dp(12));
        if (sel) {
            gd.setColor(ThemeUi.cBrandChip());
            gd.setStroke(1, ThemeUi.cBrand());
        } else {
            gd.setColor(ThemeUi.cCard());
            gd.setStroke(1, ThemeUi.cLine());
        }
        cell.setBackground(gd);

        int[] cs = isFolder ? ThemeUi.typeChip(ThemeUi.TYPE_FOLDER) : extColors(name);
        TextView ic = iconBox(isFolder ? "夹" : extTag(name), cs[0], cs[1]);
        cell.addView(ic, Util.lp(dp(44), dp(44)));
        TextView t1 = Util.text(this, name, ThemeUi.cText(), 13, isFolder ? Typeface.BOLD : Typeface.NORMAL);
        t1.setGravity(Gravity.CENTER);
        t1.setMaxLines(2);
        t1.setEllipsize(TextUtils.TruncateAt.END);
        cell.addView(t1, Util.lpM(-1, -2, 0, dp(8), 0, 0));
        TextView t2 = Util.text(this, sub, ThemeUi.cMute(), 11, Typeface.NORMAL);
        t2.setGravity(Gravity.CENTER);
        t2.setSingleLine(true);
        t2.setEllipsize(TextUtils.TruncateAt.END);
        cell.addView(t2, Util.lpM(-1, -2, 0, dp(3), 0, 0));

        cell.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { onItemTap(isFolder, o); }
        });
        cell.setOnLongClickListener(new View.OnLongClickListener() {
            @Override public boolean onLongClick(View v) {
                if (selMode) return true;
                if (isFolder) showFolderMenu(o);
                else showFileMenu(o);
                return true;
            }
        });
        Util.setFeedback(cell);
        return cell;
    }

    private LinearLayout folderRow(final JSONObject f) {
        String name = f == null ? "" : Util.s(f, "name");
        if (name.length() == 0) name = "未命名文件夹";
        String created = f == null ? "" : Util.s(f, "created_at");
        StringBuilder sb = new StringBuilder("文件夹");
        if (created.length() > 0) sb.append(" · ").append(Util.fmtDbTime(created));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackground(roundCard());
        row.setMinimumHeight(dp(56));
        row.setPadding(dp(12), dp(8), dp(12), dp(8));

        int[] fcs = ThemeUi.typeChip(ThemeUi.TYPE_FOLDER);
        TextView ic = icon("夹", fcs[0], fcs[1]);
        row.addView(ic, Util.lp(dp(38), dp(38)));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView t1 = Util.text(this, name, ThemeUi.cText(), 15, Typeface.BOLD);
        t1.setSingleLine(true);
        t1.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(2)));
        TextView t2 = Util.text(this, sb.toString(), ThemeUi.cSub(), 12, Typeface.NORMAL);
        t2.setSingleLine(true);
        t2.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(dp(10), 0, 0, 0);
        row.addView(col, cp);

        TextView chev = Util.text(this, "›", ThemeUi.cMute(), 18, Typeface.NORMAL);
        chev.setGravity(Gravity.CENTER);
        row.addView(chev, Util.lp(dp(20), -2));

        // 「⋯」操作入口（与文件行一致：下载/分享/重命名/移动/详情/删除）
        TextView more = Util.text(this, "⋯", ThemeUi.cMute(), 18, Typeface.BOLD);
        more.setGravity(Gravity.CENTER);
        more.setPadding(dp(6), 0, dp(6), 0);
        more.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showFolderMenu(f); }
        });
        more.setContentDescription("更多操作");
        Util.setFeedback(more);
        row.addView(more, Util.lp(-2, dp(36)));
        return row;
    }

    private LinearLayout itemFileRow(final JSONObject f) {
        String name = f == null ? "" : Util.s(f, "filename");
        if (name.length() == 0) name = "未命名文件";

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setBackground(roundCard());
        row.setMinimumHeight(dp(56));
        row.setPadding(dp(12), dp(8), dp(12), dp(8));

        int[] cs = extColors(name);
        TextView ic = icon(extTag(name), cs[0], cs[1]);
        row.addView(ic, Util.lp(dp(38), dp(38)));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView t1 = Util.text(this, name, ThemeUi.cText(), 15, Typeface.NORMAL);
        t1.setSingleLine(true);
        t1.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t1, Util.lpM(-1, -2, 0, 0, 0, dp(2)));
        TextView t2 = Util.text(this, fileSub(f), ThemeUi.cSub(), 12, Typeface.NORMAL);
        t2.setSingleLine(true);
        t2.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t2, Util.lpM(-1, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.setMargins(dp(10), 0, 0, 0);
        row.addView(col, cp);

        TextView more = Util.text(this, "⋯", ThemeUi.cMute(), 18, Typeface.BOLD);
        more.setGravity(Gravity.CENTER);
        more.setPadding(dp(6), 0, dp(6), 0);
        more.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { showFileMenu(f); }
        });
        Util.setFeedback(more);
        row.addView(more, Util.lp(-2, dp(36)));
        return row;
    }

    private String fileSub(JSONObject f) {
        StringBuilder sb = new StringBuilder();
        String size = f == null ? "" : Util.fmtSize(Util.l(f, "file_size"));
        if (size.length() > 0) sb.append(size);
        String when = f == null ? "" : Util.fmtDbTime(Util.s(f, "uploaded_at"));
        appendPart(sb, when);
        return sb.toString();
    }

    private void appendPart(StringBuilder sb, String p) {
        if (p == null || p.length() == 0) return;
        if (sb.length() > 0) sb.append(" · ");
        sb.append(p);
    }

    /** 类型图标块（彩色底 + 汉字标签；深色模式自动压暗底色，圆角 8） */
    private TextView icon(String tag, int bg, int fg) {
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

    private TextView iconBox(String tag, int bg, int fg) {
        TextView t = icon(tag, bg, fg);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.chipBg(bg));
        gd.setCornerRadius(dp(8));
        t.setBackground(gd);
        t.setTextSize(14);
        return t;
    }

    /** 图标文字：扩展名（<=3 大写），无扩展名用"文" */
    private String extTag(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "文";
        String ext = name.substring(dot + 1).toUpperCase(Locale.CHINA);
        if (ext.length() == 0) return "文";
        return ext.length() > 3 ? ext.substring(0, 3) : ext;
    }

    /** 按扩展名分组取 [底色, 字色]（规范 §1 文件类型色块） */
    private int[] extColors(String name) {
        int dot = name.lastIndexOf('.');
        String ext = (dot < 0 || dot == name.length() - 1) ? "" : name.substring(dot + 1).toLowerCase(Locale.CHINA);
        if (inExt(EXTS_IMG, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_IMAGE);
        if (inExt(EXTS_VIDEO, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_VIDEO);
        if (inExt(EXTS_ZIP, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_ARCHIVE);
        if (inExt(EXTS_DOC, ext)) return ThemeUi.typeChip(ThemeUi.TYPE_DOC);
        return ThemeUi.typeChip(ThemeUi.TYPE_OTHER);
    }

    private boolean inExt(String list, String ext) {
        return ext.length() > 0 && list.indexOf("," + ext + ",") >= 0;
    }

    // ---------- 目录与文件操作 ----------

    private void enterFolder(final JSONObject f) {
        if (f == null) return;
        curFolderId = Util.l(f, "id");
        load();
    }

    private void showFolderMenu(final JSONObject f) {
        if (f == null) return;
        final String nm = Util.s(f, "name");
        Util.menu(this, nm.length() == 0 ? "文件夹" : nm,
                new String[]{"打开", "重命名", "移动到", "详细信息", "删除"}, 4, false, new Util.MenuCb() {
                    @Override public void run(int which) {
                        if (which == 0) enterFolder(f);
                        else if (which == 1) askRenameFolder(f);
                        else if (which == 2) pickMoveTarget(true, Util.l(f, "id"));
                        else if (which == 3) showDetail(true, f);
                        else askDeleteFolder(f);
                    }
                });
    }

    private void showFileMenu(final JSONObject f) {
        if (f == null) return;
        final String fn = Util.s(f, "filename");
        final String title = fn.length() == 0 ? "未命名文件" : fn;
        Util.menu(this, title,
                new String[]{"预览", "下载", "分享", "重命名", "移动到", "详细信息", "删除"}, 6, false, new Util.MenuCb() {
                    @Override public void run(int which) {
                        if (which == 0) doPreview(f);
                        else if (which == 1) doDownload(f);
                        else if (which == 2) doShare(f);
                        else if (which == 3) askRenameFile(f);
                        else if (which == 4) pickMoveTarget(false, Util.l(f, "id"));
                        else if (which == 5) showDetail(false, f);
                        else askDeleteFile(f);
                    }
                });
    }

    // ---------- 详情面板（Cloudreve 详情卡的手机端映射：底部弹出） ----------

    /** 详情面板：图标 + 名称 + 大小/类型/修改时间/上传者（缺失字段显示「—」） */
    private void showDetail(boolean isFolder, JSONObject o) {
        if (o == null) return;
        String name = isFolder ? Util.s(o, "name") : Util.s(o, "filename");
        if (name.length() == 0) name = isFolder ? "未命名文件夹" : "未命名文件";
        String when = Util.fmtDbTime(isFolder ? Util.s(o, "created_at") : Util.s(o, "uploaded_at"));
        String size = isFolder ? "—" : Util.fmtSize(Util.l(o, "file_size"));

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);

        // 图标 + 名称
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        int[] cs = isFolder ? new int[]{0xFFFEF3C7, 0xFFB45309} : extColors(name);
        head.addView(icon(isFolder ? "夹" : extTag(name), cs[0], cs[1]), Util.lp(dp(44), dp(44)));
        LinearLayout headCol = new LinearLayout(this);
        headCol.setOrientation(LinearLayout.VERTICAL);
        TextView nm = Util.text(this, name, ThemeUi.cText(), 15, Typeface.BOLD);
        nm.setMaxLines(2);
        nm.setEllipsize(TextUtils.TruncateAt.END);
        headCol.addView(nm, Util.lpM(-2, -2, 0, 0, 0, dp(2)));
        TextView meta = Util.text(this, isFolder ? "文件夹" : fileTypeLabel(name), ThemeUi.cMute(), 12, Typeface.NORMAL);
        headCol.addView(meta, Util.lpM(-2, -2, 0, 0, 0, 0));
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(0, -2, 1f);
        hp.setMargins(dp(12), 0, 0, 0);
        head.addView(headCol, hp);
        box.addView(head, Util.lpM(-1, -2, 0, 0, 0, dp(10)));

        box.addView(Util.detailRow(this, "名称", name), Util.lp(-1, -2));
        box.addView(Util.detailRow(this, "大小", size), Util.lp(-1, -2));
        box.addView(Util.detailRow(this, "类型", isFolder ? "文件夹" : fileTypeLabel(name)), Util.lp(-1, -2));
        box.addView(Util.detailRow(this, "修改时间", when.length() == 0 ? "—" : when), Util.lp(-1, -2));
        // 个人目录中的文件均属当前账户；团队文件另有上传者字段
        String upl = Util.s(o, "uploader_name");
        box.addView(Util.detailRow(this, "上传者", upl.length() > 0 ? upl : "本人（当前账户）"), Util.lp(-1, -2));

        final long id = Util.l(o, "id");
        if (isFolder) {
            Util.sheet(this, "详细信息", box, new Util.Btn[]{
                    new Util.Btn("重命名", Util.KIND_PLAIN, new Util.Cb() {
                        @Override public void run() { askRenameFolder(o); }
                    }),
                    new Util.Btn("移动到", Util.KIND_PLAIN, new Util.Cb() {
                        @Override public void run() { pickMoveTarget(true, id); }
                    }),
                    new Util.Btn("打开", Util.KIND_PRIMARY, new Util.Cb() {
                        @Override public void run() { enterFolder(o); }
                    })
            });
        } else {
            Util.sheet(this, "详细信息", box, new Util.Btn[]{
                    new Util.Btn("重命名", Util.KIND_PLAIN, new Util.Cb() {
                        @Override public void run() { askRenameFile(o); }
                    }),
                    new Util.Btn("分享", Util.KIND_PLAIN, new Util.Cb() {
                        @Override public void run() { doShare(o); }
                    }),
                    new Util.Btn("下载", Util.KIND_PRIMARY, new Util.Cb() {
                        @Override public void run() { doDownload(o); }
                    })
            });
        }
    }

    /** 类型中文名（按扩展名分组，与图标色一致） */
    private String fileTypeLabel(String name) {
        int dot = name.lastIndexOf('.');
        String ext = (dot < 0 || dot == name.length() - 1) ? "" : name.substring(dot + 1).toLowerCase(Locale.CHINA);
        if (ext.length() == 0) return "文件";
        String up = ext.toUpperCase(Locale.CHINA);
        if (inExt(EXTS_IMG, ext)) return "图片 · " + up;
        if (inExt(EXTS_VIDEO, ext)) return "视频 · " + up;
        if (inExt(EXTS_ZIP, ext)) return "压缩包 · " + up;
        if (inExt(EXTS_DOC, ext)) return "文档 · " + up;
        return "文件 · " + up;
    }

    private void askNewFolder() {
        Util.input(this, "新建文件夹", "请输入文件夹名称", "", new Util.InputCb() {
            @Override public void run(String name) {
                if (name.length() == 0) { Util.toast(FilesActivity.this, "请输入文件夹名称"); return; }
                op("创建中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.folderCreate(name, curFolderId);
                        fetch();
                    }
                }, "已创建");
            }
        });
    }

    private void askRenameFolder(final JSONObject f) {
        final String old = Util.s(f, "name");
        Util.input(this, "重命名文件夹", "请输入新名称", old, new Util.InputCb() {
            @Override public void run(String name) {
                if (name.length() == 0) { Util.toast(FilesActivity.this, "请输入名称"); return; }
                op("处理中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.folderRename(Util.l(f, "id"), name);
                        fetch();
                    }
                }, "已重命名");
            }
        });
    }

    private void askDeleteFolder(final JSONObject f) {
        final String nm = Util.s(f, "name");
        final String title = nm.length() == 0 ? "文件夹" : nm;
        Util.confirm(this, "删除文件夹", "确定删除文件夹「" + title + "」？其内文件将一并删除。", new Util.Cb() {
            @Override public void run() {
                op("删除中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.folderDelete(Util.l(f, "id"));
                        fetch();
                    }
                }, "已删除");
            }
        });
    }

    private void askRenameFile(final JSONObject f) {
        final String old = Util.s(f, "filename");
        Util.input(this, "重命名文件", "请输入新名称", old, new Util.InputCb() {
            @Override public void run(String name) {
                if (name.length() == 0) { Util.toast(FilesActivity.this, "请输入名称"); return; }
                op("处理中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.fileRename(Util.l(f, "id"), name);
                        fetch();
                    }
                }, "已重命名");
            }
        });
    }

    private void askDeleteFile(final JSONObject f) {
        final String fn = Util.s(f, "filename");
        final String title = fn.length() == 0 ? "未命名文件" : fn;
        Util.confirm(this, "删除文件", "确定删除「" + title + "」？删除后不可恢复。", new Util.Cb() {
            @Override public void run() {
                op("删除中…", new Bg() {
                    @Override public void run() throws Exception {
                        Api.fileDelete(Util.l(f, "id"));
                        fetch();
                    }
                }, "已删除");
            }
        });
    }

    private void doPreview(final JSONObject f) {
        final long id = Util.l(f, "id");
        final Dialog ld = Util.loading(this, "获取预览…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.preview(id);
                    url[0] = r.optString("url", "");
                } catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(FilesActivity.this, "该文件暂不支持预览");
                else Util.openUrl(FilesActivity.this, url[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e); }
        });
    }

    private void doDownload(final JSONObject f) {
        final long id = Util.l(f, "id");
        final String fn = Util.s(f, "filename");
        if (android.os.Build.VERSION.SDK_INT < 23) {
            // 低版本系统直接连存储域可能证书/握手失败：走服务器中转下载
            Util.download(this, Api.downloadProxyUrl(id), fn);
            return;
        }
        final Dialog ld = Util.loading(this, "获取下载地址…");
        final String[] url = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.downloadPresign(id);
                    url[0] = r.optString("downloadUrl", "");
                } catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (url[0].length() == 0) Util.toast(FilesActivity.this, "获取下载地址失败");
                else Util.download(FilesActivity.this, url[0], fn.length() == 0 ? "file" : fn);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e); }
        });
    }

    private void doShare(final JSONObject f) {
        final long id = Util.l(f, "id");
        final Dialog ld = Util.loading(this, "创建分享…");
        final String[] token = {""};
        final String[] password = {""};
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject r = Api.shareCreate(id);
                    token[0] = r.optString("token", "");
                    password[0] = r.optString("password", "");
                } catch (Exception e) { FilesActivity.<RuntimeException>sneaky(e); }
            }
        }, new Util.Cb() {
            @Override public void run() {
                ld.dismiss();
                if (token[0].length() == 0) Util.toast(FilesActivity.this, "创建分享失败");
                else showShareDialog(id, token[0], password[0]);
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { ld.dismiss(); Util.toast(FilesActivity.this, e); }
        });
    }

    private void showShareDialog(final long fileId, final String token, final String password) {
        final String link = Constants.BASE_URL + "/s/" + token;
        final String shareText = password.length() == 0
                ? "链接：" + link : "链接：" + link + "\n提取码：" + password;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cFill());
        gd.setCornerRadius(dp(8));
        box.setBackground(gd);

        TextView lab = Util.text(this, "分享链接", ThemeUi.cSub(), 12, Typeface.NORMAL);
        box.addView(lab, Util.lpM(-1, -2, 0, 0, 0, dp(4)));
        TextView t1 = Util.text(this, link, ThemeUi.cText(), 14, Typeface.NORMAL);
        t1.setTextIsSelectable(true);
        t1.setLineSpacing(0, 1.2f);
        box.addView(t1, Util.lpM(-1, -2, 0, 0, 0, password.length() == 0 ? 0 : dp(10)));

        if (password.length() > 0) {
            TextView label2 = Util.text(this, "提取码", ThemeUi.cSub(), 12, Typeface.NORMAL);
            box.addView(label2, Util.lpM(-1, -2, 0, 0, 0, dp(4)));
            TextView t2 = Util.text(this, password, ThemeUi.cText(), 14, Typeface.BOLD);
            t2.setTextIsSelectable(true);
            box.addView(t2, Util.lp(-1, -2));
        }

        TextView tip = Util.text(this, "任何人凭链接（及提取码）均可访问该文件，撤销分享后链接立即失效。",
                ThemeUi.cMute(), 12, Typeface.NORMAL);
        tip.setLineSpacing(0, 1.3f);
        box.addView(tip, Util.lpM(-1, -2, 0, dp(10), 0, 0));

        Util.custom(this, "分享链接", box, new Util.Btn[]{
                new Util.Btn("撤销分享", Util.KIND_DANGER, new Util.Cb() {
                    @Override public void run() {
                        op("处理中…", new Bg() {
                            @Override public void run() throws Exception {
                                Api.shareRevoke(fileId);
                            }
                        }, "已撤销分享");
                    }
                }),
                new Util.Btn("关闭", Util.KIND_PLAIN, null),
                new Util.Btn("复制链接", Util.KIND_PRIMARY, new Util.Cb() {
                    @Override public void run() { Util.copy(FilesActivity.this, shareText); }
                })
        });
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
        final Long folderId = curFolderId;
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
                    tId[0] = Transfer.add(true, name, len); // 非阻塞：右上角 ⇅ 角标显示，可继续操作

                    JSONObject pre = Api.presignUpload(name, false, null, folderId, mime, len);
                    String url = pre.optString("uploadUrl", "");
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
                        // 老版本安卓直连对象存储常因 TLS/SNI 兼容失败：回退服务端中转上传（带进度）
                        Transfer.note(tId[0], "改用服务端中转上传…");
                        try {
                            FileInputStream rf = new FileInputStream(tmp);
                            try {
                                Api.relayUpload(rf, name, folderId, len, Transfer.httpProgress(tId[0]));
                            } finally { rf.close(); }
                        } catch (Exception re) {
                            // 中转也失败时：个人根目录再试服务端分片通道（分片接口不支持指定文件夹）
                            if (folderId != null) throw re;
                            Transfer.note(tId[0], "改用服务端分片上传…");
                            Api.uploadChunked(tmp, name, false, null, Transfer.upProgress(tId[0]));
                        }
                        Transfer.finish(tId[0], true, null);
                        fetch();
                        return;
                    }
                    Api.confirmUpload(stored, name, len, false, null, folderId);
                    Transfer.finish(tId[0], true, null);
                    fetch();
                } catch (Exception e) {
                    if (tId[0] != 0) Transfer.finish(tId[0], false, e.getMessage());
                    FilesActivity.<RuntimeException>sneaky(e);
                } finally {
                    if (tmp != null) tmp.delete();
                }
            }
        }, new Util.Cb() {
            @Override public void run() {
                Util.toast(FilesActivity.this, Util.MSG_UPLOAD_OK);
                render();
            }
        }, new Util.ErrCb() {
            @Override public void run(String e) { Util.toast(FilesActivity.this, e); }
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

    // ---------- 返回：先关抽屉/退出多选，再回上级目录 ----------

    @Override
    public void onBackPressed() {
        if (ShellUi.closeDrawerIfOpen(this)) return;
        if (selMode) { setSelMode(false); return; }
        if (curFolderId != null) {
            int n = folderPath.length();
            if (n <= 1) curFolderId = null;
            else {
                JSONObject fo = folderPath.optJSONObject(n - 2);
                curFolderId = fo == null ? null : Util.l(fo, "id");
            }
            load();
            return;
        }
        super.onBackPressed();
    }

    // ---------- 小工具 ----------

    private GradientDrawable roundCard() {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(ThemeUi.cCard()); // 行卡片：12dp 圆角 + 1px 描边
        gd.setCornerRadius(dp(12));
        gd.setStroke(1, ThemeUi.cLine());
        return gd;
    }

    private int dp(float v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
