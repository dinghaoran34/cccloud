package com.cubecute.ccyun.util;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * Android 16（Material 3）风格的“不确定加载环” CircularProgressIndicator。
 *
 * 由于应用最低支持 Android 4.0 (API 14)，无法使用 androidx/官方 Material 组件，
 * 这里用纯 framework Canvas 自绘实现同款观感：
 *   - 细描边（4dp）+ 圆头 + 浅色轨道 + 主题主色进度弧
 *   - 进度弧在匀速环绕过程中完成“伸长→收缩”，视觉与 Android 原生不区分版本。
 * ValueAnimator 为 API 11+，故 API 14 完全可用；View 移除时自动停止动画防泄漏。
 */
public final class MaterialRing extends View {

    private final Paint trackPaint;
    private final Paint arcPaint;
    private final float stroke;
    private final float density;
    private float t = 0f;
    private ValueAnimator animator;

    public MaterialRing(Context c) {
        this(c, ThemeUi.cBrand());
    }

    /** @param color 进度弧颜色（轨道自动取其 15% 透明度做浅色衬底） */
    public MaterialRing(Context c, int color) {
        super(c);
        density = c.getResources().getDisplayMetrics().density;
        stroke = 4f * density;

        trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        trackPaint.setStyle(Paint.Style.STROKE);
        trackPaint.setStrokeWidth(stroke);
        trackPaint.setStrokeCap(Paint.Cap.ROUND);
        // 深色主题下轨道改用 15% 白叠层，避免黑轨道在暗底上不可见
        trackPaint.setColor(ThemeUi.isDark(c)
                ? 0x26FFFFFF
                : (color & 0x00FFFFFF) | 0x26000000);

        arcPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        arcPaint.setStyle(Paint.Style.STROKE);
        arcPaint.setStrokeWidth(stroke);
        arcPaint.setStrokeCap(Paint.Cap.ROUND);
        arcPaint.setColor(color);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int def = Math.round(46 * density);
        setMeasuredDimension(resolveSize(def, widthMeasureSpec),
                resolveSize(def, heightMeasureSpec));
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float cx = getWidth() / 2f;
        float cy = getHeight() / 2f;
        float r = Math.max(1f, Math.min(cx, cy) - stroke / 2f - density);
        // 浅色完整轨道
        canvas.drawCircle(cx, cy, r, trackPaint);
        // 主色进度弧：匀速环绕一圈的同时，弧长在 20°~280° 间伸长再收缩
        float start = -90f + 360f * t;
        float sweep = 20f + 130f * (float) (1.0 - Math.cos(2 * Math.PI * t));
        RectF oval = new RectF(cx - r, cy - r, cx + r, cy + r);
        canvas.drawArc(oval, start, sweep, false, arcPaint);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (animator == null) {
            animator = ValueAnimator.ofFloat(0f, 1f);
            animator.setDuration(1150);
            animator.setRepeatCount(ValueAnimator.INFINITE);
            animator.addUpdateListener(new ValueAnimator.AnimatorUpdateListener() {
                @Override
                public void onAnimationUpdate(ValueAnimator animation) {
                    t = ((Float) animation.getAnimatedValue()).floatValue();
                    invalidate();
                }
            });
        }
        animator.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (animator != null) animator.cancel();
        super.onDetachedFromWindow();
    }
}
