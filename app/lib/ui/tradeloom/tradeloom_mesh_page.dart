// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'dart:async';

import 'package:dsh_client/dsh_client.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/connection_state.dart';
import '../remote/pairing_page.dart' show pairingScannerProvider;
import '../theme/app_icons.dart';
import 'tradeloom_mesh_client.dart';

class TradeLoomMeshPage extends ConsumerWidget {
  const TradeLoomMeshPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = ref.watch(localConnectionProvider);
    final host = current.value;
    final carrier = host?.client.carrier;
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.tradeloomMeshTitle)),
      body: current.isLoading
          ? const Center(child: CircularProgressIndicator())
          : host?.isLocal == true && carrier is DshHttpCarrier
          ? _DeviceDirectory(key: ObjectKey(carrier.connection), mesh: TradeLoomMeshClient(carrier.connection))
          : _MeshBody(children: [Text(current.hasError ? l10n.tradeloomMeshFailed : l10n.tradeloomMeshStart)]),
    );
  }
}

typedef _Directory = ({bool paired, List<TradeLoomMeshDevice> devices, Set<String> allowed, Object? error});

class _DeviceDirectory extends StatefulWidget {
  const _DeviceDirectory({super.key, required this.mesh});
  final TradeLoomMeshClient mesh;

  @override
  State<_DeviceDirectory> createState() => _DeviceDirectoryState();
}

class _DeviceDirectoryState extends State<_DeviceDirectory> {
  late Future<_Directory> _directory = _observed(_readDirectory());
  bool _changing = false;
  Object? _operationError;

  Future<_Directory> _readDirectory() async {
    final status = await widget.mesh.status();
    if (status['tradeLoomReadOnly'] != 1 || status['liveReadAuthorization'] != 1) throw const TradeLoomMeshFailure(404);
    final paired = status['paired'];
    if (paired == false) {
      return (paired: false, devices: const <TradeLoomMeshDevice>[], allowed: const <String>{}, error: null);
    }
    if (paired != true) throw const FormatException('Invalid Mesh status.');
    try {
      final devices = await widget.mesh.devices();
      final prefs = await widget.mesh.preferences();
      final allowed = prefs['allowedCallers'];
      if (allowed is! List) throw const FormatException('Invalid Mesh consent status.');
      return (
        paired: true,
        devices: devices.where((device) => !device.isSelf).toList(growable: false),
        allowed: prefs['allowIncoming'] == true ? allowed.whereType<String>().toSet() : const <String>{},
        error: null,
      );
    } catch (error) {
      // The authenticated local runtime still owns its pairing when Relay is
      // unavailable. Keep the local leave action and discard the old directory.
      return (paired: true, devices: const <TradeLoomMeshDevice>[], allowed: const <String>{}, error: error);
    }
  }

  void _refresh() => setState(() {
    _operationError = null;
    _directory = _observed(_readDirectory());
  });

  Future<void> _change(Future<void> Function() action) async {
    if (_changing || !mounted) return;
    setState(() {
      _changing = true;
      _operationError = null;
    });
    try {
      await action();
      if (mounted) _refresh();
    } catch (error) {
      if (mounted) setState(() => _operationError = error);
    } finally {
      if (mounted) setState(() => _changing = false);
    }
  }

  Future<void> _pair() async {
    final invite = await showDialog<String>(context: context, builder: (_) => const _InvitationDialog());
    if (!mounted || invite == null) return;
    final uri = Uri.tryParse(invite);
    if (uri == null ||
        uri.scheme != 'dshmesh' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.path != '/pair' ||
        uri.hasFragment ||
        !(uri.queryParameters['code']?.isNotEmpty ?? false)) {
      setState(() => _operationError = const TradeLoomMeshFailure(400, 'bad_pairing'));
      return;
    }
    final l10n = context.l10n;
    final confirmed = await _confirm(
      context,
      l10n.tradeloomMeshPair,
      'https://${uri.authority}\n\n${l10n.tradeloomMeshConfirmPair}',
    );
    if (mounted && confirmed) await _change(() => widget.mesh.pair(invite, confirmed: true));
  }

  Future<void> _share(TradeLoomMeshDevice device, {required bool allow}) async {
    final l10n = context.l10n;
    final confirmed = await _confirm(
      context,
      allow ? l10n.tradeloomMeshGrant : l10n.tradeloomMeshRevoke,
      '${device.name}\n\n${allow ? l10n.tradeloomMeshConfirmShare : l10n.tradeloomMeshRevoke}',
    );
    final id = device.clientDeviceId;
    if (mounted && confirmed && id != null) {
      await _change(() => widget.mesh.setReadConsent(id, allow: allow));
    }
  }

  Future<void> _unpair() async {
    final l10n = context.l10n;
    if (await _confirm(context, l10n.tradeloomMeshUnpair, l10n.tradeloomMeshConfirmUnpair) && mounted) {
      await _change(widget.mesh.unpair);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return FutureBuilder<_Directory>(
      future: _directory,
      builder: (context, snapshot) {
        final ready = snapshot.connectionState == ConnectionState.done;
        final data = ready ? snapshot.data : null;
        final error = _operationError ?? data?.error ?? (ready ? snapshot.error : null);
        return _MeshBody(
          children: [
            if (_changing || snapshot.connectionState != ConnectionState.done) const LinearProgressIndicator(),
            if (error != null)
              Text(_errorText(l10n, error), style: TextStyle(color: Theme.of(context).colorScheme.error)),
            if (data == null && error != null)
              OutlinedButton(onPressed: _changing ? null : _refresh, child: Text(l10n.commonRetry)),
            if (data?.paired == false)
              FilledButton.icon(
                onPressed: _changing ? null : _pair,
                icon: const Icon(AppIcons.qrCode),
                label: Text(l10n.tradeloomMeshPair),
              ),
            if (data?.paired == true) ...[
              for (final device in data!.devices)
                Card(
                  child: ListTile(
                    leading: const Icon(AppIcons.computer),
                    title: Text(device.name),
                    subtitle: Text(device.online ? l10n.tradeloomMeshSessions : l10n.tradeloomMeshDeviceOffline),
                    onTap: device.online && !_changing
                        ? () => Navigator.of(context).push<void>(
                            MaterialPageRoute(
                              builder: (_) => _DeviceSessions(mesh: widget.mesh, device: device),
                            ),
                          )
                        : null,
                    trailing: device.clientDeviceId == null
                        ? null
                        : PopupMenuButton<bool>(
                            enabled: !_changing,
                            onSelected: (allow) => _share(device, allow: allow),
                            itemBuilder: (_) => [
                              if (data.allowed.contains(device.clientDeviceId))
                                PopupMenuItem(value: false, child: Text(l10n.tradeloomMeshRevoke))
                              else
                                PopupMenuItem(value: true, child: Text(l10n.tradeloomMeshGrant)),
                            ],
                          ),
                  ),
                ),
              if (data.devices.isEmpty && error == null) Text(l10n.tradeloomMeshNoPeers),
              OutlinedButton(
                onPressed: _changing ? null : _refresh,
                child: Text(data.error == null ? l10n.tradeloomMeshRefresh : l10n.commonRetry),
              ),
              TextButton(onPressed: _changing ? null : _unpair, child: Text(l10n.tradeloomMeshUnpair)),
            ],
          ],
        );
      },
    );
  }
}

class _InvitationDialog extends ConsumerStatefulWidget {
  const _InvitationDialog();
  @override
  ConsumerState<_InvitationDialog> createState() => _InvitationDialogState();
}

class _InvitationDialogState extends ConsumerState<_InvitationDialog> {
  final _text = TextEditingController();

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    final scanner = ref.read(pairingScannerProvider);
    final invite = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (context) => Scaffold(
          appBar: AppBar(title: Text(context.l10n.tradeloomMeshScan)),
          body: scanner(context, (code) => Navigator.of(context).pop(code)),
        ),
      ),
    );
    if (mounted && invite != null) Navigator.of(context).pop(invite.trim());
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      title: Text(l10n.tradeloomMeshInvitation),
      content: TextField(
        controller: _text,
        obscureText: true,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: TextInputType.url,
        maxLength: 2048,
        decoration: const InputDecoration(counterText: ''),
      ),
      actions: [
        TextButton(onPressed: _scan, child: Text(l10n.tradeloomMeshScan)),
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(l10n.commonCancel)),
        FilledButton(onPressed: () => Navigator.of(context).pop(_text.text.trim()), child: Text(l10n.commonConfirm)),
      ],
    );
  }
}

class _DeviceSessions extends StatefulWidget {
  const _DeviceSessions({required this.mesh, required this.device});
  final TradeLoomMeshClient mesh;
  final TradeLoomMeshDevice device;

  @override
  State<_DeviceSessions> createState() => _DeviceSessionsState();
}

class _DeviceSessionsState extends State<_DeviceSessions> {
  final _failure = ValueNotifier<Object?>(null);

  @override
  void dispose() {
    _failure.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final device = widget.device;
    final mesh = widget.mesh;
    return Scaffold(
      appBar: AppBar(title: Text(device.name)),
      body: _MeshRead(
        failure: _failure,
        probe: () => mesh.checkReadAccess(device.nodeId),
        load: () async {
          final response = await mesh.catalog(device.nodeId);
          final nodes = response['nodes'];
          if (nodes is! List || nodes.length != 1 || nodes.single is! Map) {
            throw const FormatException('Invalid Mesh catalog.');
          }
          final node = nodes.single as Map;
          if (node['nodeId'] != device.nodeId || node['workspaces'] is! List) {
            throw const FormatException('Invalid Mesh catalog.');
          }
          return [
            for (final workspace in node['workspaces'] as List)
              if (workspace is Map && workspace['sessions'] is List)
                for (final session in workspace['sessions'] as List)
                  if (session is Map && session['sessionId'] is String)
                    (
                      id: session['sessionId'] as String,
                      title: session['title'] as String? ?? session['sessionId'] as String,
                      workspace: workspace['title'] as String?,
                    ),
          ];
        },
        content: (context, sessions) => [
          Text(l10n.tradeloomMeshSessions, style: Theme.of(context).textTheme.titleMedium),
          if (sessions.isEmpty) Text(l10n.tradeloomMeshNoSessions),
          for (final session in sessions)
            Card(
              child: ListTile(
                title: Text(session.title),
                subtitle: session.workspace == null ? null : Text(session.workspace!),
                onTap: () => Navigator.of(context).push<void>(
                  MaterialPageRoute(
                    builder: (_) => _SessionSnapshot(
                      mesh: mesh,
                      failure: _failure,
                      nodeId: device.nodeId,
                      sessionId: session.id,
                      title: session.title,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _SessionSnapshot extends StatelessWidget {
  const _SessionSnapshot({
    required this.mesh,
    required this.failure,
    required this.nodeId,
    required this.sessionId,
    required this.title,
  });
  final ValueNotifier<Object?> failure;
  final TradeLoomMeshClient mesh;
  final String nodeId;
  final String sessionId;
  final String title;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.tradeloomMeshSessions)),
      body: _MeshRead(
        failure: failure,
        probe: () => mesh.checkReadAccess(nodeId),
        load: () async {
          final raw = await mesh.session(nodeId, sessionId);
          if (raw['records'] is! List || raw['cursor'] is! int) throw const FormatException('Invalid Mesh snapshot.');
          return SessionSnapshotEvent.fromJson(sessionId, raw);
        },
        content: (context, snapshot) {
          final messages = [
            for (final event in snapshot.events)
              if (event case UserMessageEvent(:final message, isHumanPrompt: true))
                (human: true, text: message.text)
              else if (event case AssistantMessageEvent(:final message))
                (human: false, text: message.text),
          ].where((message) => message.text.trim().isNotEmpty).toList(growable: false);
          return [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            if (snapshot.hasMore) Text(l10n.tradeloomMeshRecent),
            if (messages.isEmpty) Text(l10n.tradeloomMeshNoMessages),
            for (final message in messages)
              Card(
                color: message.human ? Theme.of(context).colorScheme.secondaryContainer : null,
                child: Padding(padding: const EdgeInsets.all(16), child: SelectableText(message.text)),
              ),
          ];
        },
      ),
    );
  }
}

class _MeshRead<T> extends StatefulWidget {
  const _MeshRead({required this.load, required this.probe, required this.content, required this.failure});
  final ValueNotifier<Object?> failure;
  final Future<void> Function() probe;
  final Future<T> Function() load;
  final List<Widget> Function(BuildContext, T) content;

  @override
  State<_MeshRead<T>> createState() => _MeshReadState<T>();
}

class _MeshReadState<T> extends State<_MeshRead<T>> {
  late Future<T> _reading = _read();
  late final AppLifecycleListener _lifecycle;
  Timer? _accessTimer;
  bool _probing = false;
  int _requestGeneration = 0;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onResume: _probe);
    widget.failure.addListener(_invalidate);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (ModalRoute.isCurrentOf(context) == true) unawaited(_probe());
  }

  Future<T> _read() {
    _accessTimer?.cancel();
    _accessTimer = null;
    final generation = ++_requestGeneration;
    return _observed(
      widget.load().then(
        (value) {
          if (mounted && generation == _requestGeneration) {
            widget.failure.value = null;
            _accessTimer = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_probe()));
          }
          return value;
        },
        onError: (Object error, StackTrace stack) {
          if (mounted && generation == _requestGeneration) widget.failure.value = error;
          Error.throwWithStackTrace(error, stack);
        },
      ),
    );
  }

  void _invalidate() {
    final failure = widget.failure.value;
    if (!mounted || failure == null) return;
    _requestGeneration += 1;
    _accessTimer?.cancel();
    _accessTimer = null;
    setState(() {
      _reading = _observed(Future<T>.error(failure));
    });
  }

  Future<void> _probe() async {
    if (!mounted ||
        _probing ||
        _accessTimer == null ||
        ModalRoute.isCurrentOf(context) != true ||
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    _probing = true;
    final generation = _requestGeneration;
    try {
      await widget.probe();
    } catch (error) {
      if (mounted && generation == _requestGeneration) widget.failure.value = error;
    } finally {
      _probing = false;
    }
  }

  @override
  void dispose() {
    widget.failure.removeListener(_invalidate);
    _accessTimer?.cancel();
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => FutureBuilder<T>(
    future: _reading,
    builder: (context, snapshot) => _MeshBody(
      children: [
        if (snapshot.connectionState != ConnectionState.done)
          const LinearProgressIndicator()
        else if (snapshot.hasError) ...[
          Text(_errorText(context.l10n, snapshot.error!)),
          OutlinedButton(
            onPressed: () => setState(() {
              _reading = _read();
            }),
            child: Text(context.l10n.commonRetry),
          ),
        ] else
          ...widget.content(context, snapshot.data as T),
      ],
    ),
  );
}

class _MeshBody extends StatelessWidget {
  const _MeshBody({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 660),
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [for (final child in children) Padding(padding: const EdgeInsets.only(bottom: 8), child: child)],
        ),
      ),
    ),
  );
}

// A local request can fail before the next frame attaches FutureBuilder.
// Register a listener now; FutureBuilder still receives the original result.
Future<T> _observed<T>(Future<T> request) {
  unawaited(request.then<void>((_) {}, onError: (Object _, StackTrace _) {}));
  return request;
}

Future<bool> _confirm(BuildContext context, String title, String message) async {
  final l10n = context.l10n;
  return await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(message),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(false), child: Text(l10n.commonCancel)),
            FilledButton(onPressed: () => Navigator.of(context).pop(true), child: Text(l10n.commonConfirm)),
          ],
        ),
      ) ??
      false;
}

String _errorText(L10n l10n, Object error) {
  if (error is! TradeLoomMeshFailure) return l10n.tradeloomMeshFailed;
  return switch ((error.statusCode, error.code)) {
    (_, 'fingerprint_mismatch' || 'tls_untrusted') => l10n.tradeloomMeshTls,
    (_, 'code_used' || 'code_expired') => l10n.tradeloomMeshUsed,
    (_, 'bad_pairing' || 'code_invalid') => l10n.tradeloomMeshInvalid,
    (_, 'unreachable' || 'relay_unavailable' || 'offline') => l10n.tradeloomMeshOffline,
    (401, _) => l10n.tradeloomMeshAuth,
    (403, _) => l10n.tradeloomMeshDenied,
    (404, _) => l10n.tradeloomMeshPlugin,
    (503, _) => l10n.tradeloomMeshOffline,
    _ => l10n.tradeloomMeshFailed,
  };
}
