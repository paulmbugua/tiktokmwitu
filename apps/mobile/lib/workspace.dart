import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:share_plus/share_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import 'mwitu_links.dart';

const _googleConfigured = bool.fromEnvironment('MWITU_GOOGLE_ANDROID_ENABLED');
Future<void>? _googleInitialization;

class MwituWorkspace extends StatefulWidget {
  const MwituWorkspace({super.key, required this.destination});
  final ValueListenable<Uri?> destination;
  @override
  State<MwituWorkspace> createState() => _MwituWorkspaceState();
}

class _MwituWorkspaceState extends State<MwituWorkspace> {
  final _googleCapability = base64UrlEncode(
    List<int>.generate(32, (_) => Random.secure().nextInt(256)),
  );
  InAppWebViewController? _web;
  bool _failed = false;
  bool _leaving = false;
  double _progress = 0;
  bool _googleBusy = false;
  bool _profileEdge = false;
  bool get _googleEnabled => Platform.isAndroid && _googleConfigured;

  @override
  void initState() {
    super.initState();
    widget.destination.addListener(_navigate);
  }

  URLRequest _request(Uri uri) => URLRequest(url: WebUri(uri.toString()));

  void _navigate() {
    final uri = widget.destination.value;
    if (uri != null) unawaited(_web?.loadUrl(urlRequest: _request(uri)));
  }

  @override
  void dispose() {
    widget.destination.removeListener(_navigate);
    super.dispose();
  }

  Future<void> _leave() async {
    if (_leaving) return;
    _leaving = true;
    try {
      final stage =
          await _web?.evaluateJavascript(
            source: 'location.hostname === "tiktokmwitu.co.ke" && Boolean(document.querySelector(".arena"))',
          ) ==
          true;
      if (!mounted) return;
      if (stage) {
        final leave = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Leave this LIVE?'),
            content: const Text(
              'Returning to the feed disconnects this device from the room.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Stay'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Leave'),
              ),
            ],
          ),
        );
        if (leave != true || !mounted) return;
      }
      Navigator.pop(context);
    } finally {
      _leaving = false;
    }
  }

  Future<PermissionResponse> _permission(PermissionRequest request) async {
    final origin = Uri.tryParse(request.origin.toString());
    final supported = {
      PermissionResourceType.CAMERA,
      PermissionResourceType.MICROPHONE,
      PermissionResourceType.CAMERA_AND_MICROPHONE,
    };
    if (origin == null ||
        origin.host != mwituHost ||
        !isMwituWeb(origin) ||
        request.resources.isEmpty ||
        !request.resources.every(supported.contains)) {
      return PermissionResponse(action: PermissionResponseAction.DENY);
    }
    if (Platform.isIOS) {
      return PermissionResponse(
        resources: request.resources,
        action: PermissionResponseAction.PROMPT,
      );
    }
    final combined = request.resources.contains(
      PermissionResourceType.CAMERA_AND_MICROPHONE,
    );
    final permissions = [
      if (combined || request.resources.contains(PermissionResourceType.CAMERA))
        Permission.camera,
      if (combined ||
          request.resources.contains(PermissionResourceType.MICROPHONE))
        Permission.microphone,
    ];
    final status = await permissions.request();
    return PermissionResponse(
      resources: request.resources,
      action:
          permissions.every(
            (permission) => status[permission]?.isGranted == true,
          )
          ? PermissionResponseAction.GRANT
          : PermissionResponseAction.DENY,
    );
  }

  Future<void> _external(Uri uri) async {
    try {
      if (await launchUrl(uri, mode: LaunchMode.externalApplication)) return;
    } catch (_) {}
    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Couldn’t open this link.')));
    }
  }

  bool _mediaDownload(Uri uri) {
    final parts = uri.pathSegments;
    return uri.scheme == 'https' &&
        uri.port == 443 &&
        uri.userInfo.isEmpty &&
        (uri.host == mwituApi || uri.host == mwituHost) &&
        parts.length == 2 &&
        parts.first == 'media' &&
        parts.last.endsWith('.mp4') &&
        validVideoId(parts.last.substring(0, parts.last.length - 4));
  }

  Future<NavigationActionPolicy> _navigation(NavigationAction action) async {
    final target = Uri.tryParse(action.request.url?.toString() ?? '');
    if (target == null) return NavigationActionPolicy.CANCEL;
    if (!action.isForMainFrame) {
      return target.scheme == 'https' || target.scheme == 'about'
          ? NavigationActionPolicy.ALLOW
          : NavigationActionPolicy.CANCEL;
    }
    if (_mediaDownload(target) && target.queryParameters['download'] == '1') {
      unawaited(_external(target));
      return NavigationActionPolicy.CANCEL;
    }
    if (isMwituWeb(target)) return NavigationActionPolicy.ALLOW;
    if (target.scheme == 'https' && target.userInfo.isEmpty) {
      unawaited(_external(target));
    }
    return NavigationActionPolicy.CANCEL;
  }

  void _addSharing(InAppWebViewController controller) {
    controller.addJavaScriptHandler(
      handlerName: 'mwituShare',
      callback: (args) async {
        final current = Uri.tryParse(
          (await controller.getUrl())?.toString() ?? '',
        );
        final target = args.isEmpty
            ? null
            : Uri.tryParse(args.first.toString());
        if (!mounted ||
            current == null ||
            !isMwituWeb(current) ||
            target == null ||
            !isMwituWeb(target) ||
            appDestination(target) == null) {
          return false;
        }
        try {
          final box = context.findRenderObject() as RenderBox?;
          await SharePlus.instance.share(
            ShareParams(
              uri: target,
              sharePositionOrigin: box == null
                  ? null
                  : box.localToGlobal(Offset.zero) & box.size,
            ),
          );
          return true;
        } catch (_) {
          return false;
        }
      },
    );
  }

  void _addAndroidGoogle(InAppWebViewController controller) {
    if (!_googleEnabled) return;
    controller.addJavaScriptHandler(
      handlerName: 'mwituGoogleAndroid',
      callback: (args) async {
        final current = Uri.tryParse(
          (await controller.getUrl())?.toString() ?? '',
        );
        if (!mounted ||
            _googleBusy ||
            args.length != 1 ||
            args.first != _googleCapability ||
            current == null ||
            current.host != mwituHost ||
            !isMwituWeb(current)) {
          return <String, Object>{};
        }
        _googleBusy = true;
        try {
          final google = GoogleSignIn.instance;
          await (_googleInitialization ??= google.initialize());
          final user = await google.authenticate();
          final token = user.authentication.idToken;
          final active = Uri.tryParse(
            (await controller.getUrl())?.toString() ?? '',
          );
          if (!mounted ||
              token == null ||
              active == null ||
              active.host != mwituHost ||
              !isMwituWeb(active)) {
            return <String, Object>{};
          }
          return {'idToken': token};
        } on GoogleSignInException catch (error) {
          return {
            'cancelled': error.code == GoogleSignInExceptionCode.canceled,
          };
        } finally {
          _googleBusy = false;
        }
      },
    );
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) unawaited(_leave());
    },
    child: AnnotatedRegion<SystemUiOverlayStyle>(
      value: const SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarIconBrightness: Brightness.light,
        statusBarBrightness: Brightness.dark,
      ),
      child: Scaffold(
        body: SafeArea(
          top: !_profileEdge,
          child: Stack(
            fit: StackFit.expand,
            children: [
              InAppWebView(
                initialUrlRequest: _request(
                  widget.destination.value ?? workspaceUri(),
                ),
                initialSettings: InAppWebViewSettings(
                  applicationNameForUserAgent: mwituUserAgent,
                  allowsInlineMediaPlayback: true,
                  mediaPlaybackRequiresUserGesture: false,
                  useShouldOverrideUrlLoading: true,
                  useOnDownloadStart: true,
                  allowsBackForwardNavigationGestures: false,
                  allowFileAccess: false,
                  allowFileAccessFromFileURLs: false,
                  allowUniversalAccessFromFileURLs: false,
                  javaScriptCanOpenWindowsAutomatically: false,
                  mixedContentMode: MixedContentMode.MIXED_CONTENT_NEVER_ALLOW,
                  thirdPartyCookiesEnabled: false,
                ),
                initialUserScripts: UnmodifiableListView([
                  if (_googleEnabled)
                    UserScript(
                      source: _nativeGoogleBridge.replaceFirst(
                        '__CAPABILITY__',
                        jsonEncode(_googleCapability),
                      ),
                      injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                      forMainFrameOnly: true,
                    ),
                  UserScript(
                    source: mwituBridge,
                    injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START,
                    forMainFrameOnly: true,
                  ),
                ]),
                onWebViewCreated: (controller) {
                  _web = controller;
                  _addSharing(controller);
                  _addAndroidGoogle(controller);
                  controller.addJavaScriptHandler(
                    handlerName: 'mwituProfileEdge',
                    callback: (args) async {
                      final uri = Uri.tryParse(
                        (await controller.getUrl())?.toString() ?? '',
                      );
                      if (!mounted ||
                          uri == null ||
                          !isMwituWeb(uri) ||
                          args.length != 1 ||
                          args.first is! bool) {
                        return null;
                      }
                      final enabled = args.first as bool;
                      if (_profileEdge != enabled) {
                        setState(() => _profileEdge = enabled);
                      }
                      return MediaQuery.viewPaddingOf(this.context).top;
                    },
                  );
                  controller.addJavaScriptHandler(
                    handlerName: 'mwituOpenFeed',
                    callback: (_) async {
                      final uri = Uri.tryParse(
                        (await controller.getUrl())?.toString() ?? '',
                      );
                      if (mounted && uri != null && isMwituWeb(uri)) {
                        await _leave();
                      }
                    },
                  );
                },
                onPermissionRequest: (_, request) => _permission(request),
                shouldOverrideUrlLoading: (_, action) => _navigation(action),
                onDownloadStartRequest: (_, request) {
                  final target = Uri.tryParse(request.url.toString());
                  if (target != null && _mediaDownload(target)) {
                    unawaited(_external(target));
                  }
                },
                onProgressChanged: (_, value) {
                  if (mounted) setState(() => _progress = value / 100);
                },
                onLoadStart: (_, _) {
                  if (mounted) {
                    setState(() {
                      _failed = false;
                      _profileEdge = false;
                    });
                  }
                },
                onReceivedError: (_, request, error) {
                  if (mounted &&
                      request.isForMainFrame == true &&
                      !error.description.contains('ERR_ABORTED')) {
                    setState(() => _failed = true);
                  }
                },
                onReceivedHttpError: (_, request, response) {
                  if (mounted &&
                      request.isForMainFrame == true &&
                      (response.statusCode ?? 0) >= 500) {
                    setState(() => _failed = true);
                  }
                },
              ),
              if (_progress > 0 && _progress < 1)
                const Positioned(
                  top: 0,
                  left: 0,
                  right: 0,
                  child: LinearProgressIndicator(minHeight: 2),
                ),
              if (_failed)
                Positioned.fill(
                  child: ColoredBox(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    child: Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.wifi_off_rounded, size: 48),
                          const SizedBox(height: 16),
                          Text(
                            'Couldn’t connect to Mwitu',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          const SizedBox(height: 16),
                          FilledButton(
                            onPressed: _navigate,
                            child: const Text('Try again'),
                          ),
                          TextButton(
                            onPressed: _leave,
                            child: const Text('For You'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}

const mwituBridge = r"""
(() => {
  if (location.origin !== 'https://tiktokmwitu.co.ke') return;
  window.mwituOpenFeed = () => {
    const bridge = window.flutter_inappwebview;
    if (!bridge?.callHandler) return false;
    bridge.callHandler('mwituOpenFeed');
    return true;
  };
  window.mwituProfileEdge = async (enabled) => {
    const bridge = window.flutter_inappwebview;
    return bridge?.callHandler ? bridge.callHandler('mwituProfileEdge', enabled) : null;
  };
  const share = navigator.share?.bind(navigator);
  try {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        if (data?.url && window.flutter_inappwebview?.callHandler) {
          const shared = await window.flutter_inappwebview.callHandler('mwituShare', data.url);
          if (shared) return;
        }
        if (share) return share(data);
        throw new Error('Sharing unavailable');
      }
    });
  } catch (_) {}
})();
""";
const _nativeGoogleBridge = r"""
(() => {
  if (location.origin !== 'https://tiktokmwitu.co.ke' || window.top !== window) return;
  const proof = __CAPABILITY__;
  Object.defineProperty(window, 'mwituAndroidGoogle', {
    value: () => window.flutter_inappwebview.callHandler('mwituGoogleAndroid', proof)
  });
})();
""";
