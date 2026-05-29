package com.lekiosk.driver;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final int LOCATION_REQUEST = 20;
    private static final int NOTIFICATION_REQUEST = 21;
    private static final String ORDER_CHANNEL_ID = "driver_orders";
    private static final String DRIVER_URL = "https://lekiosk.store/driver/";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setGeolocationEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new DriverBridge(), "LekioskAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false);
            }
        });

        createNotificationChannel();
        requestLocationPermission();
        requestNotificationPermission();
        webView.loadUrl(DRIVER_URL);
    }

    private void requestLocationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }, LOCATION_REQUEST);
        }
    }

    private void requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {
                Manifest.permission.POST_NOTIFICATIONS
            }, NOTIFICATION_REQUEST);
        }
    }

    private void createNotificationChannel() {
        if (android.os.Build.VERSION.SDK_INT < 26) {
            return;
        }

        NotificationChannel channel = new NotificationChannel(
            ORDER_CHANNEL_ID,
            "Driver Orders",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Alerts when a new delivery order arrives.");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void showOrderNotification(String title, String body) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestNotificationPermission();
            return;
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, intent, flags);
        Notification.Builder builder = android.os.Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, ORDER_CHANNEL_ID)
            : new Notification.Builder(this);

        builder
            .setSmallIcon(R.drawable.ic_driver_badge)
            .setContentTitle(title == null || title.trim().isEmpty() ? "New delivery order" : title)
            .setContentText(body == null || body.trim().isEmpty() ? "Open the driver app to view it." : body)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), builder.build());
        }
    }

    private class DriverBridge {
        @JavascriptInterface
        public void notifyNewOrder(final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showOrderNotification(title, body);
                }
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
