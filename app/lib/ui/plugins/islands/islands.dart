/// Web islands (docs/design/plugin-seams.md §6–§9): DSH Web's own client
/// with everything hidden but one plugin slot, in a native seat.
library;

export 'island_assets.dart';
export 'island_budget.dart';
export 'island_gate.dart';
export 'island_handle.dart' show IslandHandle, IslandPhase, IslandTiming;
export 'island_host.dart' show IslandHost, islandHostProvider, liveIslandBudgetProvider;
export 'island_messages.dart';
export 'island_navigation.dart';
export 'island_platform.dart';
export 'island_recipes.dart';
export 'island_skeleton.dart';
export 'island_theme.dart';
export 'island_view.dart';
