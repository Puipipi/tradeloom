# 暂未收录的候选

`candidates/` 不参与生成索引，不等于通过审核。需要解决原因后，将条目移入 `plugins/`，重新跑完整检查。

| 候选 | 实查结果 | 后续 |
| --- | --- | --- |
| `dsh-univer-office@0.3.9` | 2026-10-30 npm `dist.unpackedSize` 为 195946027 字节，超过 50 MiB 上限 | 作者减小包体，或维护者另行修改已公布政策；本次不豁免 |

其他社区页推荐项的实际固定版本见 `plugins/`。只有 `npm run build` 完成后产生的 `dist/audit.json` 能说明某次检查的结果。

## 2026-10-31 媒体插件移入正式目录

`@ccch1mneyyy/dsh-media@0.2.1` 已正式发布到 npm；匿名精确版本及真实 tarball 均可读取，下载内容与本地发布包一致。市场检查重新下载发布物并核对注册表 SHA-512，通过条目格式、MIT/OSI 许可、归档安全、包身份、DSH bundle patch 及精确版本公告检查，已移入 `plugins/`。`policy.json` 只将这个媒体包标为官方；原计划包名 `@dsh-go/media`、暂存的 `0.2.0` 及暂存占位版本均不收录。

静态结果为 `adapted: true`、`minApp: 1.0.2`、`features: [media]`，风险为 medium（shell、network、filesystem）。这些结果不代表依赖树已审核，也不代替 App 安装和真实付费生成验证。发布与线上验收记录见 `../VERIFICATION.md`。
