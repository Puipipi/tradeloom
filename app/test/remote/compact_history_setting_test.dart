import 'package:dsh_app/remote/relay/dsh_remote_backend.dart';
import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_remote/dsh_remote.dart' as remote;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('compact history defaults off and preserves explicit choices across containers', () async {
    SharedPreferences.setMockInitialValues({});
    final first = ProviderContainer();
    final preference = first.read(remoteCompactHistoryProvider.notifier);
    await preference.ready;
    expect(first.read(remoteCompactHistoryProvider), isFalse);
    await preference.set(true);
    expect((await SharedPreferences.getInstance()).getBool(RemoteCompactHistoryController.prefsKey), isTrue);
    first.dispose();

    final restored = ProviderContainer();
    addTearDown(restored.dispose);
    await restored.read(remoteCompactHistoryProvider.notifier).ready;
    expect(restored.read(remoteCompactHistoryProvider), isTrue);
    await restored.read(remoteCompactHistoryProvider.notifier).set(false);
    expect((await SharedPreferences.getInstance()).getBool(RemoteCompactHistoryController.prefsKey), isFalse);
  });

  test('a lost compact capability has an actionable terminal error', () {
    final error = DshRemoteRelayBackend.describe(
      const remote.RemoteFailure('HISTORY_MODE_CHANGED', 'The Host history mode changed.', retryable: false),
    );
    expect(error.retryable, isFalse);
    expect(error.message, contains('切换到其他主机'));
    expect(error.message, contains('重新加载历史'));
  });

  test('restoring or toggling history preference does not recreate the live backend', () async {
    SharedPreferences.setMockInitialValues({RemoteCompactHistoryController.prefsKey: true});
    final container = ProviderContainer(overrides: [secretStoreProvider.overrideWithValue(MemorySecretStore())]);
    addTearDown(container.dispose);
    final backend = container.read(relayBackendProvider) as DshRemoteRelayBackend;
    final preference = container.read(remoteCompactHistoryProvider.notifier);
    await preference.ready;
    expect(backend.account.compactHistory, isTrue);
    await preference.set(false);
    expect(container.read(relayBackendProvider), same(backend));
    expect(backend.account.compactHistory, isFalse);
  });
}
