import 'package:dsh_app/ui/web/web_navigation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final base = Uri.parse('http://127.0.0.1:8080/?token=local');
  test('same origin stays, including a token and another path', () {
    expect(dshWebNavigation(base, 'http://127.0.0.1:8080/chat/123?token=local', true), DshWebNavigation.stay);
  });
  test('other origins and mail open externally', () {
    for (final url in [
      'http://127.0.0.1:8081/',
      'https://127.0.0.1:8080/',
      'https://example.com/',
      'mailto:hi@example.com',
    ]) {
      expect(dshWebNavigation(base, url, true), DshWebNavigation.external, reason: url);
    }
  });
  test('unsupported main-frame schemes are blocked', () {
    for (final url in [
      'intent:test',
      'tel:123',
      'about:blank',
      'data:text/html,test',
      'javascript:alert(1)',
      'file:///tmp/a',
    ]) {
      expect(dshWebNavigation(base, url, true), DshWebNavigation.block, reason: url);
      expect(dshWebNavigation(base, url, false), DshWebNavigation.stay, reason: url);
    }
  });
  test('an absent HTTP port equals its default port', () {
    expect(
      dshWebNavigation(Uri.parse('https://example.com'), 'https://example.com:443/path', true),
      DshWebNavigation.stay,
    );
  });
}
