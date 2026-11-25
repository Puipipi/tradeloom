import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_app/usage/usage_net.dart';

void main() {
  group('usageBuildActive', () {
    test('TradeLoom never enables DSH Go product telemetry', () {
      expect(
        usageBuildActive(
          releaseMode: true,
          tradeLoomBuild: true,
          endpointOverride: '',
        ),
        isFalse,
      );
      expect(
        usageBuildActive(
          releaseMode: false,
          tradeLoomBuild: true,
          endpointOverride: 'https://stats.example.invalid',
        ),
        isFalse,
      );
    });

    test('DSH Go release and explicit debug fixture behavior remains', () {
      expect(
        usageBuildActive(
          releaseMode: true,
          tradeLoomBuild: false,
          endpointOverride: '',
        ),
        isTrue,
      );
      expect(
        usageBuildActive(
          releaseMode: false,
          tradeLoomBuild: false,
          endpointOverride: 'https://stats.example.invalid',
        ),
        isTrue,
      );
      expect(
        usageBuildActive(
          releaseMode: false,
          tradeLoomBuild: false,
          endpointOverride: '',
        ),
        isFalse,
      );
    });
  });
}
