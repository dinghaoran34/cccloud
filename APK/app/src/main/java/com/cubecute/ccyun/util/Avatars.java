package com.cubecute.ccyun.util;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;
import android.widget.ImageView;

import com.cubecute.ccyun.net.Http;

/** 头像加载与圆形裁剪（纯 framework，API14+ 兼容；/avatar/:uid 公开可读） */
public final class Avatars {

    private Avatars() {}

    /** 异步加载圆形头像到 ImageView；avatar 为空或加载失败时置空（留给调用方占位） */
    public static void load(final Context c, final String uid, final String avatar,
                            final ImageView iv, final int px) {
        iv.setImageDrawable(null);
        if (uid == null || uid.length() == 0 || avatar == null || avatar.length() == 0) return;
        final String url = "/avatar/" + uid;
        Util.async(new Runnable() {
            @Override public void run() {
                try {
                    byte[] data = Http.getBytes(url);
                    if (data == null || data.length == 0) return;
                    final Bitmap bmp = decode(data, px);
                    if (bmp == null) return;
                    Util.onUi(new Runnable() {
                        @Override public void run() { iv.setImageBitmap(bmp); }
                    });
                } catch (Throwable ignored) {}
            }
        }, null, null);
    }

    private static Bitmap decode(byte[] data, int px) {
        try {
            BitmapFactory.Options o = new BitmapFactory.Options();
            o.inJustDecodeBounds = true;
            BitmapFactory.decodeByteArray(data, 0, data.length, o);
            int sample = 1;
            int s = Math.max(o.outWidth, o.outHeight);
            while (s / (sample * 2) >= px) sample *= 2;
            o.inJustDecodeBounds = false;
            o.inSampleSize = sample;
            Bitmap src = BitmapFactory.decodeByteArray(data, 0, data.length, o);
            if (src == null) return null;
            return round(src, px);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Bitmap round(Bitmap src, int px) {
        int size = Math.min(px, Math.min(src.getWidth(), src.getHeight()));
        if (size <= 0) { src.recycle(); return null; }
        try {
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            Bitmap scaled = Bitmap.createScaledBitmap(src, size, size, true);
            p.setShader(new BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
            canvas.drawCircle(size / 2f, size / 2f, size / 2f, p);
            if (scaled != src && !scaled.isRecycled()) scaled.recycle();
            if (!src.isRecycled()) src.recycle();
            return out;
        } catch (Throwable t) {
            return src;
        }
    }
}
