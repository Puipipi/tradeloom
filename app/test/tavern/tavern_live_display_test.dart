import 'dart:async';

import 'package:dsh_app/ui/tavern/tavern_live_display.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter_test/flutter_test.dart';

/// A display pass that hides a status block, answering when [answer]ed.
class _Passes {
  final calls = <String>[];
  final _pending = <Completer<TavernDisplayResult>>[];

  Future<TavernDisplayResult> call(String text) {
    calls.add(text);
    final done = Completer<TavernDisplayResult>();
    _pending.add(done);
    return done.future;
  }

  /// Answers the oldest pass: [text] rewritten, or [superseded], or failed.
  void answer({bool superseded = false, bool fail = false}) {
    final done = _pending.removeAt(0);
    final text = calls[calls.length - _pending.length - 1];
    if (fail) {
      done.completeError(StateError('worker gone'));
    } else {
      final shown = text.replaceAll(RegExp(r'<status>[\s\S]*?(</status>|$)'), '');
      done.complete(TavernDisplayResult(text: shown, superseded: superseded));
    }
  }
}

void main() {
  testWidgets('the first piece is passed at once; the next ones wait a beat and go as one', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '门';
    expect(passes.calls, ['门']);
    passes.answer();
    await tester.pump();

    live.text = '门开';
    live.text = '门开了';
    await tester.pump(const Duration(milliseconds: 60));
    expect(passes.calls, ['门']);
    await tester.pump(const Duration(milliseconds: 60));
    expect(passes.calls, ['门', '门开了']);
    passes.answer();
    await tester.pump(const Duration(milliseconds: 200));
    // Nothing new, nothing passed again.
    expect(passes.calls, ['门', '门开了']);
    live.dispose();
  });

  testWidgets('while a pass is out, the next waits for it', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '门';
    live.text = '门开了';
    await tester.pump(const Duration(milliseconds: 300));
    expect(passes.calls, ['门']);
    passes.answer();
    await tester.pump();
    expect(passes.calls, ['门', '门开了']);
    passes.answer();
    await tester.pump();
    live.dispose();
  });

  testWidgets('the text shows as it comes until a pass rewrites it; then the pass shows', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '她笑了。';
    expect(live.shown, '她笑了。');
    passes.answer();
    await tester.pump();
    live.text = '她笑了。<status>心情：好';
    // The last pass changed nothing: no waiting for this one.
    expect(live.shown, '她笑了。<status>心情：好');

    await tester.pump(const Duration(milliseconds: 120));
    passes.answer();
    await tester.pump();
    expect(live.shown, '她笑了。');
    live.text = '她笑了。<status>心情：好</status>';
    // A beat behind, but the block never shows raw.
    expect(live.shown, '她笑了。');
    await tester.pump(const Duration(milliseconds: 120));
    passes.answer();
    await tester.pump();
    expect(live.shown, '她笑了。');
    live.dispose();
  });

  testWidgets('a superseded result is dropped, and the same text is not passed again', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '<status>x</status>门';
    passes.answer(superseded: true);
    await tester.pump(const Duration(milliseconds: 500));
    expect(live.shown, '<status>x</status>门');
    expect(passes.calls, hasLength(1));
    live.dispose();
  });

  testWidgets('a pass that fails leaves the text as written for the rest of the reply', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '<status>x</status>门';
    passes.answer(fail: true);
    await tester.pump();
    live.text = '<status>x</status>门开了';
    await tester.pump(const Duration(milliseconds: 500));
    expect(passes.calls, hasLength(1));
    expect(live.shown, '<status>x</status>门开了');
    live.dispose();
  });

  testWidgets('a pass for the last reply, answering late, is not taken for this one', (tester) async {
    final passes = _Passes();
    final live = TavernLiveDisplay(passes.call);

    live.text = '<status>旧</status>上一条';
    live.reset();
    passes.answer();
    await tester.pump();
    expect(live.shown, '');

    // The new reply is passed at once, not after the old one's beat.
    live.text = '新的一条';
    expect(passes.calls.last, '新的一条');
    passes.answer();
    await tester.pump();
    expect(live.shown, '新的一条');
    live.dispose();
  });
}
