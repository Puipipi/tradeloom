import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_app/ui/tradeloom/tradeloom_origin.dart';
import 'package:dsh_app/ui/web/web_navigation.dart';

void main() {
  group('TradeLoom workbench origin', () {
    test('accepts HTTPS origins and normalizes a trailing slash', () {
      expect(
        parseTradeLoomOrigin('https://workbench.example/'),
        Uri.parse('https://workbench.example'),
      );
    });

    test('defaults to HTTPS for plain domains and IP addresses', () {
      for (final value in [
        'workbench.example',
        '203.0.113.10:8443',
        '[2001:db8::10]:8443',
      ]) {
        expect(parseTradeLoomOrigin(value), Uri.parse('https://$value'));
      }
    });

    test('allows plain HTTP only for loopback QA', () {
      expect(
        parseTradeLoomOrigin('http://127.0.0.1:8443'),
        Uri.parse('http://127.0.0.1:8443'),
      );
      expect(
        parseTradeLoomOrigin('http://localhost:8000'),
        Uri.parse('http://localhost:8000'),
      );
      expect(parseTradeLoomOrigin('http://workbench.example'), isNull);
    });

    test('rejects paths, credentials, queries and fragments', () {
      for (final value in [
        'https://workbench.example/enterprise',
        'https://user:secret@workbench.example',
        'https://workbench.example?next=/enterprise/',
        'https://workbench.example#login',
        'https://@workbench.example',
        'workbench.example/enterprise',
        'workbench.example:0',
        'workbench.example:65536',
        'workbench.example:',
        'workbench.example:999999999999999999999999',
        'workbench.example%2fother.example',
        r'workbench.example\other.example',
        'workbench.example\nother.example',
        'https://127.1',
        'https://0x7f000001',
        'https://127.00.0.1',
        'http://203.0.113.10:8443',
        'http://[2001:db8::10]',
        '[bad::ip]',
        'ftp://workbench.example',
      ]) {
        expect(parseTradeLoomOrigin(value), isNull, reason: value);
      }
    });

    test('WebView navigation stays on exact scheme, host and port', () {
      final origin = Uri.parse('https://workbench.example:9443');
      expect(
        staysOnOrigin(origin, 'https://workbench.example:9443/enterprise/'),
        isTrue,
      );
      expect(
        staysOnOrigin(origin, 'https://workbench.example/enterprise/'),
        isFalse,
      );
      expect(
        staysOnOrigin(origin, 'http://workbench.example:9443/enterprise/'),
        isFalse,
      );
      expect(staysOnOrigin(origin, 'https://elsewhere.example/'), isFalse);
      expect(staysOnOrigin(origin, 'javascript:alert(1)'), isFalse);
    });
  });
}
// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
