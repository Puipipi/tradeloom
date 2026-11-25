import 'package:dsh_app/tavern/deferred_tavern.dart';
import 'package:dsh_app/tavern/tavern_pinned.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

TavernStateSnapshot _state(
  Object? values, {
  List<String> pins = const [],
  List<String> hidden = const [],
  bool saved = true,
}) => TavernStateSnapshot(
  chatId: 'c',
  nodeId: 'n',
  legacy: false,
  initialized: saved,
  valueExists: saved,
  automaticEnabled: true,
  values: saved ? values : null,
  initialValuesAvailable: !saved,
  initialValues: saved ? null : values,
  pinPaths: pins,
  hiddenPaths: hidden,
);

/// The preview with a card state pinning [pins]; [values] may change.
class _Pinning extends PreviewTavern {
  _Pinning(this.values, this.pins) : super(tick: Duration.zero);

  Map<String, Object?> values;
  final List<String> pins;

  @override
  Future<TavernStateSnapshot> readState(String chatId) async => _state(values, pins: pins);
}

void main() {
  test('pinned values on one line, by their last step; nothing pinned or present is no line', () {
    final values = {
      '好感': 8,
      'where': {'地点': '旅店二楼'},
      '背包': ['钥匙', '半张地图'],
      'a/b': 'slash',
      '秘密': '她是逃犯',
    };
    expect(
      tavernPinnedLine(_state(values, pins: ['/好感', '/where/地点', '/背包', '/a~1b'])),
      '好感 8 · 地点 旅店二楼 · 背包 钥匙、半张地图 · a/b slash',
    );
    // A pin the model may not see stays off the header; a missing one is skipped.
    expect(tavernPinnedLine(_state(values, pins: ['/好感', '/秘密', '/没有'], hidden: ['/秘密'])), '好感 8');
    expect(tavernPinnedLine(_state(values)), isNull);
    expect(tavernPinnedLine(_state(values, pins: ['/没有'])), isNull);
    // Before anything is saved, the card's starting values.
    expect(tavernPinnedLine(_state({'好感': 0}, pins: ['/好感'], saved: false)), '好感 0');
  });

  testWidgets("the header's line carries what the card pins, read again with the story", (tester) async {
    SharedPreferences.setMockInitialValues({});
    final inner = _Pinning({'好感': 5, '地点': '大堂'}, ['/好感', '/地点']);
    final chat = (await tester.runAsync(() => inner.createChat('sample-innkeeper')))!;
    tester.view.physicalSize = const Size(390, 844) * 2;
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [tavernProvider.overrideWith((ref) => DeferredTavern(Future.value(inner)))],
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: TavernChatPage(chatId: chat),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('好感 5 · 地点 大堂'), findsOneWidget);

    inner.values = {'好感': 6, '地点': '二楼'};
    await tester.runAsync(() => inner.sendOnly(chat, '我上楼了。'));
    await tester.pumpAndSettle();
    expect(find.text('好感 6 · 地点 二楼'), findsOneWidget);
  });
}
