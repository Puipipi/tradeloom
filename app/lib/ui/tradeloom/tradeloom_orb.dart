// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'package:flutter/material.dart';

import '../theme/app_icons.dart';

/// An in-app shortcut to the existing TradeLoom Workbench entry.
///
/// It stays inside HomeShell, so it needs no system overlay permission and
/// works the same way on Android, iOS, and HarmonyOS. Authentication and
/// account capabilities remain with the workbench server.
class TradeLoomOrb extends StatelessWidget {
  const TradeLoomOrb({
    super.key,
    required this.label,
    required this.hint,
    required this.onTap,
    required this.onLongPress,
  });

  final String label;
  final String hint;
  final VoidCallback onTap;
  final VoidCallback onLongPress;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: label,
      hint: hint,
      onTap: onTap,
      onLongPress: onLongPress,
      child: Tooltip(
        message: '$label · $hint',
        child: SizedBox.square(
          dimension: 56,
          child: DecoratedBox(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [colors.primary, colors.tertiary],
              ),
              boxShadow: [
                BoxShadow(color: colors.primary.withValues(alpha: 0.3), blurRadius: 14, offset: const Offset(0, 5)),
              ],
            ),
            child: Material(
              type: MaterialType.transparency,
              shape: const CircleBorder(),
              child: InkWell(
                customBorder: const CircleBorder(),
                onTap: onTap,
                onLongPress: onLongPress,
                child: Icon(AppIcons.webApp, color: colors.onPrimary, size: 25),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
