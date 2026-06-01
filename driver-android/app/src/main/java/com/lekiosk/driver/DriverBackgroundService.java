package com.lekiosk.driver;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.BitmapFactory;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

public class DriverBackgroundService extends Service {
    private static final String BG_CHANNEL_ID = "driver_background";
    private static final String ORDER_CHANNEL_ID = "driver_orders";
    private static final String DRIVER_API_URL = "https://lekiosk-order-inbox.lekiosklb.workers.dev/driver";
    private static final int NOTIFICATION_ID = 200;
    private static final long ORDER_POLL_MS = 20000L;
    private PowerManager.WakeLock bgWakeLock;
    private volatile boolean polling;
    private Thread pollingThread;

    @Override
    public void onCreate() {
        super.onCreate();
        createBackgroundChannel();

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            bgWakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "lekiosk:driver:background"
            );
            bgWakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (bgWakeLock != null && !bgWakeLock.isHeld()) {
            bgWakeLock.acquire(12 * 60 * 60 * 1000L);
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent, pendingFlags
        );

        Notification.Builder builder = android.os.Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, BG_CHANNEL_ID)
            : new Notification.Builder(this);

        builder
            .setSmallIcon(R.drawable.ic_driver_badge)
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.lekiosk_logo))
            .setContentTitle("Le Kiosk Driver — Active")
            .setContentText("GPS tracking is running in the background")
            .setContentIntent(pendingIntent)
            .setPriority(Notification.PRIORITY_LOW)
            .setOngoing(true);

        try {
            startForeground(NOTIFICATION_ID, builder.build());
        } catch (RuntimeException ignored) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startOrderPolling();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopOrderPolling();
        if (bgWakeLock != null && bgWakeLock.isHeld()) {
            bgWakeLock.release();
        }
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createBackgroundChannel() {
        if (android.os.Build.VERSION.SDK_INT < 26) return;

        NotificationChannel channel = new NotificationChannel(
            BG_CHANNEL_ID,
            "Driver Background Service",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the driver app running for GPS tracking.");
        channel.setShowBadge(false);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
            NotificationChannel orderChannel = new NotificationChannel(
                ORDER_CHANNEL_ID,
                "Driver Orders",
                NotificationManager.IMPORTANCE_HIGH
            );
            orderChannel.setDescription("Alerts when a new delivery order arrives.");
            manager.createNotificationChannel(orderChannel);
        }
    }

    private void startOrderPolling() {
        if (pollingThread != null && pollingThread.isAlive()) return;

        polling = true;
        pollingThread = new Thread(new Runnable() {
            @Override
            public void run() {
                while (polling) {
                    pollOrdersOnce();
                    try {
                        Thread.sleep(ORDER_POLL_MS);
                    } catch (InterruptedException ignored) {
                        return;
                    }
                }
            }
        }, "LekioskDriverOrderPolling");
        pollingThread.start();
    }

    private void stopOrderPolling() {
        polling = false;
        if (pollingThread != null) {
            pollingThread.interrupt();
            pollingThread = null;
        }
    }

    private void pollOrdersOnce() {
        String pin = prefs().getString(MainActivity.PREF_DRIVER_PIN, "");
        if (pin == null || pin.trim().isEmpty()) return;

        try {
            JSONArray orders = fetchDriverOrders(pin.trim());
            Set<String> known = parseIdSet(prefs().getString(MainActivity.PREF_KNOWN_ORDER_IDS, ""));
            boolean baselineReady = prefs().getBoolean(MainActivity.PREF_KNOWN_ORDER_IDS_READY, false);
            Set<String> current = new LinkedHashSet<>();
            JSONObject firstNewOrder = null;

            for (int i = 0; i < orders.length(); i++) {
                JSONObject order = orders.optJSONObject(i);
                if (order == null || isDelivered(order)) continue;

                String id = order.optString("id", "");
                if (id.isEmpty()) continue;
                current.add(id);

                if (baselineReady && !known.contains(id) && firstNewOrder == null) {
                    firstNewOrder = order;
                }
            }

            if (!baselineReady) {
                if (!current.isEmpty() && firstNewOrder == null) {
                    for (int i = 0; i < orders.length(); i++) {
                        JSONObject order = orders.optJSONObject(i);
                        if (order != null && !isDelivered(order) && current.contains(order.optString("id", ""))) {
                            showOrderNotification(order);
                            break;
                        }
                    }
                }
                saveKnownIds(current);
                prefs().edit().putBoolean(MainActivity.PREF_KNOWN_ORDER_IDS_READY, true).apply();
                return;
            }

            if (firstNewOrder != null) {
                showOrderNotification(firstNewOrder);
            }
            saveKnownIds(current);
        } catch (Exception ignored) {
            // Network drops are normal for drivers on the road; the next poll retries.
        }
    }

    private JSONArray fetchDriverOrders(String pin) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(DRIVER_API_URL).openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("X-Driver-Pin", pin);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "LeKioskDriverAndroid/1.1");
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);

        try {
            int code = conn.getResponseCode();
            BufferedReader reader = new BufferedReader(new InputStreamReader(
                code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream()
            ));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
            reader.close();

            if (code < 200 || code >= 300) throw new Exception("Driver API " + code);
            JSONObject json = new JSONObject(body.toString());
            return json.optJSONArray("data") == null ? new JSONArray() : json.optJSONArray("data");
        } finally {
            conn.disconnect();
        }
    }

    private boolean isDelivered(JSONObject order) {
        JSONObject tracking = order.optJSONObject("tracking");
        return tracking != null && tracking.optString("delivered", "").length() > 0;
    }

    private void showOrderNotification(JSONObject order) {
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }

        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) {
            pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(this, 1, launchIntent, pendingFlags);
        Notification.Builder builder = android.os.Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, ORDER_CHANNEL_ID)
            : new Notification.Builder(this);

        String name = order.optString("name", "Customer");
        double total = order.optDouble("total", 0);
        String body = name + (total > 0 ? String.format(Locale.US, " · $%.2f", total) : "");

        builder
            .setSmallIcon(R.drawable.ic_driver_badge)
            .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.drawable.lekiosk_logo))
            .setContentTitle("New delivery order")
            .setContentText(body)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE)
            .setPriority(Notification.PRIORITY_HIGH);

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify((int) (System.currentTimeMillis() % Integer.MAX_VALUE), builder.build());
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE);
    }

    private Set<String> parseIdSet(String raw) {
        Set<String> ids = new LinkedHashSet<>();
        if (raw == null || raw.trim().isEmpty()) return ids;
        String[] parts = raw.split(",");
        for (String part : parts) {
            String id = part.trim();
            if (!id.isEmpty()) ids.add(id);
        }
        return ids;
    }

    private void saveKnownIds(Set<String> ids) {
        StringBuilder out = new StringBuilder();
        for (String id : ids) {
            if (out.length() > 0) out.append(',');
            out.append(id);
        }
        prefs().edit().putString(MainActivity.PREF_KNOWN_ORDER_IDS, out.toString()).apply();
    }
}
