import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

import 'mwitu_links.dart';

class AndroidRelease {
  const AndroidRelease._(this.version, this.build, this.bytes, this.notes);

  final String version;
  final int build;
  final int bytes;
  final List<String> notes;

  static final _version = RegExp(r'^\d{1,6}\.\d{1,6}\.\d{1,6}$');

  static AndroidRelease? available(
    Object? payload,
    int installedBuild,
    int sdk,
  ) {
    if (payload is! Map<String, dynamic>) return null;
    final version = payload['version'];
    final build = payload['versionCode'];
    final bytes = payload['bytes'];
    final minSdk = payload['minSdk'];
    if (version is! String ||
        !_version.hasMatch(version) ||
        build is! int ||
        build <= installedBuild ||
        build > 2100000000 ||
        minSdk is! int ||
        minSdk <= 0 ||
        minSdk > sdk ||
        bytes is! int ||
        bytes <= 0) {
      return null;
    }
    final notes = payload['notes'];
    return AndroidRelease._(
      version,
      build,
      bytes,
      notes is List
          ? notes
                .whereType<String>()
                .where((note) => note.isNotEmpty && note.length <= 180)
                .take(4)
                .toList(growable: false)
          : const [],
    );
  }

  Uri get download =>
      Uri.https(mwituHost, '/download/tiktok-mwitu-$version.apk');
}

class AndroidUpdateBanner extends StatefulWidget {
  const AndroidUpdateBanner({super.key, required this.active});

  final bool active;

  @override
  State<AndroidUpdateBanner> createState() => _AndroidUpdateBannerState();
}

class _AndroidUpdateBannerState extends State<AndroidUpdateBanner>
    with WidgetsBindingObserver {
  static const _channel = MethodChannel('mwitu/android_updates');
  static const _reminder = Duration(days: 1);
  static const _interval = Duration(minutes: 15);
  final _client = http.Client();
  Timer? _timer;
  AndroidRelease? _release;
  DateTime? _lastCheck;
  DateTime? _snoozedUntil;
  int? _snoozedBuild;
  bool _checking = false;
  bool _showingDetails = false;
  bool get _android =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  @override
  void initState() {
    super.initState();
    if (!_android) return;
    WidgetsBinding.instance.addObserver(this);
    _timer = Timer.periodic(_interval, (_) => unawaited(_check()));
    unawaited(_check());
  }

  @override
  void didUpdateWidget(AndroidUpdateBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !oldWidget.active) unawaited(_check());
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_check());
  }

  bool _snoozed(int build, DateTime now) =>
      _snoozedBuild == build && (_snoozedUntil?.isAfter(now) ?? false);

  Future<void> _check() async {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final now = DateTime.now();
    final lastCheck = _lastCheck;
    if (!_android ||
        !widget.active ||
        (lifecycle != null && lifecycle != AppLifecycleState.resumed) ||
        _checking ||
        (lastCheck != null &&
            now.difference(lastCheck) < const Duration(minutes: 1))) {
      return;
    }
    _lastCheck = now;
    _checking = true;
    try {
      final state = await _channel.invokeMapMethod<String, int>('state');
      final installed = state?['versionCode'];
      final sdk = state?['sdkInt'];
      if (installed == null || installed <= 0 || sdk == null || !mounted) {
        return;
      }
      final response = await _client
          .get(Uri.https(mwituHost, '/download/android/latest.json'))
          .timeout(const Duration(seconds: 6));
      if (!mounted) return;
      final release = response.statusCode == 200
          ? AndroidRelease.available(jsonDecode(response.body), installed, sdk)
          : null;
      final savedUntil = state?['snoozedUntil'] ?? 0;
      final snoozedOnDevice =
          state?['snoozedVersionCode'] == release?.build &&
          savedUntil > DateTime.now().millisecondsSinceEpoch;
      setState(() {
        _release =
            release == null ||
                snoozedOnDevice ||
                _snoozed(release.build, DateTime.now())
            ? null
            : release;
      });
    } catch (_) {
      // A slow connection or format error should never block the feed.
    } finally {
      _checking = false;
    }
  }

  Future<void> _later(AndroidRelease release) async {
    setState(() {
      _snoozedBuild = release.build;
      _snoozedUntil = DateTime.now().add(_reminder);
      if (_release?.build == release.build) _release = null;
    });
    try {
      await _channel.invokeMethod<void>('snooze', {
        'versionCode': release.build,
      });
    } catch (_) {}
  }

  Future<void> _details(AndroidRelease release) async {
    if (_showingDetails) return;
    _showingDetails = true;
    try {
      final download = await showModalBottomSheet<bool>(
        context: context,
        showDragHandle: true,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (context) => SafeArea(
          top: false,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 0, 22, 20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'What’s new in Mwitu',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 5),
                Text(
                  'Version ${release.version} · ${(release.bytes / (1024 * 1024)).toStringAsFixed(1)} MB',
                ),
                for (final note in release.notes)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Text('• $note'),
                  ),
                const SizedBox(height: 16),
                const Text(
                  'Open the APK after it downloads. Android will ask you to confirm the update.',
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => Navigator.pop(context, true),
                  icon: const Icon(Icons.download_rounded),
                  label: const Text('Download update'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, false),
                  child: const Text('Remind me tomorrow'),
                ),
              ],
            ),
          ),
        ),
      );
      if (!mounted) return;
      if (download == false) await _later(release);
      if (download != true) return;
      try {
        if (await launchUrl(
          release.download,
          mode: LaunchMode.externalApplication,
        )) {
          return;
        }
      } catch (_) {}
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Couldn’t open the download. Try again in a moment.'),
          ),
        );
      }
    } finally {
      _showingDetails = false;
    }
  }

  @override
  void dispose() {
    if (_android) WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final release = _release;
    if (release == null || !widget.active) return const SizedBox.shrink();
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Material(
        color: colors.primaryContainer,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: Row(
          children: [
            Expanded(
              child: InkWell(
                onTap: () => _details(release),
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Row(
                    children: [
                      Icon(
                        Icons.system_update_rounded,
                        color: colors.onPrimaryContainer,
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Text(
                          'Mwitu ${release.version} is ready · What’s new',
                          style: TextStyle(color: colors.onPrimaryContainer),
                        ),
                      ),
                      Icon(
                        Icons.arrow_forward_rounded,
                        size: 18,
                        color: colors.onPrimaryContainer,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            IconButton(
              onPressed: () => _later(release),
              tooltip: 'Remind me tomorrow',
              color: colors.onPrimaryContainer,
              icon: const Icon(Icons.close_rounded, size: 18),
            ),
          ],
        ),
      ),
    );
  }
}
