# Changelog

## 0.3.0 — unreleased (updated 2026-11-07)

- Support the exact DSH `0.2.1-rc.4` and `0.2.2-rc.1` versions, with the matching Cordis/Schemastery versions. Preserve upstream job ownership and storage cleanup fixes.
- Verify both versions using their existing pinned runtime locks, the real host compatibility evaluator, and headless image/video sessions. Wait for actual video settlement rather than a fixed post-download delay. Preserve the explicit native executor selection for rc.1; only rc.4 uses the legacy tools mode.

- Publish eight provider presets in `data/models.json` (`presets[]`), carried to the App through the existing services catalog metadata: Ark, Alibaba Model Studio, SiliconFlow, OpenAI and Gemini image/video templates with their profile, API root, response format, model list and shared `keyGroup`.
- Add per-kind defaults `imageServiceId`, `imageModelId`, `videoServiceId` and `videoModelId`. `generate_video` uses the video pair, other tools use the image pair; an unresolvable kind default falls back to the legacy `serviceId`/`modelId` and then to the first supported candidate. Legacy-only configurations behave exactly as before.
- Accept any configured env-style credential name in `keyRef` (for example `DSH_MEDIA_ARK_API_KEY`). The four fixed slots remain compatible but are no longer needed by the new settings flow, and one credential can serve the image and video service of the same provider.
- Rewrite the settings descriptions and README around “add service → enter API key → enable”, and document the preset-driven defaults.
- Runtime request handling, settings namespace `dsh-media`, media metadata v1 and App compatibility are unchanged. No publication, paid-provider call or device validation in this release preparation.

## 0.2.1 — 2026-10-31

- Publish the verified media plugin as `@ccch1mneyyy/dsh-media`. Version 0.2.0 is reserved by npm staging; this patch version enables the normal automatic publishing path.
- Keep the runtime implementation, settings namespace `dsh-media`, media metadata v1, and App compatibility unchanged.

## 0.2.0 — 2026-10-31

- Prepare public package `@ccch1mneyyy/dsh-media`; keep settings namespace `dsh-media` and frozen media metadata v1. Add DSH Go compatibility manifest for app 1.0.2.
- Add verified native Ark, Alibaba and SiliconFlow image/video adapters; preserve OpenAI and Gemini-compatible image generation. Enable one-reference edits where supported.
- Run video producers through DSH rc.4 jobs with completion delivery, bounded MP4 downloads, actual file metadata and provider-confirmed cancellation where available.
- Persist paid task identity and explicit session-bound `resume_media` recovery without another create request, including settlement-before-output crash recovery.
- Connect the existing durable budget ledger and explicit per-request approval for unknown prices. Local reservations are not a provider billing cap.
- Pin approved workspace references; reject FIFOs, symlinks and replaced files. Preflight media metadata before paid submission and distinguish unknown submission / remote continuation from confirmed cancellation.
- Add provider HTTP mocks and real rc.4 headless image/video acceptance harness. No publication, paid-provider or device validation in this release preparation.

## 0.1.0-m0.2

- Initial image-only candidate, fixed credential slots, catalog metadata and ordinary-message generation header.
