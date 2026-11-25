import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

void main() {
  group('private IPv6 HTTP origins', () {
    for (final host in [
      'fc00::1',
      'fcff:ffff::1',
      'fd00::1',
      'FD7A:115C:A1E0::1',
      'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
      'fe80::1',
      'fe90::1',
      'fea0::1',
      'FEBF:FFFF::1',
      'fe80:0000:0000:0000:0000:0000:0000:0001',
      '::1',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
    ]) {
      test('accepts [$host] without DNS lookup', () {
        final input = Uri.parse('http://[$host]:8080');
        final normalized = normalizeServerUrl('$input/');
        expect(normalized.scheme, 'http');
        expect(normalized.host, input.host);
        expect(normalized.port, 8080);
        expect(normalized.path, isEmpty);
        expect(normalizeServerUrl(input), normalized);
        expect(controlSocketUrl(normalized).toString(), 'ws://${input.authority}/ws/v1/connect');
      });
    }
  });

  group('HTTPS remains required outside private ranges', () {
    for (final host in [
      '[fbff::1]',
      '[fe00::1]',
      '[fe7f:ffff::1]',
      '[fec0::1]',
      '[feff::1]',
      '[ff02::1]',
      '[::]',
      '[::2]',
      '[::ffff:127.0.0.1]',
      '[2001:db8::1]',
      '[2606:4700:4700::1111]',
      '8.8.8.8',
      '172.15.255.255',
      '172.32.0.1',
      '192.169.0.1',
      '100.63.255.255',
      '100.128.0.1',
      'example.com',
    ]) {
      test('rejects HTTP for $host but accepts HTTPS', () {
        expect(() => normalizeServerUrl('http://$host:8080'), throwsArgumentError);
        final secure = normalizeServerUrl('https://$host:8443');
        expect(secure.scheme, 'https');
        expect(secure.port, 8443);
        expect(controlSocketUrl(secure).scheme, 'wss');
      });
    }
  });

  group('IPv4 validation', () {
    for (final host in ['10.0.0.256', '10.999.0.1', '127.0.999.1', '192.168.1.999', '169.254.256.1', '100.64.0.999']) {
      test('rejects invalid private-looking address $host', () {
        expect(() => normalizeServerUrl('http://$host'), throwsArgumentError);
      });
    }
    for (final host in [
      '10.255.255.255',
      '127.0.0.2',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.2',
      '169.254.0.1',
      '100.64.0.1',
      '100.127.255.255',
      'localhost',
      'host.local',
      'host.test',
      'host.localhost',
    ]) {
      test('preserves local HTTP exception for $host', () {
        expect(normalizeServerUrl('http://$host').scheme, 'http');
      });
    }
  });
}
