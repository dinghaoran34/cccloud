package com.cubecute.ccyun;

import android.app.Application;

import com.cubecute.ccyun.net.Http;
import com.cubecute.ccyun.util.CrashReporter;
import com.cubecute.ccyun.util.Transfer;

public class App extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        CrashReporter.install(this); // 临时诊断：崩溃堆栈落盘，下次启动展示
        Http.init(this);
        Transfer.attach(this);       // 全局传输中心
    }
}
