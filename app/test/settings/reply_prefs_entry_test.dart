import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/share_code/guest_fs.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/settings/reply_prefs_page.dart';
import 'package:dsh_app/ui/settings/personalization_page.dart';
import 'package:dsh_app/ui/settings/settings_widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../phone/support.dart' show FixedActiveHost;
import '../share_code/support/fake_engine.dart' show tempGuest, writeGuest;
import '../shell/golden_harness.dart';

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  for (final host in [HostRef.local, const HostRef.ssh('pc'), const HostRef.relay('pc')]) {
    testWidgets('个性化 › 个人偏好 is local only: $host', (tester) async {
      final fs = tempGuest();
      addTearDown(() => fs.root.parent.deleteSync(recursive: true));
      writeGuest(fs, GuestFs.importedAgentsMd, '用中文回答。\n保留格式。');
      usePhoneSurface(tester);
      await tester.pumpWidget(
        goldenApp(
          home: const PersonalizationPage(),
          brightness: Brightness.light,
          overrides: [
            activeHostProvider.overrideWith(() => FixedActiveHost(host)),
            localRuntimeProvider.overrideWith(
              () => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus)),
            ),
            settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
            guestFsProvider.overrideWith((ref) async => fs),
          ],
        ),
      );
      await tester.pumpAndSettle();
      final entry = find.widgetWithText(SettingsTile, '个人偏好');
      expect(entry, host.isLocal ? findsOneWidget : findsNothing);
      if (!host.isLocal) return;
      expect(tester.widget<SettingsTile>(entry).subtitle, '用中文回答。');
      await tester.ensureVisible(entry);
      await tester.pumpAndSettle();
      expect(entry.hitTestable(), findsOneWidget);
      await tester.tap(entry);
      await tester.pumpAndSettle();
      expect(find.byType(ReplyPrefsPage), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('reply-prefs-input')), '回答简短。');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('reply-prefs-save')));
      await tester.pumpAndSettle();
      expect(find.byType(ReplyPrefsPage), findsNothing);
      expect(tester.widget<SettingsTile>(find.widgetWithText(SettingsTile, '个人偏好')).subtitle, '回答简短。');
    });
  }
}
