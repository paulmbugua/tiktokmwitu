import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mwitu/android_updates.dart';

const release = {
  'version': '1.0.5',
  'versionCode': 6,
  'minSdk': 24,
  'bytes': 52428800,
  'notes': ['New LIVE tools'],
};

void main() {
  test('only a newer compatible Android build is offered', () {
    expect(AndroidRelease.available(release, 6, 35), isNull);
    expect(AndroidRelease.available(release, 7, 35), isNull);
    expect(AndroidRelease.available(release, 5, 23), isNull);
    expect(
      AndroidRelease.available({...release, 'version': '../other'}, 5, 35),
      isNull,
    );
    expect(
      AndroidRelease.available(
        {...release, 'url': 'https://other.example'},
        5,
        35,
      )?.download.toString(),
      'https://tiktokmwitu.co.ke/download/tiktok-mwitu-1.0.5.apk',
    );
  });

  testWidgets('shows release notes and remembers Later for this release', (
    tester,
  ) async {
    var offered = release;
    var snoozedBuild = 0;
    var fetches = 0;
    const channel = MethodChannel('mwitu/android_updates');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'snooze') {
        snoozedBuild = call.arguments['versionCode'] as int;
        return null;
      }
      return {
        'versionCode': 5,
        'sdkInt': 35,
        'snoozedVersionCode': snoozedBuild,
        'snoozedUntil': DateTime.now()
            .add(const Duration(days: 1))
            .millisecondsSinceEpoch,
      };
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);

    await http.runWithClient(
      () async {
        Future<void> show({required bool active}) async {
          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(body: AndroidUpdateBanner(active: active)),
            ),
          );
          await tester.pumpAndSettle();
        }

        await show(active: false);
        expect(fetches, 0);
        await show(active: true);
        await tester.tap(find.textContaining('Mwitu 1.0.5 is ready'));
        await tester.pumpAndSettle();
        expect(find.textContaining('New LIVE tools'), findsOneWidget);
        expect(find.textContaining('50.0 MB'), findsOneWidget);
        expect(find.text('Download update'), findsOneWidget);
        await tester.tap(find.text('Remind me tomorrow'));
        await tester.pumpAndSettle();
        expect(snoozedBuild, 6);
        expect(find.textContaining('Mwitu 1.0.5 is ready'), findsNothing);

        await tester.pumpWidget(const SizedBox());
        await show(active: true);
        expect(find.textContaining('Mwitu 1.0.5 is ready'), findsNothing);

        offered = {...release, 'version': '1.0.6', 'versionCode': 7};
        await tester.pumpWidget(const SizedBox());
        await show(active: true);
        expect(find.textContaining('Mwitu 1.0.6 is ready'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      },
      () => MockClient((request) async {
        expect(request.url.path, '/download/android/latest.json');
        fetches++;
        return http.Response(jsonEncode(offered), 200);
      }),
    );
  });
}
