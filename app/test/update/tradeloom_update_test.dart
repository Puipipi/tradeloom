import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dsh_app/state/update_state.dart';
import 'package:dsh_app/update/installer.dart';
import 'package:dsh_app/update/update_config.dart';
import 'package:dsh_app/update/update_http.dart';
import 'package:dsh_app/update/version.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'support.dart';

const _feed = 'https://updates.tradeloom.example/stable/update.json';
const _apkUrl = 'https://updates.tradeloom.example/stable/1.3.0/dsh-go-1.3.0-arm64.apk';
final _apk = utf8.encode('synthetic TradeLoom release APK bytes');

void main() {
  group('TradeLoom build-time update source', () {
    test('empty/invalid configuration disables update and all fallbacks', () {
      expect(tradeLoomUpdateSources().enabled, isFalse);
      for (final feed in ['', 'http://updates.example/update.json', 'https://user@updates.example/update.json']) {
        final sources = tradeLoomUpdateSources(feed: feed);
        expect(sources.metadataEndpoints(), isEmpty);
        expect(sources.downloadUrls([Uri.parse(_apkUrl)]), isEmpty);
      }
    });

    test('valid feed is the only metadata and download origin', () {
      final sources = tradeLoomUpdateSources(feed: _feed);
      expect(sources.metadataEndpoints().map((e) => e.url.toString()), [_feed]);
      expect(sources.useGithubApi, isFalse);
      expect(sources.mirrors, isEmpty);
      expect(
        sources
            .downloadUrls([
              Uri.parse(_apkUrl),
              Uri.parse('https://github.com/ccch1mneyyy/dsh-go/releases/download/v1.3.0/dsh-go-1.3.0-arm64.apk'),
              Uri.parse('http://updates.tradeloom.example/stable/asset.apk'),
              Uri.parse('https://other.example/asset.apk'),
            ])
            .map((x) => x.url.toString()),
        [_apkUrl],
      );
    });

    test('a higher release name requires a higher Android versionCode', () {
      final sources = tradeLoomUpdateSources(feed: _feed);
      final installed = AppVersion.tryParse('1.3.0+11251109')!;
      for (final manifestVersion in ['1.3.1', '1.3.1+11251108', '1.3.1+11251109']) {
        expect(sources.offersNewerVersion(AppVersion.tryParse(manifestVersion)!, installed), isFalse);
      }
      expect(sources.offersNewerVersion(AppVersion.tryParse('1.3.1+11251110')!, installed), isTrue);
    });

    test('every redirect in the native transport must stay HTTPS on the pinned origin', () {
      final origin = Uri.parse('https://updates.tradeloom.example');
      expect(isAllowedUpdateRedirect(origin, Uri.parse('https://updates.tradeloom.example/next')), isTrue);
      expect(isAllowedUpdateRedirect(origin, Uri.parse('https://updates.tradeloom.example:444/next')), isFalse);
      expect(isAllowedUpdateRedirect(origin, Uri.parse('http://updates.tradeloom.example/next')), isFalse);
      expect(isAllowedUpdateRedirect(origin, Uri.parse('https://cdn.example/next')), isFalse);
      expect(isAllowedUpdateRedirect(origin, Uri.parse('https://user@updates.tradeloom.example/next')), isFalse);
    });
  });

  test('versioned feed path downloads expected flavor then keeps native package/signature gates', () async {
    SharedPreferences.setMockInitialValues({});
    final directory = Directory.systemTemp.createTempSync('tradeloom-update-');
    addTearDown(() => directory.deleteSync(recursive: true));
    final http = FakeHttp();
    final installer = FakeInstaller();
    final digest = sha256.convert(_apk).toString();
    http.routes[_feed] = (_, _) => textResponse(
      jsonEncode({
        'schema': 1,
        'version': '1.3.0+11251109',
        'tag': 'v1.3.0',
        'sourceCommit': '0123456789abcdef0123456789abcdef01234567',
        'assets': {
          'arm64': {
            'name': 'dsh-go-1.3.0-arm64.apk',
            'url': '1.3.0/dsh-go-1.3.0-arm64.apk',
            'size': _apk.length,
            'sha256': digest,
          },
        },
      }),
    );
    http.routes[_apkUrl] = fileRoute(_apk);
    final container = ProviderContainer(
      overrides: [
        updateHttpProvider.overrideWithValue(http),
        updateInstallerProvider.overrideWithValue(installer),
        updateSourcesProvider.overrideWithValue(tradeLoomUpdateSources(feed: _feed)),
        updateDirectoryProvider.overrideWithValue(() async => directory),
        updateFlavorNameProvider.overrideWithValue('arm64'),
      ],
    );
    addTearDown(container.dispose);
    final controller = container.read(appUpdateProvider.notifier);
    await controller.ready;
    await controller.check();
    expect(container.read(appUpdateProvider).latest!.version.toString(), '1.3.0+11251109');
    expect(container.read(appUpdateProvider).asset!.name, 'dsh-go-1.3.0-arm64.apk');
    expect(http.urls, [_feed]);
    expect(http.originPolicies, [(Uri.parse(_feed), Uri.parse('https://updates.tradeloom.example'))]);

    await controller.startDownload();
    expect(http.urls, [_feed, _apkUrl]);
    expect(http.originPolicies, [
      (Uri.parse(_feed), Uri.parse('https://updates.tradeloom.example')),
      (Uri.parse(_apkUrl), Uri.parse('https://updates.tradeloom.example')),
    ]);
    expect(container.read(appUpdateProvider).task, UpdateTaskPhase.ready);
    installer.inspection = const ApkInspection(valid: true, samePackage: true, signatureMatches: false);
    await controller.install();
    expect(container.read(appUpdateProvider).problem, UpdateProblem.signature);
    expect(installer.calls, isNot(contains('install')));

    installer.inspection = const ApkInspection(
      valid: true, samePackage: true, signatureMatches: true, versionCode: 1,
    );
    await controller.install();
    expect(container.read(appUpdateProvider).problem, UpdateProblem.downgrade);
    expect(installer.calls, isNot(contains('install')));
  });

  test('native package mismatch is still refused before installation', () async {
    SharedPreferences.setMockInitialValues({});
    final directory = Directory.systemTemp.createTempSync('tradeloom-package-');
    addTearDown(() => directory.deleteSync(recursive: true));
    final http = FakeHttp();
    final installer = FakeInstaller(
      inspection: const ApkInspection(valid: true, samePackage: false, signatureMatches: true),
    );
    final digest = sha256.convert(_apk).toString();
    http.routes[_feed] = (_, _) => textResponse(
      jsonEncode({
        'version': '1.3.0+11251109',
        'assets': {
          'arm64': {
            'name': 'dsh-go-1.3.0-arm64.apk',
            'url': '1.3.0/dsh-go-1.3.0-arm64.apk',
            'size': _apk.length,
            'sha256': digest,
          },
        },
      }),
    );
    http.routes[_apkUrl] = fileRoute(_apk);
    final container = ProviderContainer(
      overrides: [
        updateHttpProvider.overrideWithValue(http),
        updateInstallerProvider.overrideWithValue(installer),
        updateSourcesProvider.overrideWithValue(tradeLoomUpdateSources(feed: _feed)),
        updateDirectoryProvider.overrideWithValue(() async => directory),
        updateFlavorNameProvider.overrideWithValue('arm64'),
      ],
    );
    addTearDown(container.dispose);
    final controller = container.read(appUpdateProvider.notifier);
    await controller.ready;
    await controller.check();
    await controller.startDownload();
    await controller.install();
    expect(container.read(appUpdateProvider).problem, UpdateProblem.notDsh);
    expect(installer.calls, isNot(contains('install')));
  });
}
