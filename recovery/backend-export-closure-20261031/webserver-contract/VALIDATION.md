# Pinned WebServer route contract follow-up

The previously skipped proxy route matcher case was run directly against the rep12 compiled WebServer resolved from that package's own manifest. The actual SDK package is named `@deepseek-ai/dsh-host-webserver` version `0.2.1-rc.3`; its `main` is `lib/index.js`. That compiled file exists at the path recorded in [COMMAND.txt](COMMAND.txt). No SDK build or dependency install was performed.

The named case passed **1/1**, zero skipped, exit 0. It exercises only `WebServer.prototype.match` with the fixed route fixture; it starts no Host or HTTP listener. This complements the earlier package closure run: that run passed 46 cases and skipped this optional case because its module path was unset. Across the two runs, all 47 distinct targeted cases passed, with no failures and no case left unexecuted. The earlier raw output is preserved unchanged.

Exact output is [contract.stdout.txt](contract.stdout.txt); stderr is empty and [contract.exit.txt](contract.exit.txt) contains `0`. The compiled SDK package/library SHA-256 values are included in the parent [source hash inventory](../SOURCE-SHA256.txt).
