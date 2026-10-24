# Intake 只读 live 一致性核查（2026-10-24）

本记录是已授权四份来源文件的脱敏只读核查摘要。它不包含原文件名、业务值、文件指纹、身份信息或私有路径，也不构成业务口径确认、正式入库或独立语义正确性证明。

## 方法与结果

- 复用受管 launcher 已有 Python 环境，通过只读 HTTP GET 和 stdin 脚本核查，命令 exit 0；本次没有重启或调用 launcher。初次尝试使用仓库 `.venv` 时因缺 Django/openpyxl 失败，随后复用已有隔离 Python 环境成功。未安装依赖。
- 四份 live snapshot 均为 ready；GET 下载流的 SHA-256/字节数与对应 SourceRecord 元数据相符。这不是对源文件前后状态或单一事务快照的证明。脚本逐字段将 4,276 个来源引用与 1,259 个非空单元格对照当前 parser，差异为 0。状态分类还包括 3,017 个 null、4 个数值零和 84 个带缓存值的公式错误。零与 null 分开统计；84 个公式错误没有被重算或解释成 84 条业务错误。
- 另以只读 ZIP/XML 检查绘图部件和 rich-data 关系：发现 3 个 drawing 部件、4 个 rich-data 图片引用；API 暴露的 7 个图片与原 ZIP 媒体部件摘要一致。未见缺少关系、外链、缺失 target 或非图像 target。4 个 rich-data 图片格的 XML 类型为 `t=e`（错误类型显示值），无 `<f>`，`formula_status=not_formula`，snapshot `error_code` 为空；它们不归入带缓存公式错误的 84 格。84 个缓存公式错误均保留 `<f>` 与 `<v>`；与 rich-data 图片坐标重合数为 0。该结构检查验证关系与字节对应，不单独证明图片含义或业务字段语义。
- 只读查询显示：来源一有一个 production-instruction mapping revision 和一个未确认候选；该候选没有 links，也没有 successful product application；四份来源均无 successful product application，来源一没有 requirement draft，其余三份来源未见 mapping candidate。该结果只说明本地 intake 外键路径未建立对应草稿，不能推断外部 ERP 或不存在未关联的手工订单。
- 每项数据通过多个 GET 获取，不是单一数据库事务快照；并发写入可能使读取期间状态变化。本次未新增上传、确认、产品应用或其他写请求；不据此声称此前从未导入原件。

## 解释边界

当前 parser 与 snapshot 一致只说明本次读取的归一结果相符，不是独立的业务语义复核。来源日期与商业关系仍未确认；工时依用户说明属于人工记录且多为估算，不能据此推导真实员工产量或工资；金额精确性仍需逐项核对公式、币种和业务确认。本次没有确认采购/报价/生产表之间的同一订单或产品关联。
