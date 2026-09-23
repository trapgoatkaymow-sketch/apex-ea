# Android APK (apex-ea)

Capacitor shell for the **client trading app only** (not the mentor portal).

The UI is packaged inside the APK for a fast cold start. All backends still hit
the live production API:

`https://www.apex-ea.com`

So PayPal, Chart Scanner (OpenAI), licenses, MT5API brokers, and every other
backend/API/secret stay on Vercel — exactly like the website. Nothing sensitive
is baked into the APK.

- **Android:** 7.0+ (API 24 and up) — Capacitor 8 minimum
- **Portal:** `/admin` is blocked in the native shell
- **Install name:** `apex-ea` (launcher icon + splash use the ApexEA logo)
- **Same as web:** license activate, lifetime PayPal unlock, premium Chart Scanner
  paywall, MetaTrader connect, Economic calendar — all via live APIs

## Download (share these links)

- **Best link to share:** https://www.apex-ea.com/android
- Also works: https://www.apex-ea.com/download
- **API download (always forces the APK file):** https://www.apex-ea.com/api/download-apk
- **Direct APK:** https://www.apex-ea.com/apex-ea.apk
- Versioned: https://www.apex-ea.com/apex-ea-v2.33.apk
- Legacy URL (same package): https://www.apex-ea.com/ZETA-SCALPER-AI.apk

## Rebuild

```bash
cp android/keystore/signing.properties.example android/keystore/signing.properties
# set passwords + ensure apexea-release.jks exists under android/keystore/
export ANDROID_HOME=/home/ubuntu/android-sdk
npm run android:apk
cp android/app/build/outputs/apk/release/app-release.apk public/apex-ea.apk
cp public/apex-ea.apk public/apex-ea-v2.33.apk
cp public/apex-ea.apk public/ZETA-SCALPER-AI.apk
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`
