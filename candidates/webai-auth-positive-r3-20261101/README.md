# WebAI 正证并发修复候选 R3

本候选以冻结 R2 为基线；R2 JS SHA-256：`E7E2DEC1DB29E832C4CE68923D16740D895899DCFFF50CEE7E12ACEB10E06460`。R2、A4B、26841 和 2154 均未修改。

## 修复范围

R2 中同文档并发调用会在采样开始时捕获旧的正证状态。完整菜单采样先发布 authenticated 后，较早开始的闭菜单采样仍可能用过期的 `wasPositive=false` 清成 unknown。R3 仅在 WebAI auth adapter 增加单调采样序号和最后一次明确决定序号：

- 合法的菜单缺失/不完整是“没有新证据”，不设置屏障；它不能降级同文档已有正证，若先完成也不会阻挡仍在途的有效正证。
- 完整正证、明确登录负证及畸形/失败采样提交决定序号。更早发起、较晚完成的结果不能覆盖这些更新决定，避免旧正证复活已观察到的负证或 unknown。
- 继续使用原文档身份、generation 和 lifecycle 检查；导航、关闭、dispose 和 stale 结果仍无法复活状态。

双站规则、DTO、publisher 白名单均未新增。本候选未改 Main、前端、SDK，也没有部署。

## 移植

只需审阅/替换 `after/webai-auth-state.js`；`.d.ts` 与 R2 相同。没有 publisher 或 evidence DTO 变化。相对路径补丁为 `webai-auth-state.patch`。验证与原始命令输出在 `recovery-20261029/webai-auth-positive-r3-20261101/`。
