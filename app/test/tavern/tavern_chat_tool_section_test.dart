import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_tool_section.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _chat = 'c1';

/// The preview with the engine's tool scope kept in memory, global and per
/// chat, as readToolPolicy and setToolPolicy would give and take it: a chat
/// leaf of null follows the settings, and a chat cannot turn on what the
/// settings turned off.
class _Policy extends PreviewTavern {
  _Policy({Map<String, Object?>? global}) : global = global ?? {}, super(tick: Duration.zero);

  final Map<String, Object?> global;
  final chats = <String, Map<String, Object?>>{};
  final writes = <({Map<String, Object?> patch, String? chatId})>[];

  Object? _leaf(Map<String, Object?> raw, String tool, String key) => (raw[tool] as Map?)?[key];

  TavernToolPolicySnapshot _snapshot(String? chatId) {
    final chat = chatId == null ? null : chats[chatId];
    final local = chat ?? const <String, Object?>{};
    final globalRoll = _leaf(global, 'roll', 'allow') as bool? ?? true;
    final globalRemember = _leaf(global, 'remember', 'allow') as bool? ?? false;
    return TavernToolPolicySnapshot.fromJson({
      'configuredGlobal': {'present': global.isNotEmpty, 'raw': global.isEmpty ? null : global},
      'configuredChat': chatId == null ? null : {'present': chat != null, 'raw': chat},
      'effectiveScope': {
        'rollAllow': globalRoll && (_leaf(local, 'roll', 'enabled') as bool? ?? true),
        'rememberAllow': globalRemember && (_leaf(local, 'remember', 'enabled') as bool? ?? true),
        'rememberMode':
            _leaf(local, 'remember', 'mode') as String? ?? _leaf(global, 'remember', 'mode') as String? ?? 'ask',
      },
      'diagnostics': <Object?>[],
    });
  }

  @override
  Future<TavernToolPolicySnapshot> readToolPolicy({String? chatId}) async => _snapshot(chatId);

  @override
  Future<TavernToolPolicyWriteResult> setToolPolicy(Map<String, Object?> patch, {String? chatId}) async {
    writes.add((patch: patch, chatId: chatId));
    final raw = chatId == null ? global : chats.putIfAbsent(chatId, () => {});
    for (final MapEntry(:key, :value) in patch.entries) {
      raw[key] = {...(raw[key] as Map<String, Object?>? ?? const {}), ...value! as Map<String, Object?>};
    }
    return TavernToolPolicyWriteResult.fromJson({
      'snapshot': _snapshot(chatId).toJson(),
      'committed': true,
      'diagnostics': <Object?>[],
    });
  }
}

Future<void> _section(WidgetTester tester, Tavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern)],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: const Scaffold(
          body: SingleChildScrollView(child: TavernChatToolSection(chatId: _chat)),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _pick(WidgetTester tester, String key, String label) async {
  final segment = find.descendant(of: find.byKey(ValueKey(key)), matching: find.text(label));
  await tester.ensureVisible(segment);
  await tester.pumpAndSettle();
  await tester.tap(segment);
  await tester.pumpAndSettle();
}

String _now(WidgetTester tester) => tester.widget<Text>(find.byKey(const ValueKey('tavern-chat-tool-now'))).data!;

void _wrote(({Map<String, Object?> patch, String? chatId}) write, Map<String, Object?> patch) {
  expect(write.chatId, _chat);
  expect(write.patch, patch);
}

void main() {
  testWidgets('掷骰 and 记事 each follow the settings, or are on or off for this chat', (tester) async {
    final engine = _Policy();
    await _section(tester, DeferredTavern(Future.value(engine)));
    expect(_now(tester), '这局实际：掷骰开，记事关');

    await _pick(tester, 'tavern-chat-tool-roll', '关');
    _wrote(engine.writes.last, {
      'roll': {'enabled': false},
    });
    expect(_now(tester), '这局实际：掷骰关，记事关');
    expect(engine.global, isEmpty);

    await _pick(tester, 'tavern-chat-tool-roll', '跟设置');
    _wrote(engine.writes.last, {
      'roll': {'enabled': null},
    });
    expect(_now(tester), '这局实际：掷骰开，记事关');
  });

  testWidgets('what the settings turned off stays off, and it says so', (tester) async {
    final engine = _Policy(
      global: {
        'roll': {'allow': false},
      },
    );
    await _section(tester, DeferredTavern(Future.value(engine)));
    expect(find.byKey(const ValueKey('tavern-chat-tool-held')), findsNothing);

    await _pick(tester, 'tavern-chat-tool-roll', '开');
    _wrote(engine.writes.single, {
      'roll': {'enabled': true},
    });
    expect(find.text('酒馆设置里关着的，这里打开也不算'), findsOneWidget);
    expect(_now(tester), '这局实际：掷骰关，记事关');
  });

  testWidgets('记事方式 shows while memories are on here, and is chosen for this chat', (tester) async {
    final engine = _Policy(
      global: {
        'remember': {'allow': true, 'mode': 'ask'},
      },
    );
    await _section(tester, DeferredTavern(Future.value(engine)));
    expect(_now(tester), '这局实际：掷骰开，记事先问我');

    await _pick(tester, 'tavern-chat-tool-mode', '自动');
    _wrote(engine.writes.single, {
      'remember': {'mode': 'auto'},
    });
    expect(_now(tester), '这局实际：掷骰开，记事自动');

    // Off here: the way this chat chose stays in sight, to be put back.
    await _pick(tester, 'tavern-chat-tool-remember', '关');
    expect(_now(tester), '这局实际：掷骰开，记事关');
    expect(find.byKey(const ValueKey('tavern-chat-tool-mode')), findsOneWidget);

    await _pick(tester, 'tavern-chat-tool-mode', '跟设置');
    _wrote(engine.writes.last, {
      'remember': {'mode': null},
    });
    expect(find.byKey(const ValueKey('tavern-chat-tool-mode')), findsNothing);
  });

  testWidgets('with memories off and no way chosen here, there is no 记事方式', (tester) async {
    await _section(tester, DeferredTavern(Future.value(_Policy())));
    expect(find.byKey(const ValueKey('tavern-chat-tool-roll')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-chat-tool-mode')), findsNothing);
  });

  testWidgets('the preview keeps no tools, so there is no 这局的工具', (tester) async {
    await _section(tester, PreviewTavern(tick: Duration.zero));
    expect(find.byKey(const ValueKey('tavern-chat-tools')), findsNothing);
  });
}
