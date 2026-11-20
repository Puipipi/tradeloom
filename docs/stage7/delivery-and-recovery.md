# 阶段 7 交付与恢复

## 固定构建

构建使用经 Windows Authenticode 验证的 0.2.2-rc.3 官方 Windows x64 输入和已校验的 Python、PostgreSQL、程序 seed 及资源编辑工具。沿现有离线入口执行 `python -B scripts/build-dsh-candidate.py --version 0.2.2-rc.3`，参数为独立 `--vendor-root`、`--output-root`、`--python-packages`、`--postgresql`、`--plugin-seed`、`--data-root`、`--resource-editor`。准确绝对参数和退出码在本机交付回执，由构建产物的 `build-receipt.json`、`source-manifest.json`、`program-entry-manifest.json` 与 `asar-entry-manifest.json` 对应程序树、源码 ZIP 和固定上游身份。

本次最终预期 ASAR 为 228,830,030 B，SHA-256 `2c062d456069a6bdad4177509cfb84001f8b839d4125148fdd7b7be8ab819d0f`。业务壳 77 件、3,037,873 B，SHA-256 `874761fe0739dc091fd2075fa5ed3b7a809fd19a83f4aac63e8fd41dae7a9686`。安装树只含程序和固定公开启动配置，隔离 DATA、登录信息与凭据留在交付范围之外。

## 同路径换版与恢复

先核现行目标为独立程序目录，标准端口空闲且该目标进程全部退出。保持同卷、独立于程序及 DATA 的新事务目录。只用完整候选清单和当前目标清单的 SHA-256 固定同路径替换，不接受安装树或 launcher 配置漂移。以现有事务入口操作：

```powershell
python -B scripts/apply-dsh-candidate.py apply --target <程序目录> --work-root <新事务目录> --candidate-root <候选程序目录> --candidate-manifest <候选清单> --candidate-manifest-sha256 <候选SHA256> --target-manifest <目标清单> --target-manifest-sha256 <目标SHA256>
python -B scripts/apply-dsh-candidate.py rollback --target <程序目录> --work-root <同一事务目录>
```

正常退出后比较 `installed-entry-manifest.json` 或 `restored-entry-manifest.json`、该阶段 ASAR 和当前 launcher 配置。入口沿原事务验证，对未知状态保留事务日志并使用该程序的 `recover` 分支。回退和恢复沿原程序与数据隔离边界，独立 DATA 由正在运行的工作台正常维护。真实换版、设置保全、应用回归与退出证据见后续独立运行回执。
