package com.lekiosk.driver;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.os.IBinder;
import android.os.PowerManager;

public class DriverBackgroundService extends Service {
    private static final String BG_CHANNEL_ID = "driver_background";
    private static final int NOTIFICATION_ID = 200;
    private PowerManager.WakeLock bgWakeLock;

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

        startForeground(NOTIFICATION_ID, builder.build());
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
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
        }
    }
}
