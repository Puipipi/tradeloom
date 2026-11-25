import 'package:flutter/foundation.dart';

import '../../../plugins/seams/seat_models.dart';
import 'island_messages.dart';
import 'island_platform.dart';

/// The island memory policy's numbers (docs/design/plugin-seams.md §7).
abstract final class IslandBudgetRules {
  /// What islands cost, PSS in MB, measured on the emulator (Android 15
  /// x86_64, WebView 124, DSH 0.2.1-rc.2, debug build). All WebViews share
  /// one renderer process, so the first island pays for it and for Chromium
  /// in the app process; the next ones add their page.
  ///
  /// - first island: renderer ~145 + app ~+60 = ~200 (paid once; closing
  ///   every island ends the renderer, Chromium stays loaded in the app);
  /// - each more: renderer +5–30.
  static const firstIslandMb = 200;
  static const extraIslandMb = 30;

  /// Above this per extra island, phones of every size keep to one.
  static const singleIslandAboveMb = 150;

  /// Memory classes, GiB of `totalMem`. Android reports 5–10% less than
  /// the box says (a "6 GB" phone shows about 5.6), so the cut-offs sit a
  /// little under the marketed sizes.
  static const twoIslandsFromGb = 5.5;
  static const threeIslandsFromGb = 9.5;

  /// An island off screen stays warm this long (back and forth between a
  /// page and its island costs no reload).
  static const hiddenGrace = Duration(seconds: 30);

  /// In the background islands pause, then all of them go.
  static const backgroundGrace = Duration(seconds: 60);

  /// A spec whose slot isn't there (missing, empty, no client) stays a web
  /// link this long: the recipe doesn't fit this DSH, trying again won't help.
  static const failureMemory = Duration(minutes: 10);

  /// A spec that only ran out of time (a cold start, a lost click, a load
  /// error) gets another go after this.
  static const transientFailureMemory = Duration(seconds: 30);

  /// How long a failure keeps [failure]'s spec a web link; null: not at all
  /// (memory pressure and the renderer aren't the island's fault).
  static Duration? memoryFor(IslandFailure failure) => switch (failure) {
    IslandFailure.slotMissing || IslandFailure.empty || IslandFailure.boot => failureMemory,
    IslandFailure.timeout || IslandFailure.load || IslandFailure.crash => transientFailureMemory,
    IslandFailure.evicted || IslandFailure.renderer => null,
  };
}

/// How many islands may live at once on [device]. [islandMb] is what each
/// island past the first adds.
int maxLiveIslands(IslandDevice device, {int islandMb = IslandBudgetRules.extraIslandMb}) {
  if (device.lowRam || device.totalMem <= 0) return 1;
  if (islandMb > IslandBudgetRules.singleIslandAboveMb) return 1;
  final gb = device.totalMem / (1024 * 1024 * 1024);
  if (gb >= IslandBudgetRules.threeIslandsFromGb) return 3;
  if (gb >= IslandBudgetRules.twoIslandsFromGb) return 2;
  return 1;
}

/// One live island, as the policy sees it.
@immutable
class LiveIsland {
  const LiveIsland({required this.key, required this.form, required this.visible, required this.lastSeen});
  final String key;
  final IslandForm form;
  final bool visible;
  final DateTime lastSeen;
}

/// Rank for keeping an island: what's on screen (page / panel) first, then
/// a visible overlay, then anything off screen (most recently seen first),
/// probes last.
int islandRank(IslandForm form, bool visible) {
  if (form == IslandForm.probe) return 0;
  if (!visible) return 1;
  if (form == IslandForm.overlay) return 2;
  return 3;
}

/// Which islands to close so one of [form] fits under [max]: null when it
/// can't fit without closing one that ranks as high or higher. Overlays go
/// before anything else on screen; among the rest, the least recently seen.
List<String>? evictionsFor(IslandForm form, List<LiveIsland> live, int max, {String? key}) {
  if (key != null && live.any((i) => i.key == key)) return const [];
  final excess = live.length + 1 - max;
  if (excess <= 0) return const [];
  final rank = islandRank(form, true);
  final candidates =
      [
        for (final i in live)
          if (islandRank(i.form, i.visible) < rank) i,
      ]..sort((a, b) {
        final r = islandRank(a.form, a.visible).compareTo(islandRank(b.form, b.visible));
        return r != 0 ? r : a.lastSeen.compareTo(b.lastSeen);
      });
  if (candidates.length < excess) return null;
  return [for (final i in candidates.take(excess)) i.key];
}

/// A snapshot of the runtime's state that tells the seat planner whether an
/// island may open (§7). Cheap and side-effect free; a new one is made
/// whenever the live set, the gate or the renderer changes, so the planner
/// re-plans.
@immutable
class IslandBudgetSnapshot implements IslandBudget {
  const IslandBudgetSnapshot({
    required this.supported,
    required this.max,
    required this.live,
    this.rendererLost = false,
    this.failed = const {},
    this.allowHost,
  });

  /// Android, with the islands plugin answering.
  final bool supported;
  final int max;
  final List<LiveIsland> live;

  /// The renderer died: islands stay closed until the user reopens one.
  final bool rendererLost;

  /// Specs whose ready gate failed recently.
  final Set<String> failed;

  /// The security gate (§9): may this host have islands at all.
  final bool Function(IslandSpec spec)? allowHost;

  @override
  bool canOpen(IslandSpec spec) {
    if (!supported || rendererLost) return false;
    if (!(allowHost?.call(spec) ?? false)) return false;
    if (failed.contains(spec.key)) return false;
    return evictionsFor(spec.form, live, max, key: spec.key) != null;
  }
}
