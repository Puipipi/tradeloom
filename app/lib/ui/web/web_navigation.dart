/// Navigation policy for the embedded DSH site.
enum DshWebNavigation { stay, external, block }

DshWebNavigation dshWebNavigation(Uri base, String url, bool isMainFrame) {
  if (!isMainFrame) return DshWebNavigation.stay;
  final target = Uri.tryParse(url);
  if (target == null) return DshWebNavigation.block;
  final web = target.scheme == 'http' || target.scheme == 'https';
  if (web && target.host.isNotEmpty) {
    if (target.scheme == base.scheme &&
        target.host == base.host &&
        target.port == base.port) {
      return DshWebNavigation.stay;
    }
    return DshWebNavigation.external;
  }
  return target.scheme == 'mailto'
      ? DshWebNavigation.external
      : DshWebNavigation.block;
}

/// Navigation policy for the TradeLoom workbench. Its Django session and
/// CSRF cookies are scoped to one origin; leaving it would silently move the
/// user into a different security context, so every frame stays same-origin.
bool staysOnOrigin(Uri allowedOrigin, String url) {
  final target = Uri.tryParse(url);
  return target != null &&
      (target.scheme == 'http' || target.scheme == 'https') &&
      target.scheme == allowedOrigin.scheme &&
      target.host == allowedOrigin.host &&
      target.port == allowedOrigin.port;
}
