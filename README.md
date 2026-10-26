# TradeLoom · 织贸助手

English / [简体中文](README_cn.md)

An AI workbench for integrated manufacturing and foreign-trade teams: organize business information, preserve its sources, and prepare drafts and deliverables for human review.

**Huawei ICT Competition · 11th edition (2026–2027) · Innovation Competition · Topic 1: Building AI innovative applications with Huawei Cloud products.**

TradeLoom supports manufacturing and trade work, with product catalogs and sample lists as examples. Production requirements, execution plans and ERP integration remain draft frameworks awaiting acceptance. Huawei Cloud adaptation is still awaiting acceptance; this repository does not claim a completed competition deployment. See [competition scope and goals](docs/00-赛题与目标.md).

## Download and try

Use the [desktop16 portable release](https://github.com/Puipipi/tradeloom/releases/tag/desktop16-portable-20261026) for a Windows x64 trial. The repository is currently private; downloading requires access permission.

1. Download `TradeLoom-desktop16-portable-win-x64.zip` (406,666,826 bytes; approximately 388 MiB).
2. Extract the entire archive into a short path such as `C:/Apps/TradeLoom`.
3. Double-click `Start-TradeLoom.cmd`.

SHA-256:

```text
ab973c6bf742979ef3875819a4b7729ef0ba1a3f2018dbc7b28d536cc6b13660
```

The package contains Electron 44.7.0, Node, pnpm, Python and the fixed desktop16 interface, without user profiles. Django, ERPNext, PostgreSQL and model accounts are not included; business panels require configured services. Advanced Office conversion also requires the Microsoft Visual C++ x64 runtime.

## Features and status

| Area | Purpose | Current status |
|---|---|---|
| Product information | Organize product facts and identify missing information | Implemented flows have scoped acceptance records; business rules still need validation. |
| Deliverables | Prepare catalogs and sample lists with human review | Selected generation, preview and review flows verified; quotations and the complete business cycle remain in progress. |
| AI workspace | Connect conversation, files and task workflows | Native sessions, draft attachments and web file bridges are still under acceptance. |
| Persistence and execution | Keep task history and resume work | Real runners and PostgreSQL restart recovery require further end-to-end acceptance. |
| Production and ERP | Prepare production requirements and execution plans | Draft frameworks; real execution and ERP integration await acceptance. |
| Huawei Cloud | Support the Topic 1 cloud application | Competition requirements include CodeArts and cloud deployment; current adaptation and evidence remain pending. |

## Development

Start with [quick start](docs/quick-start.md) and [runtime preparation and upgrades](docs/upgrade-harness.md). Cloning the source does not provide the external runtime or configured services. These documents contain earlier environment records: verify the applicable runtime before using their commands.

`main` source, the fixed desktop16 release, and newer development candidates are different snapshots. desktop19 has passed its build, but has not been deployed or included in this `main` update.

## Documentation

| Entry | Read it for |
|---|---|
| [Competition scope and goals](docs/00-赛题与目标.md) | Current Topic 1 direction, official sources and remaining evidence |
| [Acceptance matrix](docs/acceptance-matrix.md) | Scoped checks and their limits; historical entries retain their dates |
| [Agent development](docs/agent-development.md) | Integration background and developer contracts |
| [Architecture](docs/architecture.md) | Technical structure and earlier design context |
| [Work report](docs/work-report.md) | Dated implementation and verification records |
| [Historical README](README_legacy_20261026.md) | Unchanged former homepage; historical paths, Topic 2 statements and status are not current instructions |
| [Topic 2 historical research](docs/00-赛题二历史研究.md) | Preserved AgentArts research, an optional technical reference rather than the selected competition topic |

## Current limits

The portable package passed archive CRC, 21,090 file hashes, launch preflight from a new path without system Node, and 23 background read-only route checks. The GUI has not been rechecked after the final correction. Real-model and business end-to-end behavior is not established by these checks.

The product is under development. A successful build, simulated workflow or submitted task does not prove a completed business outcome. The final competition requirements follow the latest Huawei rules.

## Contributing and license

Issues and focused pull requests are welcome. Include the source/release snapshot, prerequisites, reproduction steps and actual verification results; use demonstration data instead of customer information or credentials.

No repository-level license file is currently provided. Do not assume this repository is MIT-licensed; third-party components retain their own licenses.
