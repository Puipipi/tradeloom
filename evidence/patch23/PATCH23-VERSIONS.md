# Patch 23 版本索引

- v1 hash `45E35CC6935E8E21E1DDC8FC13DC38C8987E6E476F25142AE1700890FEC6431B` 已过时，未交前端。原 patch 与 delivery 留存在 `desktop-ai-web-readonly-diagnostics-v1-45E3-obsolete.patch`、`23-delivery-v1-45E3-obsolete.json`；历史测试结果未覆盖。
- 当前 patch23-v2 hash `2A3EFE8E01C040696C72F2F27908C1DEAC8B77CB6D7584498C420FBFFF5C0AB7`，交付记录为 `23-delivery-v2.json`。规范 patch 路径 `integrations/dsh/patches/desktop-ai-web-readonly-diagnostics.patch` 指向 v2。
- v2 只改专用 Electron fixture/build helper：每次使用 UUID 隔离 profile，不删除目录；builder 自动对 fixture 和每个输出 CJS 执行 Node 语法检查。不改诊断生产逻辑。
- v2 专用受控 Electron run ID `85de79d6-cb3a-42df-907a-9d3d7af0a96d`，12 项通过；见 `electron-diagnostics-result-v6-85de79d6-cb3a-42df-907a-9d3d7af0a96d.json` 和 `electron-export-v6-85de79d6-cb3a-42df-907a-9d3d7af0a96d.json`。
- v1 与 v2 都未部署/重启；前端尚未消费 23。
