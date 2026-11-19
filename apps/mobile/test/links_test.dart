import 'package:flutter_test/flutter_test.dart';
import 'package:mwitu/mwitu_links.dart';

void main() {
  const id = 'a10d7c67-f691-4e78-abc5-86b7ce41d62c';
  test('public watch links route to the video workspace', () {
    final destination = appDestination(
      Uri.parse('https://tiktokmwitu.co.ke/watch/$id'),
    );
    expect(destination?.queryParameters, {'v': id, 'app': '1'});
  });
  test('audience invites open the room directly', () {
    for (final link in [
      'https://www.tiktokmwitu.co.ke/join/012345',
      'https://tiktokmwitu.co.ke/?live=012345',
      'mwitu://open/join/012345',
    ]) {
      expect(
        appDestination(Uri.parse(link))?.queryParameters['live'],
        '012345',
      );
    }
  });
  test('payment returns preserve the room and invite', () {
    final destination = appDestination(
      Uri.parse('mwitu://open/?topup=$id&room=$id&live=012345'),
    );
    expect(destination?.queryParameters, {
      'topup': id,
      'room': id,
      'live': '012345',
    });
  });
  test('untrusted and invalid URLs are rejected', () {
    for (final link in [
      'https://tiktokmwitu.co.ke.evil.example/watch/$id',
      'https://tiktokmwitu.co.ke:444/watch/$id',
      'https://tiktokmwitu.co.ke/join/123',
      'http://tiktokmwitu.co.ke/watch/$id',
      'mwitu://evil/join/012345',
    ]) {
      expect(appDestination(Uri.parse(link)), isNull);
    }
  });
}
