# N03 单产品历史事实回退

本后端切片允许可信 native bridge 对一个产品的历史版本预览并显式回退五个文字事实：`name`、`category`、`material`、`size`、`color`。它不恢复 SKU、图片字段或文件、整行产品、其他产品、数据库、SDK profile/engine，也不包含 UI 确认流程。

## API

两条接口都只接受 `POST`，沿用现有 native API 的 CSRF exemption 与 `X-TradeLoom-Native-Bridge` 私有 bridge 校验；该 exemption 不构成授权，缺失/错误 bridge 都返回 403。浏览器 cookie 或请求体中的 actor 不构成授权。响应带 `Cache-Control: no-store`。

预览：

```http
POST /api/products/{productId}/fact-restoration/preview
X-TradeLoom-Native-Bridge: <由受信 Host 注入的 64 位十六进制密钥>
Content-Type: application/json

{"sourceRevisionId":"<同一产品的历史 revision id>"}
```

成功返回 `code=preview_ready`、固定 `scope`、源 revision id/version/status/reviewer/time/snapshot SHA、当前/目标五字段、差异、当前 live fingerprint、latest revision 摘要、`previewDigest`、`wouldCreateBackup` 和 `noOp`。预览只读，不会为未同步的当前产品事实创建 revision。

执行必须由可信控制器显式发起：

```http
POST /api/products/{productId}/fact-restoration/apply
X-TradeLoom-Native-Bridge: <同一受信 Host 注入值>
Content-Type: application/json

{
  "sourceRevisionId":"<预览中的源 revision id>",
  "expectedLatestRevisionId":"<预览中的 latest id；没有时为 null>",
  "expectedLiveFingerprint":"<预览返回的 SHA-256>",
  "previewDigest":"<预览返回的 SHA-256>",
  "confirm":true
}
```

`confirm` 表示调用方明确要求执行，不是人类批准凭证。实现不新增 AI 工具，也不声称已经连接人类确认界面。成功的 `status` 为 `restored` 或 `no_op`。回退前若最新 revision 没有精确代表完整当前 legacy facts 与图片身份，会先追加完整当前事实 backup revision；随后只改五个目标字段、重算 `missing_fields`、将 Task 设为 `awaiting_confirmation`，并追加 `needs_review` revision（空 reviewer，source refs 指向源和 backup）。历史 revision 行不改写。无字段变化时返回 `no_op`，不改变旧审核状态或增加 revision。

历史源的五个字段必须是字符串且通过对应 Product 字段的既有 validators；空字符串仍可恢复为待补全值，超长字符串在预览时以 `source_revision_invalid` (409) 拒绝。错误码还包括 `native_bridge_forbidden` (403)、`invalid_request` (422)、`product_not_found` / `source_revision_not_found` (404)、`restore_preview_stale` / `restore_backup_unavailable` (409)、`restore_failed` (500) 和 `method_not_allowed` (405)。过期预览不会自动重试；调用方应重新读取并预览。数据库事务失败时，产品、Task、backup 和新 revision 一起回滚。

`no_op` 不写任何内容，也不会把一个与当前完整 legacy facts 不匹配的 latest revision 冒充 backup；这种返回的 `backupRevisionId` 为 `null`。

## 验证与边界

`workbench.tests.test_product_fact_restoration` 在本次 marker-owned PostgreSQL 17.11、CPython 3.12.14 上最终通过 10/10 项测试（无 Django HTTP listener），覆盖只读预览、CSRF-enforced test client 下的 bridge/严格 DTO、字段长度与空值、五字段范围、未同步事实备份、no-op、stale/foreign source、写失败回滚和同 preview 并发。测试用 Django test client；隔离测试 DB 是一次性 synthetic 数据，不是产品数据库。初始 red 运行在路由尚未接入时得到 404，保留于 recovery 证据中。后续曾有一次新增校验用例因测试尝试改写不可变 revision 而报错；改为创建无效 synthetic revision 后，同一自有 cluster 最终运行通过。最终 PG stop exit 0、`pg_ctl status` exit 3。命令、原始输出和 receipts 位于 [`recovery-20261029/n03-product-facts-restore-20261031`](../../recovery-20261029/n03-product-facts-restore-20261031/)，详细过程见[验证记录](../../recovery-20261029/n03-product-facts-restore-20261031/VALIDATION.md)。

这只覆盖一个产品的五个事实字段。生产 Host/UI、人类确认、图片/附件、SKU、其他数据域以及完整 N03 恢复范围均未由本切片证明。
