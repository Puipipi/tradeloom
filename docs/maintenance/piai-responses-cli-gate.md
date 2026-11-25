# 普通自定义 Responses 路由的手动 CLI 门禁

本门禁补充 W17-K / ADD4 中此前未覆盖的 `openai-responses` 普通自定义路由。它使用真实 headless CLI、Agent、pi-ai provider 与 native `todo_write`，模型服务为自有 loopback HTTP 合成响应。它是测试交付，不修复已知产品错误，不更改运行时版本输入。

## 执行

```sh
DSH_PREFIX=/absolute/prepared-prefix \
DSH_EVIDENCE_DIR=/absolute/own-evidence \
node runtime/tests/piai-responses-cli-live.mjs
```

需要准备好的 DSH 0.2.2-rc.1 运行时、Node、可写临时目录和普通 loopback 监听。没有新增依赖。`DSH_EVIDENCE_DIR` 可省略；省略时请求和输出写入本次临时目录，结束随临时 HOME/cwd 一起清除。设置时证据保留在指定目录，使用独占空目录以免覆盖既有同名文件。脚本不写源码目录或 runtime prefix。

## 检查内容

第一次合法 Responses SSE 返回一个 function call，arguments 分两片。真实工具执行后，第二次实际请求中的 `function_call` item ID、call ID、名称、JSON 参数须逐项相等，`function_call_output` 须关联同一个 call ID，输出含 completed。第二响应正常完成，CLI 的最终文本严格相等，reason 为 completed，工具结果仅一条，进程 close 后 code 0、signal null、stderr 为空。

这不声称工具输出所有字段深等，也不覆盖多个工具、取消、异常流或历史迁移。原始实跑已通过，没有产品第一红。采用已安装 pi-ai 的正常 Responses added/delta/done/completed 合同；不用私有 adapter callback。自定义 provider 与合成固定 key 仅指向自身服务，不使用账号、Codex/Azure 或登录路线。

60 秒 watchdog 只防运行挂起；成功路径不等待它。finally 终止尚存的自有子进程、关闭自身 HTTP 服务并删除自身临时目录。测试为 `*-live.mjs`，不自动加入普通 CI 测试集合。

## 设备范围

Android 未编译；未运行 PRoot/ARM、真实远程模型或 Android 动作。设备所有者可在正常构建/安装后的真实 provider 使用中另验工具续轮，但不得把本地合成响应结果当作设备或外部模型验收。
