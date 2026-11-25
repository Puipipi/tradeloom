import 'package:dsh_app/ui/chat/render/mermaid_preview.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Mermaid only loads scripts from its declared CDN origins', () {
    final html = mermaidHtml('graph TD; A-->B', dark: false, background: Colors.white, foreground: Colors.black);
    expect(html, contains('http-equiv="Content-Security-Policy"'));
    final policy = RegExp('content="(default-src[^"]+)"').firstMatch(html)!.group(1)!;
    expect(policy, contains("default-src 'none'"));
    expect(policy, contains("style-src 'unsafe-inline'"));
    expect(policy, contains('img-src data:'));
    expect(policy, contains('font-src data:'));
    final scripts = policy.split(';').singleWhere((part) => part.trim().startsWith('script-src'));
    for (final url in mermaidScriptUrls) {
      expect(scripts, contains(Uri.parse(url).origin));
    }
    expect(scripts, isNot(contains('*')));
    expect(scripts, isNot(contains('unsafe-eval')));
  });
}
