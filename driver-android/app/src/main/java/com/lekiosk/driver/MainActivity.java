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
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    private static final int LOCATION_REQUEST = 20;
    private static final int NOTIFICATION_REQUEST = 21;
    private static final String ORDER_CHANNEL_ID = "driver_orders";
    private static final String DRIVER_URL = "https://lekiosk.store/driver/";
    static final String PREFS_NAME = "lekiosk_driver";
    static final String PREF_DRIVER_PIN = "driver_pin";
    static final String PREF_KNOWN_ORDER_IDS = "known_order_ids";
    static final String PREF_KNOWN_ORDER_IDS_READY = "known_order_ids_ready";
    static final String PREF_NOTIFIED_ORDER_IDS = "notified_order_ids";
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

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request != null && !isAllowedDriverUri(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return url == null || !isAllowedDriverUri(Uri.parse(url));
            }
        });
        webView.addJavascriptInterface(new DriverBridge(), "LekioskAndroid");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, isAllowedDriverUri(Uri.parse(origin)), false);
            }
        });

        createNotificationChannel();
        if (!requestLocationPermission()) {
            requestNotificationPermission();
        }
        webView.loadUrl(DRIVER_URL);
    }

    private boolean isAllowedDriverUri(Uri uri) {
        if (uri == null) return false;
        return "https".equals(uri.getScheme()) && "lekiosk.store".equals(uri.getHost());
    }

    private boolean requestLocationPermission() {
        if (android.os.Build.VERSION.SDK_INT >= 23 &&
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }, LOCATION_REQUEST);
            return true;
        }
        return false;
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
        showOrderNotification(title, body, "");
    }

    private void showOrderNotification(String title, String body, String orderId) {
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
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.lekiosk_logo))
            .setContentTitle(title == null || title.trim().isEmpty() ? "New delivery order" : title)
            .setContentText(body == null || body.trim().isEmpty() ? "Open the driver app to view it." : body)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            String id = orderId == null ? "" : orderId.trim();
            markOrderNotified(id);
            if (id.isEmpty()) {
                manager.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), builder.build());
            } else {
                manager.notify(id, 300, builder.build());
            }
        }
    }

    private void markOrderNotified(String orderId) {
        if (orderId == null || orderId.trim().isEmpty()) return;

        String raw = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(PREF_NOTIFIED_ORDER_IDS, "");
        String id = orderId.trim();
        if (("," + raw + ",").contains("," + id + ",")) return;

        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_NOTIFIED_ORDER_IDS, raw == null || raw.isEmpty() ? id : raw + "," + id)
            .apply();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == LOCATION_REQUEST) {
            requestNotificationPermission();
        }
    }

    private class DriverBridge {
        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    requestNotificationPermission();
                }
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent intent;
                    if (android.os.Build.VERSION.SDK_INT >= 26) {
                        intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    } else {
                        intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            .setData(Uri.parse("package:" + getPackageName()));
                    }
                    startActivity(intent);
                }
            });
        }

        @JavascriptInterface
        public void notifyNewOrder(final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showOrderNotification(title, body);
                }
            });
        }

        @JavascriptInterface
        public void notifyNewOrderForOrder(final String orderId, final String title, final String body) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showOrderNotification(title, body, orderId);
                }
            });
        }

        @JavascriptInterface
        public void setDriverPin(final String pin) {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(PREF_DRIVER_PIN, pin == null ? "" : pin.trim())
                .apply();
        }

        @JavascriptInterface
        public void clearDriverPin() {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .remove(PREF_DRIVER_PIN)
                .remove(PREF_KNOWN_ORDER_IDS)
                .remove(PREF_KNOWN_ORDER_IDS_READY)
                .remove(PREF_NOTIFIED_ORDER_IDS)
                .apply();
            stopService(new Intent(MainActivity.this, DriverBackgroundService.class));
        }

        @JavascriptInterface
        public void syncKnownOrders(final String orderIds) {
            getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(PREF_KNOWN_ORDER_IDS, orderIds == null ? "" : orderIds)
                .putBoolean(PREF_KNOWN_ORDER_IDS_READY, true)
                .apply();
        }

        @JavascriptInterface
        public void markOrderNotified(final String orderId) {
            markOrderNotified(orderId);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        String pin = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(PREF_DRIVER_PIN, "");
        if (pin == null || pin.trim().isEmpty()) return;

        Intent bgIntent = new Intent(this, DriverBackgroundService.class);
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                startForegroundService(bgIntent);
            } else {
                startService(bgIntent);
            }
        } catch (RuntimeException ignored) {
            // Some Android builds reject foreground-service starts during app transitions.
        }
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        stopService(new Intent(this, DriverBackgroundService.class));
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
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
