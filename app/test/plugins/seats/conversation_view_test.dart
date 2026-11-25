// A plugin's View of a conversation (`conversation.view`, rc.4;
// docs/design/plugin-ui-v3.md §3.3) opens in 对话详情 › 插件 as a page
// island: only with the bridge's occupancy (it is found by the name the
// occupancy reports), the route guard on this phone's engine, and room in
// the island budget. Every way it can't — no guard, no room, no bridge, no
// name, no ready within 12 s, the page giving up — is 「在网页版打开」, never
// an error and never Chat in the plugin's place.

import 'dart:io';

import 'package:dsh_app/plugins/seams/seams.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/ui/plugins/islands/islands.dart';
import 'package:dsh_app/ui/plugins/seats/plugin_seat_page.dart';
import 'package:dsh_app/ui/plugins/seats/session_plugins_tab.dart';
import 'package:dsh_app/ui/session/session_detail_page.dart';
import 'package:dsh_app/ui/web/web_target.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../../chat/support/harness.dart' as chat;
import '../../chat/support/run_info_fixture.dart';
import 'support.dart';

SlotOccupant _view(String cell, {String package = probe, String? label, bool official = false}) =>
    SlotOccupant(slot: Slots.conversationView, package: package, cell: cell, label: label, official: official);

/// The probe's 「记忆」 view beside the official Chat and Trajectory.
final _views = <String, List<SlotOccupant>>{
  Slots.conversationView: [
    _view('chat', package: '@deepseek-ai/dsh-client-ui-conversation', label: 'Chat', official: true),
    _view('trajectory', package: '@deepseek-ai/dsh-client-ui-trajectory', label: 'Trajectory', official: true),
    _view('memory', label: '记忆'),
  ],
};

final _viewsAndPanels = <String, List<SlotOccupant>>{
  ..._views,
  Slots.main: fullOccupancy[Slots.main]!,
  Slots.panelList: fullOccupancy[Slots.panelList]!,
};

SeatPlan _plan(List<Override> overrides) {
  final container = ProviderContainer(overrides: overrides);
  addTearDown(container.dispose);
  return container.read(sessionPluginPlanProvider('s1'));
}

Future<void> _pumpDetail(WidgetTester tester, {required List<Override> seats}) async {
  chat.usePhoneView(tester);
  chat.mockClipboard(tester);
  final harness = chat.ChatHarness(session: 's1', states: {'s1': runInfoState()});
  await tester.pumpWidget(
    chat.testApp(
      const SessionDetailPage(sessionId: 's1', initialTab: SessionTab.plugins),
      overrides: [...harness.overrides, ...seats],
    ),
  );
  await chat.pumpFrames(tester, 6);
}

void main() {
  setUp(openedWeb.clear);

  group('plan', () {
    test('a view is a page island in its conversation; the official views stay DSH Web\'s', () {
      final plan = _plan(seatOverrides(inventory: seatInventory(occupancy: _views)));
      final item = plan.visible.single;
      expect(item.occupant.cell, 'memory');
      expect(item.mode, SeatMode.island);
      final spec = item.island!;
      expect(spec.form, IslandForm.page);
      expect(spec.slot, Slots.conversationView);
      expect(spec.cell, 'memory');
      expect(spec.sessionId, 's1');
      expect(spec.maskOfficial, isFalse, reason: 'DSH Web shows one view at a time: nothing to hide');
    });

    test('no route guard on this phone\'s engine: 在网页版打开', () {
      final item = _plan(seatOverrides(inventory: seatInventory(occupancy: _views, routeGuard: false))).visible.single;
      expect(item.mode, SeatMode.webLink);
    });

    test('no room in the island budget: 在网页版打开', () {
      final item = _plan(
        seatOverrides(
          inventory: seatInventory(occupancy: _views),
          budget: const PickyBudget(webOnly: {probe}),
        ),
      ).visible.single;
      expect(item.mode, SeatMode.webLink);
    });

    test('without the bridge (Tier A) there is no name to find the view by: 在网页版打开', () {
      final inventory = SeatInventory(
        tier: ClientInventoryTier.boot,
        routeGuard: true,
        webReachable: true,
        packages: {probe: const PluginClientInfo(package: probe, hasClient: true, installed: true, enabled: true)},
        occupancy: _views,
      );
      expect(_plan(seatOverrides(inventory: inventory)).visible.single.mode, SeatMode.webLink);
    });

    test('views coexist with global panels without a conversation-specific tab', () {
      final plan = _plan(seatOverrides(inventory: seatInventory(occupancy: _viewsAndPanels)));
      expect(plan.visible.map((i) => (i.occupant.slot, i.occupant.cell)), [
        (Slots.conversationView, 'memory'),
        (Slots.main, 'k4-panel'),
        (Slots.main, 'pet-panel'),
      ]);
      expect(plan.visible.where((i) => i.mode == SeatMode.island).map((i) => i.island!.sessionId), ['s1', null]);
      expect(plan.visible.last.mode, SeatMode.webLink);
    });

    test('conversation-specific tabs retain priority over global panels beside views', () {
      final plan = _plan(
        seatOverrides(
          inventory: seatInventory(
            occupancy: {
              ..._viewsAndPanels,
              Slots.rightPaneTab: [occupant(Slots.rightPaneTab, probe, 'k4-tab')],
              Slots.rightPaneTabTitle: [occupant(Slots.rightPaneTabTitle, probe, 'k4-tab', label: '探针页签')],
            },
          ),
        ),
      );
      expect(plan.visible.map((i) => i.occupant.slot), [Slots.rightPaneTab, Slots.conversationView]);
    });
  });

  group('recipe', () {
    final book = IslandRecipeBook.parse(File('assets/islands/recipes.json').readAsStringSync());
    IslandSpec spec({String? cell = 'memory', String? session = 's1'}) => IslandSpec(
      host: HostRef.local,
      form: IslandForm.page,
      slot: Slots.conversationView,
      cell: cell,
      sessionId: session,
    );

    test('the conversation, then the view by its id and names; 12 s to show', () {
      expect(book.targetFor(spec(), labels: ['记忆', 'Memory']), {
        'session': 's1',
        'then': {
          'view': {
            'id': 'memory',
            'names': ['记忆', 'Memory'],
          },
        },
      });
      final recipe = book.recipeFor(Slots.conversationView)!;
      expect(recipe.ready, IslandTiming.viewReady);
      expect(IslandTiming.viewReady, const Duration(seconds: 12));
      expect(recipe.stretch, IslandStretch.child);
      expect(book.labels['moreViews'], ['更多会话视图', 'More conversation views']);
    });

    test('no name to find it by, no id or no conversation: no island (the seat falls back)', () {
      expect(book.targetFor(spec()), isNull);
      expect(book.targetFor(spec(cell: null), labels: ['记忆']), isNull);
      expect(book.targetFor(spec(session: null), labels: ['记忆']), isNull);
    });

    test('the other islands keep the measured 15 s', () {
      expect(book.recipeFor(Slots.rightPaneTab)!.ready, isNull);
      expect(IslandTiming.ready, const Duration(seconds: 15));
    });
  });

  group('对话详情', () {
    testWidgets('view and global panels open their own slot and scope, even with the same cell', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(
          inventory: seatInventory(
            occupancy: {
              ..._viewsAndPanels,
              Slots.conversationView: [_view('k4-panel', label: '记忆')],
            },
          ),
        ),
      );
      expect(tester.takeException(), isNull);
      expect(find.text('记忆'), findsOneWidget);
      expect(find.text('探针面板'), findsOneWidget);
      expect(find.text('桌宠面板'), findsOneWidget);
      expect(find.byType(FakeIsland), findsNothing, reason: 'the list waits for the user to choose a page');

      await tester.tap(find.text('桌宠面板'));
      expect(openedWeb.single, const DshWebTarget(sidebar: true));
      await tester.tap(find.text('探针面板'));
      await chat.pumpFrames(tester, 8);
      var page = tester.widget<PluginSeatPage>(find.byType(PluginSeatPage));
      expect(page.request.slot, Slots.main);
      expect(page.request.package, probe);
      expect(page.request.cell, 'k4-panel');
      expect(page.request.sessionId, isNull);
      expect(tester.widget<FakeIsland>(find.byType(FakeIsland)).spec.sessionId, isNull);

      await tester.tap(find.byTooltip('返回'));
      await chat.pumpFrames(tester, 8);
      await tester.tap(find.text('记忆'));
      await chat.pumpFrames(tester, 8);
      page = tester.widget<PluginSeatPage>(find.byType(PluginSeatPage));
      expect(page.request.slot, Slots.conversationView);
      expect(page.request.package, probe);
      expect(page.request.cell, 'k4-panel');
      expect(page.request.sessionId, 's1');
      expect(tester.widget<FakeIsland>(find.byType(FakeIsland)).spec.sessionId, 's1');
      expect(tester.takeException(), isNull);
    });

    testWidgets('views and panels keep web fallbacks when the route gate closes', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(inventory: seatInventory(occupancy: _viewsAndPanels, routeGuard: false)),
      );
      expect(find.byType(FakeIsland), findsNothing);
      expect(find.text('记忆'), findsOneWidget);
      expect(find.text('探针面板'), findsOneWidget);
      expect(find.text('桌宠面板'), findsOneWidget);
      await tester.tap(find.text('记忆'));
      await tester.tap(find.text('探针面板'));
      expect(openedWeb, [const DshWebTarget(sessionId: 's1'), const DshWebTarget(sidebar: true)]);
      expect(tester.takeException(), isNull);
    });

    testWidgets('one view fills 插件 under its name, as its island', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(inventory: seatInventory(occupancy: _views)),
      );
      expect(find.text('插件'), findsOneWidget);
      expect(find.text('记忆'), findsOneWidget);
      final spec = tester.widget<FakeIsland>(find.byType(FakeIsland)).spec;
      expect(spec.slot, Slots.conversationView);
      expect(spec.cell, 'memory');
      expect(find.text('Chat'), findsNothing);
    });

    testWidgets('an island that can\'t come up is 在网页版打开 into the conversation, not an error', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(
          inventory: seatInventory(occupancy: _views),
          renderers: testRenderers(island: (context, spec, items, fallback) => fallback(context)),
        ),
      );
      expect(find.byType(FakeIsland), findsNothing);
      expect(find.text('记忆'), findsOneWidget);
      await tester.tap(find.text('在网页版打开'));
      expect(openedWeb.single, const DshWebTarget(sessionId: 's1'));
      expect(tester.takeException(), isNull);
    });

    testWidgets('with a plugin tab: a list, the view opening a page of its own', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(
          inventory: seatInventory(
            occupancy: {
              ..._views,
              Slots.rightPaneTab: [occupant(Slots.rightPaneTab, probe, 'k4-tab')],
              Slots.rightPaneTabTitle: [occupant(Slots.rightPaneTabTitle, probe, 'k4-tab', label: '探针页签')],
            },
          ),
        ),
      );
      expect(find.text('探针页签'), findsOneWidget);
      expect(find.text('记忆'), findsOneWidget);
      await tester.tap(find.text('记忆'));
      await chat.pumpFrames(tester, 8);
      final page = tester.widget<PluginSeatPage>(find.byType(PluginSeatPage));
      expect(page.request.slot, Slots.conversationView);
      expect(page.request.cell, 'memory');
      expect(page.request.sessionId, 's1');
      expect(tester.widget<FakeIsland>(find.byType(FakeIsland)).spec.slot, Slots.conversationView);
    });

    testWidgets('only official views: no 插件 tab', (tester) async {
      await _pumpDetail(
        tester,
        seats: seatOverrides(
          inventory: seatInventory(
            occupancy: {Slots.conversationView: _views[Slots.conversationView]!.where((o) => o.official).toList()},
          ),
        ),
      );
      expect(find.text('插件'), findsNothing);
      expect(find.byType(SessionPluginsTab), findsNothing);
    });
  });
}
