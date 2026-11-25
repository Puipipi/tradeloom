// package.json's "files" decides what npm ships. A file left out still works from a
// checkout and only fails once installed, so walk the imports against the pack list.
//   node --test runtime/tests/bridge-package.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const ROOT = new URL("../bridge/dsh-go-bridge/", import.meta.url);

function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return new Set(JSON.parse(out)[0].files.map((file) => file.path));
}

function localImports(file) {
  const text = readFileSync(new URL(file, ROOT), "utf8");
  const references = [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]+)['"]/gm),
    ...text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)];
  return references.map((match) =>
    posix.join(posix.dirname(file), match[1]),
  );
}

test("the npm package holds everything its entry points import", () => {
  const { exports: entries } = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
  const queue = Object.values(entries).filter((target) => target.endsWith(".js")).map(posix.normalize);
  const packed = packedFiles();
  const seen = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(packed.has(file), `${file} is imported but missing from "files"`);
    queue.push(...localImports(file));
  }
  // The walk must have followed the graph, or it would pass with nothing to check.
  assert.ok(seen.has("lib/session-deletion.js") && seen.has("lib/native/core.js"));
});
