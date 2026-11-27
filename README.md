# TradeLoom · 织贸助手

English / [简体中文](README_cn.md)

[Windows two-role quick start / 双端入门（6.18 prerelease）](docs/windows-two-role-quickstart.md): enterprise ledger server, role-based login, and the separate personal workbench. The stable desktop download remains below.

## Windows Electron desktop app

**Download the complete Windows x64 desktop package:** [Stage 6.17 release page](https://github.com/Puipipi/tradeloom/releases/tag/stage6.17-windows-x64) · [ZIP](https://github.com/Puipipi/tradeloom/releases/download/stage6.17-windows-x64/TradeLoom-stage6.17-Windows-x64-full.zip) · [SHA-256 file](https://github.com/Puipipi/tradeloom/releases/download/stage6.17-windows-x64/SHA256SUMS.txt).

1. Download the ZIP and checksum file from the release page.
2. Verify the ZIP against `SHA256SUMS.txt`, extract the complete archive, then run `program/启动工作台.exe`.
3. The desktop app opens as an Electron window titled **织贸工作台**. The first screen contains the full workbench and its navigation; a standalone browser page for product information is not the desktop app.

See the [Windows desktop deployment guide](docs/windows-desktop-deployment.md) for the exact checksum command, data location and upgrade boundary. The release page is the stable download entry.

## Product and project

An AI workbench for integrated manufacturing and foreign-trade teams: organize business information, preserve its sources, and prepare drafts and deliverables for human review. **TradeWeave** is the display name used by the project's Django business web application; it is not a separate desktop installer. The product-information Django page is for development or that web workflow, while the release above is the team's Electron desktop deployment.

**Huawei ICT Competition · 11th edition (2026–2027) · Innovation Competition · Topic 1: Building AI innovative applications with Huawei Cloud products.**

TradeLoom supports manufacturing and trade work, with product catalogs and sample lists as examples. Production requirements, execution plans and ERP integration remain draft frameworks awaiting acceptance. Huawei Cloud adaptation is still awaiting acceptance; this repository does not claim a completed competition deployment. See [competition scope and goals](docs/00-赛题与目标.md).

## Features and status

| Area | Purpose | Current status |
|---|---|---|
| Product information | Organize product facts and identify missing information | Data models, traceability APIs and delivery flows remain; the `/products` page itself now shows the SKU cost ledger. |
| SKU cost ledger | Unit cost, duty lookup, market margin and sourcing hints | Implemented with regression tests; automatic duty lookup covers US, UK and EU only. |
| Deliverables | Prepare catalogs and sample lists with human review | Selected generation, preview and review flows verified; quotations and the complete business cycle remain in progress. |
| AI workspace | Connect conversation, files and task workflows | Fresh role binding and scoped native attachment previews are verified; business end-to-end and broader file flows remain under acceptance. |
| Persistence and execution | Keep task history and resume work | Real runners and PostgreSQL restart recovery require further end-to-end acceptance. |
| Production and ERP | Prepare production requirements and execution plans | Draft frameworks; real execution and ERP integration await acceptance. |
| Huawei Cloud | Support the Topic 1 cloud application | Competition requirements include CodeArts and cloud deployment; current adaptation and evidence remain pending. |

## External services and data

The desktop package includes the application runtime, but not an ERPNext service, model-provider account, credentials, or network access to those services. Configure each external service separately before using its connected features. Stage 6.17 stores its profile data in `profile-data-f630-s6-20261122-17` beside the `program` directory. This package does not automatically read older data from `%LOCALAPPDATA%\TradeLoom`; keep the previous data and program directories when upgrading. See the deployment guide before moving or removing either directory.

## Development

Enterprise server install/start/stop entry points are in the repository root: `Install-EnterpriseServer.ps1`, `Start-EnterpriseServer.ps1`, and `Stop-EnterpriseServer.ps1`; the client URL is `http://127.0.0.1:27417/enterprise/`. See the [Windows enterprise server guide](docs/enterprise-service.md).

The GitHub repository contains source code; cloning it does not install or launch the Electron release. Start with [quick start](docs/quick-start.md) and [runtime preparation and upgrades](docs/upgrade-harness.md) for source-mode development. The deployment package is obtained from the [Stage 6.17 release](https://github.com/Puipipi/tradeloom/releases/tag/stage6.17-windows-x64), not from the Django development page.

## Documentation

| Entry | Read it for |
|---|---|
| [Windows desktop deployment](docs/windows-desktop-deployment.md) | Full package download, checksum, launch, data and upgrade steps |
| [Django enterprise service](docs/enterprise-service.md) | Authentication, accounts/groups, loopback and HTTPS deployment |
| [SKU cost ledger](docs/sku-cost-ledger.md) | Cost model, duty and FX lookups, API contract, acceptance checks |
| [Competition scope and goals](docs/00-赛题与目标.md) | Current Topic 1 direction, official sources and remaining evidence |
| [Acceptance matrix](docs/acceptance-matrix.md) | Scoped checks and their limits; historical entries retain their dates |
| [Agent development](docs/agent-development.md) | Integration background and developer contracts |
| [Architecture](docs/architecture.md) | Technical structure and earlier design context |
| [Work report](docs/work-report.md) | Dated implementation and verification records |
| [R75 portable validation](docs/releases/ui18-r75-validation.md) | Historical archive identity and isolated fresh-start evidence |
| [Historical README](README_legacy_20261026.md) | Former homepage retained for historical reference; its installation paths and status are not current instructions |
| [Topic 2 historical research](docs/00-赛题二历史研究.md) | Preserved AgentArts research, an optional technical reference rather than the selected competition topic |

## Historical validation records

R76 and desktop16 are historical package and validation records, not the current download path. The [R76 validation record](docs/releases/ui18-r76-validation.md) documents its archive checks, isolated QA profile and rebuild boundaries. R75 was a historical fresh-start baseline; its GitHub Release remained a draft. Historical validations do not establish the Stage 6.17 package's runtime or business acceptance.

The older [desktop16 portable release](https://github.com/Puipipi/tradeloom/releases/tag/desktop16-portable-20261026) had SHA-256 `ab973c6bf742979ef3875819a4b7729ef0ba1a3f2018dbc7b28d536cc6b13660`; this identifies that historical package only.

The product is under development. A successful build, simulated workflow or submitted task does not prove a completed business outcome. The final competition requirements follow the latest Huawei rules.

## Contributing and license

Issues and focused pull requests are welcome. Include the source/release snapshot, prerequisites, reproduction steps and actual verification results; use demonstration data instead of customer information or credentials.

No repository-level license file is currently provided. Do not assume this repository is MIT-licensed; third-party components retain their own licenses.
