# 赛事材料导航

完整本机比赛资料已集中到父容器 `ICT/competition/`，该目录由上级 `.gitignore` 忽略，不属于本仓库：

- `competition/official/`：官方手册、路演材料、提交要求 PDF。
- `competition/templates/`：官方 Word / PPT 模板，各保留一份 canonical 副本。
- `competition/submissions/`：TradeLoom 作品信息收集表填写稿。

本目录不再保存模板副本或填写稿。需要材料时直接在本机打开 `ICT/competition/`；GitHub 上不提供跨仓库链接，避免失效路径。

官方来源：

- 大赛门户：<https://e.huawei.com/cn/talent/>
- 模板 1 下载：<https://e.huawei.com/cn/talent/backplatform/#/download?fileId=16769&edocId=M3T1A82N1317412811624698043>
- 模板 2 下载：<https://e.huawei.com/cn/talent/backplatform/#/download?fileId=16464&edocId=M3T1A82N1301250366710833355>
- AgentArts 产品页：<https://www.huaweicloud.com/product/agentarts.html>

填写稿生成脚本仍在本仓库：`scripts/fill_form.py`。脚本默认读取 `ICT/competition/templates/`，输出到 `ICT/competition/submissions/`，可用 `TRADELOOM_COMPETITION_DIR` 覆盖。
