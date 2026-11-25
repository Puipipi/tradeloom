import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

import * as hostEntry from "../lib/index.js";

test("host and browser entries register the overlay and three common page slots", () => {
  assert.equal(hostEntry.name, "dsh-go-example-overlay");
  assert.equal(typeof hostEntry.apply, "function");

  let loaded;
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = entry;
      },
    },
  };
  vm.runInNewContext(source, { window, Math });
  assert.equal(loaded.id, "dsh-go-example-overlay");

  const plugin = loaded.factory((mod) => {
    assert.equal(mod, "react");
    return {
      createElement: (type, props, ...children) => ({ type, props, children }),
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useState: (initial) => [initial, () => {}],
    };
  });
  assert.equal(plugin.name, "dsh-go-example-overlay");

  const registered = [];
  plugin.apply({
    slots: {
      inject(slot, fn) {
        fn();
      },
      register(options, component) {
        registered.push({ options, component });
      },
    },
  });
  assert.deepEqual(
    registered.map((r) => [r.options.name, r.options.id, r.options.label()]),
    [
      ["shell.overlay", "dsh-go-example-overlay:overlay", "Overlay sample"],
      ["sidebar.footer.action", "dsh-go-example-overlay:footer", "Overlay sample sidebar"],
      ["settings.plugins.tab", "dsh-go-example-overlay:settings", "Overlay sample settings"],
      ["plugins.detail.section", "dsh-go-example-overlay:detail", "Overlay sample detail"],
    ],
  );
});
