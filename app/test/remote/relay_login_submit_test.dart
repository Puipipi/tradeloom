import 'dart:async';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/relay_login_sheet.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';
import 'support/fake_relay.dart';

class _HeldPasswordBackend extends FakeRelayBackend {
  final replies = <Completer<RelayUser>>[];

  @override
  Future<RelayUser> loginWithPassword(String email, String password) {
    passwordLogins.add((email, password));
    final reply = Completer<RelayUser>();
    replies.add(reply);
    return reply.future;
  }
}

Future<void> _frames(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 60));
  }
}

Future<void> _fill(
  WidgetTester tester,
  String server,
  String email,
  String password,
) async {
  await tester.enterText(find.byType(TextField).at(0), server);
  await tester.enterText(find.byType(TextField).at(1), email);
  await tester.enterText(find.byType(TextField).at(2), password);
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets(
    'busy password sheet ignores a second keyboard submit; a new sheet can submit',
    (tester) async {
      final relay = _HeldPasswordBackend();
      usePhoneSurface(tester);
      await tester.pumpWidget(
        goldenApp(
          home: const RemoteScreen(),
          brightness: Brightness.light,
          overrides: [
            secretStoreProvider.overrideWithValue(MemorySecretStore()),
            relayBackendProvider.overrideWithValue(relay),
            networkKicksProvider.overrideWithValue(const Stream.empty()),
            localRuntimeProvider.overrideWith(
              () => FakeRuntime(
                const LocalRuntimeState(loaded: true, status: runningStatus),
              ),
            ),
          ],
        ),
      );
      await _frames(tester);
      final c = ProviderScope.containerOf(
        tester.element(find.byType(MaterialApp)),
      );
      await tester.tap(find.text('自建服务器 · 邮箱登录'));
      await _frames(tester);
      await _fill(tester, 'a.example.com', 'a@example.com', 'password-a');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await _frames(tester);
      expect(relay.passwordLogins, [('a@example.com', 'password-a')]);

      // Re-focus the real password TextField while its first submit is busy.
      await _fill(tester, 'b.example.com', 'b@example.com', 'password-b');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await _frames(tester);
      final callsFromSameSheet = List<(String, String)>.of(
        relay.passwordLogins,
      );
      final serverFromSameSheet = c.read(relayServerProvider);

      // Closing a busy sheet is allowed; a different State may submit normally.
      Navigator.of(tester.element(find.byType(SelfHostedLoginSheet))).pop();
      await _frames(tester);
      await tester.tap(find.text('自建服务器 · 邮箱登录'));
      await _frames(tester);
      await _fill(tester, 'c.example.com', 'c@example.com', 'password-c');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await _frames(tester);
      final callsAfterNewSheet = List<(String, String)>.of(
        relay.passwordLogins,
      );

      for (final reply in relay.replies) {
        reply.complete(sampleRelayUser);
      }
      await _frames(tester);
      expect(callsFromSameSheet, [('a@example.com', 'password-a')]);
      expect(serverFromSameSheet, 'https://a.example.com');
      expect(callsAfterNewSheet, [
        ('a@example.com', 'password-a'),
        ('c@example.com', 'password-c'),
      ]);
    },
  );
}
