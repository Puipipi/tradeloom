// The 玩法包 pages against a stand-in engine: install, a scope's edits as
// one batch on its snapshot, and the two-step export taking exactly what
// was previewed.

import 'dart:async';
import 'dart:typed_data';

import 'package:dsh_app/tavern/tavern_preview.dart';
import 'package:dsh_app/tavern/tavern_provider.dart';
import 'package:dsh_app/ui/settings/settings_widgets.dart';
import 'package:dsh_app/ui/shell/page_frame.dart';
import 'package:dsh_app/ui/tavern/tavern_chat_files.dart';
import 'package:dsh_app/ui/tavern/tavern_pack_bindings_page.dart';
import 'package:dsh_app/ui/tavern/tavern_pack_export_page.dart';
import 'package:dsh_app/ui/tavern/tavern_packs_page.dart';
import 'package:dsh_app/ui/tavern/tavern_widgets.dart';
import 'package:dsh_app/ui/theme/theme.dart';
import 'package:dsh_tavern/dsh_tavern.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/test_fonts.dart';

const _revision = TavernGameplayRevision(domainId: 'd1', revision: 2);

TavernPackVersion _version(String id, String version, {bool removed = false}) => TavernPackVersion(
  ref: TavernPackVersionRef(installedPackId: 'i-$id', packVersion: version),
  externalPackId: id,
  digest: 'x',
  manifestRaw: '{}',
  manifest: {
    'formatVersion': 1,
    'packId': id,
    'packVersion': version,
    'dshgo': {
      'cast': [
        {
          'id': 'guard',
          'card': {'name': '守卫'},
        },
      ],
    },
    'resources': [
      {'localId': 'rules', 'kind': 'regex', 'path': 'regex/rules.json'},
      {'localId': 'book', 'kind': 'lorebook', 'path': 'book.json'},
    ],
  },
  inspection: {
    'resources': [
      {
        'localId': 'rules',
        'reports': [
          {
            'pointer': '/0',
            'report': {
              'kind': 'regex',
              'findings': [
                {'code': 'regex_flag', 'message': '不认识的标志', 'path': r'$.findRegex', 'kind': 'warning'},
              ],
            },
          },
        ],
        'regexDiagnostics': [
          {'status': 'incompatible', 'path': r'$.findRegex'},
        ],
      },
    ],
  },
  availability: _revision,
  removed: removed,
);

TavernPackBinding _binding(String id, String pack, int order) => TavernPackBinding(
  bindingId: id,
  bindingRevision: 1,
  packRef: TavernPackVersionRef(installedPackId: 'i-$pack', packVersion: '1'),
  enabled: true,
  removed: false,
  order: order,
  onceEpoch: 1,
  aliases: const {},
  sourceMap: const [],
);

class _Packs extends PreviewTavern {
  _Packs() : super(tick: Duration.zero);

  var installed = <TavernPackVersion>[];
  final imported = <Uint8List>[];
  final removals = <({TavernGameplayRevision expected, String operation})>[];
  var reads = 0;
  final saves = <({TavernGameplayRevision expected, List<Map<String, Object?>> edits})>[];
  TavernGameplayException? saveError;

  var bindings = [_binding('a', 'alpha', 0), _binding('b', 'beta', 1)];

  @override
  Future<List<TavernPackVersion>> listGameplayPacks({bool includeRemoved = false}) async => [
    for (final v in installed)
      if (includeRemoved || !v.removed) v,
  ];

  @override
  Future<TavernPackImportResult> importGameplayPack(Uint8List bytes) async {
    imported.add(bytes);
    installed = [_version('alpha', '1')];
    return TavernPackImportResult(version: installed.single, reused: false);
  }

  @override
  Future<TavernPackVersion?> readGameplayPack(TavernPackVersionRef ref) async =>
      installed.where((v) => v.ref.installedPackId == ref.installedPackId).firstOrNull;

  @override
  Future<TavernPackRemovalReceipt> removeGameplayPackVersion(
    TavernPackVersionRef ref, {
    required TavernGameplayRevision expected,
    required String operationId,
  }) async {
    removals.add((expected: expected, operation: operationId));
    installed = [_version('alpha', '1', removed: true)];
    return TavernPackRemovalReceipt(ref: ref, operationId: operationId, availability: expected, changed: true);
  }

  TavernPackScopeSnapshot _snapshot(TavernPackScopeTarget scope) =>
      TavernPackScopeSnapshot(scope: scope, token: _revision, bindings: bindings);

  @override
  Future<TavernPackScopeSnapshot> readGameplayBindings(TavernPackScopeTarget scope) async {
    reads++;
    return scope.kind == TavernGameplayScope.character
        ? _snapshot(scope)
        : TavernPackScopeSnapshot(scope: scope, token: _revision, bindings: const []);
  }

  @override
  Future<TavernPackBindingReceipt> updateGameplayBindings(
    TavernPackScopeTarget scope, {
    required TavernGameplayRevision expected,
    required String operationId,
    required List<TavernPackBindingEdit> edits,
  }) async {
    saves.add((expected: expected, edits: [for (final e in edits) e.toJson()]));
    if (saveError case final error?) throw error;
    return TavernPackBindingReceipt(
      operationId: operationId,
      snapshot: _snapshot(scope),
      createdBindings: const {},
      changed: true,
    );
  }

  TavernGameplayExportPreview preview = const TavernGameplayExportPreview(
    previewId: 'p1',
    sources: [],
    mergedRaw: {},
    idMappings: [],
    resourceMappings: [],
    issues: [
      {'code': 'export_asset_selection_required', 'blocking': true, 'message': '要选附件'},
    ],
  );
  final previewed = <TavernGameplayExportRequest>[];
  final exported = <(TavernGameplayExportRequest, String)>[];

  /// When set, a preview waits for it.
  Completer<void>? hold;

  @override
  Future<TavernGameplayExportPreview> previewGameplayExport(TavernGameplayExportRequest request) async {
    previewed.add(request);
    await hold?.future;
    return preview;
  }

  /// When set, making a pack from a draft waits for it.
  Completer<void>? holdExport;

  @override
  Future<Uint8List> exportGameplayPackFromDraft(
    TavernGameplayExportRequest request, {
    required String expectedPreviewId,
  }) async {
    exported.add((request, expectedPreviewId));
    await holdExport?.future;
    return Uint8List.fromList([9]);
  }

  @override
  Future<Uint8List> exportCharacterWithPacks(
    TavernGameplayExportRequest request, {
    required String expectedPreviewId,
  }) async {
    exported.add((request, expectedPreviewId));
    return Uint8List.fromList([1, 2, 3]);
  }
}

Future<void> _open(WidgetTester tester, _Packs tavern, Widget home, {List<Override> overrides = const []}) async {
  SharedPreferences.setMockInitialValues({});
  tester.view.physicalSize = const Size(390, 844) * 2;
  tester.view.devicePixelRatio = 2;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [tavernProvider.overrideWith((ref) => tavern), ...overrides],
      child: MaterialApp(
        theme: withTestFonts(buildLightTheme()),
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: home,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('importing opens the version: its character, its resource notes; withdrawing asks, then keeps it', (
    tester,
  ) async {
    final tavern = _Packs();
    await _open(
      tester,
      tavern,
      const TavernPacksPage(),
      overrides: [
        tavernChatPickerProvider.overrideWith(
          (ref) =>
              () async => [
                TavernChatFile(fileName: 'alpha.dshpack', bytes: Uint8List.fromList([7])),
              ],
        ),
      ],
    );
    expect(find.byKey(const ValueKey('tavern-packs-empty')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('tavern-packs-import')));
    await tester.pumpAndSettle();
    expect(tavern.imported.single, [7]);
    expect(find.byKey(const ValueKey('tavern-pack-cast-m-guard')), findsOneWidget);
    expect(find.text('守卫'), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('tavern-pack-resource-rules')), matching: find.text('2 条提示')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const ValueKey('tavern-pack-resource-rules')));
    await tester.pumpAndSettle();
    expect(find.textContaining('不认识的标志'), findsOneWidget);
    await tester.tapAt(const Offset(20, 20));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(find.byKey(const ValueKey('tavern-pack-withdraw')), 200);
    await tester.tap(find.byKey(const ValueKey('tavern-pack-withdraw')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-pack-confirm')));
    await tester.pumpAndSettle();
    expect(tavern.removals.single.expected, _revision);
    // Withdrawn, still there: no withdraw again, the original still exports.
    expect(find.byKey(const ValueKey('tavern-pack-withdraw')), findsNothing);
    expect(find.byKey(const ValueKey('tavern-pack-export')), findsOneWidget);
  });

  testWidgets('a scope saves its edits as one batch on the snapshot they were made on', (tester) async {
    final tavern = _Packs()..installed = [_version('alpha', '1'), _version('beta', '1')];
    await _open(
      tester,
      tavern,
      const TavernPackBindingsPage(scope: (kind: TavernGameplayScope.character, targetId: 'lin'), characterId: 'lin'),
    );
    final save = find.byKey(const ValueKey('tavern-pack-save'));
    expect(tester.widget<GlassIconButton>(save).onPressed, isNull);

    await tester.tap(find.byKey(const ValueKey('tavern-pack-binding-on-a')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-pack-binding-b')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('上移'));
    await tester.pumpAndSettle();
    // A new one too: the reorder names the saved two, so it goes first.
    await tester.tap(find.byKey(const ValueKey('tavern-pack-add')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-pack-add-i-alpha')));
    await tester.pumpAndSettle();

    await tester.tap(save);
    await tester.pumpAndSettle();
    expect(tavern.saves.single.expected, _revision);
    final edits = tavern.saves.single.edits;
    expect(edits.take(2), [
      {
        'kind': 'reorder',
        'bindingIds': ['b', 'a'],
      },
      {'kind': 'setEnabled', 'bindingId': 'a', 'enabled': false},
    ]);
    expect(edits.last, containsPair('kind', 'create'));
    expect(edits, hasLength(3));
    expect(find.text('已保存'), findsOneWidget);
  });

  testWidgets('changed elsewhere: the snapshot is read again and nothing is resent', (tester) async {
    final tavern = _Packs()
      ..installed = [_version('alpha', '1'), _version('beta', '1')]
      ..saveError = const TavernGameplayException(code: 'revision_conflict', message: 'stale');
    await _open(
      tester,
      tavern,
      const TavernPackBindingsPage(scope: (kind: TavernGameplayScope.character, targetId: 'lin')),
    );
    await tester.tap(find.byKey(const ValueKey('tavern-pack-binding-on-a')));
    await tester.pumpAndSettle();
    final before = tavern.reads;
    await tester.tap(find.byKey(const ValueKey('tavern-pack-save')));
    await tester.pumpAndSettle();
    expect(tavern.reads, greaterThan(before));
    expect(find.text('配置在别处变了，已刷新，请重新确认这次修改'), findsOneWidget);
    expect(tester.widget<GlassIconButton>(find.byKey(const ValueKey('tavern-pack-save'))).onPressed, isNull);
    expect(tavern.saves, hasLength(1));
  });

  testWidgets('a card export takes exactly the request it previewed, and only when nothing blocks', (tester) async {
    final tavern = _Packs()..installed = [_version('beta', '1')];
    final shared = <String>[];
    await _open(
      tester,
      tavern,
      const TavernPackCardExportPage(
        character: TavernCharacter(id: 'lin', name: '林晚'),
      ),
      overrides: [
        tavernCardSinkProvider.overrideWith(
          (ref) =>
              (name, bytes, mime) async => shared.add(name),
        ),
      ],
    );
    final go = find.byKey(const ValueKey('tavern-pack-export-go'));
    expect(tester.widget<SettingsTile>(go).onTap, isNull);

    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-b-book')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const ValueKey('tavern-pack-export-preview')), 200);
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-preview')));
    await tester.pumpAndSettle();
    expect(tavern.previewed.single.packResources.single.localId, 'book');
    expect(find.textContaining('要选附件'), findsOneWidget);
    expect(tester.widget<SettingsTile>(go).onTap, isNull);

    tavern.preview = const TavernGameplayExportPreview(
      previewId: 'p2',
      sources: [],
      mergedRaw: {},
      idMappings: [],
      resourceMappings: [],
      issues: [],
    );
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-preview')));
    await tester.pumpAndSettle();
    await tester.tap(go);
    await tester.pumpAndSettle();
    expect(tavern.exported.single.$2, 'p2');
    expect(identical(tavern.exported.single.$1, tavern.previewed.last), isTrue);
    expect(shared.single, '林晚.png');
  });

  testWidgets('a preview answered after an option changed is not shown, and export stays off', (tester) async {
    final tavern = _Packs()
      ..installed = [_version('beta', '1')]
      ..preview = const TavernGameplayExportPreview(
        previewId: 'p1',
        sources: [],
        mergedRaw: {},
        idMappings: [],
        resourceMappings: [],
        issues: [],
      )
      ..hold = Completer<void>();
    await _open(
      tester,
      tavern,
      const TavernPackCardExportPage(
        character: TavernCharacter(id: 'lin', name: '林晚'),
      ),
    );
    await tester.scrollUntilVisible(find.byKey(const ValueKey('tavern-pack-export-preview')), 200);
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-preview')));
    await tester.pump();

    // Changed while the preview is out.
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-b-book')));
    await tester.pump();
    tavern.hold!.complete();
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('tavern-pack-export-findings')), findsNothing);
    expect(tester.widget<SettingsTile>(find.byKey(const ValueKey('tavern-pack-export-go'))).onTap, isNull);
  });

  testWidgets('a draft pack still goes out if the form changes while it is made, but is not offered to install', (
    tester,
  ) async {
    const card = TavernAuthoringTarget(kind: TavernAuthoringTargetKind.character, id: 'lin');
    const book = TavernAuthoringTarget(kind: TavernAuthoringTargetKind.lorebook, id: 'b1');
    final draft = TavernAuthoringDraft(
      id: 'd1',
      draftRevision: 1,
      sources: const [
        TavernAuthoringSource(
          target: card,
          sourceFormat: 'chara_card_v3',
          base: {
            'data': {'name': '林晚'},
          },
          applySupported: true,
        ),
        TavernAuthoringSource(target: book, sourceFormat: 'lorebook', base: {'name': '旧城'}, applySupported: true),
      ],
      changes: const [],
      createdAt: DateTime.utc(2026),
      updatedAt: DateTime.utc(2026),
    );
    final tavern = _Packs()
      ..preview = const TavernGameplayExportPreview(
        previewId: 'p1',
        sources: [],
        mergedRaw: {},
        idMappings: [],
        resourceMappings: [],
        issues: [],
      )
      ..holdExport = Completer<void>();
    final shared = <String>[];
    await _open(
      tester,
      tavern,
      TavernPackDraftExportPage(draft: draft, cardResourceId: card.physicalResourceId),
      overrides: [
        tavernCardSinkProvider.overrideWith(
          (ref) =>
              (name, bytes, mime) async => shared.add(name),
        ),
      ],
    );
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-pack-export-preview')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-preview')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('tavern-pack-export-go')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('tavern-pack-export-go')));
    await tester.pump();

    // The lorebook switched on while the pack is being made.
    await tester.ensureVisible(find.byKey(ValueKey('tavern-pack-draft-book-${book.physicalResourceId}')));
    await tester.tap(find.byKey(ValueKey('tavern-pack-draft-book-${book.physicalResourceId}')));
    await tester.pump();
    tavern.holdExport!.complete();
    await tester.pumpAndSettle();

    expect(tavern.exported.single.$1.draftResources, isEmpty);
    expect(shared.single, '林晚 1.dshpack');
    expect(find.byKey(const ValueKey('tavern-pack-draft-install')), findsNothing);
  });
}
