import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';

import 'mwitu_links.dart';

class _Clip {
  const _Clip(this.id, this.caption, this.handle);
  final String id;
  final String caption;
  final String handle;

  Uri get thumbnail => Uri.https(mwituHost, '/media/$id.jpg');
  Uri get playback => Uri.https(mwituHost, '/media/$id.mp4');
  Uri get link => Uri.https(mwituHost, '/watch/$id');
}

class VideoFeed extends StatefulWidget {
  const VideoFeed({super.key, required this.open, required this.active});
  final Future<void> Function(Uri) open;
  final bool active;

  @override
  State<VideoFeed> createState() => _VideoFeedState();
}

class _VideoFeedState extends State<VideoFeed> with WidgetsBindingObserver {
  final _client = http.Client();
  final _pages = PageController();
  final _clips = <_Clip>[];
  Map<String, String>? _cursor;
  bool _loading = false;
  bool _error = false;
  bool _muted = true;
  bool _foreground = true;
  int _position = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_load(reset: true));
  }

  Future<void> _load({bool reset = false}) async {
    if (_loading || (!reset && _cursor == null)) return;
    setState(() {
      _loading = true;
      _error = false;
    });
    try {
      final response = await _client
          .get(Uri.https(mwituApi, '/api/videos', reset ? null : _cursor))
          .timeout(const Duration(seconds: 12));
      if (response.statusCode != 200) {
        throw const FormatException('Feed unavailable');
      }
      final result = jsonDecode(response.body) as Map<String, dynamic>;
      final clips = (result['items'] as List)
          .whereType<Map<String, dynamic>>()
          .where(
            (item) =>
                item['id'] is String && validVideoId(item['id'] as String),
          )
          .map(
            (item) => _Clip(
              item['id'] as String,
              item['caption'] as String? ?? '',
              item['handle'] as String? ?? '',
            ),
          );
      if (!mounted) return;
      final next = result['next'] as Map<String, dynamic>?;
      if (reset && _pages.hasClients) _pages.jumpToPage(0);
      setState(() {
        if (reset) {
          _clips.clear();
          _position = 0;
        }
        final existing = _clips.map((clip) => clip.id).toSet();
        _clips.addAll(clips.where((clip) => existing.add(clip.id)));
        _cursor = next?.cast<String, String>();
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (mounted) {
      setState(() => _foreground = state == AppLifecycleState.resumed);
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _pages.dispose();
    _client.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      bottom: false,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 6, 6, 10),
            child: Row(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(11),
                  child: Image.asset('assets/mwitu.png', width: 35, height: 35),
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    'TikTok Mwitu',
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                    style: Theme.of(context).textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w800),
                  ),
                ),
                const Spacer(),
                IconButton(
                  tooltip: 'Following',
                  onPressed: () => widget.open(workspaceUri(tab: 'following')),
                  icon: const Icon(Icons.people_outline_rounded),
                ),
                IconButton(
                  tooltip: 'Discover',
                  onPressed: () => widget.open(workspaceUri(tab: 'videos')),
                  icon: const Icon(Icons.search_rounded),
                ),
                IconButton(
                  tooltip: 'Refresh feed',
                  onPressed: _loading ? null : () => _load(reset: true),
                  icon: const Icon(Icons.refresh_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: _clips.isEmpty
                ? _empty()
                : PageView.builder(
                    scrollDirection: Axis.vertical,
                    controller: _pages,
                    itemCount: _clips.length + (_cursor != null ? 1 : 0),
                    onPageChanged: (index) {
                      setState(() => _position = index);
                      if (!_error && index >= _clips.length - 2) {
                        unawaited(_load());
                      }
                    },
                    itemBuilder: (_, index) {
                      if (index >= _clips.length) {
                        return Center(
                          child: _error
                              ? FilledButton(
                                  onPressed: () => _load(),
                                  child: const Text('Retry'),
                                )
                              : _loading
                              ? const CircularProgressIndicator()
                              : TextButton(
                                  onPressed: () => _load(),
                                  child: const Text('Load more'),
                                ),
                        );
                      }
                      final clip = _clips[index];
                      return _VideoCard(
                        key: ValueKey(clip.id),
                        clip: clip,
                        active:
                            widget.active && _foreground && index == _position,
                        muted: _muted,
                        toggleMute: () => setState(() => _muted = !_muted),
                        open: widget.open,
                      );
                    },
                  ),
          ),
        ],
      ),
    ),
    bottomNavigationBar: NavigationBar(
      selectedIndex: 0,
      onDestinationSelected: (index) async {
        const tabs = ['', 'live', 'post', 'inbox', 'account'];
        if (index != 0) {
          await widget.open(workspaceUri(tab: tabs[index]));
          if (mounted && index == 2) unawaited(_load(reset: true));
        }
      },
      destinations: const [
        NavigationDestination(
          icon: Icon(Icons.play_circle_outline_rounded),
          selectedIcon: Icon(Icons.play_circle_fill_rounded),
          label: 'For You',
        ),
        NavigationDestination(
          icon: Icon(Icons.wifi_tethering_rounded),
          label: 'LIVE',
        ),
        NavigationDestination(
          icon: Icon(Icons.add_box_outlined),
          label: 'Post',
        ),
        NavigationDestination(
          icon: Icon(Icons.chat_bubble_outline_rounded),
          label: 'Inbox',
        ),
        NavigationDestination(
          icon: Icon(Icons.person_outline_rounded),
          label: 'Profile',
        ),
      ],
    ),
  );

  Widget _empty() => Center(
    child: Padding(
      padding: const EdgeInsets.all(22),
      child: _loading
          ? const CircularProgressIndicator()
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.slow_motion_video_rounded, size: 48),
                const SizedBox(height: 14),
                Text(
                  _error ? 'Couldn’t load the feed' : 'No videos yet',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 14),
                FilledButton(
                  onPressed: _error
                      ? () => _load(reset: true)
                      : () => widget.open(workspaceUri(tab: 'live')),
                  child: Text(_error ? 'Try again' : 'Explore LIVE'),
                ),
              ],
            ),
    ),
  );
}

class _VideoCard extends StatefulWidget {
  const _VideoCard({
    super.key,
    required this.clip,
    required this.active,
    required this.muted,
    required this.toggleMute,
    required this.open,
  });
  final _Clip clip;
  final bool active;
  final bool muted;
  final VoidCallback toggleMute;
  final Future<void> Function(Uri) open;

  @override
  State<_VideoCard> createState() => _VideoCardState();
}

class _VideoCardState extends State<_VideoCard> {
  VideoPlayerController? _video;
  bool _failed = false;
  bool _paused = false;

  @override
  void initState() {
    super.initState();
    if (widget.active) unawaited(_start());
  }

  Future<void> _start() async {
    final video = VideoPlayerController.networkUrl(widget.clip.playback);
    _video = video;
    try {
      await video.initialize();
      if (!mounted || _video != video || !widget.active) return;
      await video.setLooping(true);
      await video.setVolume(widget.muted ? 0 : 1);
      if (!mounted || _video != video || !widget.active) return;
      if (!_paused) await video.play();
      if (mounted && _video == video) setState(() {});
    } catch (_) {
      if (mounted && _video == video) setState(() => _failed = true);
    }
  }

  void _release() {
    final video = _video;
    _video = null;
    unawaited(video?.dispose());
  }

  @override
  void didUpdateWidget(covariant _VideoCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active && oldWidget.active) _release();
    if (widget.active && !oldWidget.active) {
      _failed = false;
      _paused = false;
      unawaited(_start());
    }
    if (widget.active && oldWidget.muted != widget.muted) {
      unawaited(_video?.setVolume(widget.muted ? 0 : 1));
    }
  }

  @override
  void dispose() {
    _release();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final video = _video;
    final initialized = video?.value.isInitialized ?? false;
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 0, 6, 5),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(22),
        child: ColoredBox(
          color: const Color(0xff211829),
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (initialized)
                FittedBox(
                  fit: video!.value.aspectRatio > 1
                      ? BoxFit.contain
                      : BoxFit.cover,
                  child: SizedBox(
                    width: video.value.size.width,
                    height: video.value.size.height,
                    child: VideoPlayer(video),
                  ),
                )
              else
                Image.network(
                  widget.clip.thumbnail.toString(),
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => const SizedBox.shrink(),
                ),
              if (initialized)
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () {
                      setState(() => _paused = !_paused);
                      unawaited(_paused ? video!.pause() : video!.play());
                    },
                    child: _paused
                        ? const Icon(Icons.play_circle_fill_rounded, size: 62)
                        : null,
                  ),
                ),
              if (_failed)
                Center(
                  child: FilledButton.tonal(
                    onPressed: () =>
                        widget.open(workspaceUri(video: widget.clip.id)),
                    child: const Text('Open video'),
                  ),
                ),
              const Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                height: 170,
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [Colors.transparent, Color(0xee100c17)],
                      ),
                    ),
                  ),
                ),
              ),
              Positioned(
                left: 16,
                right: 66,
                bottom: 16,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '@${widget.clip.handle}',
                      style: const TextStyle(
                        fontWeight: FontWeight.w800,
                        color: Colors.white,
                      ),
                    ),
                    if (widget.clip.caption.isNotEmpty)
                      Text(
                        widget.clip.caption,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Colors.white),
                      ),
                  ],
                ),
              ),
              Positioned(
                right: 8,
                bottom: 12,
                child: Column(
                  children: [
                    IconButton.filledTonal(
                      tooltip: widget.muted ? 'Turn sound on' : 'Mute',
                      onPressed: widget.toggleMute,
                      icon: Icon(
                        widget.muted
                            ? Icons.volume_off_rounded
                            : Icons.volume_up_rounded,
                      ),
                    ),
                    IconButton.filledTonal(
                      tooltip: 'Comments',
                      onPressed: () => widget.open(
                        workspaceUri(video: widget.clip.id, action: 'comments'),
                      ),
                      icon: const Icon(Icons.chat_bubble_outline_rounded),
                    ),
                    IconButton.filledTonal(
                      tooltip: 'Open reactions, follow and save',
                      onPressed: () =>
                          widget.open(workspaceUri(video: widget.clip.id)),
                      icon: const Icon(Icons.favorite_border_rounded),
                    ),
                    Builder(
                      builder: (context) => IconButton.filledTonal(
                        tooltip: 'Share',
                        onPressed: () async {
                          final box = context.findRenderObject() as RenderBox?;
                          try {
                            await SharePlus.instance.share(
                              ShareParams(
                                uri: widget.clip.link,
                                sharePositionOrigin: box == null
                                    ? null
                                    : box.localToGlobal(Offset.zero) & box.size,
                              ),
                            );
                          } catch (_) {
                            if (context.mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                const SnackBar(
                                  content: Text('Couldn’t open sharing.'),
                                ),
                              );
                            }
                          }
                        },
                        icon: const Icon(Icons.share_rounded),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
