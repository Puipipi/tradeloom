// The brand mark and its lockup.
//
// - The generated glyph data (brand_glyph.g.dart) agrees with its own paths:
//   the ink box and the visual centre, re-measured on the drawn outlines.
// - The widget's sizes.
// - Lockups at the drawer's and the share card's sizes and at a larger text
//   scale, measured (brand_support.dart); the share card's tagline hangs under
//   the word.
// - One golden sheet per theme: every variant at the sizes the app draws.
//
//   flutter test test/shell/brand_mark_test.dart

import 'package:dsh_app/ui/share/share_card.dart';
import 'package:dsh_app/ui/shell/brand_glyph.g.dart';
import 'package:dsh_app/ui/shell/brand_mark.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../share/support.dart';
import 'brand_support.dart';
import 'golden_harness.dart';

/// Points every [step] grid units along every contour of [path].
List<List<Offset>> _outline(Path path, {double step = 0.02}) => [
  for (final metric in path.computeMetrics())
    [for (var d = 0.0; d < metric.length; d += step) metric.getTangentForOffset(d)!.position],
];

void main() {
  test('generated glyph data matches its paths', () {
    var area = 0.0;
    var cx = 0.0;
    var cy = 0.0;
    var box = Rect.zero;
    var first = true;
    for (final path in [BrandGlyph.body, BrandGlyph.bubble]) {
      for (final poly in _outline(path)) {
        for (var i = 0; i < poly.length; i++) {
          final a = poly[i];
          final b = poly[(i + 1) % poly.length];
          final k = a.dx * b.dy - b.dx * a.dy;
          area += k;
          cx += (a.dx + b.dx) * k;
          cy += (a.dy + b.dy) * k;
          final r = Rect.fromPoints(a, a);
          box = first ? r : box.expandToInclude(r);
          first = false;
        }
      }
    }
    area /= 2;
    final centroid = Offset(cx / (6 * area), cy / (6 * area));
    expect((centroid - BrandGlyph.centroid).distance, lessThan(0.02));
    expect(box.left, closeTo(BrandGlyph.box.left, 0.01));
    expect(box.top, closeTo(BrandGlyph.box.top, 0.01));
    expect(box.right, closeTo(BrandGlyph.box.right, 0.01));
    expect(box.bottom, closeTo(BrandGlyph.box.bottom, 0.01));
    expect(BrandGlyph.aspect, closeTo(BrandGlyph.box.width / BrandGlyph.box.height, 1e-5));
    // The fin and the belly lie on the silhouette.
    final body = BrandGlyph.body.getBounds();
    for (final layer in [BrandGlyph.fin, BrandGlyph.belly]) {
      final b = layer.getBounds();
      expect(b.left >= body.left - 1e-3 && b.right <= body.right + 1e-3, isTrue);
      expect(b.top >= body.top - 1e-3 && b.bottom <= body.bottom + 1e-3, isTrue);
    }
    // The glyph sits in the tile's visible square like the launcher's glyph.
    expect(BrandGlyph.tileBox.contains(BrandGlyph.box.topLeft), isTrue);
    expect(BrandGlyph.tileBox.contains(BrandGlyph.box.bottomRight), isTrue);
    // Visual centre: a little below the box's middle, near the middle across.
    expect(BrandMark.visualCentre.dy, inInclusiveRange(0.5, 0.65));
    expect((BrandMark.visualCentre.dx - 0.5).abs(), lessThan(0.05));
  });

  testWidgets('sizes: the glyph keeps its aspect, the tile is square', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildLightTheme(),
        home: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            BrandMark(key: ValueKey('glyph'), size: 40),
            BrandMark(key: ValueKey('mono'), size: 18, color: Colors.black),
            BrandMark(key: ValueKey('tile'), size: 52, tile: true),
          ],
        ),
      ),
    );
    expect(tester.getSize(find.byKey(const ValueKey('glyph'))), Size(40 * BrandMark.aspect, 40));
    expect(tester.getSize(find.byKey(const ValueKey('mono'))), Size(18 * BrandMark.aspect, 18));
    expect(tester.getSize(find.byKey(const ValueKey('tile'))), const Size(52, 52));
    final shift = BrandMark.opticalShift(40);
    expect(shift.dy, lessThan(0));
    expect(shift.dx.abs(), lessThan(40 * BrandMark.aspect * 0.05));
  });

  group('lockup', () {
    Future<void> pumpLockup(WidgetTester tester, BrandLockup lockup, {double textScale = 1}) async {
      await tester.runAsync(loadGoldenFonts);
      usePhoneSurface(tester);
      await tester.pumpWidget(
        goldenApp(
          brightness: Brightness.light,
          home: Builder(
            builder: (context) => MediaQuery(
              data: MediaQuery.of(context).copyWith(textScaler: TextScaler.linear(textScale)),
              child: Scaffold(body: Center(child: lockup)),
            ),
          ),
        ),
      );
      await tester.pump();
    }

    testWidgets('「DSH」 at the drawer\'s size: centred on the cap height', (tester) async {
      await pumpLockup(tester, const BrandLockup(height: 19));
      await expectBrandLockup(tester, find.byType(BrandLockup));
    });

    testWidgets('「dsh-go」 at the share card\'s size: centred on the x-height', (tester) async {
      await pumpLockup(tester, const BrandLockup(fontSize: 17, label: 'dsh-go'));
      await expectBrandLockup(tester, find.byType(BrandLockup));
    });

    testWidgets('follows the text scale', (tester) async {
      await pumpLockup(tester, const BrandLockup(height: 19), textScale: 1.3);
      await expectBrandLockup(tester, find.byType(BrandLockup));
      final glyph = tester.getSize(find.byType(BrandMark));
      expect(glyph.height, closeTo(19 * 0.95 * 1.3 * BrandLockup.glyphScale, 0.01));
    });

    for (final template in [ShareTemplate.light, ShareTemplate.dark, ShareTemplate.card]) {
      testWidgets('share card brand line (${template.name}): the tagline under the word', (tester) async {
        await tester.runAsync(loadGoldenFonts);
        tester.view.devicePixelRatio = 2;
        tester.view.physicalSize = const Size(ShareCard.width * 2, 2400 * 2);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildLightTheme(),
              locale: const Locale('zh', 'CN'),
              supportedLocales: const [Locale('zh', 'CN')],
              localizationsDelegates: GlobalMaterialLocalizations.delegates,
              home: Align(
                alignment: Alignment.topLeft,
                child: ShareCard(content: sampleReplyContent(), template: template),
              ),
            ),
          ),
        );
        await tester.pump();
        final word = await expectBrandLockup(tester, find.byType(BrandLockup));
        final tagline = tester.getRect(find.text('手机上的 DSH · 扫码获取'));
        expect(tagline.left, closeTo(word.left, 0.01));
        expect(tagline.top, greaterThanOrEqualTo(word.bottom));
      });
    }
  });

  for (final brightness in Brightness.values) {
    final mode = brightness == Brightness.dark ? 'dark' : 'light';
    testWidgets('sheet ($mode)', (tester) async {
      await tester.runAsync(loadGoldenFonts);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(390 * 2, 300 * 2);
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        goldenApp(
          brightness: brightness,
          home: Builder(
            builder: (context) {
              final colors = DshColors.of(context);
              Widget row(List<Widget> children) => Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: children,
              );
              return AppBackdrop(
                child: Material(
                  type: MaterialType.transparency,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 20),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        row(const [BrandMark(size: 18), BrandMark(size: 26), BrandMark(size: 40), BrandMark(size: 60)]),
                        row([
                          BrandMark(size: 18, color: colors.textDisabled),
                          const BrandMark(size: 26, color: Colors.white),
                          const BrandMark(size: 52, tile: true),
                          const BrandMark(size: 64, tile: true),
                        ]),
                        row(const [BrandLockup(height: 19), BrandLockup(fontSize: 17, label: 'dsh-go')]),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      );
      await tester.pump();
      await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/brand_mark_$mode.png'));
    });
  }
}
