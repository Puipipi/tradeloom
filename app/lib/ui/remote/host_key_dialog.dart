import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../remote/ssh/ssh_link.dart';
import '../../state/connection_state.dart';
import '../../state/hosts_state.dart';
import '../common/app_dialog.dart';
import '../theme/theme.dart';

/// "信任这台主机？" — trust on first use. Shows the fingerprint to compare and
/// how to read it on the computer. Returns true to pin and continue.
Future<bool> confirmHostKey(BuildContext context, HostKeyPrompt prompt) async {
  final ok = await showAppDialog<bool>(
    context: context,
    barrierDismissible: false,
    builder: (dialog) => HostKeyDialog(prompt: prompt),
  );
  return ok ?? false;
}

class HostKeyDialog extends StatelessWidget {
  const HostKeyDialog({super.key, required this.prompt});

  final HostKeyPrompt prompt;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final colors = DshColors.of(context);
    final key = prompt.key;
    final pubFile = switch (key.shortType) {
      'RSA' => 'ssh_host_rsa_key.pub',
      'ECDSA' => 'ssh_host_ecdsa_key.pub',
      _ => 'ssh_host_ed25519_key.pub',
    };
    final command = 'ssh-keygen -lf /etc/ssh/$pubFile';
    final instruction = l10n.remoteHostKeyVerifyCommand(command).split(command);
    return AlertDialog(
      title: Text(l10n.remoteHostKeyTrustTitle, style: theme.textTheme.headlineSmall),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l10n.remoteHostKeyFirstConnection(prompt.hostName, prompt.address),
              style: theme.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 14),
            GestureDetector(
              onLongPress: () => Clipboard.setData(ClipboardData(text: key.fingerprint)),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
                decoration: ShapeDecoration(
                  color: colors.codeWellBg,
                  shape: Squircle.border(AppShape.md, side: BorderSide(color: colors.codeWellBorder, width: 0.5)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(key.shortType, style: AppType.monoLabel(color: colors.textTertiary)),
                    const SizedBox(height: 4),
                    SelectableText(
                      key.fingerprint,
                      style: AppType.mono(size: 13, color: colors.codeWellFg, height: 1.5),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Text.rich(
              TextSpan(
                style: theme.textTheme.bodySmall?.copyWith(color: colors.textTertiary, height: 1.6),
                children: [
                  TextSpan(text: instruction.first),
                  TextSpan(
                    text: command,
                    style: AppType.monoLabel(color: scheme.onSurfaceVariant),
                  ),
                  TextSpan(text: instruction.last),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: Text(l10n.commonCancel)),
        FilledButton(onPressed: () => Navigator.pop(context, true), child: Text(l10n.remoteHostKeyTrustConnect)),
      ],
    );
  }
}

/// Makes [host] the active host. An SSH host whose key was never confirmed
/// is checked first (read key → ask → pin), so background reconnects never
/// need to ask. Returns false when the person backed out or it failed.
Future<bool> activateHost(BuildContext context, WidgetRef ref, HostRef host) async {
  final l10n = context.l10n;
  if (host.kind == HostKind.ssh) {
    final config = ref.read(hostsProvider).sshById(host.id);
    if (config == null) return false;
    if (config.hostKeyFingerprint == null) {
      final messenger = ScaffoldMessenger.maybeOf(context);
      final navigator = Navigator.of(context);
      showAppDialog<void>(context: context, barrierDismissible: false, builder: (_) => const _Fetching());
      PresentedHostKey? key;
      String? error;
      try {
        key = await fetchHostKey(config, transportFactory: ref.read(sshTransportFactoryProvider));
      } on HostLinkError catch (e) {
        error = e.message;
      } catch (e) {
        error = l10n.remoteErrReadFingerprint;
      } finally {
        navigator.pop();
      }
      if (key == null) {
        messenger?.showSnackBar(SnackBar(content: Text(error ?? l10n.remoteErrReadFingerprint)));
        return false;
      }
      if (!context.mounted) return false;
      final ok = await confirmHostKey(context, HostKeyPrompt(hostName: config.name, address: config.address, key: key));
      if (!ok) return false;
      await ref.read(hostsProvider.notifier).pinHostKey(host.id, key);
    }
  }
  if (host.kind == HostKind.relay) {
    var relay = ref.read(relayAccountProvider).value?.hostById(host.id);
    if (relay != null && relay.trust != RelayTrust.pinned) {
      // Show the key the Server reports right now, not a stale listing.
      await ref.read(relayAccountProvider.notifier).refresh();
      relay = ref.read(relayAccountProvider).value?.hostById(host.id) ?? relay;
    }
    final target = relay;
    if (target != null && target.trust != RelayTrust.pinned && target.trust != RelayTrust.unknown) {
      final changed = target.trust == RelayTrust.keyChanged;
      if (!context.mounted) return false;
      final ok = await showAppDialog<bool>(
        context: context,
        barrierDismissible: false,
        builder: (_) => RelayTrustDialog(host: target, keyChanged: changed),
      );
      if (ok != true) return false;
      final backend = ref.read(relayBackendProvider);
      if (changed) {
        await backend.forgetHost(target);
      } else {
        backend.approveHost(target);
      }
    }
  }
  ref.read(activeHostProvider.notifier).select(host);
  return true;
}

/// First connect to a DSH Remote host (compare the identity fingerprint with
/// the one the computer's remote plugin shows), or re-trust after its key
/// changed.
class RelayTrustDialog extends StatelessWidget {
  const RelayTrustDialog({super.key, required this.host, this.keyChanged = false});

  final RelayHost host;
  final bool keyChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final colors = DshColors.of(context);
    return AlertDialog(
      title: Text(
        keyChanged ? l10n.remoteHostKeyChangedTitle : l10n.remoteHostKeyTrustTitle,
        style: theme.textTheme.headlineSmall,
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              keyChanged ? l10n.remoteRelayKeyChangedBody(host.name) : l10n.remoteRelayKeyFirstBody(host.name),
              style: theme.textTheme.bodyMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
            if (host.fingerprint case final fp?) ...[
              const SizedBox(height: 14),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
                decoration: ShapeDecoration(
                  color: colors.codeWellBg,
                  shape: Squircle.border(AppShape.md, side: BorderSide(color: colors.codeWellBorder, width: 0.5)),
                ),
                child: SelectableText(
                  fp,
                  style: AppType.mono(size: 18, color: colors.codeWellFg, height: 1.3, weight: FontWeight.w500),
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              l10n.remoteHostKeyChangeWarning,
              style: theme.textTheme.bodySmall?.copyWith(color: colors.textTertiary),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: Text(l10n.commonCancel)),
        FilledButton(
          style: keyChanged
              ? FilledButton.styleFrom(backgroundColor: colors.danger, foregroundColor: colors.onDanger)
              : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(keyChanged ? l10n.remoteHostKeyTrustAgain : l10n.remoteHostKeyTrustConnect),
        ),
      ],
    );
  }
}

class _Fetching extends StatelessWidget {
  const _Fetching();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    return PopScope(
      canPop: false,
      child: AlertDialog(
        content: Row(
          children: [
            const SizedBox.square(dimension: 22, child: CircularProgressIndicator(strokeWidth: 2.4)),
            const SizedBox(width: 18),
            Expanded(child: Text(l10n.remoteHostKeyReading, style: theme.textTheme.bodyMedium)),
          ],
        ),
      ),
    );
  }
}
