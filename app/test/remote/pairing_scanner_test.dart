import 'dart:async';

import 'package:dsh_app/ui/remote/pairing_page.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../chat/support/harness.dart';

const _code = 'test pairing code';

class _Scanner extends MobileScannerPlatform {
  final captures = StreamController<BarcodeCapture?>.broadcast();
  int starts = 0;
  int analyses = 0;
  MobileScannerException? cameraError;
  bool imageFails = false;

  @override
  Stream<BarcodeCapture?> get barcodesStream => captures.stream;
  @override
  Stream<TorchState> get torchStateStream => const Stream.empty();
  @override
  Stream<double> get zoomScaleStateStream => const Stream.empty();

  @override
  Future<MobileScannerViewAttributes> start(StartOptions options) async {
    starts++;
    if (cameraError case final error?) throw error;
    return const MobileScannerViewAttributes(
      cameraDirection: CameraFacing.back,
      currentTorchMode: TorchState.off,
      size: Size(640, 480),
    );
  }

  @override
  Widget buildCameraView() => const ColoredBox(color: Colors.black);
  @override
  Future<void> stop() async {}
  @override
  Future<void> dispose() async {}

  @override
  Future<BarcodeCapture?> analyzeImage(String path, {List<BarcodeFormat> formats = const []}) async {
    analyses++;
    if (imageFails) throw PlatformException(code: 'image_decode_failed');
    return BarcodeCapture(barcodes: [const Barcode(rawValue: _code)]);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const appChannel = MethodChannel('dsh/app');
  const photoChannel = MethodChannel('plugins.flutter.io/image_picker');
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late MobileScannerPlatform original;
  late _Scanner scanner;
  late Completer<void> initialized;
  late List<String> reported;
  late int preparations;

  Widget app() => testApp(
    Scaffold(body: Consumer(builder: (context, ref, _) => ref.watch(pairingScannerProvider)(context, reported.add))),
  );

  setUp(() {
    expect(defaultTargetPlatform, TargetPlatform.android);
    original = MobileScannerPlatform.instance;
    scanner = _Scanner();
    MobileScannerPlatform.instance = scanner;
    reported = [];
    preparations = 0;
    messenger.setMockMethodCallHandler(appChannel, (call) {
      expect(call.method, 'initializePairingScanner');
      preparations++;
      return initialized.future;
    });
    messenger.setMockMethodCallHandler(photoChannel, (call) async {
      expect(call.method, 'pickImage');
      return '/pairing-code.png';
    });
  });

  tearDown(() async {
    MobileScannerPlatform.instance = original;
    messenger.setMockMethodCallHandler(appChannel, null);
    messenger.setMockMethodCallHandler(photoChannel, null);
    await scanner.captures.close();
  });

  testWidgets('camera waits for native initialization, once per scanner, then reports a code', (tester) async {
    initialized = Completer<void>();
    await tester.pumpWidget(app());
    await tester.pump();
    expect(preparations, 1);
    expect(find.byType(MobileScanner), findsNothing);
    expect(scanner.starts, 0);
    await tester.pumpWidget(app());
    expect(preparations, 1);

    initialized.complete();
    await tester.pumpAndSettle();
    expect(find.byType(MobileScanner), findsOneWidget);
    expect(scanner.starts, 1);
    scanner.captures.add(BarcodeCapture(barcodes: [const Barcode(rawValue: _code)]));
    await tester.pump();
    expect(reported, [_code]);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('photo decoding also waits for initialization without waiting for camera permission', (tester) async {
    initialized = Completer<void>();
    scanner.cameraError = const MobileScannerException(errorCode: MobileScannerErrorCode.permissionDenied);
    await tester.pumpWidget(app());
    await tester.tap(find.text('从相册识别'));
    await tester.pump();
    expect(scanner.analyses, 0);
    expect(scanner.starts, 0);

    initialized.complete();
    await tester.pumpAndSettle();
    expect(scanner.analyses, 1);
    expect(reported, [_code]);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('a denied camera still allows photo decoding after initialization', (tester) async {
    initialized = Completer<void>();
    scanner.cameraError = const MobileScannerException(errorCode: MobileScannerErrorCode.permissionDenied);
    initialized.complete();
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    expect(find.textContaining('没有相机权限'), findsOneWidget);
    await tester.tap(find.text('从相册识别'));
    await tester.pumpAndSettle();
    expect(scanner.analyses, 1);
    expect(reported, [_code]);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('SDK initialization failure never starts either decoder or claims an image has no code', (tester) async {
    initialized = Completer<void>();
    await tester.pumpWidget(app());
    await tester.tap(find.text('从相册识别'));
    await tester.pump();
    initialized.completeError(PlatformException(code: 'scanner_initialization_failed'));
    await tester.pumpAndSettle();
    expect(scanner.starts, 0);
    expect(scanner.analyses, 0);
    expect(find.textContaining('二维码识别器不可用'), findsWidgets);
    expect(find.text('这张图里没找到二维码'), findsNothing);
    expect(reported, isEmpty);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('leaving while initialization is pending cannot start a camera or decode a selected photo later', (
    tester,
  ) async {
    initialized = Completer<void>();
    await tester.pumpWidget(app());
    await tester.tap(find.text('从相册识别'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    initialized.complete();
    await tester.pumpAndSettle();
    expect(scanner.starts, 0);
    expect(scanner.analyses, 0);
    expect(reported, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a photo decoder exception is not misreported as a missing QR code', (tester) async {
    initialized = Completer<void>();
    scanner.imageFails = true;
    initialized.complete();
    await tester.pumpWidget(app());
    await tester.pumpAndSettle();
    await tester.tap(find.text('从相册识别'));
    await tester.pumpAndSettle();
    expect(scanner.analyses, 1);
    expect(find.textContaining('二维码识别器不可用'), findsOneWidget);
    expect(find.text('这张图里没找到二维码'), findsNothing);
    expect(reported, isEmpty);
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
