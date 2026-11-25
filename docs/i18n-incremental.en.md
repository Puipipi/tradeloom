# Incremental copy changes and preservation of human edits

[中文](i18n-incremental.md)

`app/tool/l10n_catalog.py` is an offline maintenance tool. It produces source fingerprints and reviewable plans. It does not call a model, write ARBs or translations, select an App locale, or treat review declarations as authenticated approval. Existing output files are never overwritten.

## Workflow

Save a source snapshot before changing copy:

```sh
python3 app/tool/l10n_catalog.py snapshot --output catalog-v1.json
```

After source changes, prepare a new plan using the previous snapshot and the language's maintained state:

```sh
python3 app/tool/l10n_catalog.py plan --locale ru \
  --previous catalog-v1.json --translations ru-state-v1.json \
  --output ru-plan-v2.json
python3 app/tool/l10n_catalog.py snapshot --output catalog-v2.json
```

Omit `--translations` when starting a language with no translations. `--repo PATH` reads another repository copy; the default is the script's repository. The output directory must exist. Only Chinese/English sources in `app/lib/l10n/parts/` are read; chats, accounts, devices, and credentials are not accessed.

`sourceDiff` reports `new / changed / removed / unchanged` between the previous and current source snapshots. `freshness` compares each translation's recorded source hash with the current source. A translation may therefore still be stale even when those two source snapshots are unchanged.

| Situation | Preserved data | Plan result |
|---|---|---|
| Missing translation | No target text is invented | `translationQueue`, reason `missing` |
| Source changed; unlocked AI draft | Existing text and its original hashes | `preservedTranslations`, `freshness: stale`, suggested retranslation queue |
| Source changed; declared human review or lock | Existing text and its original hashes, never replaced | `preservedTranslations`, `freshness: stale`, only `humanReviewQueue` |
| Translation is bound to current source | Text and declarations | `freshness: current`, no retranslation request |
| Source key removed | Old text, declarations, lock, and original hashes | `retiredTranslations`, `freshness: removed` |

Queued `sourceHash` values always identify the current source request. Preserved/retired translation records keep their original source hash. Queues are suggestions only: no model call or writeback occurs. Even an unlocked AI draft queued for replacement is retained.

## Version 1 contract

Source snapshots use `format: dsh-go-i18n-catalog`, `schemaVersion: 1`, and `sourceHashAlgorithm: sha256-canonical-source-v1`. Each source hash is defined by:

```python
payload = {"area": area, "zh": chinese_text,
           "en": english_text, "metadata": chinese_at_key_or_empty_object}
source_hash = sha256(json.dumps(payload, ensure_ascii=False,
                               sort_keys=True, separators=(',', ':'),
                               allow_nan=False).encode('utf-8')).hexdigest()
```

This is the same algorithm as the four-language draft's `source-all-hashes.json` (not in the repo); on `d38c1f0` all 5477 hashes matched. Including `area` conservatively marks a fragment move for review. Metadata is the Chinese template's `@key` object, including declared types/context, or `{}` when absent. English `@key` metadata is not the template type source and is excluded from this hash version.

A separate glossary/style-guide version is outside the v1 source hash. When those rules change, maintainers must prepare additional review work for affected terms; unchanged message hashes do not waive terminology review.

A translation state looks like:

```json
{
  "format": "dsh-go-i18n-translations",
  "schemaVersion": 1,
  "locale": "ru",
  "entries": {
    "commonCancel": {
      "text": "Отмена",
      "sourceHash": "<64 lowercase hexadecimal SHA-256 characters>",
      "translationHash": "<64 lowercase hexadecimal SHA-256 characters>",
      "review": "ai-draft",
      "locked": false
    }
  }
}
```

Angle-bracket values above are explanatory placeholders, not runnable data. `translationHash` applies the same canonical JSON hashing to the target string itself, not raw string bytes. Review records should bind locale, key, sourceHash, and translationHash. Changing target text while retaining its old translation hash fails; recompute the hash and reassess review status.

`review` accepts only `ai-draft` or `human-reviewed`; `locked` must be a JSON boolean. These are local maintainer workflow declarations without signatures, identity verification, or language quality guarantees. An imported package must not gain release/activation rights by declaring itself human-reviewed. A lock protects text but does not certify it. Changed-source human translations retain their history while `freshness: stale` explicitly requires review again.

Unknown structural fields, duplicate JSON keys, non-JSON constants, malformed values, hash mismatches, and translation keys absent from both source snapshots fail instead of being silently ignored. Legitimately removed entries are archived rather than discarded. Retain the previous source snapshot to distinguish removed keys from unknown input.

## Validation and workload metrics

```sh
python3 -m unittest discover -s app/tool -p test_l10n_catalog.py -v
python3 app/tool/l10n_merge.py --check
```

Fingerprinting does not replace ICU or placeholder validation. Follow it with structural checks, the project's Flutter `gen-l10n`, native-speaker review, and UI regression checks. This tool neither imports ARBs nor publishes locales.

Metrics count keys, Python Unicode characters, and English whitespace-separated words, including ICU syntax, markup, and placeholders. They are not token counts or pricing estimates. The supplied `d38c1f0` snapshot has 5477 keys, 52337 Chinese characters, 144756 English characters, and 23245 English whitespace-separated words. Both suggested queues have separate metrics for preparing batches around actual changes.

For example, a 20-key source change gives each of four target languages those 20 changes to assess, plus any separately missing or stale entries. It should not trigger a full retranslation on every update. Model charges, token counts, and human review time require measurement with the actual model, context, target text, and review method.
