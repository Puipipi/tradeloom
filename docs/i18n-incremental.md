# 文案增量与人工修订保留

[English](i18n-incremental.en.md)

`app/tool/l10n_catalog.py` 是离线维护工具。它生成来源指纹和可审阅的工作计划；不调用模型、不写回 ARB 或译文、不设置应用语言、不把审核声明当作可信认证。现有输出文件一律拒绝覆盖。

## 使用流程

在一次修改前保存来源目录快照：

```sh
python3 app/tool/l10n_catalog.py snapshot --output catalog-v1.json
```

修改文案后，用旧快照和对应语言的维护状态生成新计划：

```sh
python3 app/tool/l10n_catalog.py plan --locale ru \
  --previous catalog-v1.json --translations ru-state-v1.json \
  --output ru-plan-v2.json
python3 app/tool/l10n_catalog.py snapshot --output catalog-v2.json
```

开始一门尚无译文的语言时省略 `--translations`。`--repo PATH` 可读取另一份仓库工作副本；默认是脚本所在仓库。输出目录必须已存在。工具只读 `app/lib/l10n/parts/` 的中英来源，不访问聊天记录、账号、设备或凭据。

`sourceDiff` 给出 `new / changed / removed / unchanged` 四组键，比较的是旧来源快照与当前来源；`freshness` 比较的是每条译文所绑定的来源与当前来源。因此文案在这两份来源快照间未变，也可能有更早的译文仍然 stale。

| 情况 | 保留内容 | 计划位置 |
|---|---|---|
| 没有译文 | 不生成目标文本 | `translationQueue`，reason 为 `missing` |
| 来源变化，AI 草稿且未锁定 | 完整保留旧文本、旧来源 hash 和旧翻译 hash | `preservedTranslations` + `freshness: stale`，进入建议重译队列 |
| 来源变化，声明人工审核或已锁定 | 同上，绝不自动替换 | `preservedTranslations` + `freshness: stale`，仅进入 `humanReviewQueue` |
| 来源未变且译文绑定当前来源 | 保留文本与状态 | `freshness: current`，不进入重译队列 |
| 来源键删除 | 保留旧文本、审核声明、锁定和原 hash | `retiredTranslations` + `freshness: removed` |

所有队列项的 `sourceHash` 对应**当前**准备项；保留和退休译文记录中的 `sourceHash` 仍是它们原来绑定的来源。队列只是建议清单，不触发模型请求或任何写回。即使条目进入建议重译队列，旧 AI 草稿也不会被丢弃。

## 数据契约 v1

来源快照标识：`format: dsh-go-i18n-catalog`、`schemaVersion: 1`、`sourceHashAlgorithm: sha256-canonical-source-v1`。每条来源的 hash 计算对象严格为：

```python
payload = {"area": area, "zh": chinese_text,
           "en": english_text, "metadata": chinese_at_key_or_empty_object}
source_hash = sha256(json.dumps(payload, ensure_ascii=False,
                               sort_keys=True, separators=(',', ':'),
                               allow_nan=False).encode('utf-8')).hexdigest()
```

这与当初四语草稿（没有入库）里的 `source-all-hashes.json` 是同一算法；在 `d38c1f0` 上，5477 个键逐条对比一致。`area` 纳入 hash，所以仅移动分片也会保守地要求重审。`metadata` 采用中文模板 `@key`，包含参数类型和已有说明；未提供时用 `{}`。英文 `@key` 不是模板类型来源，不纳入这个版本的 hash。

独立术语表或风格指南的版本不包含在 v1 来源 hash 中。它们变化时，维护者需另列相关词条的人工重审任务，不能因为文案 hash 未变就跳过术语检查。

翻译维护状态格式：

```json
{
  "format": "dsh-go-i18n-translations",
  "schemaVersion": 1,
  "locale": "ru",
  "entries": {
    "commonCancel": {
      "text": "Отмена",
      "sourceHash": "<当前或历史来源的64位小写SHA-256>",
      "translationHash": "<目标字符串的64位小写SHA-256>",
      "review": "ai-draft",
      "locked": false
    }
  }
}
```

上面的尖括号是说明，不是可直接执行的数据。`translationHash` 使用同一 canonical JSON 算法，对象是目标**字符串本身**，不是 UTF-8 裸字符串。审核绑定应至少包含 locale、key、sourceHash、translationHash。修改目标文本却沿用旧 translationHash 会被拒绝；需要重新生成 hash 并重新决定审核状态。

`review` 只接受 `ai-draft` 或 `human-reviewed`，`locked` 必须是 JSON 布尔值。这些字段是本地维护者工作流声明，**没有签名、身份验证或语言质量保证**。外部导入包不得凭自称 `human-reviewed` 获得发布或应用内激活资格。锁定只表示保护该文本；不表示译文正确。对来源变更的人工译文，即使保留原审核声明，`freshness: stale` 也明确要求重新审核。

快照/状态的未知结构字段、重复 JSON 键、非 JSON 常量、错误形状、hash 不匹配和两个来源目录中都不存在的译文键都会失败，不会静默忽略。合法删除条目保留到退休区，不直接删除。保留旧来源快照，才能区分真正删除的旧键与未知输入键。

## 检查与费用计量

```sh
python3 -m unittest discover -s app/tool -p test_l10n_catalog.py -v
python3 app/tool/l10n_merge.py --check
```

指纹工具不替代 ICU/占位符校验。计划完成后仍要通过文案结构检查、项目 Flutter 的 `gen-l10n`、目标语言母语复核和界面回归。它不自动导入 ARB，也不自动发布任何语言。

`metrics` 记录键数、Python Unicode 字符数和英文按空白划分的词数，包含 ICU 语法、标记和占位符；**不是 token 数，也不是计费估算**。本次 `d38c1f0` 快照：5477 个键，中文 52337 字符，英文 144756 字符，英文空白分词 23245。计划还单独统计建议重译队列与人工复核队列的这些指标，方便按真实改动量准备批次。

例如源文案变更 20 个键时，四种目标语言最多各需要查看这 20 个来源变化，外加各自缺失或已陈旧的条目；不能每次都把全量重译一遍。是否耗费模型费用、需要多少 token 或多久人工审完，要按实际模型、上下文、译文长度与审核方法另行测量。
