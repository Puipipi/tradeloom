# TradeLoom · 织贸助手

English / [简体中文](README_cn.md)

An AI workbench for integrated manufacturing and foreign-trade teams: organize business information, preserve its sources, and prepare drafts and deliverables for human review.

**Huawei ICT Competition · 11th edition (2026–2027) · Innovation Competition · Topic 1: Building AI innovative applications with Huawei Cloud products.**

TradeLoom supports manufacturing and trade work, with product catalogs and sample lists as examples. Production requirements, execution plans and ERP integration remain draft frameworks awaiting acceptance. Huawei Cloud adaptation is still awaiting acceptance; this repository does not claim a completed competition deployment. See [competition scope and goals](docs/00-赛题与目标.md).

## Portable release status

The R75 Windows x64 portable ZIP has passed entry-by-entry archive readback, extraction, and a fresh C10 startup from its own empty data directory. Release assets will be listed at [ui18-r75-portable-20261106](https://github.com/Puipipi/tradeloom/releases/tag/ui18-r75-portable-20261106); check that page for availability. See [R75 validation and rebuild inputs](docs/releases/ui18-r75-validation.md) for the artifact hash, startup evidence, and rebuild boundary.

Extract the release asset to a short path, such as `C:/Apps/TradeLoom`, then run `启动工作台.exe`. It includes the Electron, Node, Python, PostgreSQL, Django/backend, and pure program plugin seed required by the bundled runtime; it excludes personal profiles, credentials, databases, and chats. External services such as ERPNext must be provided separately.

The [desktop16 portable release](https://github.com/Puipipi/tradeloom/releases/tag/desktop16-portable-20261026) is an older historical release, not the current R75 artifact. Its hash is `ab973c6bf742979ef3875819a4b7729ef0ba1a3f2018dbc7b28d536cc6b13660`.

## Features and status

| Area | Purpose | Current status |
|---|---|---|
| Product information | Organize product facts and identify missing information | Implemented flows have scoped acceptance records; business rules still need validation. |
| Deliverables | Prepare catalogs and sample lists with human review | Selected generation, preview and review flows verified; quotations and the complete business cycle remain in progress. |
| AI workspace | Connect conversation, files and task workflows | Fresh role binding and scoped native attachment previews are verified; business end-to-end and broader file flows remain under acceptance. |
| Persistence and execution | Keep task history and resume work | Real runners and PostgreSQL restart recovery require further end-to-end acceptance. |
| Production and ERP | Prepare production requirements and execution plans | Draft frameworks; real execution and ERP integration await acceptance. |
| Huawei Cloud | Support the Topic 1 cloud application | Competition requirements include CodeArts and cloud deployment; current adaptation and evidence remain pending. |

## Development

Start with [quick start](docs/quick-start.md) and [runtime preparation and upgrades](docs/upgrade-harness.md). Cloning the source does not provide the external runtime or configured services. These documents contain earlier environment records: verify the applicable runtime before using their commands.

The published release and this local source snapshot are versioned separately. R75 source and artifact evidence is summarized in [the release validation record](docs/releases/ui18-r75-validation.md); runtime and vendor inputs are version-pinned there.

## Documentation

| Entry | Read it for |
|---|---|
| [Competition scope and goals](docs/00-赛题与目标.md) | Current Topic 1 direction, official sources and remaining evidence |
| [Acceptance matrix](docs/acceptance-matrix.md) | Scoped checks and their limits; historical entries retain their dates |
| [Agent development](docs/agent-development.md) | Integration background and developer contracts |
| [Architecture](docs/architecture.md) | Technical structure and earlier design context |
| [Work report](docs/work-report.md) | Dated implementation and verification records |
| [R75 portable validation](docs/releases/ui18-r75-validation.md) | Archive identity, isolated fresh-start evidence, and fixed rebuild inputs |
| [Historical README](README_legacy_20261026.md) | Unchanged former homepage; historical paths, Topic 2 statements and status are not current instructions |
| [Topic 2 historical research](docs/00-赛题二历史研究.md) | Preserved AgentArts research, an optional technical reference rather than the selected competition topic |

## Current limits

The locally prepared R75 archive contains 39,739 program files and has been started once from a fresh extracted path. The new profile had no configured user accounts; no login or message sending was performed. The source builder uses a fixed R74 ASAR/sidecar input and fixed SDK/vendor snapshots; it does not claim a full SDK TypeScript rebuild. Real-model business end-to-end behavior is not established by the package startup check.

The product is under development. A successful build, simulated workflow or submitted task does not prove a completed business outcome. The final competition requirements follow the latest Huawei rules.

## Contributing and license

Issues and focused pull requests are welcome. Include the source/release snapshot, prerequisites, reproduction steps and actual verification results; use demonstration data instead of customer information or credentials.

No repository-level license file is currently provided. Do not assume this repository is MIT-licensed; third-party components retain their own licenses.
