#!/usr/bin/env python3
"""Exercise an already-built dev probe through actual emulator overlay UI.

Does not build/install/start an emulator. Requires the pet-actions probe entry
to be running, overlay + microphone permissions, and adb. Never targets a phone.
"""
import argparse
import json
import re
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET


HARDWARE_SERIAL = 'emulator-5556'
HARDWARE_DEVICE = '/dev/input/event2'
HARDWARE_NAME = 'virtio_input_multi_touch_1'
SCREEN_WIDTH, SCREEN_HEIGHT = 720, 1280


def inspect_hardware(adb, serial):
    """Read-only, fail-closed check for this dedicated emulator's touch mapper."""
    if serial != HARDWARE_SERIAL:
        raise ValueError(f'Hardware approval taps require dedicated {HARDWARE_SERIAL}')
    for prop, expected in [('ro.kernel.qemu', '1'), ('ro.build.version.sdk', '35'),
                           ('ro.product.cpu.abi', 'x86_64')]:
        if adb('shell', 'getprop', prop).strip() != expected:
            raise ValueError(f'Unexpected emulator property: {prop}')
    size = adb('shell', 'wm', 'size')
    sizes = re.findall(r'(?:Physical|Override) size: (\d+)x(\d+)', size)
    if not sizes or any(pair != ('720', '1280') for pair in sizes):
        raise ValueError(f'Hardware taps require unchanged 720x1280 display: {size!r}')
    capabilities = adb('shell', 'getevent', '-lp', HARDWARE_DEVICE)
    name = re.search(r'name:\s*"([^"]+)"', capabilities)
    if name is None or name.group(1) != HARDWARE_NAME:
        raise ValueError('Unexpected event2 device name')
    for axis, maximum in [('ABS_X', 32767), ('ABS_Y', 32767),
                          ('ABS_MT_POSITION_X', 32767), ('ABS_MT_POSITION_Y', 32767),
                          ('ABS_MT_SLOT', 10), ('ABS_MT_TRACKING_ID', 65535),
                          ('ABS_MT_TOOL_TYPE', 15), ('ABS_MT_PRESSURE', 1024)]:
        if not re.search(rf'\b{axis}\s*:.*\bmin 0, max {maximum}(?:,|\s|$)', capabilities):
            raise ValueError(f'Unexpected event2 axis: {axis}')
    input_state = adb('shell', 'dumpsys', 'input')
    devices = re.findall(
        rf'^  Device (\d+): {HARDWARE_NAME}\n(.*?)(?=^  Device |\Z)',
        input_state, re.MULTILINE | re.DOTALL)
    if len(devices) != 1 or int(devices[0][0]) <= 0:
        raise ValueError('Expected one positive Android input device ID')
    device_id, mapper = devices[0]
    if ('Touch Input Mapper (mode - DIRECT)' not in mapper
            or 'Sources: KEYBOARD | TOUCHSCREEN' not in mapper
            or not re.search(r'Viewport INTERNAL: displayId=0, [^\n]*orientation=0, '
                             r'logicalFrame=\[0, 0, 720, 1280\], '
                             r'physicalFrame=\[0, 0, 720, 1280\], '
                             r'deviceSize=\[720, 1280\], isActive=\[1\]', mapper)):
        raise ValueError('Unexpected touch display binding or rotation')
    if 'Last Raw Touch: pointerCount=0' not in mapper:
        raise ValueError('Hardware touch is already active; release the emulator pointer first')
    return {'serial': serial, 'path': HARDWARE_DEVICE, 'name': HARDWARE_NAME,
            'androidDeviceId': int(device_id), 'screen': [SCREEN_WIDTH, SCREEN_HEIGHT],
            'axisRange': [0, 32767], 'rotation': 0}


def hardware_tap_plan(x, y):
    """Protocol B finger contact; no BTN_TOUCH (not exposed by this device)."""
    if not (0 <= x < SCREEN_WIDTH and 0 <= y < SCREEN_HEIGHT):
        raise ValueError(f'Touch outside dedicated emulator display: {(x, y)}')
    # InputReader maps the 32768-value range to the whole display extent.
    raw_x = min(32767, round(x * 32768 / SCREEN_WIDTH))
    raw_y = min(32767, round(y * 32768 / SCREEN_HEIGHT))
    # type=EV_ABS(3): SLOT, TRACKING_ID, TOOL_TYPE(finger=0), X/Y, PRESSURE.
    down = [(3, 47, 0), (3, 57, 1), (3, 55, 0),
            (3, 53, raw_x), (3, 54, raw_y), (3, 58, 512),
            (3, 0, raw_x), (3, 1, raw_y), (0, 0, 0)]
    up = [(3, 47, 0), (3, 58, 0), (3, 57, -1), (0, 0, 0)]

    def event(command):
        return f'sendevent {HARDWARE_DEVICE} ' + ' '.join(map(str, command))

    # Release on success/error/signal so a failed host assertion cannot leave a
    # pressed pointer behind. No user-supplied text enters the shell program.
    release = '; '.join(map(event, up))
    shell = '\n'.join(['set -e', f"trap '{release}' EXIT", "trap 'exit 1' HUP INT TERM",
                       *map(event, down), 'sleep 0.08'])
    return {'screen': [x, y], 'raw': [raw_x, raw_y], 'down': down, 'up': up,
            'holdSeconds': 0.08, 'shell': shell}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--port', type=int, default=38081, help='Local adb-forward port')
    parser.add_argument('--output', default='pet-actions-probe-result.json')
    parser.add_argument('--ui-dump-dex', help='PetUiDump classes.dex built by build_pet_ui_dump.sh')
    parser.add_argument('--check-hardware', action='store_true',
                        help='Only inspect hardware metadata and print a center-tap plan; no UI/input writes')
    args = parser.parse_args()
    if not re.fullmatch(r'emulator-\d+', args.serial):
        parser.error('Only an explicit emulator-NNNN serial is supported')
    package = 'io.github.ccch1mneyyy.dsh_app'

    def adb(*command):
        return subprocess.check_output(['adb', '-s', args.serial, *command], text=True, timeout=20)

    if args.check_hardware:
        print(json.dumps({'hardware': inspect_hardware(adb, args.serial),
                          'plan': hardware_tap_plan(360, 640), 'sent': False}, indent=2))
        return

    if not args.ui_dump_dex:
        parser.error('--ui-dump-dex is required; stock uiautomator dump suspends accessibility overlays')

    def control(path='/state', method='GET'):
        request = urllib.request.Request(f'http://127.0.0.1:{args.port}{path}', method=method)
        with urllib.request.urlopen(request, timeout=3) as response:
            return json.load(response)

    def wait(test, reason, timeout=30):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                last = test()
                if last:
                    return last
            except (OSError, ET.ParseError, subprocess.SubprocessError):
                pass
            time.sleep(0.25)
        raise AssertionError(f'Timed out: {reason}; last={last!r}')

    def nodes():
        xml = adb('shell', 'CLASSPATH=/data/local/tmp/dsh-pet-ui-dump.dex',
                  'app_process', '/system/bin', 'PetUiDump')
        return list(ET.fromstring(xml).iter('node'))

    def find_node(predicate):
        return next((node for node in nodes()
                     if node.attrib.get('package') == package and predicate(node.attrib)), None)

    def stable_node(find, reason):
        bounds, since = None, 0

        def stable():
            nonlocal bounds, since
            found = find()
            current = found[0].attrib.get('bounds') if found else None
            if current != bounds:
                bounds, since = current, time.monotonic()
            return found if current and time.monotonic() - since >= 0.5 else None

        return wait(stable, reason)[0]

    def text_node(*labels):
        # Use an explicit None check: ElementTree leaf elements are falsey.
        node = find_node(lambda a: a.get('text') in labels or a.get('content-desc') in labels)
        return [node] if node is not None else None

    def center(node):
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', node.attrib['bounds']))
        return str((x1 + x2) // 2), str((y1 + y2) // 2)

    def click(*labels, hardware=False):
        node = stable_node(lambda: text_node(*labels), f'UI {labels}')
        if hardware:
            # PromptInputPolicy intentionally rejects adb input's virtual
            # deviceId. Enter through the emulator's actual evdev touch device;
            # the production obscured/injection/arming guards remain intact.
            device = inspect_hardware(adb, args.serial)
            plan = hardware_tap_plan(*map(int, center(node)))
            adb('shell', plan['shell'])
            report['hardwareTaps'].append({'labels': labels, 'device': device,
                                           'screen': plan['screen'], 'raw': plan['raw']})
        else:
            adb('shell', 'input', 'tap', *center(node))

    def broadcast(cmd, *extras):
        adb('shell', 'am', 'broadcast', '-a', package + '.PET_PROBE', '-p', package, '--es', 'cmd', cmd, *extras)

    def ask(text, fresh=False):
        before = control()['promptCount']
        broadcast('ask', '--ez', 'fresh', str(fresh).lower())
        def input_node():
            node = find_node(lambda a: a.get('class') == 'android.widget.EditText')
            return [node] if node is not None else None
        node = stable_node(input_node, 'native ask EditText')
        adb('shell', 'input', 'tap', *center(node))
        adb('shell', 'input', 'keycombination', '113', '29')  # Ctrl+A, Android 35
        adb('shell', 'input', 'keyevent', '67')  # Delete an old persisted draft.
        adb('shell', 'input', 'text', text.replace(' ', '%s'))
        click('发送', 'Send')
        wait(lambda: control()['promptCount'] == before + 1, 'prompt RPC')
        wait(lambda: any(e.get('kind') == 'native-result' and e.get('method') == 'ask'
                         and e.get('result', {}).get('sent') is True for e in control()['events']), 'native send result')

    forwarded = False
    report = {'nativeUi': True, 'recognitionModel': False, 'steps': [], 'hardwareTaps': []}
    try:
        # Validate before forwarding, enabling overlays, or changing the UI.
        report['hardware'] = inspect_hardware(adb, args.serial)
        report['environment'] = {
            'adbdUid': adb('shell', 'id', '-u').strip(),
            'stylusHandwriting': adb('shell', 'settings', 'get', 'secure', 'stylus_handwriting_enabled').strip(),
        }
        if report['environment']['adbdUid'] != '0':
            raise ValueError(f'Hardware approval taps require adb -s {HARDWARE_SERIAL} root first')
        adb('push', args.ui_dump_dex, '/data/local/tmp/dsh-pet-ui-dump.dex')
        adb('forward', f'tcp:{args.port}', 'tcp:38080')
        forwarded = True
        state = control()
        assert state.get('fixture') == 'dsh-pet-actions-probe-v1' and state['ready'], 'Not the dev fixture'
        # A fresh process is intentional: accumulated results must not satisfy assertions.
        assert state['promptCount'] == state['answerCount'] == state['speechCount'] == 0, 'Restart the probe first'
        broadcast('enable', '--ez', 'on', 'true')
        broadcast('always', '--ez', 'on', 'true')
        broadcast('unsnooze')
        adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
        time.sleep(1)

        ask('probe existing message')
        report['steps'].append('existing prompt via native ask')
        ask('probe fresh message', fresh=True)
        report['steps'].append('new session + prompt via native ask')
        for path, labels, expected in [
            ('/approval', ('允许本次', 'Allow once'), 'allowed-once'),
            ('/approval', ('拒绝', 'Decline', 'Reject'), 'rejected'),
            ('/question', ('Blue',), {'answers': [{'id': 'color', 'selected': ['Blue']}]}),
        ]:
            seed = control(path, 'POST')['eventId']
            wait(lambda: (control().get('lastRequest') or {}).get('eventId') == seed, 'bubble token from real tracker')
            time.sleep(0.8)  # Native approval buttons arm after 600 ms.
            click(*labels, hardware=True)
            def answered():
                return next((e for e in control()['events'] if e.get('endpoint') == '$events/result'
                             and e.get('args', {}).get('eventId') == seed), None)
            answer = wait(answered, 'approval/question RPC')
            assert answer['args']['outcome'] == {'kind': 'result', 'value': expected}, answer
            report['steps'].append(f'{seed}: {expected}')
            time.sleep(0.3)

        before = control()['promptCount']
        broadcast('ask')
        mic = stable_node(lambda: text_node('按住说话', 'Hold to talk'), 'native microphone')
        x, y = center(mic)
        adb('shell', 'input', 'swipe', x, y, x, y, '1500')
        wait(lambda: control()['speechCount'] == 1, 'speech/transcribe over loopback HTTP')
        def filled():
            return any(n.attrib.get('class') == 'android.widget.EditText'
                       and 'probe voice words' in n.attrib.get('text', '') for n in nodes())
        wait(filled, 'native ask draft filled from transcription')
        assert control()['promptCount'] == before, 'Voice unexpectedly sent a prompt'
        report['steps'].append('voice fills draft without auto-send')
        click('发送', 'Send')
        wait(lambda: control()['promptCount'] == before + 1, 'explicit send after voice')
        report['steps'].append('voice draft explicitly sent')

        final = control()
        prompts = [e['args']['request'] for e in final['events'] if e.get('endpoint') == 'session/prompt']
        assert len(prompts) == 3 and prompts[0]['sessionId'] == 'probe-existing', prompts
        assert prompts[1]['sessionId'].startswith('probe-new-'), prompts
        assert any(c.get('text') == 'probe voice words' for c in prompts[2]['content']), prompts
        assert final['answerCount'] == 3 and final['speechCount'] == 1, final
        answers = [e for e in final['events'] if e.get('kind') == 'native-result' and e.get('method') == 'answer']
        assert len(answers) == 3 and all(e['result'] == {'result': 'handled'} for e in answers), answers
        report.update(passed=True, state=final)
        print('PASS: native ask, new session, allow/reject, question, voice refill + explicit send')
    except BaseException as error:
        report.update(passed=False, error=str(error))
        try:
            report['state'] = control()
        except OSError:
            pass
        raise
    finally:
        with open(args.output, 'w', encoding='utf-8') as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
        if forwarded:
            adb('forward', '--remove', f'tcp:{args.port}')


if __name__ == '__main__':
    main()
