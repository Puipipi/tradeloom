// SPDX-FileCopyrightText: 2026 TradeLoom contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/l10n.dart';
import '../../pets/overlay_channel.dart';
import '../common/risk_notice.dart';
import '../settings/settings_widgets.dart';
import '../theme/app_icons.dart';

class TradeLoomOverlayTile extends ConsumerStatefulWidget {
  const TradeLoomOverlayTile({super.key, required this.tint});

  final int tint;

  @override
  ConsumerState<TradeLoomOverlayTile> createState() =>
      _TradeLoomOverlayTileState();
}

class _TradeLoomOverlayTileState extends ConsumerState<TradeLoomOverlayTile> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onResume: () =>
          unawaited(ref.read(petOverlayProvider.notifier).refresh()),
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  Future<void> _change(bool on, PetOverlayStatus status) async {
    final overlay = ref.read(petOverlayProvider.notifier);
    if (!on) {
      await overlay.turnOff();
      return;
    }
    if (!status.permission.usable) {
      final l10n = context.l10n;
      final confirmed = await confirmRisk(
        context,
        RiskNotice(
          id: 'tradeloom.overlay-permission',
          level: RiskLevel.medium,
          title: l10n.riskPetOverlayTitle,
          body: l10n.tradeloomFloatingWorkbenchPermission,
          action: l10n.riskPetOverlayAction,
        ),
      );
      if (!confirmed || !mounted) return;
    }
    await overlay.turnOn();
    if (mounted && status.snoozed) await overlay.unsnooze();
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(petOverlayProvider);
    if (!status.native) return const SizedBox.shrink();
    final l10n = context.l10n;
    return SettingsSwitchTile(
      icon: AppIcons.webApp,
      tint: widget.tint,
      title: l10n.tradeloomFloatingWorkbench,
      subtitle: status.refused || (status.enabled && !status.permission.usable)
          ? l10n.botsPetNotAuthorized
          : status.snoozed
          ? l10n.botsPetHiddenToday
          : null,
      value: status.working && !status.snoozed,
      onChanged: (on) => unawaited(_change(on, status)),
    );
  }
}
