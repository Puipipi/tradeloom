// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../l10n/l10n.dart';
import '../theme/app_icons.dart';
import '../theme/theme.dart';
import '../web/web_view_page.dart';
import 'tradeloom_mesh_page.dart';
import 'tradeloom_origin.dart';

/// TradeLoom's server-rendered portal, kept separate from DSH Web and its
/// local runtime. Authentication and permissions remain server-owned.
class TradeLoomWorkbenchPage extends StatefulWidget {
  const TradeLoomWorkbenchPage({super.key});

  static const originKey = 'tradeloom_workbench_origin';

  @override
  State<TradeLoomWorkbenchPage> createState() => _TradeLoomWorkbenchPageState();
}

class _TradeLoomWorkbenchPageState extends State<TradeLoomWorkbenchPage> {
  final _origin = TextEditingController();
  bool _loading = true;
  bool _invalid = false;

  @override
  void initState() {
    super.initState();
    _loadOrigin();
  }

  @override
  void dispose() {
    _origin.dispose();
    super.dispose();
  }

  Future<void> _loadOrigin() async {
    String? value;
    try {
      value = await SharedPreferences.getInstance().then(
        (p) => p.getString(TradeLoomWorkbenchPage.originKey),
      );
    } catch (_) {
      // The origin is a convenience setting; the person can still connect.
    }
    if (!mounted) return;
    if (value != null) _origin.text = value;
    setState(() => _loading = false);
  }

  Future<void> _connect({bool receiveWorkflow = false}) async {
    final l10n = context.l10n;
    final origin = parseTradeLoomOrigin(_origin.text);
    if (origin == null) {
      setState(() => _invalid = true);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(l10n.tradeloomOriginInvalid)));
      return;
    }
    final normalized = origin.origin;
    _origin.text = normalized;
    setState(() => _invalid = false);
    try {
      await SharedPreferences.getInstance().then(
        (p) => p.setString(TradeLoomWorkbenchPage.originKey, normalized),
      );
    } catch (_) {
      // Open the portal for this run even when the local preference backend is unavailable.
    }
    if (!mounted) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => WebViewPage(
          url: receiveWorkflow
              ? origin.replace(path: '/enterprise/workflow-handoff/')
              : origin.replace(
                  path: '/accounts/login/',
                  queryParameters: const {'next': '/enterprise/'},
                ),
          title: receiveWorkflow
              ? l10n.tradeloomReceiveWorkflow
              : l10n.tradeloomLoginTitle,
          subtitle: receiveWorkflow ? null : l10n.tradeloomLoginSubtitle,
          nativeContentInsets: true,
          navigationOrigin: origin,
          tradeLoomDownloads: true,
          navigationPolicyError: l10n.tradeloomNavigationPolicyError,
          navigationBlockedMessage: l10n.tradeloomNavigationBlocked,
          allowOpenExternal: false,
          externalDisabledReason: l10n.tradeloomOriginInvalid,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.tradeloomWorkbenchTitle)),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 600),
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 24, 20, 32),
              children: [
                Container(
                  padding: const EdgeInsets.all(22),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerLow,
                    borderRadius: BorderRadius.circular(AppShape.xl),
                    border: Border.all(color: theme.colorScheme.outlineVariant),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(
                        AppIcons.webApp,
                        size: 30,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        l10n.tradeloomWorkbenchTitle,
                        style: theme.textTheme.headlineSmall,
                      ),
                      const SizedBox(height: 6),
                      Text(
                        l10n.tradeloomWorkbenchSubtitle,
                        style: theme.textTheme.bodyMedium,
                      ),
                      const SizedBox(height: 24),
                      TextField(
                        controller: _origin,
                        enabled: !_loading,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        enableSuggestions: false,
                        textInputAction: TextInputAction.go,
                        onSubmitted: (_) => _connect(),
                        onChanged: (_) {
                          if (_invalid) setState(() => _invalid = false);
                        },
                        decoration: InputDecoration(
                          labelText: l10n.tradeloomOriginLabel,
                          hintText: l10n.tradeloomOriginHint,
                          errorText: _invalid
                              ? l10n.tradeloomOriginInvalid
                              : null,
                          prefixIcon: const Icon(AppIcons.webApp),
                          border: const OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 18),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                          onPressed: _loading ? null : _connect,
                          icon: const Icon(AppIcons.webApp),
                          label: Text(l10n.tradeloomConnect),
                        ),
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: _loading
                              ? null
                              : () => _connect(receiveWorkflow: true),
                          icon: const Icon(AppIcons.swap),
                          label: Text(l10n.tradeloomReceiveWorkflow),
                        ),
                      ),
                      const SizedBox(height: 8),
                      SizedBox(
                        width: double.infinity,
                        child: OutlinedButton.icon(
                          onPressed: () => Navigator.of(context).push<void>(
                            MaterialPageRoute(builder: (_) => const TradeLoomMeshPage()),
                          ),
                          icon: const Icon(AppIcons.link),
                          label: Text(l10n.tradeloomMeshTitle),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Text(
                    l10n.tradeloomOriginHelp,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
