// Runtime-owned module boundary. Resolver URLs (including Node's realpath and
// require.resolve caches) are names, not proof of the file being loaded now.
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { threadId } from 'node:worker_threads';

// Capture uncached operations before boot-cache or application hooks can wrap
// fs. Never share a realpath cache with Node's resolver or a package lookup scope.
const realpath = fs.realpathSync.native;
const { openSync, closeSync, readFileSync, readlinkSync, fstatSync, statSync, constants } = fs;
const identityError = (cause) => Object.assign(new Error(
  'this file needs compatible launch; stop the engine and turn off Direct engine',
  cause === undefined ? undefined : { cause },
), { name: 'DshDirectModuleIdentityError', code: 'DSH_DIRECT_MODULE_IDENTITY' });

let nativeLoadSerial = 0n;

/** A different dlopen name for each (Node thread, load), still the same open FD.
 * glibc caches literal names: closing and reusing /proc/self/fd/N can otherwise
 * load a previous addon. The two bit spellings leave /proc/self unchanged;
 * task/../ separates their prefix-free encodings. No persistent files or FDs. */
export function nativeDescriptorAlias(fd, thread, serial) {
  if (!Number.isSafeInteger(fd) || fd < 0 || !Number.isSafeInteger(thread) || thread < 0 ||
      typeof serial !== 'bigint' || serial < 1n) throw identityError();
  const encode = (value) => value.toString(2).replaceAll('0', './').replaceAll('1', 'fd/../');
  const alias = `/proc/self/${encode(BigInt(thread))}task/../${encode(serial)}fd/${fd}`;
  if (alias.length > 1024) throw identityError(new Error('native descriptor alias exceeds its path budget'));
  return alias;
}

export function installModules(paths, inventory = { schema: 1, files: {} }) {
  if (inventory?.schema !== 1 || !inventory.files || typeof inventory.files !== 'object' || Array.isArray(inventory.files)) {
    throw identityError(new Error('native module inventory is missing or invalid'));
  }
  const nativeFiles = new Map(Object.entries(inventory.files).map(([file, digest]) => {
    if (!file.startsWith('/opt/dsh/node_modules/') || !file.endsWith('.node') ||
        posix.normalize(file) !== file || file.includes('\u0000') || !/^[a-f0-9]{64}$/u.test(digest)) throw identityError();
    return [paths.root + file, digest];
  }));
  function allowed(file) {
    if (paths.requiresProot(file) || !paths.containsExecutionPath(file)) throw identityError();
    return file;
  }
  function current(file) {
    try { return allowed(realpath(allowed(file))); }
    catch (error) { throw error.code === 'DSH_DIRECT_MODULE_IDENTITY' ? error : identityError(error); }
  }
  const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
  const sameContents = (a, b) => sameIdentity(a, b) && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

  function withFile(file, use) {
    const canonical = current(file);
    let fd;
    try {
      // O_NONBLOCK prevents an unexpected FIFO/device from hanging before the
      // regular-file check. O_NOFOLLOW closes a final-component substitution.
      fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const fdPath = `/proc/self/fd/${fd}`;
      const before = fstatSync(fd, { bigint: true });
      function check() {
        // The kernel's open descriptor, not another cached pathname lookup,
        // identifies the bytes. Deleted/replaced paths fail closed as well.
        if (!before.isFile() || allowed(readlinkSync(fdPath)) !== canonical ||
            current(file) !== canonical || !sameContents(before, fstatSync(fd, { bigint: true })) ||
            !sameIdentity(before, statSync(file, { bigint: true }))) throw identityError();
      }
      check();
      const result = use(fd, canonical);
      check();
      return result;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('file:')) {
        const url = new URL(specifier);
        const mapped = paths.toHost(fileURLToPath(url));
        if (mapped !== fileURLToPath(url)) {
          const replacement = pathToFileURL(mapped);
          replacement.search = url.search; replacement.hash = url.hash;
          specifier = replacement.href;
        }
      } else if (specifier.startsWith('/')) specifier = paths.toHost(specifier);
      const result = nextResolve(specifier, context);
      if (result.url?.startsWith('file:')) current(fileURLToPath(result.url));
      return result;
    },
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      return withFile(fileURLToPath(url), (fd) => {
        if (context.format === 'addon') return nextLoad(url, context);
        const source = readFileSync(fd);
        // Node 24's ESM default load uses the supplied source for format
        // detection. Its CJS default load may read again; never execute those
        // second-path bytes. Preserve Node's attributes and format validation,
        // and explicitly supply the verified descriptor's source to the loader.
        const result = nextLoad(url, { ...context, source });
        return { ...result, source };
      });
    },
  });

  // Node 24's CJS .node handler bypasses the source load hook. Keep native
  // loading synchronous and bind it to the same verified open file. Only exact
  // bundled addon bytes are supported. User-installed native packages can have
  // private $ORIGIN dependencies; refuse them instead of guessing a library.
  // The planner supplies the two audited bundled addon library directories.
  const dlopen = process.dlopen;
  process.dlopen = function(module, filename, ...args) {
    // Node's native binding coerces objects to paths. Reject unvalidated input
    // without invoking user-defined coercion or delegating it to that binding.
    if (typeof filename !== 'string') throw new TypeError('process.dlopen filename must be a string');
    return withFile(filename, (fd, canonical) => {
      const expected = nativeFiles.get(canonical);
      if (!expected || createHash('sha256').update(readFileSync(fd)).digest('hex') !== expected) throw identityError();
      return Reflect.apply(dlopen, this, [module, nativeDescriptorAlias(fd, threadId, ++nativeLoadSerial), ...args]);
    });
  };
  return hooks;
}
