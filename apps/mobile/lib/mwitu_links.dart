const mwituHost = 'tiktokmwitu.co.ke';
const mwituApi = 'api.tiktokmwitu.co.ke';
const mwituUserAgent = 'MwituFlutter/1.0';
final _videoId = RegExp(
  r'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$',
  caseSensitive: false,
);
final _roomCode = RegExp(r'^(?:[0-9]{6}|[a-f0-9]{16})$', caseSensitive: false);

bool validVideoId(String value) => _videoId.hasMatch(value);

bool isMwituWeb(Uri uri) =>
    uri.scheme == 'https' &&
    uri.port == 443 &&
    uri.userInfo.isEmpty &&
    (uri.host == mwituHost || uri.host == 'www.$mwituHost');

Uri workspaceUri({String? tab, String? video, String? action}) =>
    Uri.https(mwituHost, '/', {
      'browse': ?tab,
      'v': ?video,
      if (video != null) 'app': '1',
      'action': ?action,
    });

Uri? appDestination(Uri incoming) {
  final custom =
      incoming.scheme == 'mwitu' &&
      incoming.host == 'open' &&
      incoming.userInfo.isEmpty &&
      !incoming.hasPort;
  if (!custom && !isMwituWeb(incoming)) return null;
  final path = incoming.pathSegments
      .where((segment) => segment.isNotEmpty)
      .toList();
  if (path.length == 2 && path.first == 'watch' && validVideoId(path.last)) {
    return workspaceUri(video: path.last.toLowerCase());
  }
  if (path.length == 2 &&
      path.first == 'join' &&
      _roomCode.hasMatch(path.last)) {
    return Uri.https(mwituHost, '/', {'live': path.last});
  }
  if (path.length == 1 && path.first == 'live') {
    return workspaceUri(tab: 'live');
  }
  if (path.isNotEmpty) return null;
  final code = incoming.queryParameters['live'];
  final topup = incoming.queryParameters['topup'];
  if (topup != null && validVideoId(topup)) {
    final room = incoming.queryParameters['room'];
    return Uri.https(mwituHost, '/', {
      'topup': topup.toLowerCase(),
      if (code != null && _roomCode.hasMatch(code)) 'live': code,
      if (room != null && validVideoId(room)) 'room': room.toLowerCase(),
    });
  }
  if (code != null && _roomCode.hasMatch(code)) {
    return Uri.https(mwituHost, '/', {'live': code});
  }
  final video = incoming.queryParameters['v'];
  if (video != null && validVideoId(video)) {
    return workspaceUri(video: video.toLowerCase());
  }
  return null;
}
