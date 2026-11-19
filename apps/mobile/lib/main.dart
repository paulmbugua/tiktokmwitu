import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'mwitu_links.dart';
import 'video_feed.dart';
import 'workspace.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final links = AppLinks();
  runApp(MwituApp(links: links));
}

const mwituBackground = Color(0xff15121b);
const mwituAccent = Color(0xffd3fc77);

class MwituApp extends StatefulWidget {
  const MwituApp({super.key, required this.links});
  final AppLinks links;

  @override
  State<MwituApp> createState() => _MwituAppState();
}

class _MwituAppState extends State<MwituApp> {
  final _navigator = GlobalKey<NavigatorState>();
  StreamSubscription<Uri>? _subscription;
  bool _workspaceOpen = false;
  final _destination = ValueNotifier<Uri?>(null);

  @override
  void initState() {
    super.initState();
    _subscription = widget.links.uriLinkStream.listen((link) {
      final destination = appDestination(link);
      if (destination == null) return;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_open(destination));
      });
      WidgetsBinding.instance.ensureVisualUpdate();
    }, onError: (Object _) {});
  }

  Future<void> _open(Uri destination) async {
    if (_workspaceOpen) {
      _destination.value = destination;
      return;
    }
    final navigator = _navigator.currentState;
    if (navigator == null) return;
    setState(() => _workspaceOpen = true);
    _destination.value = destination;
    try {
      await navigator.push<void>(
        MaterialPageRoute(
          builder: (_) => MwituWorkspace(destination: _destination),
        ),
      );
    } finally {
      if (mounted) {
        _destination.value = null;
        setState(() => _workspaceOpen = false);
      }
    }
  }

  @override
  void dispose() {
    unawaited(_subscription?.cancel());
    _destination.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    navigatorKey: _navigator,
    title: 'TikTok Mwitu',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      colorScheme:
          ColorScheme.fromSeed(
            seedColor: mwituAccent,
            brightness: Brightness.dark,
          ).copyWith(
            primary: mwituAccent,
            onPrimary: const Color(0xff20280d),
            surface: mwituBackground,
          ),
      scaffoldBackgroundColor: mwituBackground,
      appBarTheme: const AppBarTheme(
        backgroundColor: mwituBackground,
        systemOverlayStyle: SystemUiOverlayStyle.light,
      ),
    ),
    home: VideoFeed(open: _open, active: !_workspaceOpen),
  );
}
