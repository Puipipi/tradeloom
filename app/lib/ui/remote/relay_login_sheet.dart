import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../state/hosts_state.dart';
import '../common/app_sheet.dart';
import '../common/sheet_title_bar.dart';
import '../theme/theme.dart';

/// Select a self-hosted DSH Remote server or sign in with email and password.
/// Returns true only after password sign-in, not after selecting a server.
Future<bool?> showSelfHostedLogin(BuildContext context, {String? initialServer}) {
  return showAppSheet<bool>(
    context,
    dismissal: SheetDismissal.button,
    isScrollControlled: true,
    builder: (_) => SelfHostedLoginSheet(initialServer: initialServer),
  );
}

class SelfHostedLoginSheet extends ConsumerStatefulWidget {
  const SelfHostedLoginSheet({super.key, this.initialServer});

  final String? initialServer;

  @override
  ConsumerState<SelfHostedLoginSheet> createState() => _SelfHostedLoginSheetState();
}

class _SelfHostedLoginSheetState extends ConsumerState<SelfHostedLoginSheet> {
  late final _server = TextEditingController(text: widget.initialServer ?? ref.read(relayServerProvider) ?? '');
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _server.dispose();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _login({bool withPassword = true}) async {
    if (_busy) return;
    FocusManager.instance.primaryFocus?.unfocus();
    if (withPassword && (_server.text.trim().isEmpty || _email.text.trim().isEmpty || _password.text.isEmpty)) {
      setState(() => _error = context.l10n.remoteRelayLoginRequired);
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final server = ref.read(relayServerProvider.notifier);
      if (withPassword) {
        await server.loginWithPassword(server: _server.text, email: _email.text, password: _password.text);
      } else {
        await server.useServer(_server.text);
      }
      if (mounted) Navigator.of(context).pop(withPassword);
    } on HostLinkError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = context.l10n.remoteErrSignIn);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final colors = DshColors.of(context);
    final custom = ref.watch(relayServerProvider);
    final insets = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: insets),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SheetTitleBar(l10n.remoteSelfHostedServer),
              Padding(
                padding: const EdgeInsets.fromLTRB(SheetTitleBar.inset, 0, SheetTitleBar.inset, 16),
                child: Text(
                  l10n.remoteSelfHostedSignInHelp,
                  style: theme.textTheme.bodyMedium?.copyWith(color: colors.textTertiary),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: SheetTitleBar.inset),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  spacing: 12,
                  children: [
                    TextField(
                      controller: _server,
                      keyboardType: TextInputType.url,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      style: AppType.mono(size: 14, color: theme.colorScheme.onSurface, height: 1.4),
                      decoration: InputDecoration(
                        labelText: l10n.remoteServerAddress,
                        hintText: 'https://remote.example.com',
                      ),
                    ),
                    TextField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      autofillHints: const [AutofillHints.email],
                      decoration: InputDecoration(labelText: l10n.remoteEmail),
                    ),
                    TextField(
                      controller: _password,
                      obscureText: true,
                      obscuringCharacter: '•',
                      autocorrect: false,
                      enableSuggestions: false,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _login(),
                      decoration: InputDecoration(labelText: l10n.remotePassword),
                    ),
                    if (_error case final e?) Text(e, style: theme.textTheme.bodySmall?.copyWith(color: colors.danger)),
                    FilledButton(
                      onPressed: _busy ? null : _login,
                      child: _busy
                          ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : Text(l10n.commonSignIn),
                    ),
                    TextButton(
                      onPressed: _busy ? null : () => _login(withPassword: false),
                      child: Text(l10n.remoteUseServer),
                    ),
                    if (custom != null)
                      TextButton(
                        onPressed: _busy
                            ? null
                            : () async {
                                final navigator = Navigator.of(context);
                                await ref.read(relayServerProvider.notifier).useDefault();
                                navigator.pop();
                              },
                        child: Text(l10n.remoteRestoreServer),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }
}
