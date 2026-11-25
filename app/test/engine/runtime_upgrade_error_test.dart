import 'package:dsh_app/l10n/l10n.dart';
import 'package:dsh_app/ui/engine/engine_status.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  tearDown(() => AppLocale.use(AppLocale.zhCN));

  test('upgrade failures explain preservation and backup in both languages', () {
    for (final locale in [AppLocale.zhCN, AppLocale.en]) {
      AppLocale.use(locale);
      expect(humanizeRuntimeError('install failed: runtime_upgrade_blocked:base'), appL10n.phoneRuntimeUpgradeBase);
      for (final reason in ['transaction', 'legacy_interrupted']) {
        expect(
          humanizeRuntimeError('install failed: runtime_upgrade_blocked:$reason'),
          appL10n.phoneRuntimeUpgradeInterrupted,
        );
      }
      expect(
        humanizeRuntimeError('install failed: runtime_upgrade_blocked:symlink'),
        appL10n.phoneRuntimeUpgradeSymlink,
      );
      expect(
        humanizeRuntimeError('install failed: runtime_upgrade_blocked:running'),
        appL10n.phoneRuntimeUpgradeRunning,
      );
    }
  });

  test('unrecognized upgrade details are not echoed into UI', () {
    expect(
      humanizeRuntimeError('install failed: runtime_upgrade_blocked:private-path-token-fixture'),
      appL10n.phoneRuntimeUpgradeManifest,
    );
    expect(humanizeRuntimeError('install failed: unknown native message'), isNull);
  });
}
