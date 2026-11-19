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

The APK is at `build/app/outputs/flutter-apk/app-release.apk`. Increase the version name and build number in `pubspec.yaml` for every release and build with the production configuration below. From the repository root, publish the signed APK with PowerShell while authenticated to Wrangler:

```powershell
./deploy/publish-android.ps1 -Apk './apps/mobile/build/app/outputs/flutter-apk/app-release.apk' -Notes @('Short description of the changes')
```

The publisher verifies the package and signing certificate, uploads the versioned APK to R2, updates the public release manifest, and verifies the download. Commit the updated `apps/web/cloudflare/android-releases.json` after publishing. The website download and the in-app update check use the same release. Android builds from 1.0.4 onward check on launch, when returning to the native feed, and periodically while it is open. People on earlier builds can get the first update from the website.

## Build iPhone

Use macOS with Xcode and run `flutter build ios --simulator` for the simulator or `flutter build ios --release --no-codesign` for an unsigned device compile. GitHub Actions runs those checks on macOS. For installation through TestFlight or the App Store, configure the `ke.co.tiktokmwitu.mwitu` bundle in the Apple Developer account with a distribution certificate and provisioning profile, then run `flutter build ipa`. The iOS target uses iOS 15 or later. The private `mwitu://open/` scheme is registered on both platforms. HTTPS Universal Links on iOS require the Apple team association and app entitlement.

Review Apple’s current digital-goods payment and user-generated-content rules before an App Store submission. This source uses the existing web checkout and is configured for development builds. [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

## Google sign-in on Android

Register Android package `ke.co.tiktokmwitu.mwitu` in Firebase under the project that owns Google sign-in. Add both signing fingerprints for the APK you distribute, enable Google in Firebase Authentication, then download a fresh `google-services.json` into `apps/mobile/android/app/`. The file is ignored by Git.

Set the VPS API’s `GOOGLE_ANDROID_CLIENT_ID` to the **Web OAuth client ID** supplied by the matching Android Firebase entry as `client_type: 3`. Flutter uses that client ID as the Google token audience. Build a new signed APK with `flutter build apk --release --dart-define=MWITU_GOOGLE_ANDROID_ENABLED=true`. Build without this flag when compiling without the Firebase configuration.

The mobile workflow also supports a manual Google-enabled Android build. Supply the matching JSON in the encrypted `MWITU_ANDROID_FIREBASE_RELEASE` Actions secret and turn on the `google_android` input. Sign the resulting APK with the website release key before publishing.
