import 'package:flutter_test/flutter_test.dart';

import '../../lib/ui/tradeloom/tradeloom_attachment.dart';

void main() {
  final origin = Uri.parse('https://portal.example');
  const workflow = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const version = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const path = '/enterprise/deliveries/$workflow/$version/download';

  test('intercepts only the portal delivery attachment in the main frame', () {
    expect(
      tradeLoomAttachmentUri(
        origin,
        '${origin.origin}$path',
        isMainFrame: true,
      ),
      isNotNull,
    );
    expect(
      tradeLoomAttachmentUri(
        origin,
        '${origin.origin}$path',
        isMainFrame: false,
      ),
      isNull,
    );
    for (final url in [
      'https://external.example$path',
      'https://portal.example:444$path',
      '${origin.origin}$path?extra=1',
      '${origin.origin}$path#fragment',
      '${origin.origin}${path.replaceFirst('/download', '/preview')}',
      '${origin.origin}/enterprise/workbooks/$version/download/',
      '${origin.origin}/enterprise/workflows/',
    ]) {
      expect(
        tradeLoomAttachmentUri(origin, url, isMainFrame: true),
        isNull,
        reason: url,
      );
    }
  });
}
