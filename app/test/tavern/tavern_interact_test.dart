import 'dart:async';

import 'package:dsh_app/tavern/tavern_interact.dart';
import 'package:dsh_app/ui/tavern/tavern_interact_view.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/test_fonts.dart';

const _submitted = TavernInteractStatus.submitted;
const _cancelled = TavernInteractStatus.cancelled;
const _dismissed = TavernInteractStatus.dismissed;

/// A page to ask from; [ask] runs with its context, the answer kept.
Future<Future<TavernInteractAnswer>> _ask(
  WidgetTester tester,
  TavernInteractKind kind,
  Map<String, Object?> fields, {
  Future<void>? withdraw,
  ValueChanged<String>? onSetInput,
}) async {
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: withTestFonts(buildLightTheme()),
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      home: const Scaffold(body: SizedBox.expand()),
    ),
  );
  final context = tester.element(find.byType(SizedBox).last);
  final answer = showTavernInteract(context, kind, fields, withdraw: withdraw, onSetInput: onSetInput);
  await tester.pumpAndSettle();
  return answer;
}

void main() {
  setUpAll(loadTestFonts);

  group('reading a request', () {
    test('fields take the contract defaults; HTML for the dialogs, plain for echo', () {
      final input = TavernInteractFields.of(TavernInteractKind.input, {'text': 'Name?'});
      expect(
        (input.html, input.markdown, input.defaultValue, input.rows, input.wide, input.large, input.okButton),
        (true, false, '', 4, false, false, null),
      );
      final echo = TavernInteractFields.of(TavernInteractKind.echo, {'text': '<b>x</b>'});
      expect((echo.html, echo.shown, echo.severity, echo.awaitDismissal), (false, '<b>x</b>', 'info', false));
      final popup = TavernInteractFields.of(TavernInteractKind.popup, {
        'text': 'a',
        'textKind': 'plain',
        'scroll': false,
        'title': '  ',
        'okButton': '',
        'rows': 0,
      });
      expect((popup.html, popup.scroll, popup.title, popup.okButton, popup.rows), (false, false, null, null, 4));
      final buttons = TavernInteractFields.of(TavernInteractKind.buttons, {
        'text': 'Pick',
        'buttonLabels': ['A', ' ', 'A'],
      });
      expect(buttons.buttonLabels, ['A', ' ', 'A']);
      expect(tavernInteractKind('setInput'), TavernInteractKind.setInput);
      expect(tavernInteractKind('setinput'), isNull);
    });

    test('HTML reads as its words: blocks on lines, scripts gone, nothing run', () {
      expect(
        tavernInteractPlain(
          '<h3>Title</h3><p>One  &amp; <b>two</b></p><script>alert(1)</script><style>p{}</style>'
          '<ul><li>a</li><li>b</li></ul>line<br>next<img src=x onerror="x()">',
        ),
        'Title\n\nOne & two\n\n• a\n\n• b\n\nline\nnext',
      );
      expect(tavernInteractPlain('a < b and c > d'), 'a < b and c > d');
    });

    test('an answer reads as the contract writes it', () {
      expect(const TavernInteractAnswer(_submitted, text: '').toJson(), {'status': 'submitted', 'text': ''});
      expect(const TavernInteractAnswer(_submitted, buttonIndex: 2, label: 'A').toJson(), {
        'status': 'submitted',
        'buttonIndex': 2,
        'label': 'A',
      });
      expect(const TavernInteractAnswer(_dismissed).toJson(), {'status': 'dismissed'});
    });
  });

  testWidgets('/input: its words, the box with its default; OK sends what is written, empty too', (tester) async {
    final answer = await _ask(tester, TavernInteractKind.input, {
      'text': '<p>你叫什么？</p>',
      'defaultValue': '旅人',
      'rows': 1,
      'okButton': '就这个',
    });
    expect(find.text('你叫什么？'), findsOneWidget);
    expect(find.text('就这个'), findsOneWidget);
    expect(find.text('旅人'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('tavern-interact-field')), '');
    await tester.tap(find.byKey(const ValueKey('tavern-interact-ok')));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_submitted, text: ''));
    expect(find.byKey(const ValueKey('tavern-interact-input')), findsNothing);
  });

  testWidgets('/input: 取消 is cancelled, a tap beside it dismissed; the app word for OK', (tester) async {
    var answer = await _ask(tester, TavernInteractKind.input, {'text': 'x'});
    expect(find.text('确认'), findsOneWidget);
    // Four rows by default.
    expect(tester.widget<TextField>(find.byKey(const ValueKey('tavern-interact-field'))).minLines, 4);
    await tester.tap(find.byKey(const ValueKey('tavern-interact-cancel')));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_cancelled));

    answer = await _ask(tester, TavernInteractKind.input, {'text': 'x'});
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_dismissed));
  });

  testWidgets('/buttons: each label as given, blank and repeated ones too; the one tapped answers', (tester) async {
    final answer = await _ask(tester, TavernInteractKind.buttons, {
      'text': '去哪？',
      'buttonLabels': ['酒馆', ' ', '酒馆'],
    });
    for (var i = 0; i < 3; i++) {
      expect(find.byKey(ValueKey('tavern-interact-button-$i')), findsOneWidget);
    }
    // The blank one is as tall as the others.
    expect(
      tester.getSize(find.byKey(const ValueKey('tavern-interact-button-1'))).height,
      tester.getSize(find.byKey(const ValueKey('tavern-interact-button-0'))).height,
    );
    await tester.tap(find.byKey(const ValueKey('tavern-interact-button-2')));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_submitted, buttonIndex: 2, label: '酒馆'));
  });

  testWidgets('/popup: title and words; OK submits, put aside dismisses; Markdown when asked', (tester) async {
    var answer = await _ask(tester, TavernInteractKind.popup, {'text': '<p>雨停了。</p>', 'title': '天气'});
    expect(find.text('天气'), findsOneWidget);
    expect(find.text('雨停了。'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('tavern-interact-ok')));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_submitted));

    answer = await _ask(tester, TavernInteractKind.popup, {
      'text': '**重要**',
      'textKind': 'html',
      'renderMarkdown': true,
    });
    expect(find.textContaining('**'), findsNothing);
    expect(find.textContaining('重要', findRichText: true), findsWidgets);
    await tester.tapAt(const Offset(10, 10));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_dismissed));
  });

  testWidgets('withdrawn while open (the script stopped): closed, answered cancelled', (tester) async {
    final withdraw = Completer<void>();
    final answer = await _ask(tester, TavernInteractKind.buttons, {
      'text': '选',
      'buttonLabels': ['A'],
    }, withdraw: withdraw.future);
    expect(find.byKey(const ValueKey('tavern-interact-buttons')), findsOneWidget);
    withdraw.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-interact-buttons')), findsNothing);
    expect(await answer, const TavernInteractAnswer(_cancelled));
  });

  testWidgets('withdrawn before it was drawn: it does not stay up', (tester) async {
    final answer = await _ask(tester, TavernInteractKind.input, {'text': '名字？'}, withdraw: Future<void>.value());
    expect(find.byKey(const ValueKey('tavern-interact-input')), findsNothing);
    expect(await answer, const TavernInteractAnswer(_cancelled));
  });

  testWidgets('/echo: the app notice, answered with its words at once', (tester) async {
    final answer = await _ask(tester, TavernInteractKind.echo, {'text': '存好了', 'severity': 'success', 'title': '存档'});
    expect(await answer, const TavernInteractAnswer(_submitted, text: '存好了'));
    expect(find.byKey(const ValueKey('tavern-interact-echo')), findsOneWidget);
    expect(find.text('存档'), findsOneWidget);
    expect(find.text('存好了'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tavern-interact-echo')), findsNothing);
  });

  testWidgets('/echo awaiting dismissal: answered when it goes, dismissed if put away', (tester) async {
    var settled = false;
    final answer = await _ask(tester, TavernInteractKind.echo, {'text': '读完再走', 'awaitDismissal': true});
    unawaited(answer.then((_) => settled = true));
    await tester.pump();
    expect(settled, isFalse);
    await tester.tap(find.text('读完再走'));
    await tester.pumpAndSettle();
    expect(await answer, const TavernInteractAnswer(_dismissed, text: '读完再走'));

    final timed = await _ask(tester, TavernInteractKind.echo, {'text': '等它走', 'awaitDismissal': true});
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(await timed, const TavernInteractAnswer(_submitted, text: '等它走'));
  });

  testWidgets('/setinput: into the composer, its words the answer; nowhere to put them, cancelled', (tester) async {
    String? composer;
    final answer = await _ask(tester, TavernInteractKind.setInput, {
      'text': '/roll 1d20',
    }, onSetInput: (t) => composer = t);
    expect(await answer, const TavernInteractAnswer(_submitted, text: '/roll 1d20'));
    expect(composer, '/roll 1d20');
    final nowhere = await _ask(tester, TavernInteractKind.setInput, {'text': 'x'});
    expect(await nowhere, const TavernInteractAnswer(_cancelled));
  });
}
