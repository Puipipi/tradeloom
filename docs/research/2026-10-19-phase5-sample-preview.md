# Phase 5 样品清单 CSV 预览切片

## 目标与边界

Phase 5 Task 19 的用户目标包含预览生成的目录草稿和样品清单。既有页面能预览 HTML/Markdown 目录并下载样品清单 CSV，但没有 CSV 版本的表格预览。本切片只补充已登记 `sample_checklist_csv` 版本的只读预览；不解析任意文件，不从当前 Product 重建内容，也不审批或登记新版本。

## 既有实现与约束

- 交付生成器使用 `csv.DictWriter` 和固定 `CHECKLIST_FIELDS` 顺序，输出 UTF-8、逗号分隔、双引号转义、LF 行尾；CSV 字节保存在 ArtifactVersion 对应路径。
- `get_artifact_version(workflow_id, version_id)` 同时检查工作流归属、受限 artifact 根路径、文件存在和登记 SHA-256。预览与下载继续复用此校验；仅从数据库登记的具体版本读字节。
- CSV 使用 `utf-8-sig` 解码以兼容 UTF-8 BOM，再以 Python 标准库 `csv.reader` 和 `newline=""` 保留逗号、双引号、嵌入换行与中文；表头固定比对 `CHECKLIST_FIELDS`，记录列数不一致时返回固定错误，不显示本机路径。
- Django 模板自动转义表头和单元格，保留换行显示。页面显示本地模拟提示，并按版本实际状态显示草稿、待审核、已批准或已驳回；同时显示对应版本、来源 ProductRevision、字节数、SHA-256 和同版本下载入口。读取不修改审核状态、ArtifactVersion、EventLog 或文件。
- CSV 预览响应保留 sandbox CSP 与 `nosniff`，仅增加 `sandbox allow-downloads` 以允许同版本链接触发浏览器附件导航；脚本与表单仍禁用。JSON、质检报告和其他文件格式仍仅下载；HTML/Markdown 原预览响应策略保持原样。

## 官方资料

- Python 标准库 [`csv`](https://docs.python.org/3.14/library/csv.html)：使用 `csv.reader`、文件对象 `newline=""` 解析标准 CSV 引号与嵌入换行。
- Django 模板[自动 HTML 转义](https://docs.djangoproject.com/en/5.2/ref/templates/language/#automatic-html-escaping)：动态表头与单元格由模板默认转义，避免把 CSV 内容解释为 HTML。
- MDN [CSP `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)：允许附件导航下载需要 `allow-downloads` sandbox capability。

## 验收状态

目标测试 7/7、workbench 全量 294/294、Django check、迁移 no-drift 和 diff check 均通过。旧 `tradeloom_ui_phase3_files` QA 数据库只有 workbench 0001/0002，本切片未迁移；两个目标 CSV 版本均以 HTTP GET 成功预览/下载，表格 13 列与 2 行逐格匹配保存 CSV，v1 显示已驳回、v2 显示已批准，下载字节和 SHA 与版本登记一致。QA 前后 15 表/3 sequence/迁移行/媒体与 Artifact 文件完全不变。

当前源码通过受控重启恢复正式 8000：旧 owned listener/launcher 20916/45200 停止，新 listener/launcher 44680/45256，PostgreSQL PID 30328 保持运行。GET 五板块、旧 Workflow 页面/API、health 与 CSS/JS 均 200；CSRF 只读意图 preview 200/ready。正式 15 表 306 行、3 sequence、5 migration、90 uploads、0 Artifact 和旧 Workflow `07082f323dfa4746a6f83e0df870ae7d` 的 `waiting_human`/5 pending 状态前后不变。QA 服务 owned 8011 已停止且端口释放。

无 CUA/Playwright 浏览器验收，HTTP 响应不能证明浏览器点击下载成功；probe 保存了摘要、下载字节与逐格比较结果，未保存原始 HTML 正文。完整 Phase 5/Phase 4/Phase 7 和真实浏览器 e2e 不由本切片代替。全量快照、运行日志和下载证据位于项目外 `workspace/testing/phase5-sample-preview/`。
