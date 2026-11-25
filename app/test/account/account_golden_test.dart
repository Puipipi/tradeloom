// Golden screenshots of the account sign-in surfaces, light and dark.
//
//   flutter test --update-goldens test/account

import 'package:dsh_app/state/account_state.dart';
import 'package:dsh_app/ui/account/account_page.dart';
import 'package:dsh_app/ui/account/account_widgets.dart';
import 'package:dsh_app/ui/common/app_sheet.dart';
import 'package:dsh_app/ui/onboarding/connect_page.dart';
import 'package:dsh_app/ui/onboarding/onboarding_scaffold.dart';
import 'package:dsh_app/ui/shell/page_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;

import 'support.dart';

List<Override> _fixed(AccountState state, {AccountBalance? balance = sampleBalance}) => [
  ...accountOverrides(),
  accountProvider.overrideWith(() => FixedAccount(state)),
  accountBalanceProvider.overrideWith((ref) async => balance),
];

const _signedOut = AccountState(phase: AccountPhase.signedOut, connected: true, links: links);

const _waiting = AccountState(
  phase: AccountPhase.signingIn,
  stage: SignInStage.waitingBrowser,
  attemptId: 'att-1',
  authorizeUrl: authorizeUrl,
  connected: true,
  links: links,
);

const _signedIn = AccountState(phase: AccountPhase.signedIn, connected: true, links: links, profile: sampleProfile);

void main() {
  // ── Onboarding ──
  goldenBoth(
    'connect_choose',
    () => OnboardingProgress(step: 2, steps: 2, child: ConnectPage(onDone: () {})),
    overrides: () => _fixed(_signedOut),
  );

  goldenBoth(
    'connect_failure',
    () => OnboardingProgress(step: 2, steps: 2, child: ConnectPage(onDone: () {})),
    overrides: () => _fixed(_signedOut.copyWith(failure: const SignInFailure(SignInFailureKind.offline))),
  );

  goldenBoth(
    'connect_starting',
    () => OnboardingProgress(step: 2, steps: 2, child: ConnectPage(onDone: () {})),
    overrides: () =>
        _fixed(const AccountState(phase: AccountPhase.signingIn, stage: SignInStage.preparing, connected: false)),
  );

  goldenBoth(
    'connect_waiting',
    () => OnboardingProgress(step: 2, steps: 2, child: ConnectPage(onDone: () {})),
    overrides: () => _fixed(_waiting),
  );

  goldenBoth(
    'connect_returned',
    () => OnboardingProgress(step: 2, steps: 2, child: ConnectPage(onDone: () {})),
    overrides: () => _fixed(_waiting.copyWith(browserHint: BrowserHint.returned)),
  );

  // ── Account page ──
  goldenBoth('account_signed_in', () => const AccountPage(), overrides: () => _fixed(_signedIn));

  goldenBoth(
    'account_signed_out',
    () => const AccountPage(),
    overrides: () => _fixed(const AccountState(phase: AccountPhase.signedOut, connected: false), balance: null),
  );

  goldenBoth('account_signing_in', () => const AccountPage(), overrides: () => _fixed(_waiting));

  // ── Settings row ──
  goldenBoth('account_tile', () => const _TileGallery(), overrides: accountOverrides);
}

/// The tile in its three common states, each in its own scope.
class _TileGallery extends StatelessWidget {
  const _TileGallery();

  @override
  Widget build(BuildContext context) {
    Widget tile(String title, AccountState state) => ProviderScope(
      overrides: [accountProvider.overrideWith(() => FixedAccount(state))],
      child: SheetGroup(title: title, children: const [AccountTile()]),
    );
    return AppPage.list(
      title: '设置',
      children: [
        tile('已登录', _signedIn),
        tile('未登录', _signedOut),
        tile('登录中', _waiting),
        tile(
          '已登录（只有手机号）',
          _signedIn.copyWith(
            profile: const AccountProfile(id: 'u-2', contact: '139****0021'),
          ),
        ),
      ],
    );
  }
}
