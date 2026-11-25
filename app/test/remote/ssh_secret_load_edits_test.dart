import 'dart:async';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/common/discard_guard.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';

const _host = SshHostConfig(id: 'slow-secrets', name: 'Original name', host: 'example.invalid', user: 'test');

class _SlowSecrets extends MemorySecretStore {
  _SlowSecrets()
    : super({
        SshSecrets.passwordKey(_host.id): 'stored-password',
        SshSecrets.privateKeyKey(_host.id): 'stored-private-key',
        SshSecrets.passphraseKey(_host.id): 'stored-passphrase',
        SshSecrets.attachTokenKey(_host.id): 'stored-token',
      });

  final gate = Completer<void>();
  int reads = 0;

  @override
  Future<String?> read(String key) async {
    reads++;
    await gate.future;
    return super.read(key);
  }
}

class _Rig {
  final secrets = _SlowSecrets();
  final visible = ValueNotifier(true);

  Future<void> pump(WidgetTester tester, {bool privateKey = false, bool attach = false}) async {
    usePhoneSurface(tester);
    SharedPreferences.setMockInitialValues({});
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') return {'text': 'pasted-private-key'};
      return null;
    });
    addTearDown(() {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null);
      visible.dispose();
    });
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        overrides: [secretStoreProvider.overrideWithValue(secrets)],
        home: ValueListenableBuilder<bool>(
          valueListenable: visible,
          builder: (context, show, _) => show
              ? SshHostFormPage(existing: _host.copyWith(
                  auth: privateKey ? SshAuthMethod.privateKey : SshAuthMethod.password,
                  dshMode: attach ? SshDshMode.attachOnly : SshDshMode.managed,
                ))
              : const Scaffold(body: Text('next page')),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(secrets.reads, 1, reason: 'the real controller is waiting on secure storage');
  }

  Finder get password =>
      find.byWidgetPredicate((widget) => widget is TextField && widget.keyboardType == TextInputType.visiblePassword);
  Finder get key => find.byWidgetPredicate(
    (widget) => widget is TextField && widget.decoration?.hintText?.startsWith('-----BEGIN') == true,
  );
  Finder get passphrase => find.byWidgetPredicate((widget) => widget is TextField && widget.obscureText);

  String text(WidgetTester tester, Finder field) => tester.widget<TextField>(field).controller!.text;
  bool dirty(WidgetTester tester) => tester.widget<DiscardGuard>(find.byType(DiscardGuard)).isDirty();

  Future<void> loaded(WidgetTester tester) async {
    secrets.gate.complete();
    await tester.pumpAndSettle();
    expect(secrets.reads, 4);
  }
}

void main() {
  testWidgets('loading credentials does not mark an edited host name as saved', (tester) async {
    final rig = _Rig();
    await rig.pump(tester);
    final name = find.byWidgetPredicate((widget) => widget is TextField && widget.controller?.text == _host.name);
    await tester.enterText(name, 'Edited name');
    expect(rig.dirty(tester), isTrue);
    await rig.loaded(tester);
    expect(find.widgetWithText(TextField, 'Edited name'), findsOneWidget);
    expect(rig.dirty(tester), isTrue, reason: 'only loaded secrets belong to the original clean baseline');
  });

  for (final kind in ['password', 'privateKey', 'passphrase']) {
    testWidgets('a $kind typed during storage loading is not overwritten', (tester) async {
      final rig = _Rig();
      await rig.pump(tester, privateKey: kind != 'password');
      final field = switch (kind) {
        'password' => rig.password,
        'privateKey' => rig.key,
        _ => rig.passphrase,
      };
      await tester.enterText(field, 'new-$kind');
      await rig.loaded(tester);
      expect(rig.text(tester, field), 'new-$kind');
      expect(rig.dirty(tester), isTrue);
      if (kind == 'privateKey') expect(rig.text(tester, rig.passphrase), 'stored-passphrase');
    });
  }

  testWidgets('typing then clearing a secret remains an explicit empty edit', (tester) async {
    final rig = _Rig();
    await rig.pump(tester);
    await tester.enterText(rig.password, 'temporary');
    await tester.enterText(rig.password, '');
    await rig.loaded(tester);
    expect(rig.text(tester, rig.password), '');
    expect(rig.dirty(tester), isTrue);
  });

  testWidgets('programmatic paste before storage completion is preserved', (tester) async {
    final rig = _Rig();
    await rig.pump(tester, privateKey: true);
    await tester.ensureVisible(find.text('粘贴'));
    await tester.tap(find.text('粘贴'));
    await tester.pumpAndSettle();
    expect(rig.text(tester, rig.key), 'pasted-private-key');
    await rig.loaded(tester);
    expect(rig.text(tester, rig.key), 'pasted-private-key');
    expect(rig.dirty(tester), isTrue);
  });

  testWidgets('untouched credentials load normally and leave the form clean', (tester) async {
    final rig = _Rig();
    await rig.pump(tester, privateKey: true);
    await rig.loaded(tester);
    expect(rig.text(tester, rig.key), 'stored-private-key');
    expect(rig.text(tester, rig.passphrase), 'stored-passphrase');
    expect(rig.dirty(tester), isFalse);
  });

  testWidgets('selection-only changes do not suppress loading a secret', (tester) async {
    final rig = _Rig();
    await rig.pump(tester, privateKey: true);
    tester.widget<TextField>(rig.key).controller!.selection = const TextSelection.collapsed(offset: 0);
    await rig.loaded(tester);
    expect(rig.text(tester, rig.key), 'stored-private-key');
    expect(rig.dirty(tester), isFalse);
  });

  testWidgets('an ordinary edit undone before loading still leaves a clean form', (tester) async {
    final rig = _Rig();
    await rig.pump(tester);
    final controller = tester
        .widget<TextField>(
          find.byWidgetPredicate((widget) => widget is TextField && widget.controller?.text == _host.name),
        )
        .controller!;
    controller.text = 'temporary name';
    controller.text = _host.name;
    await rig.loaded(tester);
    expect(rig.dirty(tester), isFalse);
  });

  testWidgets('an attach token edited during loading is preserved', (tester) async {
    final rig = _Rig();
    await rig.pump(tester, attach: true);
    final token = find.byWidgetPredicate(
      (widget) => widget is TextField && widget.obscureText && widget.keyboardType != TextInputType.visiblePassword,
    );
    await tester.ensureVisible(token);
    await tester.enterText(token, 'edited-token');
    await rig.loaded(tester);
    expect(rig.text(tester, token), 'edited-token');
    expect(rig.dirty(tester), isTrue);
  });

  testWidgets('closing the form before storage returns is harmless', (tester) async {
    final rig = _Rig();
    await rig.pump(tester);
    rig.visible.value = false;
    await tester.pumpAndSettle();
    await rig.loaded(tester);
    expect(tester.takeException(), isNull);
    expect(find.text('next page'), findsOneWidget);
  });
}
