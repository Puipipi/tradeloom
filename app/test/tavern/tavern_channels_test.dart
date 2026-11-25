import 'dart:async';
import 'dart:convert';

import 'package:dsh_app/tavern/tavern_channels.dart';
import 'package:dsh_app/tavern/tavern_generation.dart';
import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/tavern/tavern_settings.dart';
import 'package:dsh_app/ui/tavern/tavern_channels_page.dart';
import 'package:dsh_app/ui/tavern/tavern_number_tile.dart';
import 'package:dsh_app/ui/tavern/tavern_settings_page.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart' show TavernModelConfig;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

class _Keys implements TavernChannelKeys {
  final stored = <String, String>{};
  final headers = <String, Map<String, String>>{};

  @override
  Future<String?> read(String id) async => stored[id];

  @override
  Future<void> write(String id, String key) async => stored[id] = key;

  @override
  Future<Map<String, String>> readHeaders(String id) async => headers[id] ?? const {};

  @override
  Future<void> writeHeaders(String id, Map<String, String> value) async =>
      value.isEmpty ? headers.remove(id) : headers[id] = value;

  @override
  Future<void> delete(String id) async {
    stored.remove(id);
    headers.remove(id);
  }
}

const _relay = TavernChannel(id: 'c1', name: 'Relay', baseUrl: 'https://relay.example/v1', model: 'gpt-x');

Widget _app(_Keys keys, Widget home) => ProviderScope(
  overrides: [
    tavernProvider.overrideWith((ref) => PreviewTavern(tick: Duration.zero)),
    tavernChannelKeysProvider.overrideWithValue(keys),
  ],
  child: MaterialApp(
    theme: withTestFonts(buildLightTheme()),
    locale: const Locale('zh', 'CN'),
    supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
    localizationsDelegates: GlobalMaterialLocalizations.delegates,
    home: home,
  ),
);

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
}

Future<void> _show(WidgetTester tester, Finder finder) async {
  unawaited(Scrollable.ensureVisible(tester.element(finder), alignment: 0.5));
  await tester.pumpAndSettle();
}

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(Scaffold).first));

void main() {
  group('TavernChannel', () {
    test('a list survives preferences; anything else there reads as none', () {
      final json = TavernChannel.listToJson([_relay, _relay.copyWith(name: 'B')]);
      expect(TavernChannel.listFromJson(json), [_relay, _relay.copyWith(name: 'B')]);
      expect(TavernChannel.listFromJson('{"not": "a list"}'), isEmpty);
      expect(TavernChannel.listFromJson('not json'), isEmpty);
      expect(TavernChannel.listFromJson('[{"id": "x"}, ${jsonEncode(_relay.toJson())}]'), [_relay]);
    });

    test('/models sits where /chat/completions does', () {
      expect(tavernModelsUrl('https://a.example/v1').toString(), 'https://a.example/v1/models');
      expect(tavernModelsUrl('https://a.example/v1/').toString(), 'https://a.example/v1/models');
      expect(tavernModelsUrl('https://a.example/v1/chat/completions').toString(), 'https://a.example/v1/models');
    });

    test('the endpoint lists its models, sorted, asked with the key', () async {
      late http.Request seen;
      final client = MockClient((request) async {
        seen = request;
        return http.Response(
          jsonEncode({
            'data': [
              {'id': 'b-model'},
              {'id': 'a-model'},
            ],
          }),
          200,
        );
      });
      expect(await fetchTavernModels('https://a.example/v1', 'sk-1', client: client), ['a-model', 'b-model']);
      expect(seen.headers['Authorization'], 'Bearer sk-1');

      final keyless = MockClient((request) async {
        seen = request;
        return http.Response('{"data": []}', 200);
      });
      expect(await fetchTavernModels('http://192.168.1.2:1234/v1', null, client: keyless), isEmpty);
      expect(seen.headers.containsKey('Authorization'), isFalse);

      final refused = MockClient((_) async => http.Response('no', 401));
      expect(
        fetchTavernModels('https://a.example/v1', 'bad', client: refused),
        throwsA(isA<TavernModelsException>().having((e) => e.detail, 'detail', 'HTTP 401')),
      );
    });
  });

  group('酒馆设置 keeps channels', () {
    test('saving, choosing and deleting one; its key apart from preferences', () async {
      SharedPreferences.setMockInitialValues({});
      final keys = _Keys();
      final container = ProviderContainer(overrides: [tavernChannelKeysProvider.overrideWithValue(keys)]);
      addTearDown(container.dispose);
      final controller = container.read(tavernSettingsProvider.notifier);
      await Future<void>.delayed(Duration.zero);

      await controller.saveChannel(_relay, key: 'sk-relay');
      await controller.setChannel(_relay.id);
      var settings = container.read(tavernSettingsProvider);
      expect(settings.activeChannel, _relay);
      expect(settings.activeModel, 'gpt-x');
      expect(settings.deepseekApi, isFalse);
      expect(keys.stored, {'c1': 'sk-relay'});
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(TavernSettingsController.channelsKey), isNot(contains('sk-relay')));

      // An edit without a key keeps the stored one.
      await controller.saveChannel(_relay.copyWith(model: 'gpt-y'));
      expect(container.read(tavernSettingsProvider).activeModel, 'gpt-y');
      expect(keys.stored, {'c1': 'sk-relay'});

      await controller.deleteChannel(_relay.id);
      settings = container.read(tavernSettingsProvider);
      expect(settings.channels, isEmpty);
      expect(settings.activeChannel, isNull);
      expect(settings.activeModel, 'deepseek-flash');
      expect(keys.stored, isEmpty);
      expect(prefs.getString(TavernSettingsController.channelKey), isNull);
    });

    test('read back: the channel in use, a typed DeepSeek model, typed numbers', () async {
      SharedPreferences.setMockInitialValues({
        TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
        TavernSettingsController.channelKey: 'c1',
        TavernSettingsController.modelKey: 'deepseek-chat',
        TavernSettingsController.textSizeKey: 17.0,
        TavernSettingsController.costAlertKey: 0.3,
      });
      final container = ProviderContainer(overrides: [tavernChannelKeysProvider.overrideWithValue(_Keys())]);
      addTearDown(container.dispose);
      container.read(tavernSettingsProvider);
      await Future<void>.delayed(Duration.zero);
      await Future<void>.delayed(Duration.zero);
      final settings = container.read(tavernSettingsProvider);
      expect(settings.activeChannel, _relay);
      expect(settings.model, 'deepseek-chat');
      expect(settings.textSize, 17);
      expect(settings.costAlert, 0.3);
    });

    test('a channel id with no channel behind it is DeepSeek', () async {
      SharedPreferences.setMockInitialValues({TavernSettingsController.channelKey: 'gone'});
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(tavernSettingsProvider);
      await Future<void>.delayed(Duration.zero);
      expect(container.read(tavernSettingsProvider).activeChannel, isNull);
    });
  });

  testWidgets('adding a channel from 酒馆设置 starts using it; 思考 and the DeepSeek key row step aside', (tester) async {
    SharedPreferences.setMockInitialValues({});
    _phone(tester);
    final keys = _Keys();
    await tester.pumpWidget(_app(keys, const TavernSettingsPage()));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-thinking')), findsOneWidget);
    expect(find.byKey(const ValueKey('tavern-key')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-channel')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-channel-add')));
    await tester.pumpAndSettle();

    // Nothing filled: both required fields say so.
    await tester.tap(find.byKey(const ValueKey('tavern-channel-save')));
    await tester.pumpAndSettle();
    expect(find.text('要以 http:// 或 https:// 开头'), findsOneWidget);
    expect(find.text('填一个模型名'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('tavern-channel-base-url')), 'https://relay.example/v1');
    await tester.enterText(find.byKey(const ValueKey('tavern-channel-key')), 'sk-relay');
    await tester.enterText(find.byKey(const ValueKey('tavern-channel-model')), 'gpt-x');
    await tester.tap(find.byKey(const ValueKey('tavern-channel-save')));
    await tester.pumpAndSettle();

    // Back on the list, the new one ticked; its name is the host.
    final settings = _container(tester).read(tavernSettingsProvider);
    expect(settings.activeChannel?.name, 'relay.example');
    expect(settings.activeChannel?.baseUrl, 'https://relay.example/v1');
    expect(keys.stored.values, ['sk-relay']);
    tester.state<NavigatorState>(find.byType(Navigator)).pop();
    await tester.pumpAndSettle();

    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-channel')), matching: find.text('relay.example')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-model')), matching: find.text('gpt-x')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('tavern-thinking')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-key')), findsNothing);
  });

  testWidgets('DeepSeek takes a model name typed under 自定义', (tester) async {
    SharedPreferences.setMockInitialValues({});
    _phone(tester);
    await tester.pumpWidget(_app(_Keys(), const TavernSettingsPage()));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-model'));
    await tester.tap(find.descendant(of: row, matching: find.text('自定义')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'deepseek-chat');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect((await SharedPreferences.getInstance()).getString(TavernSettingsController.modelKey), 'deepseek-chat');
    expect(find.descendant(of: row, matching: find.text('deepseek-chat')), findsOneWidget);
  });

  testWidgets('生成 takes a number typed under 自定义, within its range, and edits it again', (tester) async {
    final tavern = PreviewTavern(tick: Duration.zero);
    SharedPreferences.setMockInitialValues({});
    _phone(tester);
    await tester.pumpWidget(
      ProviderScope(
        overrides: [tavernProvider.overrideWith((ref) => tavern), tavernChannelKeysProvider.overrideWithValue(_Keys())],
        child: MaterialApp(
          theme: withTestFonts(buildLightTheme()),
          locale: const Locale('zh', 'CN'),
          supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
          localizationsDelegates: GlobalMaterialLocalizations.delegates,
          home: const TavernSettingsPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-temperature'));
    await _show(tester, row);
    await tester.tap(find.descendant(of: row, matching: find.text('自定义')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).last, '2.5');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(find.text('填 0 到 2 之间的数'), findsNWidgets(2)); // the caption, and the field's error

    await tester.enterText(find.byType(TextField).last, '0.85');
    await tester.tap(find.text('保存'));
    await tester.pumpAndSettle();
    expect(((await tavern.readSettings())['preset']! as Map<String, Object?>)['temperature'], 0.85);
    expect(find.descendant(of: row, matching: find.text('0.85')), findsOneWidget);

    // Tapping the typed value opens it again, filled in.
    await tester.tap(find.descendant(of: row, matching: find.text('0.85')));
    await tester.pumpAndSettle();
    expect(find.widgetWithText(TextField, '0.85'), findsOneWidget);
  });

  test('tavernNumberText drops what does not count', () {
    expect(tavernNumberText(1.0), '1');
    expect(tavernNumberText(0.85), '0.85');
    expect(tavernNumberText(4096), '4096');
    expect(tavernNumberText(0.1 + 0.2), '0.3');
  });

  test('the ranges hold their presets', () {
    for (final (presets, range) in [(tavernContextSizes, tavernContextRange), (tavernReplySizes, tavernReplyRange)]) {
      expect(presets.every((p) => p >= range.min && p <= range.max), isTrue);
    }
    expect(tavernTemperatures.every((t) => t <= tavernTemperatureRange.max), isTrue);
    expect(tavernTopPs.every((t) => t <= tavernTopPRange.max), isTrue);
  });

  testWidgets('the channel list: DeepSeek, then each added one with its edit button', (tester) async {
    SharedPreferences.setMockInitialValues({
      TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
      TavernSettingsController.channelKey: 'c1',
    });
    _phone(tester);
    final keys = _Keys()..stored['c1'] = 'sk-relay';
    await tester.pumpWidget(_app(keys, const TavernChannelsPage()));
    await tester.pumpAndSettle();
    expect(find.text('relay.example · gpt-x'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-channel-deepseek')));
    await tester.pumpAndSettle();
    expect(_container(tester).read(tavernSettingsProvider).activeChannel, isNull);

    await tester.tap(find.byKey(const ValueKey('tavern-channel-c1-edit')));
    await tester.pumpAndSettle();
    expect(find.text('已存了 Key，不填就保持原样'), findsOneWidget);
    await _show(tester, find.byKey(const ValueKey('tavern-channel-delete')));
    await tester.tap(find.byKey(const ValueKey('tavern-channel-delete')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('删除').last);
    await tester.pumpAndSettle();
    expect(_container(tester).read(tavernSettingsProvider).channels, isEmpty);
    expect(keys.stored, isEmpty);
  });

  test('request headers: one "Name: value" a line; anything else is refused', () {
    expect(tavernParseHeaders('HTTP-Referer: https://a.example\n\nX-Title: 我的 酒馆'), {
      'HTTP-Referer': 'https://a.example',
      'X-Title': '我的 酒馆',
    });
    expect(tavernParseHeaders(''), isEmpty);
    expect(tavernParseHeaders('no colon here'), isNull);
    expect(tavernParseHeaders('Bad Name: x'), isNull);
    final relay = _relay.copyWith(headers: {'api-key': 'secret'});
    expect(tavernHeaderLines(relay.headers), 'api-key: secret');
    // Preferences never see them: they go beside the key.
    expect(TavernChannel.listToJson([relay]), isNot(contains('secret')));
  });

  test('headers are kept beside the key and read back with the channel', () async {
    SharedPreferences.setMockInitialValues({});
    final keys = _Keys();
    final container = ProviderContainer(overrides: [tavernChannelKeysProvider.overrideWithValue(keys)]);
    addTearDown(container.dispose);
    container.read(tavernSettingsProvider);
    await Future<void>.delayed(Duration.zero);
    await container.read(tavernSettingsProvider.notifier).saveChannel(_relay.copyWith(headers: {'api-key': 'secret'}));
    expect(keys.headers['c1'], {'api-key': 'secret'});

    final again = ProviderContainer(overrides: [tavernChannelKeysProvider.overrideWithValue(keys)]);
    addTearDown(again.dispose);
    again.read(tavernSettingsProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(again.read(tavernSettingsProvider).channels.single.headers, {'api-key': 'secret'});
  });

  test('a channel of its own needs no DeepSeek key to send', () async {
    SharedPreferences.setMockInitialValues({
      TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
    });
    final container = ProviderContainer(overrides: [tavernChannelKeysProvider.overrideWithValue(_Keys())]);
    addTearDown(container.dispose);
    container.read(tavernSettingsProvider);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    expect(container.read(tavernNeedsKeyProvider), isTrue); // DeepSeek's own, no key in the app
    await container.read(tavernSettingsProvider.notifier).setChannel('c1');
    expect(container.read(tavernNeedsKeyProvider), isFalse);
  });

  test('the engine is told the channel in use, its headers, and the helper model', () async {
    final keys = _Keys()..stored['c1'] = 'sk-relay';
    final relay = _relay.copyWith(headers: {'X-Title': 'T'});
    final local = const TavernChannel(id: 'c2', name: 'Local', baseUrl: 'http://192.168.1.2:1234/v1', model: 'qwen');
    TavernModelConfig of(TavernSettings s) => tavernModelConfig(s, appKey: () => 'sk-app', keys: keys);

    // DeepSeek's own: the app's key, no helper of ours.
    var config = of(const TavernSettings(thinking: true));
    expect(
      (config.baseUrl, config.model, config.deepseek, config.thinking),
      (tavernDeepSeekBaseUrl, 'deepseek-flash', true, true),
    );
    expect(await config.apiKey(), 'sk-app');
    expect(config.auxiliary, isNull);

    // A channel in use, a local one as its helper (no key: none sent).
    config = of(TavernSettings(channel: 'c1', channels: [relay, local], auxiliary: 'c2', thinking: true));
    expect((config.baseUrl, config.model, config.deepseek), ('https://relay.example/v1', 'gpt-x', false));
    expect(config.headers, {'X-Title': 'T'});
    expect(await config.apiKey(), 'sk-relay');
    final helper = config.auxiliary!;
    expect((helper.baseUrl, helper.model, helper.thinking), ('http://192.168.1.2:1234/v1', 'qwen', false));
    expect(await helper.apiKey(), isNull);

    // DeepSeek's flash as the helper, under any channel.
    config = of(TavernSettings(channel: 'c1', channels: [relay], auxiliary: tavernAuxiliaryDeepSeek));
    expect((config.auxiliary!.baseUrl, config.auxiliary!.model), (tavernDeepSeekBaseUrl, 'deepseek-flash'));
    expect(await config.auxiliary!.apiKey(), 'sk-app');
  });

  testWidgets('辅助模型 is picked in 酒馆设置; deleting its channel sets it back to 自动', (tester) async {
    SharedPreferences.setMockInitialValues({
      TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
    });
    _phone(tester);
    await tester.pumpWidget(_app(_Keys(), const TavernSettingsPage()));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('tavern-auxiliary'));
    expect(find.descendant(of: row, matching: find.text('自动')), findsOneWidget);

    await tester.tap(row);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-auxiliary-c1')));
    await tester.pumpAndSettle();
    expect(find.descendant(of: row, matching: find.text('Relay')), findsOneWidget);
    expect((await SharedPreferences.getInstance()).getString(TavernSettingsController.auxiliaryKey), 'c1');

    await _container(tester).read(tavernSettingsProvider.notifier).deleteChannel('c1');
    await tester.pumpAndSettle();
    expect(find.descendant(of: row, matching: find.text('自动')), findsOneWidget);
  });

  testWidgets('a stored key can be cleared on the channel page', (tester) async {
    SharedPreferences.setMockInitialValues({
      TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
    });
    _phone(tester);
    final keys = _Keys()..stored['c1'] = 'sk-old';
    await tester.pumpWidget(_app(keys, const TavernChannelEditPage(channel: _relay)));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-channel-key-clear')));
    await tester.pumpAndSettle();
    expect(find.text('Key 会在保存时清除'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-channel-save')));
    await tester.pumpAndSettle();
    expect(keys.stored, isEmpty);
  });

  testWidgets('a channel keeps the headers typed on its page; a malformed line is said', (tester) async {
    SharedPreferences.setMockInitialValues({
      TavernSettingsController.channelsKey: TavernChannel.listToJson([_relay]),
    });
    _phone(tester);
    await tester.pumpWidget(_app(_Keys(), TavernChannelEditPage(channel: _relay)));
    await tester.pumpAndSettle();
    // Saving pops this page, the only one here: hold on to the container.
    final container = _container(tester);
    final field = find.byKey(const ValueKey('tavern-channel-headers'));
    await _show(tester, field);
    await tester.enterText(field, 'not a header');
    await tester.tap(find.byKey(const ValueKey('tavern-channel-save')));
    await tester.pumpAndSettle();
    expect(find.text('每行写成「名称: 值」'), findsOneWidget);

    await tester.enterText(field, 'X-Title: 我的酒馆');
    await tester.tap(find.byKey(const ValueKey('tavern-channel-save')));
    await tester.pumpAndSettle();
    expect(container.read(tavernSettingsProvider).channels.single.headers, {'X-Title': '我的酒馆'});
  });
}
