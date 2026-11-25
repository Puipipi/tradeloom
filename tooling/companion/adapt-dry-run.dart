// Generate the real request, or check a recorded candidate, without an API key.
// dart tooling/companion/adapt-dry-run.dart probe.json [candidate.json]
import 'dart:convert';
import 'dart:io';

import '../../app/lib/companion/companion_adapt_contract.dart';

Object? read(String path) {
  final file = File(path);
  if (file.lengthSync() > 1024 * 1024) throw const FormatException('Input exceeds 1 MiB');
  return jsonDecode(file.readAsStringSync());
}

void main(List<String> args) {
  try {
    if (args.isEmpty || args.length > 2) throw const FormatException('Expected probe.json [candidate.json]');
    final probe = CompanionProbe.fromJson(read(args.first));
    if (probe == null) throw const FormatException('Probe must be an object');
    if (args.length == 1) {
      print(companionAdaptRequest(probe));
      return;
    }
    final raw = read(args[1]);
    if (raw is! Map) throw const FormatException('Candidate must be an object');
    final result = companionAdapterCheck(raw.cast<String, Object?>(), probe);
    print(const JsonEncoder.withIndent('  ').convert({
      'adapter': result.adapter,
      'dropped': result.dropped,
      'empty': companionAdapterEmpty(result.adapter),
      'visualValidation': 'not-run',
    }));
  } on Object catch (error) {
    stderr.writeln('Dry run failed: $error');
    exitCode = 2;
  }
}
