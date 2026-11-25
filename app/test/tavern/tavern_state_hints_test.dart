import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_state_hints.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_page.dart';
import 'package:dsh_app/ui/theme/app_icons.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

/// A card's own state: [values] saved at the current message under [schema].
class _Drawn extends PreviewTavern {
  _Drawn(this.values, this.schema, {this.hidden = const []}) : super(tick: Duration.zero);

  final Map<String, Object?> values;
  final Map<String, Object?> schema;
  final List<String> hidden;

  @override
  Future<TavernStateSnapshot> readState(String chatId) async => TavernStateSnapshot(
    chatId: chatId,
    nodeId: (await path(chatId)).last.nodeId,
    legacy: false,
    initialized: true,
    valueExists: true,
    automaticEnabled: true,
    schema: schema,
    values: values,
    hiddenPaths: hidden,
  );
}

const _schema = <String, Object?>{
  'type': 'object',
  'properties': {
    '好感': {'type': 'integer', 'minimum': -100, 'maximum': 100, 'x-dsh-show': 'bar'},
    '体力': {'type': 'integer', 'x-dsh-show': 'number'},
    '心情': {
      'type': 'array',
      'items': {'type': 'string'},
      'x-dsh-show': 'tags',
    },
    '背包': {
      'type': 'array',
      'items': {
        'type': 'object',
        'properties': {
          '名称': {'type': 'string'},
          '数量': {'type': 'integer'},
        },
      },
      'x-dsh-show': 'inventory',
    },
    '任务': {
      'type': 'array',
      'items': {'type': 'string'},
      'x-dsh-show': 'list',
    },
    '此刻': {
      'type': 'object',
      'properties': {
        '时间': {'type': 'string'},
        '地点': {'type': 'string'},
      },
      'x-dsh-show': 'line',
    },
    '名字': {'type': 'string', 'x-dsh-show': 'bar'}, // does not fit: drawn plainly
    '秘密': {'type': 'string', 'x-dsh-show': 'line', 'x-dsh-hidden': true},
  },
};

const _values = <String, Object?>{
  '好感': 50,
  '体力': 8,
  '心情': ['平静', '有点饿'],
  '背包': [
    {'名称': '钥匙', '数量': 1},
    {'名称': '半张地图', '数量': 2},
  ],
  '任务': ['找到灯塔', '把信交给旅店老板'],
  '此刻': {'时间': '傍晚', '地点': '旅店'},
  '名字': '阿岚',
  '秘密': '她就是灯塔守',
};

Future<void> _openState(WidgetTester tester, PreviewTavern tavern) async {
  SharedPreferences.setMockInitialValues({});
  final chat = (await tester.runAsync(() => tavern.createChat('sample-innkeeper')))!;
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
        home: TavernChatPage(chatId: chat),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('bot-action')));
  await tester.pumpAndSettle();
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('tavern-stage-tabs')), matching: find.text('状态')));
  await tester.pumpAndSettle();
}

Finder _row(String key) => find.byKey(ValueKey('tavern-variable-$key'));

void main() {
  group('reading the hints', () {
    test('the schema at a path: properties, items by index, other keys', () {
      const schema = {
        'properties': {
          'a/b': {
            'type': 'array',
            'items': {'x-dsh-show': 'line'},
          },
          'npc': {
            'additionalProperties': {
              'properties': {
                'bond': {'x-dsh-show': 'bar', 'maximum': 10},
              },
            },
          },
        },
      };
      expect(tavernStateSchemaAt(schema, '/a~1b/0'), {'x-dsh-show': 'line'});
      expect(tavernStateSchemaAt(schema, '/npc/阿岚/bond')?['maximum'], 10);
      expect(tavernStateSchemaAt(schema, '/a~1b/x'), isNull);
      expect(tavernStateSchemaAt(schema, '/missing'), isNull);
      expect(tavernStateSchemaAt(null, '/a'), isNull);
    });

    test('a hint counts only when the value fits it', () {
      const schema = {
        'properties': {
          'bond': {'x-dsh-show': 'bar', 'maximum': 10},
          'open': {'x-dsh-show': 'bar'},
          'tags': {'x-dsh-show': 'tags'},
          'odd': {'x-dsh-show': 'future-widget'},
        },
      };
      expect(tavernStateShow(schema, '/bond', 4), TavernStateShow.bar);
      expect(tavernStateShow(schema, '/bond', 'four'), isNull);
      expect(tavernStateShow(schema, '/open', 4), isNull); // no range to fill
      expect(tavernStateShow(schema, '/tags', ['a']), TavernStateShow.tags);
      expect(tavernStateShow(schema, '/tags', 'a'), isNull);
      expect(tavernStateShow(schema, '/odd', 1), isNull);
      expect(tavernStateFraction(4, (0, 10)), closeTo(0.4, 1e-9));
      expect(tavernStateFraction(50, (-100, 100)), closeTo(0.75, 1e-9));
      expect(tavernStateFraction(120, (-100, 100)), 1);
    });

    test('a bag: names, objects with a count, or name to count', () {
      expect(tavernStateGoods(['钥匙', '火柴']), [(name: '钥匙', count: null), (name: '火柴', count: null)]);
      expect(
        tavernStateGoods([
          {'name': 'key', 'count': 3},
          {'名称': '地图'},
          {'weight': 2},
        ]),
        [(name: 'key', count: 3), (name: '地图', count: null), (name: '2', count: null)],
      );
      expect(
        tavernStateGoods({
          '钥匙': 1,
          '信': true,
          '灯': {'数量': 2},
          '纸条': '旧的',
        }),
        [(name: '钥匙', count: 1), (name: '信', count: null), (name: '灯', count: 2), (name: '纸条：旧的', count: null)],
      );
      expect(tavernStateLine({'时间': '傍晚', '地点': '旅店', '天气': null}), '傍晚 · 旅店');
      expect(
        tavernStateEntries({
          '主线': '找灯塔',
          '支线': ['送信'],
        }),
        ['主线：找灯塔', '支线：送信'],
      );
    });
  });

  testWidgets('状态 draws each field the way the card asks', (tester) async {
    await _openState(tester, _Drawn(Map.of(_values), _schema, hidden: const ['/秘密']));

    // A bar, filled between the schema's ends, its number beside it.
    final bar = find.byKey(const ValueKey('tavern-state-bar-/好感'));
    expect(bar, findsOneWidget);
    expect(find.descendant(of: _row('好感'), matching: find.text('50')), findsOneWidget);
    final fill = tester.widget<FractionallySizedBox>(
      find.descendant(of: bar, matching: find.byType(FractionallySizedBox)),
    );
    expect(fill.widthFactor, closeTo(0.75, 1e-9));

    // A number as itself; tags as capsules, never opened.
    expect(find.descendant(of: _row('体力'), matching: find.text('8')), findsOneWidget);
    final tags = find.byKey(const ValueKey('tavern-state-tags-/心情'));
    expect(find.descendant(of: tags, matching: find.text('平静')), findsOneWidget);
    expect(find.descendant(of: tags, matching: find.text('有点饿')), findsOneWidget);
    expect(find.descendant(of: _row('心情'), matching: find.byIcon(AppIcons.disclosure)), findsNothing);

    // A bag: a cell for each thing, how many when more than one.
    final goods = find.byKey(const ValueKey('tavern-state-goods-/背包'));
    expect(find.descendant(of: goods, matching: find.text('钥匙')), findsOneWidget);
    expect(find.descendant(of: goods, matching: find.text('半张地图')), findsOneWidget);
    expect(find.descendant(of: goods, matching: find.text('×2')), findsOneWidget);
    expect(find.descendant(of: goods, matching: find.text('×1')), findsNothing);
    expect(find.descendant(of: _row('背包'), matching: find.text('2 项')), findsOneWidget);

    // A list a line each; time and place on one line.
    final list = find.byKey(const ValueKey('tavern-state-list-/任务'));
    expect(find.descendant(of: list, matching: find.text('把信交给旅店老板')), findsOneWidget);
    expect(find.descendant(of: _row('此刻'), matching: find.text('傍晚 · 旅店')), findsOneWidget);

    // A hint the value does not fit is drawn plainly; a spoiler stays folded.
    expect(find.descendant(of: _row('名字'), matching: find.text('阿岚')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-state-bar-/名字')), findsNothing);
    expect(find.text('她就是灯塔守'), findsNothing);

    // Still opens whole to read or change.
    await tester.tap(_row('背包'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-variable-whole')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-state-edit')), findsOneWidget);
  });

  testWidgets('搜 finds a drawn field by what it shows', (tester) async {
    await _openState(tester, _Drawn(Map.of(_values), _schema));

    await tester.enterText(find.byKey(const ValueKey('tavern-state-search')), '旅店');
    await tester.pumpAndSettle();
    expect(_row('/此刻'), findsOneWidget);
    expect(_row('/任务'), findsOneWidget); // 把信交给旅店老板
    expect(_row('/好感'), findsNothing);
    // A drawn field is whole: its parts are not rows of their own.
    expect(_row('/此刻/地点'), findsNothing);
  });
}
