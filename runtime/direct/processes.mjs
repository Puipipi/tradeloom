import cp from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/** Plan one public child_process/node-pty invocation without changing its argv text. */
export function createCommands(config, paths) {
  const { bin, node, rootfs } = config;
  const directBins = new Set([`${bin}/node`, `${bin}/pnpm`, `${bin}/pnpx`, `${bin}/guest`]);
  const nodeNames = new Set(['node', node, '/opt/node/bin/node', '/usr/local/bin/node', `${rootfs}/usr/local/bin/node`]);
  const pnpmNames = new Set(['pnpm', 'pnpx', '/usr/local/bin/pnpm', '/usr/local/bin/pnpx', `${rootfs}/usr/local/bin/pnpm`, `${rootfs}/usr/local/bin/pnpx`]);
  const shellWrappers = new Map();
  function copyEnvironment(environment) {
    const copy = Object.create(null);
    for (const key in environment) copy[key] = environment[key];
    return copy;
  }
  function guestOptions(options) {
    const environment = options.env ?? process.env;
    const path = environment.PATH;
    return { ...options, env: { ...copyEnvironment(environment), ...(path === undefined ? {} : {
      DSH_GO_GUEST_PATH: path.split(':').filter((entry) => entry !== bin).map(paths.toGuest).join(':'),
    }) } };
  }
  function nodeOptions(options) {
    if (options.env == null) return options;
    const env = copyEnvironment(options.env);
    for (const name of ['HOME', 'TMPDIR', 'DSH_HOME', 'DSH_AGENTS_HOME', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE']) {
      if (typeof env[name] === 'string') env[name] = paths.toHost(env[name]);
    }
    if (typeof env.SSL_CERT_DIR === 'string') env.SSL_CERT_DIR = env.SSL_CERT_DIR.split(':').map(paths.toHost).join(':');
    return { ...options, env };
  }

  function shellWrapper(shell = '/bin/sh') {
    if (shell === `${bin}/sh` || shell === `${bin}/bash`) return shell;
    if (shell === '/bin/sh' || shell === 'sh') return `${bin}/sh`;
    if (shell === '/bin/bash' || shell === 'bash') return `${bin}/bash`;
    if (typeof shell !== 'string' || shell.includes('\0')) throw new TypeError('direct shell must be a string without NUL');
    let wrapper = shellWrappers.get(shell);
    if (!wrapper) {
      wrapper = `${bin}/shell-${createHash('sha256').update(shell).digest('hex').slice(0, 24)}`;
      const body = `#!${config.hostShell}\nexec ${shellQuote(`${bin}/guest`)} ${shellQuote(paths.executable(shell))} "$@"\n`;
      fs.writeFileSync(wrapper, body, { mode: 0o700 });
      shellWrappers.set(shell, wrapper);
    }
    return wrapper;
  }

  function command(file, args = [], options = {}) {
    // Preserve Node's own validation/error contract for malformed overloads.
    if (typeof file !== 'string' || !Array.isArray(args) || (options != null && typeof options !== 'object')) {
      return { file, args, options };
    }
    const out = { ...options };
    if (out.cwd !== undefined) out.cwd = paths.cwd(out.cwd);
    if (out.shell) {
      out.shell = shellWrapper(out.shell === true ? undefined : out.shell);
      return { file, args, options: guestOptions(out) };
    }
    if (directBins.has(file) || file.startsWith(`${bin}/shell-`) || file === `${bin}/bash` || file === `${bin}/sh`) {
      return { file, args, options: file === `${bin}/node` || file === `${bin}/pnpm` || file === `${bin}/pnpx`
        ? nodeOptions(out) : guestOptions(out) };
    }
    if (nodeNames.has(file)) return { file: `${bin}/node`, args, options: nodeOptions(out) };
    if (pnpmNames.has(file)) return { file: `${bin}/${file.endsWith('pnpx') ? 'pnpx' : 'pnpm'}`, args, options: nodeOptions(out) };
    const executable = paths.executable(file);
    if (config.ripgrep && executable === config.ripgrep.path) {
      return config.ripgrep.dynamic
        ? { file: config.loader, args: ['--library-path', config.libraryPath, executable, ...args], options: out }
        : { file: executable, args, options: out };
    }
    // Only executable identity is mapped. Both old /root and physical file
    // arguments are visible inside the guest, so no shell-text replacement.
    return { file: `${bin}/guest`, args: [executable, ...args], options: guestOptions(out) };
  }
  return { command, shellWrapper, guestOptions, nodeOptions };
}

/**
 * Cover the public APIs used by DSH, execa, plugins, and child Nodes. node-pty
 * calls execvp in native code and uses the separately pinned DSH seam patch.
 * Native spawn/execFile retain validation, AbortSignal, timeout, detached PGID,
 * stdio, IPC descriptors, and result/ChildProcess ownership.
 */
export function installCommands(config, paths) {
  const adapter = createCommands(config, paths);
  const original = Object.fromEntries(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']
    .map((key) => [key, cp[key]]));
  function argumentsFor(file, args, options) {
    if (!Array.isArray(args) && args != null && typeof args === 'object') return adapter.command(file, [], args);
    return adapter.command(file, args ?? [], options === undefined ? {} : options);
  }
  for (const name of ['spawn', 'spawnSync', 'execFileSync']) {
    cp[name] = function (file, args, options) {
      if (typeof file !== 'string' || !file || file.includes('\0') ||
          (args != null && !Array.isArray(args) && typeof args !== 'object') ||
          (options !== undefined && ((options === null && name !== 'execFileSync') ||
            (options !== null && (typeof options !== 'object' || Array.isArray(options))))) ||
          (options?.shell != null && typeof options.shell !== 'string' && typeof options.shell !== 'boolean')) {
        return original[name](...arguments);
      }
      const plan = argumentsFor(file, args, options);
      return original[name](plan.file, plan.args, plan.options);
    };
  }
  cp.execFile = function (file, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = {}; }
    else if (!Array.isArray(args) && args != null && typeof args === 'object') { callback = options; options = args; args = []; }
    else if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof file !== 'string' || !file || file.includes('\0') ||
        (args != null && !Array.isArray(args)) ||
        (options != null && (typeof options !== 'object' || Array.isArray(options)))) {
      return original.execFile(file, args, options, callback);
    }
    const plan = argumentsFor(file, args, options);
    return original.execFile(plan.file, plan.args, plan.options, callback);
  };
  cp.exec = function (command, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const out = { ...options, shell: adapter.shellWrapper(typeof options?.shell === 'string' ? options.shell : undefined) };
    if (out.cwd !== undefined) out.cwd = paths.cwd(out.cwd);
    return original.exec(command, adapter.guestOptions(out), callback);
  };
  cp.execSync = function (command, options) {
    const out = { ...options, shell: adapter.shellWrapper(typeof options?.shell === 'string' ? options.shell : undefined) };
    if (out.cwd !== undefined) out.cwd = paths.cwd(out.cwd);
    return original.execSync(command, adapter.guestOptions(out));
  };
  cp.fork = function (modulePath, args, options) {
    if (!Array.isArray(args) && args != null && typeof args === 'object') { options = args; args = []; }
    if ((args != null && !Array.isArray(args)) ||
        (options != null && (typeof options !== 'object' || Array.isArray(options)))) {
      return original.fork(modulePath, args, options);
    }
    const out = { ...options };
    if (out.cwd !== undefined) out.cwd = paths.cwd(out.cwd);
    if (out.execPath !== undefined) {
      const plan = adapter.command(out.execPath);
      out.execPath = plan.args.length ? adapter.shellWrapper(out.execPath) : plan.file;
    }
    return original.fork(paths.toHost(modulePath instanceof URL ? fileURLToPath(modulePath) : modulePath), args ?? [], adapter.nodeOptions(out));
  };
  for (const name of ['exec', 'execFile']) {
    cp[name][promisify.custom] = (...args) => {
      let child;
      const promise = new Promise((resolve, reject) => {
        child = cp[name](...args, (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      });
      promise.child = child;
      return promise;
    };
  }
  process.execPath = `${config.bin}/node`;
  process.argv[0] = process.execPath;
  syncBuiltinESMExports();
  return adapter;
}
