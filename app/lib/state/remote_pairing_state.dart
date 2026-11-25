// 扫码配对电脑 (Remote device pairing v1), the phone's side: scan the code the
// computer's Remote plugin shows, confirm it is that computer, show the 8-digit
// code the person types into the computer, wait, then connect.
//
// The phone never confirms for the computer, and the code has one attempt:
// a wrong one on the computer ends the session and the scan starts over.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../l10n/l10n.dart';
import '../remote/relay/relay_backend.dart';
import 'hosts_state.dart';
import 'read_list_epoch.dart';

enum PairingStep {
  /// The camera (or a pasted link) is looking for a code.
  scanning,

  /// Asking the Server what the code points at (nothing claimed yet).
  resolving,

  /// Showing the computer and Server for the person to confirm.
  confirming,

  /// Claiming the session with this phone's identity.
  claiming,

  /// Showing the code until the computer submitted it.
  showingCode,

  /// Paired: [PairingFlowState.host] is the computer.
  done,
  failed,
}

@immutable
class PairingFlowState {
  const PairingFlowState({
    this.step = PairingStep.scanning,
    this.offer,
    this.session,
    this.approved = false,
    this.host,
    this.error,
  });

  final PairingStep step;
  final RelayPairingOffer? offer;

  /// Holds the code while [step] is [PairingStep.showingCode].
  final RelayPairingSession? session;

  /// The computer submitted the right code; the Server is finishing.
  final bool approved;
  final RelayHost? host;
  final RelayPairingError? error;
}

final remotePairingProvider = NotifierProvider.autoDispose<PairingFlowController, PairingFlowState>(
  PairingFlowController.new,
);

class PairingFlowController extends Notifier<PairingFlowState> {
  /// Bumped by every new attempt; late results of an older one are dropped.
  int _epoch = 0;

  /// The scanned text, kept in memory only to retry it after a Server
  /// switch (it holds the ticket secret).
  String? _scanned;
  StreamSubscription<RelayPairingPhase>? _phases;

  /// The session whose code is on screen (lifecycle callbacks cannot read
  /// [state]).
  RelayPairingSession? _shown;

  /// The app is in the background; a session claimed meanwhile starts paused.
  bool _paused = false;

  @override
  PairingFlowState build() {
    ref.onDispose(() {
      _epoch++;
      _scanned = null;
      unawaited(_phases?.cancel());
      final shown = _shown;
      _shown = null;
      if (shown != null) unawaited(shown.cancel());
    });
    return const PairingFlowState();
  }

  RelayPairingBackend? get _backend {
    final backend = ref.read(relayBackendProvider);
    return backend is RelayPairingBackend ? backend as RelayPairingBackend : null;
  }

  bool _current(int epoch) => ref.mounted && epoch == _epoch;

  void _fail(int epoch, Object error) {
    if (!_current(epoch)) return;
    _shown = null;
    final e = error is RelayPairingError
        ? error
        : RelayPairingError(RelayPairingErrorKind.other, appL10n.remotePairErrFailed, detail: '$error');
    state = PairingFlowState(step: PairingStep.failed, offer: state.offer, error: e);
  }

  /// A code was read (camera, image or paste). Ignored unless scanning.
  Future<void> scanned(String text) async {
    if (state.step != PairingStep.scanning) return;
    final backend = _backend;
    final epoch = ++_epoch;
    if (backend == null) {
      return _fail(epoch, RelayPairingError(RelayPairingErrorKind.unsupported, appL10n.remotePairErrUnsupported));
    }
    _scanned = text;
    state = const PairingFlowState(step: PairingStep.resolving);
    try {
      final offer = await backend.resolvePairing(text);
      if (!_current(epoch)) return;
      state = PairingFlowState(step: PairingStep.confirming, offer: offer);
    } catch (e) {
      _fail(epoch, e);
    }
  }

  /// The code is for another Server and the person agreed to switch to it:
  /// switch, then resolve the same code there.
  Future<void> switchServerAndRetry() async {
    final server = state.error?.server;
    final text = _scanned;
    if (state.step != PairingStep.failed || server == null || text == null) return;
    final epoch = ++_epoch;
    state = const PairingFlowState(step: PairingStep.resolving);
    try {
      await ref.read(relayServerProvider.notifier).useServer(server);
    } catch (e) {
      return _fail(epoch, RelayPairingError(RelayPairingErrorKind.other, appL10n.remoteErrInvalidServer));
    }
    if (!_current(epoch)) return;
    state = const PairingFlowState();
    await scanned(text);
  }

  /// The person confirmed the computer: claim and show the code.
  /// [deepseekUserId] is the signed-in DeepSeek account's id (unverified
  /// metadata; never credentials).
  Future<void> confirm({String? deepseekUserId}) async {
    final offer = state.offer;
    final backend = _backend;
    if (state.step != PairingStep.confirming || offer == null || backend == null) return;
    final epoch = ++_epoch;
    state = PairingFlowState(step: PairingStep.claiming, offer: offer);
    // Pairing may sign this phone in: retire reads tied to the old sign-in,
    // as the other sign-in paths do.
    ref.read(readListCredentialEpochProvider.notifier).advance();
    final RelayPairingSession session;
    try {
      session = await backend.claimPairing(offer, deepseekUserId: deepseekUserId);
    } catch (e) {
      return _fail(epoch, e);
    }
    if (!_current(epoch)) {
      // Nobody waits for this one: its cancellation error is expected.
      session.completed.ignore();
      unawaited(session.cancel());
      return;
    }
    _scanned = null;
    _shown = session;
    if (_paused) session.paused = true;
    state = PairingFlowState(step: PairingStep.showingCode, offer: offer, session: session);
    await _phases?.cancel();
    _phases = session.phases.listen((phase) {
      if (!_current(epoch) || state.step != PairingStep.showingCode) return;
      state = PairingFlowState(
        step: PairingStep.showingCode,
        offer: offer,
        session: session,
        approved: phase == RelayPairingPhase.approved,
      );
    });
    try {
      final host = await session.completed;
      if (!_current(epoch)) return;
      _shown = null;
      state = PairingFlowState(step: PairingStep.done, offer: offer, host: host);
    } catch (e) {
      _fail(epoch, e);
    }
  }

  /// Back to the camera; a shown code is given up (the Server is told).
  void restart() {
    final shown = _shown;
    _shown = null;
    _epoch++;
    _scanned = null;
    unawaited(_phases?.cancel());
    _phases = null;
    if (shown != null) unawaited(shown.cancel());
    state = const PairingFlowState();
  }

  /// Gives up a shown code (the Server is told) and ends in [PairingStep.failed].
  Future<void> cancel() async {
    final shown = _shown;
    if (shown == null) return;
    await shown.cancel();
  }

  /// The app went to the background (or came back): pause polling.
  void setPaused(bool paused) {
    _paused = paused;
    _shown?.paused = paused;
  }
}
