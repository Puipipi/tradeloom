// Goldens of the 模型渠道 pages (light + dark): the list, the add / edit form
// (empty-save errors, filled after a fetch), the model picker and a detail page.
//
//   flutter test --update-goldens test/providers

import 'package:dsh_app/ui/providers/provider_detail_page.dart';
import 'package:dsh_app/ui/providers/provider_form_page.dart';
import 'package:dsh_app/ui/providers/providers_page.dart';
import 'package:dsh_app/ui/providers/subscription_page.dart';
import 'package:dsh_app/ui/providers/subscription_sheet.dart';
import 'package:dsh_client/dsh_client.dart' show DshClient, ModelCatalog, ModelInfo, ProviderGroup;
import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/read_list_identity.dart';
import 'package:dsh_app/state/account_state.dart' show accountBrowserProvider;
import 'package:dsh_app/state/models_state.dart';
import 'package:dsh_app/state/providers_state.dart';
import 'package:dsh_app/state/subscriptions_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import '../account/support.dart' show FakeBrowser;
import '../engine_settings/support.dart' as engine;
import '../shell/golden_harness.dart';
import 'support.dart';

// Only the two overview goldens use this modern Host. Other provider pages
// retain their existing backend fixtures and network behavior.
List<Override> _withNewChatDefaults(List<Override> overrides) {
  final host =
      engine.FakeSettingsHost(
          describe: {
            'namespaces': [
              {
                'ns': defaultModelSettingsNs,
                'schema': {
                  'type': 'object',
                  'dict': {
                    'provider': {'type': 'string'},
                    'model': {'type': 'string'},
                    'reasoningEffort': {'type': 'string'},
                    'rememberLastSelection': {'type': 'boolean'},
                  },
                },
                'base': {
                  'provider': 'deepseek-official',
                  'model': 'deepseek-v4-pro',
                  'reasoningEffort': 'high',
                  'rememberLastSelection': true,
                },
                'revision': 2,
              },
            ],
          },
        )
        ..modelCatalog = {
          'default': {'provider': 'deepseek-official', 'model': 'deepseek-v4-pro', 'reasoningEffort': 'high'},
          'routableProviders': ['deepseek-official'],
          'groups': [
            {
              'id': 'deepseek-official',
              'name': 'DeepSeek',
              'models': [
                {
                  'id': 'deepseek-v4-pro',
                  'name': 'DeepSeek-V4-Pro',
                  'reasoning': {
                    'defaultEffort': 'high',
                    'efforts': [
                      {'id': 'off', 'name': 'Off'},
                      {'id': 'high', 'name': 'High'},
                    ],
                  },
                },
              ],
            },
          ],
          'failures': <Object?>[],
        };
  final client = DshClient.withCarrier(host);
  addTearDown(client.close);
  return [
    for (final override in overrides)
      if (override.origin != activeConnectionProvider) override,
    activeConnectionProvider.overrideWithValue(AsyncData(engine.fakeConnection(client))),
    readListIdentityProvider.overrideWithValue(null),
  ];
}

void main() {
  // Everything at once: DeepSeek, both subscriptions (one signed in), three
  // custom providers in three states.
  goldenTall(
    'providers_list',
    height: 1080,
    () => const ProvidersPage(),
    overrides: () => _withNewChatDefaults(
      providerOverrides(
        sampleBackend(),
        account: signedInAccount,
        subscriptions: FakeSubscriptionBackend(
          statuses: const [
            SubscriptionStatus(subscription: Subscription.chatgpt, signedIn: true, account: 'me@example.com'),
            SubscriptionStatus(subscription: Subscription.claude, signedIn: false),
          ],
        ),
      ),
    ),
    before: engine.flush,
  );

  goldenBoth(
    'providers_list_empty',
    () => const ProvidersPage(),
    overrides: () => _withNewChatDefaults(providerOverrides(FakeProviderBackend())),
    before: engine.flush,
  );

  goldenTall(
    'provider_form_errors',
    height: 1240,
    () => const ProviderFormPage(),
    overrides: () => providerOverrides(FakeProviderBackend()),
    before: (tester) async {
      await tester.enterText(find.byType(TextField).at(1), 'gw.example.com');
      await tester.tap(find.text('保存'));
      await settle(tester);
    },
  );

  goldenTall(
    'provider_form_filled',
    height: 1480,
    () => const ProviderFormPage(),
    overrides: () => providerOverrides(
      FakeProviderBackend()
        ..discoverFor = (url) =>
            url == 'https://gw.example.com/v1' ? discovered : listingRefused('https://gw.example.com', 404),
    ),
    before: (tester) async {
      await tester.enterText(find.byType(TextField).at(0), 'My Gateway');
      await tester.enterText(find.byType(TextField).at(1), 'https://gw.example.com/');
      await tester.enterText(find.byType(TextField).at(2), 'sk-or-v1-0123456789abcdef');
      await tester.tap(find.text('获取模型'));
      await settle(tester);
      await tester.tap(find.text('添加 3 个模型'));
      await settle(tester);
    },
  );

  goldenBoth(
    'provider_picker',
    () => const ProviderFormPage(),
    overrides: () => providerOverrides(
      FakeProviderBackend(
        discoverResult: [
          ...discovered,
          for (final id in ['kimi-k2-0905', 'minimax-m2', 'doubao-seed-1.6', 'hunyuan-t1', 'ernie-4.5', 'step-2'])
            DiscoveredModel(id: id),
        ],
      ),
    ),
    before: (tester) async {
      await tester.enterText(find.byType(TextField).at(1), 'https://gw.example.com/v1');
      await tester.enterText(find.byType(TextField).at(2), 'sk-or-v1-0123456789abcdef');
      await tester.ensureVisible(find.text('获取模型'));
      await tester.pump();
      await tester.tap(find.text('获取模型'));
      await settle(tester);
      await tester.tap(find.text('qwen3-coder'));
      await tester.tap(find.text('deepseek-v4-pro'));
      await settle(tester);
    },
  );

  goldenBoth(
    'provider_detail',
    () => const ProviderDetailPage(providerId: 'custom-mygw'),
    overrides: () => providerOverrides(sampleBackend()..discoverResult = discovered),
    before: (tester) async {
      await tester.tap(find.text('测试连接'));
      await settle(tester);
    },
  );

  goldenBoth(
    'provider_detail_missing_key',
    () => const ProviderDetailPage(providerId: 'custom-claude-relay'),
    overrides: () => providerOverrides(sampleBackend()),
  );

  // The sign-in sheet's three waiting steps.
  for (final (name, step) in const [
    ('subscription_sheet_open', LoginStep(phase: LoginPhase.open, url: 'https://auth.example.com/oauth/authorize')),
    (
      'subscription_sheet_device',
      LoginStep(phase: LoginPhase.device, url: 'https://auth.example.com/device', userCode: 'WDJB-MJHT'),
    ),
    (
      'subscription_sheet_prompt',
      LoginStep(phase: LoginPhase.prompt, message: 'Paste the authorization code', placeholder: 'code#state'),
    ),
  ]) {
    goldenBoth(
      name,
      () => const _SheetHost(),
      overrides: () => [
        ...providerOverrides(FakeProviderBackend(), subscriptions: FakeSubscriptionBackend(steps: [step])),
        accountBrowserProvider.overrideWithValue(FakeBrowser()),
      ],
      before: (tester) async {
        await tester.tap(find.text('open'));
        await settle(tester);
      },
    );
  }

  goldenBoth(
    'subscription_page',
    () => const SubscriptionPage(subscription: Subscription.chatgpt),
    overrides: () => [
      ...providerOverrides(
        FakeProviderBackend(),
        subscriptions: FakeSubscriptionBackend(
          statuses: const [
            SubscriptionStatus(subscription: Subscription.chatgpt, signedIn: true, account: 'me@example.com'),
          ],
        ),
      ),
      modelCatalogProvider.overrideWith(
        (ref) async => const ModelCatalog(
          defaultSelection: null,
          routableProviders: ['openai-codex'],
          groups: [
            ProviderGroup('openai-codex', 'ChatGPT', [
              ModelInfo(provider: 'openai-codex', id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex'),
              ModelInfo(provider: 'openai-codex', id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini'),
              ModelInfo(provider: 'openai-codex', id: 'gpt-5.1', name: 'GPT-5.1'),
            ]),
          ],
          failures: [],
        ),
      ),
    ],
  );

  // The catalog couldn't be read: the error with 「重试」, not 「暂无模型」 (D5).
  goldenBoth(
    'subscription_page_models_failed',
    () => const SubscriptionPage(subscription: Subscription.chatgpt),
    overrides: () => [
      ...providerOverrides(
        FakeProviderBackend(),
        subscriptions: FakeSubscriptionBackend(
          statuses: const [
            SubscriptionStatus(subscription: Subscription.chatgpt, signedIn: true, account: 'me@example.com'),
          ],
        ),
      ),
      modelCatalogProvider.overrideWith((ref) async => throw StateError('catalog unavailable')),
    ],
  );
}

/// A blank page with a button that opens the ChatGPT sign-in sheet.
class _SheetHost extends StatelessWidget {
  const _SheetHost();

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: Colors.transparent,
    body: Center(
      child: TextButton(
        onPressed: () => showSubscriptionLogin(context, Subscription.chatgpt),
        child: const Text('open'),
      ),
    ),
  );
}
