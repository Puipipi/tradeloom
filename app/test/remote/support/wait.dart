import 'dart:async';

import 'package:dsh_app/remote/link_status.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show ProviderListenable;
import 'package:flutter_test/flutter_test.dart';

Future<T> until<T>(
  ProviderContainer container,
  ProviderListenable<T> provider,
  bool Function(T) ok, {
  required String what,
  Duration timeout = const Duration(seconds: 5),
}) async {
  final done = Completer<T>();
  T? last;
  final sub = container.listen(provider, (_, next) {
    last = next;
    if (!done.isCompleted && ok(next)) done.complete(next);
  }, fireImmediately: true);
  try {
    return await done.future.timeout(
      timeout,
      onTimeout: () {
        fail('等待超时：$what；最后的值：$last');
      },
    );
  } finally {
    sub.close();
  }
}

Future<HostLinkStatus> nextStatus(HostLink link, bool Function(HostLinkStatus) ok, {required String what}) => link
    .statuses
    .firstWhere(ok)
    .timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        fail('等待超时：$what；最后的值：${link.status}');
      },
    );
