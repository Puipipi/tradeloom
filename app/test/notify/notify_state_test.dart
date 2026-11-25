// Where alerts go (system notification, banner, nothing), what gets cleared,
// and how a tap opens the conversation (lib/state/notify_state.dart).

import 'dart:async';

import 'package:dsh_app/state/connection_state.dart';
import 'package:dsh_app/state/hosts_state.dart';
import 'package:dsh_app/state/notify_state.dart';
import 'package:dsh_app/state/sessions_state.dart';
import 'package:dsh_client/dsh_client.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../phone/support.dart' show FakePhoneNative, phoneStatus;
import 'support.dart';

class _Local extends LocalConnectionController {
  _Local(this.connection);

  final HostConnection? connection;

  @override
  Future<HostConnection?> build() async => connection;
}

const _ssh = HostRef.ssh('lab');

class _MutableConnection extends Notifier<HostConnection> {
  _MutableConnection(this.initial);
  final HostConnection initial;
  @override
  HostConnection build() => initial;
  void set(HostConnection connection) => state = connection;
}

ChatAlert _alert(String session, AlertKind kind, {HostRef host = HostRef.local, String key = turnKey}) =>
    ChatAlert(host: host, sessionId: session, kind: kind, key: key, title: 't', text: 'x');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('deliveryFor', () {
    const prefs = NotifyPrefs();
    final done = _alert('s1', AlertKind.done);

    test('background → system, foreground → banner', () {
      expect(deliveryFor(done, prefs: prefs, foreground: false), AlertDelivery.system);
      expect(deliveryFor(done, prefs: prefs, foreground: true), AlertDelivery.banner);
    });

    test('background ignores a stale foreground conversation target', () {
      final ask = _alert('s1', AlertKind.approval, host: _ssh, key: 'e1');
      expect(
        deliveryFor(ask, prefs: prefs, foreground: false, viewed: (host: _ssh, sessionId: 's1')),
        AlertDelivery.system,
      );
      expect(
        deliveryFor(
          ask,
          prefs: const NotifyPrefs(approval: false),
          foreground: false,
          viewed: (host: _ssh, sessionId: 's1'),
        ),
        AlertDelivery.none,
      );
    });

    test('the conversation on screen is never interrupted', () {
      expect(
        deliveryFor(done, prefs: prefs, foreground: true, viewed: (host: HostRef.local, sessionId: 's1')),
        AlertDelivery.none,
      );
      // Same id on another host is another conversation.
      expect(
        deliveryFor(done, prefs: prefs, foreground: true, viewed: (host: _ssh, sessionId: 's1')),
        AlertDelivery.banner,
      );
    });

    test('settings: master switch and one switch per kind', () {
      expect(deliveryFor(done, prefs: const NotifyPrefs(enabled: false), foreground: false), AlertDelivery.none);
      expect(deliveryFor(done, prefs: const NotifyPrefs(done: false), foreground: false), AlertDelivery.none);
      final stopped = _alert('s1', AlertKind.stopped);
      expect(deliveryFor(stopped, prefs: const NotifyPrefs(failed: false), foreground: false), AlertDelivery.none);
      expect(deliveryFor(stopped, prefs: const NotifyPrefs(done: false), foreground: false), AlertDelivery.system);
      final ask = _alert('s1', AlertKind.question);
      expect(deliveryFor(ask, prefs: const NotifyPrefs(approval: false), foreground: false), AlertDelivery.system);
      expect(deliveryFor(ask, prefs: const NotifyPrefs(question: false), foreground: false), AlertDelivery.none);
    });
  });

  test('postFor: grouping, channel and lock-screen text', () {
    final post = postFor(
      const ChatAlert(
        host: _ssh,
        sessionId: 's9',
        kind: AlertKind.approval,
        key: 'e1',
        title: '部署',
        text: '等你确认：运行命令',
        eventId: 'e1',
      ),
    );
    expect(post.group, 'ssh:lab|s9');
    expect(post.attention, isTrue);
    expect(post.canApprove, isFalse);
    expect(post.publicText, '有一步等你确认');
    expect(post.toMap(), containsPair('host', _ssh.encode()));
    expect(post.toMap(), containsPair('eventId', 'e1'));
    expect(postFor(_alert('s1', AlertKind.done)).attention, isFalse);
    expect(postFor(_alert('s1', AlertKind.done)).toMap().containsKey('eventId'), isFalse);
  });

  test('postFor carries verified approval details without changing older callers', () {
    final post = postFor(
      const ChatAlert(
        host: _ssh,
        sessionId: 's9',
        kind: AlertKind.approval,
        key: 'e1',
        eventId: 'e1',
        title: '部署',
        text: '运行：echo ok',
        fullText: '运行：echo ok',
        canApprove: true,
      ),
    );
    expect(post.canApprove, isTrue);
    expect(post.toMap(), containsPair('canApprove', true));
    expect(post.fullText, '运行：echo ok');
  });

  group('NotifyTap.fromMap', () {
    test('parses our payload', () {
      final tap = NotifyTap.fromMap({'sessionId': 's1', 'host': _ssh.encode(), 'kind': 'approval', 'eventId': 'e1'});
      expect(tap, const NotifyTap(host: _ssh, sessionId: 's1', kind: 'approval', eventId: 'e1'));
    });

    test('defaults to 本机 and rejects garbage', () {
      expect(NotifyTap.fromMap({'sessionId': 's1'})!.host, HostRef.local);
      expect(NotifyTap.fromMap({'sessionId': ''}), isNull);
      expect(NotifyTap.fromMap({'host': 'x'}), isNull);
      expect(NotifyTap.fromMap('s1'), isNull);
      expect(NotifyTap.fromMap({'sessionId': 'x' * 300}), isNull);
    });
  });

  group('controller', () {
    late FakeNotifyChannel channel;
    late FakeAlertSource local;
    late FakeAlertSource remote;
    late ProviderContainer container;

    ProviderContainer make({HostConnection? active}) {
      final localConn = fakeHostConnection();
      container = ProviderContainer(
        overrides: [
          notifyChannelProvider.overrideWithValue(channel),
          alertSourceFactoryProvider.overrideWithValue((conn) => conn.isLocal ? local : remote),
          alertTimingProvider.overrideWithValue((announce: Duration.zero, reconcile: const Duration(milliseconds: 30))),
          localConnectionProvider.overrideWith(() => _Local(localConn)),
          activeConnectionProvider.overrideWithValue(AsyncData(active ?? localConn)),
        ],
      );
      addTearDown(container.dispose);
      container.listen(chatAlertsProvider, (_, _) {});
      return container;
    }

    setUp(() {
      SharedPreferences.setMockInitialValues({});
      channel = FakeNotifyChannel();
      local = FakeAlertSource()..sessions = [session('s1', title: '修复登录按钮'), session('s2', title: '深色模式')];
      remote = FakeAlertSource()..sessions = [session('r1', title: '服务器上的任务')];
    });

    Future<void> foreground(bool value) async {
      container.read(appForegroundProvider.notifier).set(value);
      await settle();
    }

    test('in the background: a system notification', () async {
      make();
      await settle();
      await foreground(false);
      local.emit(approval('e1', 's1'));
      await settle();
      expect(channel.shown, hasLength(1));
      final post = channel.shown.single;
      expect(post.group, 'local:local|s1');
      expect(post.key, 'e1');
      expect(post.attention, isTrue);
      expect(post.title, '修复登录按钮');
      expect(post.publicText, '有一步等你确认');
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('in the foreground on another conversation: a banner', () async {
      make();
      await settle();
      container.read(currentSessionProvider.notifier).select('s2');
      await settle();
      local.emit(question('q1', 's1', ['继续吗？']));
      await settle();
      expect(channel.shown, isEmpty);
      expect(container.read(chatAlertsProvider)?.sessionId, 's1');
    });

    test('on the conversation itself: nothing', () async {
      make();
      await settle();
      container.read(currentSessionProvider.notifier).select('s1');
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      expect(channel.shown, isEmpty);
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('a page over the chat counts as not looking: banner', () async {
      make();
      await settle();
      container.read(currentSessionProvider.notifier).select('s1');
      container.read(chatOnScreenProvider.notifier).set(false);
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      expect(container.read(chatAlertsProvider)?.key, 'e1');
    });

    test('opening the conversation clears its notifications and banner', () async {
      make();
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      expect(container.read(chatAlertsProvider), isNotNull);
      container.read(chatAlertsProvider.notifier).open(HostRef.local, 's1');
      await settle();
      expect(container.read(currentSessionProvider), 's1');
      expect(channel.cancelledGroups, contains('local:local|s1'));
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('answered elsewhere: notification and banner withdrawn', () async {
      make();
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      local.emit(const HostRequestCancelledEvent('e1'));
      await settle();
      expect(channel.cancelled, [('local:local|s1', 'e1')]);
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('leaving the app with a banner up keeps it as a notification', () async {
      make();
      await settle();
      local.emit(approval('e1', 's2'));
      await settle();
      expect(container.read(chatAlertsProvider), isNotNull);
      await foreground(false);
      expect(container.read(chatAlertsProvider), isNull);
      expect(channel.shown.single.key, 'e1');
    });

    test('settings off: nothing at all', () async {
      make();
      await settle();
      await container.read(notifyPrefsProvider.notifier).setEnabled(false);
      expect(channel.cancelledAll, 1, reason: 'switching off clears the shade');
      await foreground(false);
      local.emit(approval('e1', 's1'));
      await settle();
      expect(channel.shown, isEmpty);
    });

    test('a newer banner replaces the older; dismissing an old one is a no-op', () async {
      make();
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      final first = container.read(chatAlertsProvider)!;
      local.emit(approval('e2', 's2'));
      await settle();
      final second = container.read(chatAlertsProvider)!;
      expect(second.key, 'e2');
      container.read(chatAlertsProvider.notifier).dismissBanner(first);
      expect(container.read(chatAlertsProvider), same(second));
      container.read(chatAlertsProvider.notifier).dismissBanner(second);
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('a remote host is watched too, and its taps switch hosts', () async {
      SharedPreferences.setMockInitialValues({});
      make(
        active: fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab'),
      );
      await settle();
      await foreground(false);
      remote.emit(approval('e9', 'r1'));
      local.emit(approval('e1', 's1'));
      await settle();
      expect(channel.shown.map((p) => p.group), unorderedEquals(['ssh:lab|r1', 'local:local|s1']));
      expect(channel.shown.firstWhere((p) => p.key == 'e9').host, _ssh);

      // Tapping the local one switches back to 本机 and opens it.
      container.read(chatAlertsProvider.notifier).open(HostRef.local, 's1');
      expect(container.read(activeHostProvider), HostRef.local);
      expect(container.read(currentSessionProvider), 's1');
    });

    for (final kind in [HostKind.ssh, HostKind.relay]) {
      test('$kind current-chat requests become system reminders on background', () async {
        final host = kind == HostKind.ssh ? _ssh : const HostRef.relay('lab');
        make(
          active: fakeHostConnection(local: false, kind: kind, hostId: 'lab'),
        );
        container.read(activeHostProvider.notifier).select(host);
        container.read(currentSessionProvider.notifier).select('r1');
        await settle();
        expect(container.read(viewedChatProvider), (host: host, sessionId: 'r1'));
        remote.emit(approval('e9', 'r1'));
        remote.emit(question('q9', 'r1', ['Continue?']));
        await settle();
        expect(channel.shown, isEmpty);
        expect(container.read(chatAlertsProvider), isNull, reason: 'current chat stays quiet');
        await foreground(false);
        expect(channel.shown.map((p) => p.key), unorderedEquals(['e9', 'q9']));
        expect(channel.shown.every((p) => p.host == host && p.attention), isTrue);
        await foreground(false);
        expect(channel.shown, hasLength(2), reason: 'same lifecycle value does not reannounce');
      });
    }

    test('a remote attention banner migrates only once, not again from pending', () async {
      make(
        active: fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab'),
      );
      await settle();
      remote.emit(approval('e9', 'r1'));
      await settle();
      expect(container.read(chatAlertsProvider)?.key, 'e9');
      await foreground(false);
      expect(channel.shown.single.key, 'e9');
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('a withdrawn remote banner is not recovered on background', () async {
      make(
        active: fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab'),
      );
      await settle();
      remote.emit(approval('e9', 'r1'));
      await settle();
      remote.emit(const HostRequestCancelledEvent('e9'));
      await foreground(false);
      expect(channel.shown, isEmpty);
      expect(container.read(chatAlertsProvider), isNull);
    });

    test('a request announced across the foreground edge posts only once', () async {
      make(
        active: fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab'),
      );
      await settle();
      remote.emit(question('q9', 'r1', ['Continue?']));
      container.read(appForegroundProvider.notifier).set(false);
      await settle();
      expect(channel.shown.single.key, 'q9');
    });

    test('remote background recovery still respects per-kind notification settings', () async {
      make(
        active: fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab'),
      );
      await settle();
      remote.emit(approval('e9', 'r1'));
      remote.emit(question('q9', 'r1', ['Continue?']));
      await settle();
      await container.read(notifyPrefsProvider.notifier).setApproval(false);
      await foreground(false);
      expect(channel.shown.single.key, 'q9');
    });

    test('a terminal outcome seen in the current chat stays quiet after leaving', () async {
      make();
      container.read(currentSessionProvider.notifier).select('s1');
      await settle();
      local.outcomes['s1'] = outcome(8, 'completed');
      local.emit(const SessionStatusEvent('s1', true));
      local.emit(const SessionStatusEvent('s1', false));
      await settle();
      expect(channel.shown, isEmpty);
      expect(container.read(chatAlertsProvider), isNull);
      await foreground(false);
      expect(channel.shown, isEmpty, reason: 'only pending requests are recovered');
    });

    test('background recovery keeps the local phone prompt ahead of system alerts', () async {
      final reply = Completer<Map<String, Object?>>();
      addTearDown(() {
        if (!reply.isCompleted) reply.complete({'decision': 'stopped', 'presented': 'none'});
      });
      final native = FakePhoneNative(status: phoneStatus())
        ..onPresentPrompt = ((_) => reply.future)
        ..install();
      make();
      container.read(currentSessionProvider.notifier).select('s1');
      await settle();
      local.emit(approval('e1', 's1'));
      await settle();
      expect(native.callsOf('presentPrompt'), isEmpty);
      expect(channel.shown, isEmpty);
      await foreground(false);
      expect(native.callsOf('presentPrompt'), hasLength(1));
      expect(channel.shown, isEmpty, reason: 'no parallel system reminder for the local phone prompt');
      reply.complete({'decision': 'stopped', 'presented': 'none'});
      await settle();
    });

    test('C907 a same-client rename retains request history; a new client retires it', () async {
      final old = fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab');
      final selected = NotifierProvider<_MutableConnection, HostConnection>(() => _MutableConnection(old));
      final request = question('q1', 'r1', ['继续吗？']);
      remote.pending = [request];
      var sources = 0;
      container = ProviderContainer(
        overrides: [
          notifyChannelProvider.overrideWithValue(channel),
          alertSourceFactoryProvider.overrideWithValue((_) {
            sources++;
            return remote;
          }),
          alertTimingProvider.overrideWithValue((announce: Duration.zero, reconcile: const Duration(milliseconds: 30))),
          localConnectionProvider.overrideWith(() => _Local(null)),
          activeConnectionProvider.overrideWith((ref) => AsyncData(ref.watch(selected))),
        ],
      );
      addTearDown(container.dispose);
      final banners = <ChatAlert>[];
      container.listen(chatAlertsProvider, (_, alert) {
        if (alert != null) banners.add(alert);
      });
      await settle();
      expect(banners, hasLength(1));
      final first = banners.single;
      final controller = container.read(chatAlertsProvider.notifier);
      controller.dismissBanner(first);
      final renamed = HostConnection(
        client: old.client,
        isLocal: false,
        kind: HostKind.ssh,
        hostId: 'lab',
        name: 'renamed',
      );
      container.read(selected.notifier).set(renamed);
      await settle();
      expect(sources, 1);
      expect(banners, hasLength(1));
      expect(container.read(chatAlertsProvider), isNull);
      // No ready generation in this fake; reaching 'failed' instead of 'gone'
      // demonstrates that the original pet request scope/token survived rename.
      expect(
        await controller.answerFromPet(_ssh, 'q1', sessionId: 'r1', token: first.petToken!),
        NotifyActionResult.failed,
      );

      final replacement = fakeHostConnection(local: false, kind: HostKind.ssh, hostId: 'lab');
      container.read(selected.notifier).set(replacement);
      await settle();
      expect(sources, 2);
      expect(banners, hasLength(2));
      expect(banners.last.petToken, isNot(first.petToken));
      expect(
        await controller.answerFromPet(_ssh, 'q1', sessionId: 'r1', token: first.petToken!),
        NotifyActionResult.gone,
      );
    });
  });

  group('NotifyPrefs', () {
    test('defaults on, persisted, and a flip right after launch survives the load', () async {
      SharedPreferences.setMockInitialValues({'notify_question': false});
      final c = ProviderContainer();
      addTearDown(c.dispose);
      await c.read(notifyPrefsProvider.notifier).setDone(false);
      final prefs = c.read(notifyPrefsProvider);
      expect(prefs.loaded, isTrue);
      expect(prefs.enabled, isTrue);
      expect(prefs.done, isFalse);
      expect(prefs.question, isFalse);
      expect((await SharedPreferences.getInstance()).getBool('notify_done'), isFalse);
    });
  });

  group('viewedChatProvider', () {
    test('needs the app and the chat on screen and an open conversation', () async {
      SharedPreferences.setMockInitialValues({});
      final c = ProviderContainer();
      addTearDown(c.dispose);
      expect(c.read(viewedChatProvider), isNull, reason: 'new chat');
      c.read(currentSessionProvider.notifier).select('s1');
      expect(c.read(viewedChatProvider), (host: HostRef.local, sessionId: 's1'));
      c.read(appForegroundProvider.notifier).set(false);
      expect(c.read(viewedChatProvider), isNull);
      c.read(appForegroundProvider.notifier).set(true);
      c.read(chatOnScreenProvider.notifier).set(false);
      expect(c.read(viewedChatProvider), isNull);
    });

    test('on a call, the call\'s conversation, though the chat is under the call page', () async {
      SharedPreferences.setMockInitialValues({});
      final c = ProviderContainer();
      addTearDown(c.dispose);
      c.read(currentSessionProvider.notifier).select('s1');
      c.read(chatOnScreenProvider.notifier).set(false);
      c.read(callChatProvider.notifier).set((host: HostRef.local, sessionId: 's2'));
      expect(c.read(viewedChatProvider), (host: HostRef.local, sessionId: 's2'));
      c.read(appForegroundProvider.notifier).set(false);
      expect(c.read(viewedChatProvider), isNull);
      c.read(appForegroundProvider.notifier).set(true);
      c.read(callChatProvider.notifier).set(null);
      expect(c.read(viewedChatProvider), isNull);
    });
  });
}
