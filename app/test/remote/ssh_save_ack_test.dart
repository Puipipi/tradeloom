import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/remote/secret_store.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/remote/ssh_host_form.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../shell/golden_harness.dart';

const _host = SshHostConfig(id: 'save-ack', name: 'Original host', host: 'example.invalid', user: 'test');
const _editedName = 'Edited host';
const _password = 'synthetic-password';
const _channel = MethodChannel('plugins.flutter.io/shared_preferences');
const _hostKey = 'flutter.${HostsController.prefsKey}';

enum _Reply { success, refused, exception }

class _Secrets extends MemorySecretStore {
  _Secrets() : super({SshSecrets.passwordKey(_host.id): _password});

  bool rejectNextWrite = false;

  @override
  Future<void> write(String key, String value) async {
    if (rejectNextWrite) {
      rejectNextWrite = false;
      throw PlatformException(code: 'synthetic_secret_failure');
    }
    await super.write(key, value);
  }
}

/// Only the platform preferences boundary is replaced. The real plugin still
/// updates its cache, encodes the method call, and decodes bool/error replies.
class _Rig {
  _Rig() {
    SharedPreferences.resetStatic();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, _call);
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(_channel, null);
      SharedPreferences.resetStatic();
    });
  }

  final values = <String, Object>{
    _hostKey: jsonEncode([_host.toJson()]),
  };
  final secrets = _Secrets();
  final returned = <SshHostConfig?>[];
  _Reply reply = _Reply.success;
  Completer<void>? writeGate;
  int hostWrites = 0;
  late ProviderContainer container;

  Future<Object?> _call(MethodCall call) async {
    if (call.method == 'getAll' || call.method == 'getAllWithParameters') return Map<String, Object>.of(values);
    final args = call.arguments as Map;
    final key = args['key'] as String;
    if (call.method.startsWith('set')) {
      if (key == _hostKey) {
        hostWrites++;
        if (writeGate case final gate?) await gate.future;
        switch (reply) {
          case _Reply.refused:
            return false;
          case _Reply.exception:
            throw PlatformException(code: 'synthetic_preferences_failure');
          case _Reply.success:
            break;
        }
      }
      values[key] = args['value'] as Object;
      return true;
    }
    if (call.method == 'remove') {
      values.remove(key);
      return true;
    }
    throw StateError('unexpected preferences operation ${call.method}');
  }

  SshHostConfig get platformHost => SshHostConfig.fromJson((jsonDecode(values[_hostKey]! as String) as List).single)!;

  Future<void> open(WidgetTester tester) async {
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        brightness: Brightness.light,
        overrides: [secretStoreProvider.overrideWithValue(secrets)],
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  final saved = await Navigator.of(context)
                      .push<SshHostConfig>(MaterialPageRoute(builder: (_) => const SshHostFormPage(existing: _host)));
                  returned.add(saved);
                },
                child: const Text('Edit host'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Edit host'));
    await tester.pumpAndSettle();
    container = ProviderScope.containerOf(tester.element(find.byType(SshHostFormPage)));
    expect(container.read(hostsProvider).loaded, isTrue);
    expect(container.read(hostsProvider).ssh.single, _host);
    await tester.enterText(find.widgetWithText(TextField, _host.name), _editedName);
  }

  Future<void> save(WidgetTester tester) async {
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
  }

  void expectSaved() {
    expect(platformHost.name, _editedName);
    expect(returned.single?.name, _editedName);
    expect(returned.single?.id, _host.id);
    expect(secrets.values[SshSecrets.passwordKey(_host.id)], _password);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  for (final reply in [_Reply.refused, _Reply.exception]) {
    testWidgets('configuration ${reply.name} keeps the form open and a later retry succeeds', (tester) async {
      final rig = _Rig()..reply = reply;
      await rig.open(tester);
      await rig.save(tester);

      expect(rig.hostWrites, 1);
      expect(rig.platformHost, _host, reason: 'this platform fixture refused before storing the new configuration');
      // A failure reply does not roll back the existing optimistic app state
      // or the preferences plugin cache; this is an acknowledgement fix only.
      expect(rig.container.read(hostsProvider).ssh.single.name, _editedName);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(HostsController.prefsKey), contains(_editedName));
      expect(
        find.byType(SshHostFormPage),
        findsOneWidget,
        reason: 'a refused save must not return success to its caller',
      );
      expect(find.text('没能保存'), findsOneWidget);
      expect(rig.returned, isEmpty);
      expect(tester.takeException(), isNull);

      rig.reply = _Reply.success;
      await rig.save(tester);
      expect(rig.hostWrites, 2);
      expect(find.byType(SshHostFormPage), findsNothing);
      expect(find.text('没能保存'), findsNothing);
      rig.expectSaved();
    });
  }

  testWidgets('successful configuration acknowledgement is awaited before returning the edited host', (tester) async {
    final rig = _Rig()..writeGate = Completer<void>();
    await rig.open(tester);
    await rig.save(tester);
    expect(rig.hostWrites, 1);
    expect(rig.returned, isEmpty);
    expect(rig.platformHost, _host);
    expect(find.byType(SshHostFormPage), findsOneWidget);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '保存')).onPressed, isNull);

    rig.writeGate!.complete();
    await tester.pumpAndSettle();
    expect(find.byType(SshHostFormPage), findsNothing);
    rig.expectSaved();
  });

  testWidgets('a secret write error still keeps the form open before any configuration write', (tester) async {
    final rig = _Rig();
    rig.secrets.rejectNextWrite = true;
    await rig.open(tester);
    await rig.save(tester);
    expect(rig.hostWrites, 0);
    expect(rig.platformHost, _host);
    expect(find.byType(SshHostFormPage), findsOneWidget);
    expect(find.text('没能保存'), findsOneWidget);
    expect(rig.returned, isEmpty);
    expect(tester.takeException(), isNull);

    await rig.save(tester);
    expect(rig.hostWrites, 1);
    rig.expectSaved();
  });

  testWidgets('a refused acknowledgement after form disposal does not update another page', (tester) async {
    final rig = _Rig()
      ..reply = _Reply.refused
      ..writeGate = Completer<void>();
    await rig.open(tester);
    await rig.save(tester);
    expect(rig.hostWrites, 1);
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('next page'))));
    await tester.pumpAndSettle();
    rig.writeGate!.complete();
    await tester.pumpAndSettle();
    expect(find.text('next page'), findsOneWidget);
    expect(find.text('没能保存'), findsNothing);
    expect(rig.platformHost, _host);
    expect(tester.takeException(), isNull);
  });
}
