// Golden screenshots of the remote UI: the Remote page (signed in / out /
// failed link), the host sheet, the SSH host form with its test progress, the
// host-key dialog and the drawer on an SSH host.
//
//   flutter test --update-goldens test/remote/remote_golden_test.dart

import 'package:dsh_app/remote/relay/relay_backend.dart';
import 'package:dsh_app/remote/link_status.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/remote/ssh/ssh_link.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/ui/remote/host_key_dialog.dart';
import 'package:dsh_app/ui/remote/host_switcher.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:dsh_app/ui/remote/network_details_sheet.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:dsh_app/ui/shell/home_shell.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../shell/golden_harness.dart';
import 'support/fake_relay.dart';
import 'support/fake_ssh.dart';

class _FakeHosts extends HostsController {
  _FakeHosts(this.hosts);

  final List<SshHostConfig> hosts;

  @override
  HostsState build() => HostsState(ssh: hosts, loaded: true);
}

class _FakeActive extends ActiveHostController {
  _FakeActive(this.host);

  final HostRef host;

  @override
  HostRef build() => host;
}

const _lab = SshHostConfig(
  id: 'ssh-lab',
  name: '实验室服务器',
  host: 'lab.example.com',
  port: 2222,
  user: 'root',
  auth: SshAuthMethod.privateKey,
);

const _connected = HostLinkStatus(
  HostLinkPhase.connected,
  completed: {...HostLinkStep.values},
  detail: '复用了远端已在运行的 DSH',
);

final _mismatch = HostLinkStatus(
  HostLinkPhase.failed,
  step: HostLinkStep.verifyHostKey,
  completed: const {HostLinkStep.connect},
  error: hostKeyMismatchError(
    sampleSsh,
    const PresentedHostKey('ssh-ed25519', 'SHA256:Xq3nU0d8Hc1tWb2yLk9pFz7eRv5aMs4oJi6gTh0wQyE'),
  ),
);

List<Override> _remote({
  List<SshHostConfig> hosts = const [sampleSsh, _lab],
  HostRef active = const HostRef.ssh('ssh-test'),
  HostLinkStatus status = _connected,
  RelayBackend? relay,
}) => [
  secretStoreProvider.overrideWithValue(MemorySecretStore()),
  networkKicksProvider.overrideWithValue(const Stream.empty()),
  hostsProvider.overrideWith(() => _FakeHosts(hosts)),
  activeHostProvider.overrideWith(() => _FakeActive(active)),
  relayBackendProvider.overrideWithValue(relay ?? FakeRelayBackend(user: sampleRelayUser)),
  hostLinkStatusProvider.overrideWith((ref, host) => Stream.value(host == active ? status : HostLinkStatus.idle)),
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
];

void main() {
  goldenBoth('remote_signed_in', () => const RemoteScreen(), overrides: _remote);

  goldenBoth(
    'remote_signed_out',
    () => const RemoteScreen(),
    overrides: () => _remote(hosts: const [], active: HostRef.local, relay: FakeRelayBackend()),
  );

  // Relay turned off: "即将接入".
  goldenBoth(
    'remote_relay_pending',
    () => const RemoteScreen(),
    overrides: () => _remote(hosts: const [sampleSsh], active: HostRef.local, relay: const UnavailableRelayBackend()),
  );

  goldenBoth(
    'remote_connected_lan',
    () => const RemoteScreen(),
    overrides: () => _remote(
      active: const HostRef.relay('mac'),
      status: const HostLinkStatus(
        HostLinkPhase.connected,
        path: RelayPath.lan,
        network: RemoteNetworkStatus(path: RelayPath.lan, connectDuration: Duration(milliseconds: 315)),
      ),
    ),
  );

  goldenBoth(
    'remote_network_details',
    () => const _NetworkSheetLauncher(),
    overrides: () => _remote(
      active: const HostRef.relay('mac'),
      status: HostLinkStatus(
        HostLinkPhase.connected,
        path: RelayPath.relay,
        network: RemoteNetworkStatus(
          path: RelayPath.relay,
          connectDuration: Duration(milliseconds: 2391),
          roundTripTime: Duration(milliseconds: 81),
          fallbackReason: 'turnTimeout',
          observedAt: DateTime(2026, 10, 31, 14, 20),
        ),
      ),
    ),
    before: (tester) async {
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(const Duration(milliseconds: 300));
    },
  );

  goldenBoth('remote_key_mismatch', () => const RemoteScreen(), overrides: () => _remote(status: _mismatch));

  goldenBoth(
    'host_sheet',
    () => const _SheetLauncher(),
    overrides: _remote,
    before: (tester) async {
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 600));
    },
  );

  goldenBoth('ssh_form_new', () => const SshHostFormPage(), overrides: () => _remote(active: HostRef.local));

  goldenBoth(
    'ssh_form_testing',
    () => const SshHostFormPage(
      existing: sampleSsh,
      initialStatus: HostLinkStatus(
        HostLinkPhase.connecting,
        step: HostLinkStep.startDsh,
        completed: {HostLinkStep.connect, HostLinkStep.verifyHostKey},
        detail: '正在远端启动 DSH…',
      ),
    ),
    overrides: _remote,
    before: _scrollToEnd,
  );

  goldenBoth(
    'ssh_form_failed',
    () => const SshHostFormPage(
      existing: sampleSsh,
      initialStatus: HostLinkStatus(
        HostLinkPhase.failed,
        step: HostLinkStep.startDsh,
        completed: {HostLinkStep.connect, HostLinkStep.verifyHostKey},
        error: HostLinkError(
          HostLinkErrorKind.dshNotFound,
          '主机上没有 dsh，装好后重试，或在启动命令里填完整路径',
          detail: 'npm install -g @deepseek-ai/dsh\n启动命令示例：~/.nvm/versions/node/v22.0.0/bin/dsh web',
        ),
      ),
    ),
    overrides: _remote,
    before: _scrollToEnd,
  );

  goldenBoth(
    'host_key_dialog',
    () => const _DialogLauncher(),
    overrides: _remote,
    before: (tester) async {
      await tester.tap(find.text('open'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    },
  );

  goldenBoth(
    'drawer_ssh',
    () => HomeShell(chatBuilder: (_) => const SizedBox.expand(), initiallyOpen: true),
    overrides: () => [
      ..._remote(),
      sessionsProvider.overrideWith(() => FakeSessions(sampleSessions().take(4).toList())),
      currentSessionProvider.overrideWith(() => FakeCurrentSession('s2')),
    ],
  );

  goldenBoth(
    'drawer_ssh_reconnecting',
    () => HomeShell(chatBuilder: (_) => const SizedBox.expand(), initiallyOpen: true),
    overrides: () => [
      ..._remote(
        status: const HostLinkStatus(
          HostLinkPhase.reconnecting,
          attempt: 2,
          error: HostLinkError(HostLinkErrorKind.unreachable, 'SSH 连接没有响应', retryable: true),
        ),
      ),
      sessionsProvider.overrideWith(() => FakeSessions(const [])),
    ],
  );
}

/// Scrolls a page to its end. SliverList over-estimates the extent of unbuilt
/// rows, so the position settles back over a few frames.
Future<void> _scrollToEnd(WidgetTester tester) async {
  for (var i = 0; i < 3; i++) {
    await tester.drag(find.byType(CustomScrollView), const Offset(0, -3000));
    for (var f = 0; f < 12; f++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }
}

/// A page with a button that opens the host sheet (so the real modal route
/// and glass sheet are rendered).
class _SheetLauncher extends StatelessWidget {
  const _SheetLauncher();

  @override
  Widget build(BuildContext context) {
    return AppBackdrop(
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () => showHostSheet(context, onManage: () {}),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
  }
}

class _DialogLauncher extends StatelessWidget {
  const _DialogLauncher();

  @override
  Widget build(BuildContext context) {
    return AppBackdrop(
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: Center(
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () => confirmHostKey(
                context,
                HostKeyPrompt(
                  hostName: '电脑',
                  address: sampleSsh.address,
                  key: const PresentedHostKey('ssh-ed25519', 'SHA256:LT+mgCqG77AFbB1kIh6ludgYZ6hBkWPKXA64IJAicIk'),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
  }
}

class _NetworkSheetLauncher extends StatelessWidget {
  const _NetworkSheetLauncher();

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: TextButton(
        onPressed: () => showRemoteNetworkDetails(context, const HostRef.relay('mac')),
        child: const Text('open'),
      ),
    ),
  );
}
