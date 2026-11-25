import 'package:dsh_app/phone/phone_channel.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _channel = MethodChannel('dsh/phone');
const _skill = 'phone-task-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const _revision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _invocation = 'cccccccccccccccccccccccccccccccc';
const _available = {'kind': 'available', 'revision': _revision, 'summary': 'Public navigation',
  'apps': [{'packageName': 'test.app', 'uid': 10002, 'label': 'Test app'}]};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  tearDown(() => messenger.setMockMethodCallHandler(_channel, null));

  test('private inspection choice is sent with exact revision and typed PM pair', () async {
    final calls = <MethodCall>[];
    messenger.setMockMethodCallHandler(_channel, (call) async {
      calls.add(call);
      return switch (call.method) {
        'inspectSkillReplay' => _available,
        'prepareSkillReplay' => {'kind': 'ready', 'invocation': _invocation, 'revision': _revision, 'parameterNames': []},
        'discardSkillReplay' => {'kind': 'discarded'},
        _ => throw StateError('unexpected method'),
      };
    });
    final phone = PhoneChannel();
    final inspected = await phone.inspectSkillReplay(_skill);
    expect(inspected.available, isTrue);
    expect(inspected.summary, 'Public navigation');
    final app = inspected.apps.single;
    expect((app.packageName, app.uid, app.label), ('test.app', 10002, 'Test app'));
    final ready = await phone.prepareSkillReplay(skillId: _skill, revision: inspected.revision!, sessionId: 'S', app: app);
    expect((ready!.invocation, ready.revision), (_invocation, _revision));
    expect(await phone.discardSkillReplay(ready.invocation), isTrue);
    expect(calls.map((c) => c.method).toList(), ['inspectSkillReplay', 'prepareSkillReplay', 'discardSkillReplay']);
    expect(calls[0].arguments, {'skillId': _skill});
    expect(calls[1].arguments, {'skillId': _skill, 'revision': _revision, 'sessionId': 'S',
      'parameters': {'appSlots': {'app1': {'packageName': 'test.app', 'uid': 10002}}, 'values': {}}});
    expect(calls[2].arguments, {'invocation': _invocation});
  });

  test('unsupported native inspection is not an available synthetic route', () async {
    messenger.setMockMethodCallHandler(_channel, (_) async => {'kind': 'rejected', 'reason': 'unsupported'});
    final result = await PhoneChannel().inspectSkillReplay(_skill);
    expect(result.available, isFalse);
    expect(result.apps, isEmpty);
    expect(result.revision, isNull);
    expect(result.reason, 'unsupported');
  });

  test('invalid PM identities and unrequested ready parameters are not accepted', () async {
    for (final uid in [null, true, 10002.0, '10002', -1, 2147483648]) {
      messenger.setMockMethodCallHandler(_channel, (_) async => {..._available,
        'apps': [{'packageName': 'test.app', 'uid': uid, 'label': 'Test app'}]});
      expect((await PhoneChannel().inspectSkillReplay(_skill)).available, isFalse);
    }
    messenger.setMockMethodCallHandler(_channel, (_) async => {'kind': 'ready', 'invocation': _invocation,
      'revision': _revision, 'parameterNames': ['private']});
    expect(await PhoneChannel().prepareSkillReplay(skillId: _skill, revision: _revision, sessionId: 'S',
      app: const PhoneSkillReplayApp(packageName: 'test.app', uid: 10002, label: 'Test app')), isNull);
  });

  test('private channel errors do not expose native text or report cancellation success', () async {
    messenger.setMockMethodCallHandler(_channel, (_) async => throw PlatformException(code: 'io', message: 'private path'));
    final phone = PhoneChannel();
    expect((await phone.inspectSkillReplay(_skill)).reason, 'unavailable');
    expect(await phone.discardSkillReplay(_invocation), isFalse);
  });
}
