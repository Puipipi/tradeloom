// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

final _attachmentPath = RegExp(
  r'^/enterprise/deliveries/[0-9a-f]{32}/[0-9a-f]{32}/download$',
);

/// This entry point handles ordinary attachments registered by the enterprise
/// portal. Previews and every other URL stay in the existing navigation flow.
Uri? tradeLoomAttachmentUri(
  Uri origin,
  String raw, {
  required bool isMainFrame,
}) {
  if (!isMainFrame) return null;
  final uri = Uri.tryParse(raw);
  if (uri == null ||
      !uri.hasAuthority ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.scheme != origin.scheme ||
      uri.host != origin.host ||
      uri.port != origin.port ||
      !_attachmentPath.hasMatch(uri.path)) {
    return null;
  }
  return uri;
}
