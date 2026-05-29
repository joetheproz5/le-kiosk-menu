# Le Kiosk Driver Android App

This is a small Android WebView wrapper for the live driver site:

`https://lekiosk.store/driver/`

It requests location permission, allows web geolocation, keeps the screen awake, and opens the same driver workflow used by the website.

## Build APK

Install Android Studio or Android command-line tools with a Java runtime, then run:

```sh
gradle assembleDebug
```

From this folder:

```sh
/Users/joe/Documents/GitHub/le-kiosk-menu/driver-android
```

The debug APK will be created at:

```sh
app/build/outputs/apk/debug/app-debug.apk
```
