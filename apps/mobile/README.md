# TikTok Mwitu mobile

Flutter owns the vertical For You feed, playback, navigation, app links, and system sharing. The app opens the production Mwitu workspace inside a system WebView for account sessions, upload, reactions, messages, live hosting and guest access, moderation, gifts, coin purchases, invite plans, and promotions. Both surfaces use the existing NestJS API and PostgreSQL data. Playback needs no account. Camera and microphone access are requested by the system only when the trusted Mwitu workspace needs them.

## Build Android

Use Flutter 3.47.2 with the Android SDK and the NDK selected by Flutter. Set `MWITU_ANDROID_NDK` to a locally installed version if needed. From `apps/mobile`:

```text
flutter pub get
flutter analyze
flutter test
flutter run
flutter build apk --release
```

The release uses `android/key.properties`, which is ignored by Git. Keep the private keystore and its backup outside the repository. The properties are `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. Always use the original release key for website-distributed updates. Android links for `/watch/<video-id>` and `/join/<code>` use the public signing certificate fingerprint in `apps/web/public/.well-known/assetlinks.json`.

The APK is at `build/app/outputs/flutter-apk/app-release.apk`. Website distribution serves a versioned file from the private R2 bucket at `releases/tiktok-mwitu-1.0.0.apk`. The public entry point is `/download`. Upload each new signed build under its versioned key before updating the filename in the Worker.

## Build iPhone

Use macOS with Xcode and run `flutter build ios --simulator` for the simulator or `flutter build ios --release --no-codesign` for an unsigned device compile. GitHub Actions runs those checks on macOS. For installation through TestFlight or the App Store, configure the `ke.co.tiktokmwitu.mwitu` bundle in the Apple Developer account with a distribution certificate and provisioning profile, then run `flutter build ipa`. The iOS target uses iOS 15 or later. The private `mwitu://open/` scheme is registered on both platforms. HTTPS Universal Links on iOS require the Apple team association and app entitlement.

Review Apple’s current digital-goods payment and user-generated-content rules before an App Store submission. This source uses the existing web checkout and is configured for development builds. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

## Google sign-in on Android

Register Android package `ke.co.tiktokmwitu.mwitu` in Firebase under the project that owns Google sign-in. Add both signing fingerprints for the APK you distribute, enable Google in Firebase Authentication, then download a fresh `google-services.json` into `apps/mobile/android/app/`. The file is ignored by Git.

Set the VPS API’s `GOOGLE_ANDROID_CLIENT_ID` to the **Web OAuth client ID** supplied by the matching Android Firebase entry as `client_type: 3`. Flutter uses that client ID as the Google token audience. Build a new signed APK with `flutter build apk --release --dart-define=MWITU_GOOGLE_ANDROID_ENABLED=true`. Build without this flag when compiling without the Firebase configuration.
