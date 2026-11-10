# Embed content-only template candidate

This candidate suppresses the shared Django workbench top bar only when the existing `business_embed` context is true. The sidebar already uses that condition. Page content, page-level controls, CSRF metadata, styles, and scripts are unchanged.

## Source and patch

- Read-only source: `C:/Users/23825/Desktop/ICT/tradeloom/workbench/templates/workbench/base.html`
- Source SHA-256: `23E4A05765C042AE7FBF782744EF092985F6A5BB628D72360ED3AC7FF45A650F`
- `base/workbench/templates/workbench/base.html` is the byte-identical before copy.
- `after/workbench/templates/workbench/base.html` is the proposed file; SHA-256 `E1490BD196202662E6F6ACACA241BA4A25EB1C5F5C574D3D3446FB83BCCE3E55`.
- `base-topbar.patch` contains the two-line conditional change.

## Integration

The frozen target is `C:/Users/23825/Desktop/TLUI-r2-20261031/app/resources/tradeloom/backend/workbench/templates/workbench/base.html`. Its current 4562-byte file is SHA-256 `23E4A05765C042AE7FBF782744EF092985F6A5BB628D72360ED3AC7FF45A650F`, byte-identical to `base/`; the proposed 4600-byte `after/` file is SHA-256 `E1490BD196202662E6F6ACACA241BA4A25EB1C5F5C574D3D3446FB83BCCE3E55`. Before any later assembly, check the frozen target still matches the recorded before hash; if it differs, compare first and do not overwrite blindly.

When the frontend owner assembles the reviewed candidate, replace only that file in a copy of the frozen R5 backend. Update only its existing `deployment.json.resources.business.files` entry and recompute the totals and aggregate over all original 153 entries; keep the other 152 entries unchanged. Do not run the default staging flow from the newer main checkout, which could copy its whole backend over R5. The inventory algorithm from `stage-desktop.mjs` sorts by `path.localeCompare(other.path, 'en')`, then hashes UTF-8 bytes of the concatenated lines `path + NUL + decimalBytes + NUL + lowercaseSha256 + LF`. It hashes original file bytes without newline normalization.

For this one-entry preview, the existing inventory is 153 files / 1,554,825 bytes / aggregate `35eb207d11c60f5d07c08625a058d5ff223f08b1afb0fee26b4b00447c756026`; replacing the template yields 153 files / 1,554,863 bytes / expected aggregate `b4a5e4d24f04331a5c5dd0564b61cab8d44a9bcbb6194e0d71eb73aeac3642fe`. These are calculated preview values, not a modified or deployed manifest. The final `deployment.json` hash must be calculated by the frontend owner after assembly. Do not change `sourceBuild` or the independent SDK `compiledFiles` receipt. main `config/settings.py:11` reads `TRADELOOM_DSH_EMBED`, and `workbench/views.py:122-123` supplies `business_embed`; this candidate adds no query-string switch and does not mount or deploy itself.

## Verification

The Django Engine test and its raw output are in `../../recovery-20261029/business-embed-content-only-20261031/`. The candidate has not been merged or deployed.
