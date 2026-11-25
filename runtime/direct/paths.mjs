import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';

const within = (value, root) => value === root || value.startsWith(`${root}/`);

/**
 * One physical spelling for engine cwd/fs/module paths. The whole rootfs is
 * bound at this identical absolute path after direct has been prepared, so
 * saved physical paths remain usable on rollback without changing defaults
 * for installations that have never prepared a direct launch.
 * Legacy guest paths are accepted at DSH's typed filesystem/cwd boundaries;
 * arbitrary shell output and Markdown are deliberately never rewritten.
 */
export function createPaths(rootfs, mounts = []) {
  if (typeof rootfs !== 'string' || !rootfs.startsWith('/') || rootfs === '/') {
    throw new Error('direct paths: rootfs must be a non-root absolute directory');
  }
  const root = rootfs.replace(/\/+$/u, '');
  if (!Array.isArray(mounts) || mounts.some((mount) => typeof mount.host !== 'string' || !mount.host.startsWith('/') ||
      typeof mount.guest !== 'string' || !mount.guest.startsWith('/') || mount.guest === '/')) {
    throw new Error('direct paths: invalid mounted execution world');
  }
  const byGuest = [...mounts].sort((a, b) => b.guest.length - a.guest.length);
  const byHost = [...mounts].sort((a, b) => b.host.length - a.host.length);
  function toHost(value) {
    if (typeof value !== 'string' || !value.startsWith('/')) return value;
    if (within(value, root)) return value;
    const mount = byGuest.find((entry) => within(value, entry.guest));
    if (mount) return mount.host + value.slice(mount.guest.length);
    return root + (value === '/' ? '' : value);
  }
  function toGuest(value) {
    if (typeof value !== 'string') return value;
    if (within(value, root)) return value.slice(root.length) || '/';
    const mount = byHost.find((entry) => within(value, entry.host));
    return mount ? mount.guest + value.slice(mount.host.length) : value;
  }
  function cwd(value) {
    return value === undefined ? undefined : toHost(value instanceof URL ? fileURLToPath(value) : value);
  }
  // Executable identities can be lexically normalized. File-tool spellings keep
  // `link/..` intact so the existing fs provider retains physical path semantics.
  const executable = (value) => typeof value === 'string' && value.startsWith('/')
    ? posix.normalize(toHost(value)) : value;
  const requiresProot = (value) => typeof value === 'string' && within(toHost(value), `${root}/root/.l2s`);
  // A broad mount can contain a more specific replacement (for example /sys
  // with an empty /sys/fs/selinux). A native symlink must not expose the hidden
  // original merely because it sits below that broad host source.
  const containsExecutionPath = (value) => typeof value === 'string' &&
    (within(value, root) || (mounts.some((mount) => within(value, mount.host)) && toHost(toGuest(value)) === value));

  // Session creation is a typed filesystem boundary too. Resolve the existing
  // ancestor before recursive mkdir, retaining physical link/.. semantics and
  // the same L2S/execution-world refusal as the file provider. Metadata keeps
  // its caller spelling; no global fs method or session header is rewritten.
  async function prepareDirectory(value) {
    const mapped = toHost(value);
    if (typeof mapped !== 'string' || mapped.length === 0) throw new TypeError('direct paths: directory must be a nonempty string');
    const check = (path) => {
      if (requiresProot(path) || !containsExecutionPath(path)) throw new Error('this directory needs compatible launch; stop the engine and turn off Direct engine');
      return path;
    };
    let ancestor = check(posix.isAbsolute(mapped) ? mapped : `${process.cwd()}/${mapped}`);
    const missing = [];
    while (true) {
      try {
        const resolved = check(await realpath(ancestor));
        if (missing.includes('..')) throw new Error('cannot create directory: parent traversal crosses a missing directory');
        return check(posix.join(resolved, ...missing));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = posix.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.unshift(posix.basename(ancestor));
        ancestor = parent;
      }
    }
  }
  return { root, toHost, toGuest, cwd, executable, within, requiresProot, containsExecutionPath, prepareDirectory };
}
