# Android APK (apex-ea)

Capacitor shell for the **client trading app only** (not the mentor portal).

## How updates reach phones (no delete)

1. **Most updates (UI, licenses, scanner, PayPal)** ship when you deploy the
   website. The APK loads `https://www.apex-ea.com`, so clients get new UI after
   they close/reopen the app (or when the shell watchdog reloads).
2. **Never ask clients to delete the app.** Same package + same signing key =
   Install over the existing app. Data and license stay.
3. **APK rebuild only** when native Android code changes (overlay, permissions,
   Capacitor plugins). Bump `versionCode` / `versionName`, rebuild, publish.
   Phones show an in-app **Install** banner — tap Install, do not uninstall.
4. Share **https://www.apex-ea.com/android** (or `/download`). One tap installs
   over the old APK.

## Runtime

- Live UI: `https://www.apex-ea.com` (`capacitor.config.json` → `server.url`)
- APIs / secrets: same production backend on Vercel
- Android: 7.0+ (API 24 and up) — Capacitor 8 minimum
- Portal: `/admin` is blocked in the native shell
- Install name: `apex-ea`

## Download (share these links)

- **Best link to share:** https://www.apex-ea.com/android
- Also works: https://www.apex-ea.com/download
- **API download (always forces the APK file):** https://www.apex-ea.com/api/download-apk
- **Direct APK:** https://www.apex-ea.com/apex-ea.apk
- Versioned: https://www.apex-ea.com/apex-ea-v2.48.apk
- Legacy URL (same package): https://www.apex-ea.com/ZETA-SCALPER-AI.apk

## Rebuild

```bash
cp android/keystore/signing.properties.example android/keystore/signing.properties
# set passwords + ensure apexea-release.jks exists under android/keystore/
export ANDROID_HOME=/home/ubuntu/android-sdk
npm run android:apk
cp android/app/build/outputs/apk/release/app-release.apk public/apex-ea.apk
cp public/apex-ea.apk public/apex-ea-v2.48.apk
cp public/apex-ea.apk public/ZETA-SCALPER-AI.apk
```

Keep `apkVersionCode` / `apkVersionName` in `vite.config.js` aligned with
`android/app/build.gradle` so the in-app Install banner knows when a new binary
is available.

APK output: `android/app/build/outputs/apk/release/app-release.apk`
