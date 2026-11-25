import 'dart:async';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../plugins/seams/seat_state.dart' show seatRouteGuardReportProvider;
import '../../../remote/ssh/ssh_link.dart';
import '../../../runtime/runtime_state.dart';
import '../../../state/connection_state.dart';
import '../../../state/hosts_state.dart';

/// Whether a host's plugin routes refuse callers without the session cookie
/// (the route guard, §9).
enum RouteGuard {
  /// Not known yet, or nothing to ask (the bridge isn't installed).
  unknown,

  /// A plugin route answered a cookieless call: the hole is open.
  absent,

  /// A plugin route refused a cookieless call (401 / 403).
  present,
}

/// Turns islands on for the on-device engine without the route guard: for
/// the PoC and the emulator only (`--dart-define=DSH_GO_LOCAL_ISLANDS=true`),
/// never in a build that ships.
const islandsWithoutGuard = bool.fromEnvironment('DSH_GO_LOCAL_ISLANDS');

/// Whether a host may have islands at all (§9). Pure:
///
/// - relay: never (no DSH Web over the relay);
/// - SSH: yes, the same exposure as the 网页版 entry that's already there;
/// - on-device: only once the route guard ships with the runtime — the
///   bridge says so ([reported], `routeGuard` in `/dsh-go/v1/inventory`)
///   *and* a cookieless call to a plugin route is refused ([probed]). Any
///   app on the phone can reach 127.0.0.1, so a self-report alone isn't
///   enough. [override] is [islandsWithoutGuard].
bool islandHostAllowed(
  HostKind kind, {
  bool? reported,
  RouteGuard probed = RouteGuard.unknown,
  bool override = false,
}) => switch (kind) {
  HostKind.relay => false,
  HostKind.ssh => true,
  HostKind.local => override || (reported == true && probed == RouteGuard.present),
};

/// The route that answers the probe: the bridge's own inventory, which the
/// guard covers like every other plugin route.
const routeGuardProbePath = '/dsh-go/v1/inventory';

/// Calls [routeGuardProbePath] on [base] with no cookie and no credentials.
Future<RouteGuard> probeRouteGuard(
  Uri base, {
  HttpClient? client,
  Duration timeout = const Duration(seconds: 3),
}) async {
  final http = client ?? HttpClient();
  try {
    final url = Uri(scheme: base.scheme, host: base.host, port: base.port, path: routeGuardProbePath);
    final request = await http.getUrl(url).timeout(timeout);
    request.followRedirects = false;
    final response = await request.close().timeout(timeout);
    await response.drain<void>().catchError((_) {});
    return switch (response.statusCode) {
      401 || 403 => RouteGuard.present,
      >= 200 && < 300 => RouteGuard.absent,
      _ => RouteGuard.unknown,
    };
  } catch (_) {
    return RouteGuard.unknown;
  } finally {
    if (client == null) http.close(force: true);
  }
}

/// What the bridge reports per host (`routeGuard`), from the seats'
/// inventory; null when unknown.
final islandRouteGuardReportProvider = Provider.family<bool?, HostRef>(
  (ref, host) => ref.watch(seatRouteGuardReportProvider(host)),
);

/// The cookieless probe against the on-device engine, rerun per engine
/// start (a new base URL / token is a new process) and whenever the bridge's
/// own report changes. An inconclusive answer (the engine still starting,
/// the bridge's routes not registered yet) is asked again every few seconds
/// for a minute, instead of keeping islands off until the next restart.
final localRouteGuardProbeProvider = FutureProvider<RouteGuard>((ref) async {
  final status = ref.watch(localRuntimeProvider.select((s) => s.status));
  ref.watch(islandRouteGuardReportProvider(HostRef.local));
  final base = status.baseUrl;
  if (!status.isRunning || base == null) return RouteGuard.unknown;
  final uri = Uri.tryParse(base);
  if (uri == null) return RouteGuard.unknown;
  final result = await probeRouteGuard(uri);
  final process = '$base|${status.token}';
  if (result == RouteGuard.unknown) {
    final attempt = (_probeAttempts[process] ?? 0) + 1;
    _probeAttempts[process] = attempt;
    if (attempt <= routeGuardProbeRetries) {
      final timer = Timer(routeGuardProbeRetry, ref.invalidateSelf);
      ref.onDispose(timer.cancel);
    }
  } else {
    _probeAttempts.remove(process);
  }
  return result;
});

/// Retries of an inconclusive guard probe (per engine process).
const routeGuardProbeRetries = 12;
const routeGuardProbeRetry = Duration(seconds: 5);
final _probeAttempts = <String, int>{};

/// Whether [host] may have islands now.
final islandHostGateProvider = Provider.family<bool, HostRef>((ref, host) {
  if (host.kind != HostKind.local) return islandHostAllowed(host.kind);
  final reported = ref.watch(islandRouteGuardReportProvider(host));
  // Only probe once the bridge claims a guard (or the override is on).
  if (reported != true && !islandsWithoutGuard) return false;
  final probed = islandsWithoutGuard
      ? RouteGuard.unknown
      : ref.watch(localRouteGuardProbeProvider).value ?? RouteGuard.unknown;
  return islandHostAllowed(host.kind, reported: reported, probed: probed, override: islandsWithoutGuard);
});

/// The DSH Web launch URL for [host]'s islands (same as the 网页版's,
/// `localWebUri`): the on-device engine while it runs, an SSH host through
/// the app's forward while connected, nothing over the relay.
final islandHostUrlProvider = Provider.autoDispose.family<Uri?, HostRef>((ref, host) {
  switch (host.kind) {
    case HostKind.local:
      final status = ref.watch(localRuntimeProvider.select((s) => s.status));
      if (!status.isRunning || status.baseUrl == null || status.token == null) return null;
      return islandLaunchUri(status.baseUrl!, status.token!);
    case HostKind.ssh:
      ref.watch(hostLinkStatusProvider(host));
      final link = ref.watch(hostLinkProvider(host));
      final port = link is SshHostLink ? link.localPort : null;
      final token = link is SshHostLink ? link.endpoint?.token : null;
      if (port == null || token == null) return null;
      return islandLaunchUri('http://127.0.0.1:$port', token);
    case HostKind.relay:
      return null;
  }
});

/// `http://127.0.0.1:3080/?token=…`: the token only buys the session cookie,
/// exactly as the 网页版 does.
Uri islandLaunchUri(String baseUrl, String token) =>
    Uri.parse(baseUrl).replace(path: '/', queryParameters: {'token': token});
