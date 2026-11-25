import 'package:dsh_remote/dsh_remote.dart';
import 'package:test/test.dart';

List<Map<String, Object?>> pair(String local, String remote, {String protocol = 'udp'}) => [
  {'id': 'local', 'type': 'local-candidate', 'candidateType': 'host', 'address': local, 'protocol': protocol},
  {'id': 'remote', 'type': 'remote-candidate', 'candidateType': 'host', 'address': remote, 'protocol': protocol},
  {
    'id': 'pair',
    'type': 'candidate-pair',
    'localCandidateId': 'local',
    'remoteCandidateId': 'remote',
    'state': 'succeeded',
    'nominated': true,
  },
  {'id': 'transport', 'type': 'transport', 'selectedCandidatePairId': 'pair'},
];

void main() {
  test('reports IPv6 and UDP without retaining candidate addresses', () {
    final stats = pair('2001:db8::1', '2001:db8::2');
    final info = selectedPeerNetworkInfo(stats)!;
    expect(info.localIpVersion, RemoteIpVersion.ipv6);
    expect(info.remoteIpVersion, RemoteIpVersion.ipv6);
    expect(info.protocol, RemoteIceProtocol.udp);
    expect(selectedPeerPath(stats), RemoteTransportMode.p2p);
  });

  test('reports IPv4, TCP and the legacy ip field', () {
    final stats = pair('192.0.2.1', '198.51.100.2', protocol: 'tcp');
    stats[1]['ip'] = stats[1].remove('address');
    final info = selectedPeerNetworkInfo(stats)!;
    expect(info.localIpVersion, RemoteIpVersion.ipv4);
    expect(info.remoteIpVersion, RemoteIpVersion.ipv4);
    expect(info.protocol, RemoteIceProtocol.tcp);
  });

  test('does not guess addresses behind mDNS or malformed stats', () {
    final stats = pair('peer.local', 'not-an-address', protocol: 'secret://arbitrary');
    final info = selectedPeerNetworkInfo(stats)!;
    expect(info.localIpVersion, isNull);
    expect(info.remoteIpVersion, isNull);
    expect(info.protocol, isNull);
    expect(selectedPeerNetworkInfo(const []), isNull);
  });

  test('prefers the current pair and never substitutes an old nominated pair', () {
    final stats = pair('192.0.2.1', '198.51.100.2');
    stats.last['selectedCandidatePairId'] = 'new-pair-not-yet-reported';
    expect(selectedPeerNetworkInfo(stats), isNull);
    stats.last['selectedCandidatePairId'] = 'pair';
    stats[2]['state'] = 'failed';
    expect(selectedPeerNetworkInfo(stats), isNull);
  });

  test('accepts a succeeded nominated pair when native transport stats are absent', () {
    final stats = pair('2001:db8::1', '198.51.100.2')..removeLast();
    final info = selectedPeerNetworkInfo(stats)!;
    expect(info.localIpVersion, RemoteIpVersion.ipv6);
    expect(info.remoteIpVersion, RemoteIpVersion.ipv4);
    stats[2]['state'] = 'in-progress';
    expect(selectedPeerNetworkInfo(stats), isNull);
  });

  test('multiple nominated pairs cannot masquerade as the current pair', () {
    final stats = pair('192.0.2.1', '198.51.100.2')..removeLast();
    stats[2]['currentRoundTripTime'] = 0.01;
    stats.add({...stats[2], 'id': 'old-pair', 'currentRoundTripTime': 0.8});
    expect(selectedPeerNetworkInfo(stats), isNull);
    expect(selectedPeerPath(stats), isNull);
    expect(selectedPeerRoundTripTime(stats), isNull);
    stats[2]['selected'] = true;
    expect(selectedPeerNetworkInfo(stats)!.localIpVersion, RemoteIpVersion.ipv4);
    expect(selectedPeerRoundTripTime(stats), const Duration(milliseconds: 10));
    stats[3]['selected'] = true;
    expect(selectedPeerNetworkInfo(stats), isNull);
  });

  test('classifies IPv6 scope numerically across equivalent spellings', () {
    for (final address in ['fe90::1', 'febf::2', '0:0:0:0:0:0:0:1', 'FC12:0:0:0:0:0:0:1']) {
      expect(selectedPeerPath(pair(address, address)), RemoteTransportMode.lan, reason: address);
    }
    for (final address in ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:0:0:0:0:1', '2001:db8::1']) {
      expect(selectedPeerPath(pair(address, address)), RemoteTransportMode.p2p, reason: address);
    }
  });

  test('contradictory candidate protocols stay unknown', () {
    final stats = pair('192.0.2.1', '198.51.100.2');
    stats[1]['protocol'] = 'tcp';
    expect(selectedPeerNetworkInfo(stats)!.protocol, isNull);
  });
}
