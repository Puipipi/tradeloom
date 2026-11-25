// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

// Only the host, an optional scheme/port, and an optional trailing slash.
final _serverAddress = RegExp(
  r'^(?:https?://)?(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?)(?::([0-9]+))?/?$',
  caseSensitive: false,
);

/// Parses a host or server origin for the TradeLoom portal.
///
/// Bare hosts use HTTPS. Explicit HTTP is limited to loopback so local QA
/// can use adb reverse without opening a remote cleartext endpoint.
Uri? parseTradeLoomOrigin(String input) {
  final value = input.trim();
  final match = _serverAddress.firstMatch(value);
  if (match == null) return null;

  final portText = match[2];
  final port = portText == null ? null : int.tryParse(portText);
  if (portText != null && (port == null || port < 1 || port > 65535)) {
    return null;
  }

  final uri = Uri.tryParse(value.contains('://') ? value : 'https://$value');
  if (uri == null) return null;
  final host = uri.host;
  if (!host.contains(':')) {
    final unqualified = host.endsWith('.')
        ? host.substring(0, host.length - 1)
        : host;
    final labels = unqualified.split('.');
    if (unqualified.length > 253 ||
        labels.any(
          (label) =>
              label.length > 63 || label.startsWith('-') || label.endsWith('-'),
        )) {
      return null;
    }
    // Browsers reinterpret shortened, octal, and hexadecimal IPv4 spellings.
    // Require dotted decimal whenever the last DNS label looks like a number.
    if (RegExp(r'^(?:[0-9]+|0x[0-9a-f]*)$').hasMatch(labels.last)) {
      try {
        if (Uri.parseIPv4Address(host).join('.') != host) return null;
      } on FormatException {
        return null;
      }
    }
  }
  final loopback = host == 'localhost' || host == '127.0.0.1' || host == '::1';
  if (uri.scheme != 'https' && !(uri.scheme == 'http' && loopback)) return null;
  return Uri(scheme: uri.scheme, host: host, port: port);
}
