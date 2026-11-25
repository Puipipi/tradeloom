// The host label under the chat title follows the app language, also on a
// connection made before the language changed.

import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/chat/chat_screen.dart';
import 'package:dsh_app/ui/chat/widgets/whale_tail.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../chat/support/harness.dart';
import '../remote/support/ready_mux.dart';
import '../remote/support/wait.dart';
import '../support/english_preview.dart';

class _Runtime extends LocalRuntimeController {
  @override
  LocalRuntimeState build() => LocalRuntimeState(
    loaded: true,
    status: RuntimeStatus.fromMap({'phase': 'running', 'baseUrl': 'http://127.0.0.1:9', 'token': 't'}),
  );
}

class _Settings extends SettingsController {
  @override
  AppSettings build() => const AppSettings(loaded: true);
}

DshClient _client() => DshClient(DshConnection(Uri.parse('http://127.0.0.1:9')));

class _LocalClient extends DshClient {
  _LocalClient() : super(DshConnection(Uri.parse('http://127.0.0.1:9')));
  final _mux = ReadyMux();
  @override
  DshMux get mux => _mux;
}

/// Chinese for this test, whatever the run defaults to.
void _useChinese() {
  AppLocale.use(AppLocale.zhCN);
  addTearDown(() => AppLocale.use(englishPreview ? AppLocale.en : AppLocale.zhCN));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(WhaleSprites.load);
  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('本机 connected in Chinese reads "This phone" after switching to English', () async {
    _useChinese();
    final c = ProviderContainer(
      overrides: [
        settingsProvider.overrideWith(_Settings.new),
        localRuntimeProvider.overrideWith(_Runtime.new),
        networkKicksProvider.overrideWithValue(const Stream.empty()),
        localClientConnectorProvider.overrideWithValue(({required baseUri, required token}) async => _LocalClient()),
      ],
    );
    addTearDown(c.dispose);
    final sub = c.listen(localConnectionProvider, (_, _) {});
    addTearDown(sub.close);
    final conn = (await until(c, localConnectionProvider, (s) => s.value != null, what: '本机连接')).value!;
    expect(conn.label, '本机');

    useEnglish();
    expect(conn.label, 'This phone');
  });

  test('remote labels keep the host name and translate the rest', () {
    _useChinese();
    final ssh = HostConnection(client: _client(), isLocal: false, kind: HostKind.ssh, hostId: 'mac', name: '书房的 Mac');
    final relay = HostConnection(client: _client(), isLocal: false, kind: HostKind.relay, hostId: 'r1');
    expect(ssh.label, '书房的 Mac · SSH');
    expect(relay.label, '远程主机 · 远程');

    useEnglish();
    expect(ssh.label, '书房的 Mac · SSH');
    expect(relay.label, 'Remote host · Remote');
  });

  test('a fixed label wins', () {
    useEnglish();
    expect(HostConnection(client: _client(), label: '电脑', isLocal: true).label, '电脑');
  });

  testWidgets('chat header shows "This phone" in English', (tester) async {
    useEnglish();
    usePhoneView(tester);
    final harness = ChatHarness();
    await tester.pumpWidget(testApp(inEnglish(const ChatScreen()), overrides: harness.overrides));
    await pumpFrames(tester);
    expect(find.textContaining('This phone'), findsOneWidget);
    expect(find.textContaining('本机'), findsNothing);
  });
}
