// Screenshots of the main screens at the four review widths (a landscape
// phone, 600, 840, 1280) for visual review. Writes PNGs and
// compares nothing; skipped unless an output folder is given:
//
//   flutter test test/landscape/capture --dart-define=LANDSCAPE_OUT=/abs/dir
//
// The goldens that guard the result live next to the screens' own tests
// (test/landscape/landscape_golden_test.dart and friends); this is the
// before / after camera.

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/chat_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/chat/chat_screen.dart';
import 'package:dsh_app/ui/chat/model_sheet.dart' show ModelChip;
import 'package:dsh_app/ui/chat/usage_sheet.dart' show ContextRing;
import 'package:dsh_app/ui/chat/widgets/whale_tail.dart' show WhaleSprites;
import 'package:dsh_app/ui/cordis/cordis_page.dart';
import 'package:dsh_app/ui/engine/engine_screen.dart';
import 'package:dsh_app/ui/features/all_features_page.dart';
import 'package:dsh_app/ui/files/files_page.dart';
import 'package:dsh_app/ui/onboarding/api_key_page.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/onboarding/runtime_setup_page.dart';
import 'package:dsh_app/ui/onboarding/welcome_page.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:dsh_app/ui/session/session_detail_page.dart';
import 'package:dsh_app/ui/settings/settings_screen.dart';
import 'package:dsh_app/ui/terminal/terminal_page.dart';
import 'package:dsh_app/ui/remote/remote_screen.dart';
import 'package:dsh_app/state/session_search.dart';
import 'package:dsh_app/state/update_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_app/ui/bots/bot_sheets.dart' show confirmDelete;
import 'package:dsh_app/ui/replay/replay_page.dart';
import 'package:dsh_app/ui/share/share_panel.dart';
import 'package:dsh_app/ui/shell/session_search_page.dart';
import 'package:dsh_app/ui/update/update_sheet.dart';
import 'package:dsh_app/update/release.dart';
import 'package:dsh_app/update/version.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../chat/support/harness.dart' hide fakeConnection;
import '../../chat/support/sample_chat.dart';
import '../../cordis/support.dart';
import '../../files/support/files_harness.dart';
import '../../phone/harness.dart';
import '../../phone/support.dart' show FakePhoneNative, PhoneTestRuntime, runningRuntime;
import '../../shell/adaptive/support.dart';
import '../../shell/golden_harness.dart';
import '../../replay/support/rich_conversation.dart';
import '../../search/support.dart';
import '../../share/support.dart' show firstReply, shareChatState;
import '../../terminal/support.dart';
import '../support.dart';

const _out = String.fromEnvironment('LANDSCAPE_OUT');

/// The whole view → `$_out/<name>.png` at 1.5× logical.
Future<void> shoot(WidgetTester tester, String name) async {
  await tester.pump();
  await tester.runAsync(() async {
    final view = RendererBinding.instance.renderViews.first;
    final layer = view.debugLayer! as OffsetLayer;
    final dpr = view.configuration.devicePixelRatio;
    final image = await layer.toImage(view.paintBounds, pixelRatio: 1.5 / dpr);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('$_out/$name.png');
    file.parent.createSync(recursive: true);
    file.writeAsBytesSync(data!.buffer.asUint8List());
    image.dispose();
  });
}

/// One screen at every window (or [only]).
void capture(
  String name,
  Widget Function(Win win) app, {
  Future<void> Function(WidgetTester tester, Win win)? before,
  Iterable<String>? only,
  double keyboard = 0,
  int frames = 8,
}) {
  for (final win in wins) {
    if (only != null && !only.contains(win.name)) continue;
    testWidgets('$name ${win.name}', (tester) async {
      useWin(tester, win, keyboard: keyboard);
      mockClipboard(tester);
      await tester.pumpWidget(app(win));
      await pumpFrames(tester, frames);
      if (before != null) await before(tester, win);
      await shoot(tester, '${name}_${win.name}');
    }, skip: _out.isEmpty);
  }
}

const _key = 'sk-4c1f0e7b9a2d4e6f8a1b3c5d7e9fa3f9';

List<Override> _shellOverrides() => [
  localRuntimeProvider.overrideWith(() => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus))),
  settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true, apiKey: _key))),
];

Widget _golden(Widget home, {List<Override> overrides = const []}) =>
    goldenApp(home: home, brightness: Brightness.light, overrides: overrides);

void main() {
  setUpAll(() async {
    await loadTestFonts();
    await WhaleSprites.load();
  });
  setUp(() {
    SharedPreferences.setMockInitialValues({});
    freezeClocks();
  });
  tearDown(thawClocks);

  // ── Home: chat, drawer, rail, panel ──────────────────────────────────────
  capture('chat_run', (_) => homeApp());
  capture(
    'chat_approval',
    (_) => homeApp(chat: (id) => id == 's1' ? conversationState() : const ChatState(loading: false)),
  );
  capture('chat_empty', (_) => homeApp(session: null));
  capture(
    'chat_keyboard',
    (_) => homeApp(),
    keyboard: 200,
    only: const ['phone'],
    before: (tester, _) async {
      await tester.tap(find.byType(EditableText).first);
      await pumpFrames(tester, 4);
    },
  );
  capture(
    'drawer',
    (_) => homeApp(),
    before: (tester, win) async {
      final menu = find.byTooltip('对话列表');
      final rail = find.byKey(const ValueKey('rail-menu'));
      if (menu.evaluate().isNotEmpty) {
        await tester.tap(menu.first);
      } else if (rail.evaluate().isNotEmpty) {
        await tester.tap(rail);
      } else {
        await tester.tap(find.byKey(const ValueKey('chat-menu')));
      }
      await pumpFrames(tester, 8);
    },
  );
  capture(
    'drawer_scrolled',
    (_) => homeApp(),
    only: const ['phone'],
    before: (tester, win) async {
      await tester.tap(find.byKey(const ValueKey('chat-menu')));
      await pumpFrames(tester, 8);
      await tester.drag(find.text('给设置页加深色模式').last, const Offset(0, -240));
      await pumpFrames(tester, 8);
    },
  );
  capture(
    'session_detail',
    (_) => homeApp(),
    before: (tester, _) async {
      SessionDetailPage.open(tester.element(find.byType(ChatScreen)), 's1');
      await pumpFrames(tester, 8);
    },
  );
  capture(
    'model_sheet',
    (_) => homeApp(),
    before: (tester, _) async {
      await tester.tap(find.byType(ModelChip));
      await pumpFrames(tester, 8);
    },
  );
  capture(
    'usage_sheet',
    (_) => homeApp(),
    before: (tester, _) async {
      await tester.tap(find.byType(ContextRing));
      await pumpFrames(tester, 10);
    },
  );

  // ── Secondary pages ──────────────────────────────────────────────────────
  capture('settings', (_) => _golden(const SettingsScreen(), overrides: _shellOverrides()));
  capture(
    'settings_scrolled',
    (_) => _golden(const SettingsScreen(), overrides: _shellOverrides()),
    before: (tester, _) async {
      await tester.drag(find.byType(Scrollable).first, const Offset(0, -260));
      await pumpFrames(tester, 4);
    },
  );
  capture('all_features', (_) => _golden(const AllFeaturesPage(), overrides: _shellOverrides()));
  capture('engine', (_) => _golden(const EngineScreen(), overrides: _shellOverrides()));
  capture('remote', (_) => _golden(const RemoteScreen(), overrides: _shellOverrides()));
  capture(
    'files',
    (_) => filesApp(const WorkspaceFilesPage(sessionId: 's1', now: _now), sampleWorkspace()),
    frames: 12,
  );
  capture('phone_control', (_) {
    FakePhoneNative().install();
    return goldenApp(
      home: const PhoneControlScreen(),
      brightness: Brightness.light,
      overrides: phoneOverrides(PhoneTestRuntime(const LocalRuntimeState(loaded: true, status: runningRuntime))),
    );
  }, before: (tester, _) => settlePhone(tester));
  capture(
    'terminal',
    (_) => goldenApp(
      home: const TerminalPage(sessionId: 's1'),
      brightness: Brightness.light,
      overrides: terminalOverrides(FakeTerminalBackend()..createdScreen = sampleScreen),
    ),
    before: (tester, _) => settleTerminal(tester),
  );
  capture(
    'cordis',
    (_) => goldenApp(home: const CordisPage(), brightness: Brightness.light, overrides: cordisOverrides()),
  );

  // ── Sheets, dialogs, replay ──────────────────────────────────────────────
  capture('share_panel', (_) {
    final state = shareChatState();
    return testApp(
      _Launcher(
        (context) => showSharePanel(context, ConversationSubject(sessionId: 's1', reply: firstReply(state))),
      ),
      overrides: [chatProvider.overrideWith2((id) => FakeChatController(id, state))],
    );
  }, before: _tapOpen);
  capture(
    'update_sheet',
    (_) => _golden(
      _Launcher(showUpdateSheet),
      overrides: [..._shellOverrides(), appUpdateProvider.overrideWith(_Update.new)],
    ),
    before: _tapOpen,
  );
  capture(
    'confirm_dialog',
    (_) => testApp(_Launcher((context) => confirmDelete(context, title: '删除这个任务？', body: '删除后不能恢复，历史记录也会一起清掉。'))),
    before: _tapOpen,
  );
  capture('replay', (_) {
    final asset = richAsset();
    return testApp(
      ReplayPage(share: richConversation(), assets: {asset.id: asset}, autoplay: false, preview: false),
      overrides: [settingsProvider.overrideWith(() => TestSettings())],
    );
  });
  capture(
    'session_search',
    (_) => _golden(
      SessionSearchPage(now: searchNow),
      overrides: [
        sessionsProvider.overrideWith(() => SearchSessions(sampleSearchSessions(), sampleArchivedSessions())),
        sessionContentSearchProvider.overrideWithValue(
          FakeContentSearch(results: {'登录': (items: loginHits, hasMore: false)}),
        ),
        currentSessionProvider.overrideWith(() => FakeCurrentSession('s2')),
      ],
    ),
  );

  // ── Onboarding ───────────────────────────────────────────────────────────
  capture('welcome', (_) => _golden(WelcomePage(onStart: () {})));
  capture(
    'setup',
    (_) => _golden(
      OnboardingProgress(step: 1, steps: 2, child: RuntimeSetupPage(onDone: () {})),
      overrides: [
        localRuntimeProvider.overrideWith(
          () => FakeRuntime(
            const LocalRuntimeState(
              loaded: true,
              status: RuntimeStatus(phase: RuntimePhase.installing, bundledVersion: 'r1'),
              progress: RuntimeProgressEvent(step: 'extract', done: 48234496, total: 120586240),
            ),
          ),
        ),
      ],
    ),
  );
  capture(
    'api_key',
    (_) => _golden(
      OnboardingProgress(step: 2, steps: 2, child: ApiKeyPage(onDone: () {})),
      overrides: [settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true)))],
    ),
  );
  capture(
    'api_key_focused',
    (_) => _golden(
      OnboardingProgress(step: 2, steps: 2, child: ApiKeyPage(onDone: () {})),
      overrides: [settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true)))],
    ),
    keyboard: 200,
    only: const ['phone'],
    before: (tester, win) async {
      await tester.showKeyboard(find.byType(EditableText).first);
      await pumpFrames(tester, 8);
    },
  );
  capture(
    'api_key_keyboard',
    (_) => _golden(
      OnboardingProgress(step: 2, steps: 2, child: ApiKeyPage(onDone: () {})),
      overrides: [settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true)))],
    ),
    keyboard: 200,
    only: const ['phone'],
  );
}

/// A page with one button that runs [open] (sheets and dialogs).
class _Launcher extends StatelessWidget {
  const _Launcher(this.open);

  final void Function(BuildContext context) open;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Builder(
        builder: (context) => TextButton(onPressed: () => open(context), child: const Text('open')),
      ),
    ),
  );
}

Future<void> _tapOpen(WidgetTester tester, Win _) async {
  await tester.tap(find.text('open'));
  await pumpFrames(tester, 8);
}

/// An update on offer (the fixture release), nothing downloading.
class _Update extends AppUpdateController {
  @override
  AppUpdateState build() {
    final release = parseGithubRelease(jsonDecode(File('test/update/fixtures/github_release.json').readAsStringSync()));
    return AppUpdateState(
      loaded: true,
      current: AppVersion.tryParse('1.0.0+1')!,
      flavor: ApkFlavor.arm64,
      check: UpdateCheckPhase.available,
      latest: release,
      total: release.apkFor(ApkFlavor.arm64)!.size,
    );
  }

  @override
  Future<void> get ready async {}
}

DateTime _now() => DateTime(2026, 10, 24, 15, 0);
