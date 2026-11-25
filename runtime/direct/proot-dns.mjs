// PRoot launches import this through NODE_OPTIONS. There Node resolves names
// through glibc, which sends A and AAAA on one socket: a network that refuses
// AAAA fails both (#152). Use Direct's per-family resolver instead. If it
// cannot start (no usable resolv.conf), keep the native lookup: this must never
// stop a Node process from running.
import { installLookup } from './dns.mjs';

try {
  installLookup({ resolvConf: '/etc/resolv.conf', hostsFile: '/etc/hosts' });
} catch {
  console.error('[dsh-app] proot DNS initialization failed; native lookup retained');
}
