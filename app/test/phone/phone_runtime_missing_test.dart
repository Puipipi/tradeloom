// Phone control on a phone without the on-device runtime: the status line
// says the runtime comes first, not 「引擎启动后生效」 (it never would).

import 'package:dsh_app/runtime/runtime_bridge.dart';
import 'package:dsh_app/ui/phone/phone_control_screen.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';

const _missing = RuntimeStatus(
  phase: RuntimePhase.notInstalled,
  bundledVersion: 'r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2',
  abi: 'arm64-v8a',
);

const _stopped = RuntimeStatus(
  phase: RuntimePhase.installed,
  bundledVersion: 'r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2',
  installedVersion: 'r5-dsh0.2.1-rc.2-node24.22.1-ubuntu24.04.5-b3f6c96ee2f2',
  abi: 'arm64-v8a',
);

void main() {
  testWidgets('no runtime: points at installing it', (tester) async {
    await pumpPhone(tester, const PhoneControlScreen(), engine: _missing);
    expect(find.text('安装本机运行环境后可用'), findsOneWidget);
    expect(find.text('引擎启动后生效'), findsNothing);
  });

  testWidgets('installed but stopped: still waits for the engine', (tester) async {
    await pumpPhone(tester, const PhoneControlScreen(), engine: _stopped);
    expect(find.text('引擎启动后生效'), findsOneWidget);
    expect(find.text('安装本机运行环境后可用'), findsNothing);
  });
}
