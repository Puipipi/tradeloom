# 这里是「DSH 基座补丁」，不是业务代码

这个目录里放的是**对 DSH 基座（app.asar 内 `dsh/**`）的补丁**，属于受控例外。

- 已登记 5 项，清单在仓库根 `dsh-base.manifest.json` → `base.sanctionedPatches`。
- 新增或删除任何文件，必须先改清单，否则 `node scripts/check-dsh-base-boundary.mjs` 会失败。
- 这些补丁是**按基座版本写的**：基座从 `0.2.1-rc.3` 升级时，5 项全部需要重新核对锚点，见 `docs/DSH-基座升级方案.md` 的实测数据。
- 不要在这里放业务功能；业务代码请放 `packages/tradeloom-shell/**` 或 `apps/tradeloom-launcher/accepted-runtime/**`。

规则全文：`docs/DSH-基座边界.md`。