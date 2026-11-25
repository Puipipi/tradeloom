// Goldens of the settings family's secondary pages that have no other home:
// diagnostics, background running, and the settings hub signed in to a
// DeepSeek account.
//
//   flutter test --update-goldens test/settings

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/runtime/runtime_state.dart';
import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/state/balance_state.dart';
import 'package:dsh_app/state/settings_state.dart';
import 'package:dsh_app/ui/settings/background_guide_page.dart';
import 'package:dsh_app/ui/settings/diagnostics_page.dart';
import 'package:dsh_app/ui/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../account/support.dart' show FixedAccount, sampleBalance, sampleProfile;
import '../shell/golden_harness.dart';
import '../support/english_preview.dart';

void main() {
  // English smoke golden (i18n): the settings hub, light.
  testWidgets('settings_signed_in (en)', (tester) async {
    useEnglish();
    await tester.runAsync(loadGoldenFonts);
    usePhoneSurface(tester);
    await tester.pumpWidget(
      goldenApp(
        home: inEnglish(
          ProviderScope(
            overrides: [accountWalletBalanceProvider.overrideWithValue(sampleBalance)],
            child: const SettingsScreen(),
          ),
        ),
        brightness: Brightness.light,
        overrides: [
          localRuntimeProvider.overrideWith(
            () => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus)),
          ),
          settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
          accountProvider.overrideWith(
            () =>
                FixedAccount(const AccountState(phase: AccountPhase.signedIn, connected: true, profile: sampleProfile)),
          ),
        ],
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/en_settings_signed_in_light.png'));
  });

  goldenBoth(
    'diagnostics',
    () => const DiagnosticsPage(),
    overrides: () => [
      localRuntimeProvider.overrideWith(
        () => FakeRuntime(const LocalRuntimeState(loaded: true, status: _runningCompatible)),
      ),
      localRuntimeLogsProvider.overrideWithBuild((ref, notifier) => sampleLogs),
      settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
    ],
  );

  goldenBoth(
    'background_guide',
    () => const BackgroundGuidePage(),
    overrides: () => [batteryExemptProvider.overrideWith((ref) async => false)],
    before: (tester) async {
      await tester.tap(find.text('小米 / Redmi（HyperOS、MIUI）'));
      await tester.pump(const Duration(milliseconds: 600));
    },
  );

  // The hub's overview card for a signed-in account: avatar, name, balance.
  goldenBoth(
    'settings_signed_in',
    // The harness pins the wallets to null at the root; this scope has them.
    () => ProviderScope(
      overrides: [accountWalletBalanceProvider.overrideWithValue(sampleBalance)],
      child: const SettingsScreen(),
    ),
    overrides: () => [
      localRuntimeProvider.overrideWith(
        () => FakeRuntime(const LocalRuntimeState(loaded: true, status: runningStatus)),
      ),
      settingsProvider.overrideWith(() => FakeSettings(const AppSettings(loaded: true))),
      accountProvider.overrideWith(
        () => FixedAccount(const AccountState(phase: AccountPhase.signedIn, connected: true, profile: sampleProfile)),
      ),
    ],
  );
}

/// [runningStatus] as the native side reports a running engine: the process
/// it observes, launched compatibly.
const _runningCompatible = RuntimeStatus(
  phase: RuntimePhase.running,
  abi: 'arm64-v8a',
  bundledVersion: 'r1-dsh0.2.0-rc.2-node24.22.1-ubuntu24.04.5-a45b1e8964a3',
  installedVersion: 'r1-dsh0.2.0-rc.2-node24.22.1-ubuntu24.04.5-a45b1e8964a3',
  dshVersion: '0.2.0-rc.2',
  nodeVersion: '24.22.1',
  baseUrl: 'http://127.0.0.1:3080',
  token: 'golden-token',
  currentExecutionMode: 'proot',
  launchSelectedMode: 'proot',
  launchSpawned: true,
);
