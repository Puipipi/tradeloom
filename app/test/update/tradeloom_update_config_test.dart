// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'package:dsh_app/update/update_config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('TradeLoom cannot discover or download an official DSH Go release', () {
    final sources = tradeLoomUpdateSources();
    expect(sources.metadataEndpoints(), isEmpty);
    expect(sources.useGithubApi, isFalse);
    expect(sources.mirrors, isEmpty);
  });
}
