# O08 candidate assembly

`build-candidate-overlay.mjs <new-output-directory>` composes the immutable, readback-verified R76 portable ZIP with the source inventory fixed in `candidate-source-manifest-o08.json`. It does not accept a caller-provided base ZIP, source manifest, expected hash, lock, marker, or receipt.

The output replaces the complete backend payload and the current `package.json` plus its complete `files` list, including the adapter and three canonical workflow modules. It recalculates the business and business-shell inventories in `deployment.json`; the R76 ASAR, bundled Node, runtime lock, launcher, and remaining program entries stay byte-identical. The sidecar identifies this as a candidate source overlay with inherited R76 SDK inputs. It is not an official source-build receipt and does not claim installation, launch, or publication.

The R76 base ZIP is pinned to 797266789 bytes and SHA-256 `868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341`; its 39739-entry manifest is separately pinned. R76's prior fresh-ZIP launch check is false, so this assembly does not establish that historical acceptance boundary.
