# Build preparation for additional static locales

[中文](i18n-static.md)

This document describes the build preparation provided by `app/tool/l10n_merge.py --locale`. The default still generates only Chinese and English. Adding Russian, Japanese, Korean, or Spanish draft files does not automatically add application support. Language preferences, system locale resolution, native/plugin boundaries, and actual rendering need separate implementation and verification.

## Source files and explicit selection

Keep source fragments in `app/lib/l10n/parts/<area>_<locale>.arb`. The `zh` template and `en` are always required. Select additional locales explicitly with repeated `--locale` options. Canonical ARB forms such as `ru`, `ja`, `ko`, `es`, `es_MX`, and `zh_Hant` are accepted. Paths and hyphenated forms such as `ru-RU` are rejected. A region/script locale requires its base locale too, for example `--locale es --locale es_MX`; `zh` is already included for `zh_Hant`.

```sh
# Existing Chinese/English workflow:
python3 app/tool/l10n_merge.py --check
python3 app/tool/l10n_merge.py

# Check one draft area without writing or invoking Flutter:
python3 app/tool/l10n_merge.py --part common --locale ru

# Check all areas, then generate the explicitly selected locale:
python3 app/tool/l10n_merge.py --check --locale ru
python3 app/tool/l10n_merge.py --locale ru

# Explicitly select several complete catalogs:
python3 app/tool/l10n_merge.py --check --locale ru --locale ja --locale ko --locale es
```

A full build requires every area for each selected locale, exactly the template's keys, non-empty messages, matching placeholder sets, and successful structural preflight. Missing translations are not silently filled from English, and generated translations are not marked as reviewed. A `--part` check is an editing aid, not a release gate. Use `--no-gen` to inspect merged ARBs without invoking Flutter.

Template `@key` metadata remains the source of generated parameter types. Languages may use different ICU structures: plain Chinese `{count}` can correspond to a Russian plural. Plural branch sets are not required to be identical across languages. Known plural categories and existing numeric selectors are accepted; `other` is required and duplicate/misspelled categories fail. Reviewers must check semantic `select` alternatives. Matching placeholder sets do not establish translation correctness.

## Avoid accidental draft inclusion

Unselected `<area>_<locale>.arb` fragments are not read or merged. Flutter scans the root ARB directory, so a full check/build refuses any unselected `.arb` file, including `draft_ru.arb`, left in `app/lib/l10n/`. It reports filenames without deleting them. When returning to a Chinese/English build, use a clean work copy or deliberately remove confirmed generated catalogs, then regenerate from source.

Enabling an additional locale for a release requires updating every generation/CI caller with the same selected locales and separately updating the App's supported locales and settings UI. This snapshot does not include all build callers; they are not assumed to have been updated. Keep the default Chinese/English build until these changes and language review are complete.

Do not hand-edit `app/lib/l10n/app_*.arb` or `app/lib/l10n/gen/`. In a complete repository, this tool invokes `flutter gen-l10n`, which remains the authoritative syntax and typed-generation check for the project's Flutter version. The Python preflight neither implements full ICU nor computes runtime plurals.

## Acceptance

```sh
python3 -m unittest discover -s app/tool -p test_l10n_merge.py -v
python3 -m unittest discover -s app/tool -p test_console_encoding.py -v
python3 app/tool/l10n_merge.py --check
# Once the selected locale is complete, using the project's Flutter toolchain:
python3 app/tool/l10n_merge.py --locale ru
(cd app && flutter analyze && flutter test test/l10n)
```

Manually review terminology and permission/deletion/credential wording. Verify Russian forms for 1/2/5/11/21/22/25/101 and decimals, narrow screens, enlarged text, system fallback, existing saved settings, plugin text, and native text. Key completeness and Python tests alone do not establish formal language support.
