import 'package:dsh_app/companion/companion_keeper.dart';
import 'package:dsh_client/dsh_client.dart';

/// Light mode's keeper for widget tests, in memory: real file I/O doesn't run
/// on the test clock (the file store has its own tests in dsh_client). With no
/// [state] it keeps nothing, as a phone that can't keep her state would.
class FakePhoneKeeper implements CompanionKeeper {
  FakePhoneKeeper({this.state, this.closenessAfter, this.remembered});

  CompanionSnapshot? state;
  final events = <String>[];

  /// Her closeness after the next event, to cross a step on purpose.
  double? closenessAfter;

  /// What she has been asked to remember; null for a keeper without memories.
  List<CompanionMemory>? remembered;

  static CompanionSnapshot snapshotOf({
    int revision = 0,
    String activity = 'idle',
    int? activityUntil,
    double closeness = 0.01,
  }) => CompanionSnapshot.fromJson({
    'storeId': 'd0a90d66-ff37-4f2a-b31c-194c791ec651',
    'revision': revision,
    'memoryRevision': 0,
    'capabilities': {'persistence': 'local', 'memories': true, 'automaticRecall': false},
    'asOf': 1793899800000,
    'state': {
      'valence': 0.35,
      'energy': 0.75,
      'closeness': closeness,
      'activity': activity,
      'activityUntil': activityUntil,
    },
  })!;

  @override
  Future<CompanionSnapshot?> snapshot() async => state;

  @override
  Future<CompanionSnapshot> event(CompanionSnapshot read, String type) async {
    events.add(type);
    final next = snapshotOf(
      revision: read.revision + 1,
      closeness: closenessAfter ?? read.vitals.closeness,
      activity: const {'snack', 'play', 'rest'}.contains(type) ? type : 'idle',
      activityUntil: const {'snack', 'play', 'rest'}.contains(type) ? 1793899800000 + 45000 : null,
    );
    state = next;
    return next;
  }

  @override
  Future<CompanionMemories> memories() async => switch (remembered) {
    final list? => CompanionMemories(storeId: 'd0a90d66-ff37-4f2a-b31c-194c791ec651', revision: 0, memories: list),
    null => throw UnsupportedError('no memories in this fake'),
  };

  @override
  Future<int> saveMemory(String storeId, int revision, CompanionMemory memory) async => revision + 1;

  @override
  Future<int> deleteMemory(String storeId, int revision, String id) async => revision + 1;
}
