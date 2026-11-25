# 从空目录到市场：做一个原生工具卡插件

[English](en/from-zero.md)

这篇从空目录做一个可安装的 DSH 插件。它统计输入文本的 Unicode 码点、UTF-8 字节和行数，在 dsh-go 中显示原生卡片，同时保留模型和网页版可读的普通工具结果。示例不联网、不写文件、不读剪贴板；输出只含计数。

完成路径是：写出 bundle → 跑测试和原生视图检查 → 安装到主机 → 检查发布 tarball → 发布自己的包 → 核对市场索引。每一步都可以单独确认。

## 1. 准备开发环境

示例基于 **DSH / dsh-tools 0.2.1-rc.4**，需要 Node 22.19 或以上（本文在 Node 24 上验证）。DSH Go 现在内置 0.2.2-rc.1（要求 Node 24.9 或以上），仓库里的示例插件也在它上面跑测试。

`engines.dsh` 和 dsh-tools 的依赖写**验证过的版本范围**，和仓库里的示例插件一样：`">=0.2.1-rc.2 <0.3.0-0"`。DSH 安装时按 semver 比较，写成一个精确版本，引擎一升级（例如 rc.2 → rc.4）插件就会被拒装，哪怕代码一行没变。下限写你测过的最低版本；上限停在下一个次版本之前，因为 0.x 的次版本可以有破坏性改动。要支持范围以外的版本，先在那个版本上跑一遍同样的测试，再放宽。

需要一个已安装的 `dsh` CLI，以及一份包含 `sdk/plugin-kit/` 的 dsh-go 开发源码。SDK 目前随仓库分发，没有发布到 npm；不要把示例中的名称 `@dsh-go/plugin-kit` 当成可直接安装的公共包。本文直接调用源码中的检查器，插件运行时只依赖 DSH 提供的 `dsh-tools`。

```sh
node --version
npm --version
pnpm --version
dsh --version

# 替换成你取得的完整 dsh-go 开发源码根目录。
DSHGO_DEV_ROOT=/absolute/path/to/dsh-go
mkdir -p dsh-text-metrics-demo/lib dsh-text-metrics-demo/test
cd dsh-text-metrics-demo
```

## 2. 写出完整插件

以下七个文件都位于刚创建的目录中。`package.json` 的 `dsh.bundle.patch` 声明安装层，`cordis.patch.yml` 把这个包的入口挂入 DSH。这里没有 `dshGo` 清单：**只显示工具结果卡片并不需要桥接清单**。

`render` 返回模型读取的普通文本；`presentationMeta` 提供 App 的卡片。卡片使用固定组件和具体数值，没有工具卡不支持的数据绑定或按钮。`toolCard` 将视图变成纯 JSON，并在构造失败或超过 8 KiB 时退回没有卡片的正常工具结果。

输入上限按 UTF-16 码元计数；输出码点不是字形，组合字符和 emoji 可能不同。CRLF 算一个换行，空文本算 0 行。这些定义写进测试，避免把不明确的“字数”做成误导结果。

### package.json

<!-- file: package.json -->
```json
{
  "name": "dsh-text-metrics-demo",
  "version": "0.1.0",
  "private": true,
  "description": "A DSH tool with a bilingual native text-metrics card.",
  "type": "module",
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "scripts": { "test": "node --test test/*.test.js" },
  "engines": { "node": ">=22.19", "dsh": ">=0.2.1-rc.2 <0.3.0-0" },
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.1-rc.2 <0.3.0-0" },
  "devDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.1-rc.2 <0.3.0-0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

### cordis.patch.yml

<!-- file: cordis.patch.yml -->
```yaml
- insert:
    - id: text-metrics-demo
      name: dsh-text-metrics-demo
```

### lib/measure.js

<!-- file: lib/measure.js -->
```js
export function measure(text) {
  if (typeof text !== 'string' || text.length > 8000) {
    throw new TypeError('text must be a string of at most 8000 UTF-16 code units')
  }
  return {
    codePoints: [...text].length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    lines: text === '' ? 0 : text.split(/\r\n|\r|\n/).length,
  }
}
```

### lib/view.js

<!-- file: lib/view.js -->
```js
export function metricsView(value) {
  const en = value.language === 'en'
  return {
    type: 'stack',
    title: en ? 'Text metrics' : '文本统计',
    children: [
      { type: 'metric', label: en ? 'Code points' : '码点', value: value.codePoints },
      { type: 'metric', label: en ? 'UTF-8 bytes' : 'UTF-8 字节', value: value.utf8Bytes },
      { type: 'metric', label: en ? 'Lines' : '行', value: value.lines },
      { type: 'text', text: en ? 'Code points are not grapheme clusters.' : '码点数不等于肉眼看到的字形数。', tone: 'muted' },
    ],
  }
}

export function toolCard(build) {
  return (args, value) => {
    try {
      const json = JSON.stringify(build(args, value))
      if (json === undefined || Buffer.byteLength(json, 'utf8') > 8 * 1024) return {}
      return { 'dsh-go/view': JSON.parse(json) }
    } catch {
      return {}
    }
  }
}
```

### lib/index.js

<!-- file: lib/index.js -->
```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import { measure } from './measure.js'
import { metricsView, toolCard } from './view.js'

export const name = 'text-metrics-demo'
export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'text_metrics',
    description: 'Count Unicode code points, UTF-8 bytes and lines in text. Does not store or send the text.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text, at most 8000 UTF-16 code units.' },
      language: { type: 'string', enum: ['zh', 'en'], description: 'Card language. Default zh.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          codePoints: { type: 'integer', required: true },
          utf8Bytes: { type: 'integer', required: true },
          lines: { type: 'integer', required: true },
          language: { type: 'string', enum: ['zh', 'en'], required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.codePoints} code points; ${value.utf8Bytes} UTF-8 bytes; ${value.lines} lines.`,
      }],
      presentationMeta: toolCard((_args, value) => metricsView(value)),
    },
    isConcurrencySafe: () => true,
    execute: (args) => ({ ...measure(args.text), language: args.language === 'en' ? 'en' : 'zh' }),
  }))
}
```

### test/metrics.test.js

<!-- file: test/metrics.test.js -->
```js
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'
import { measure } from '../lib/measure.js'
import { metricsView, toolCard } from '../lib/view.js'

test('Unicode code points, UTF-8 bytes and CRLF are counted explicitly', () => {
  assert.deepEqual(measure('你好\nA'), { codePoints: 4, utf8Bytes: 8, lines: 2 })
  assert.deepEqual(measure('A😀\r\n中'), { codePoints: 5, utf8Bytes: 10, lines: 2 })
  assert.deepEqual(measure('e\u0301'), { codePoints: 2, utf8Bytes: 3, lines: 1 })
})

test('empty text and input bounds have defined behavior', () => {
  assert.deepEqual(measure(''), { codePoints: 0, utf8Bytes: 0, lines: 0 })
  assert.equal(measure('😀'.repeat(4000)).codePoints, 4000)
  assert.throws(() => measure('😀'.repeat(4001)), TypeError)
  assert.throws(() => measure(null), TypeError)
})

test('real defineTool output validates and carries both model text and a card', async () => {
  const registered = []
  apply({ tools: { register: definition => registered.push(definition) } })
  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'text_metrics')
  for (const language of ['zh', 'en']) {
    const args = { text: '你好\nA', language }
    const value = await tool.execute(args)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [])
    const meta = tool.output.presentationMeta(args, value)
    assert.deepEqual(meta['dsh-go/view'], metricsView(value))
    assert.ok(Buffer.byteLength(JSON.stringify(meta['dsh-go/view']), 'utf8') < 8192)
    assert.equal(tool.output.render(args, value)[0].type, 'text')
    assert.ok(!JSON.stringify(meta).includes(args.text))
  }
})

test('a broken or oversized card does not fail the tool result', () => {
  assert.deepEqual(toolCard(() => { throw new Error('broken view') })({}, {}), {})
  assert.deepEqual(toolCard(() => undefined)({}, {}), {})
  assert.deepEqual(toolCard(() => ({ text: 'x'.repeat(8192) }))({}, {}), {})
})
```

### README.md

<!-- file: README.md -->
```markdown
# Text metrics / 文本统计

The `text_metrics` tool counts Unicode code points, UTF-8 bytes and lines.
It does not store the input or make network requests. dsh-go shows a native
card; the DSH web client keeps the ordinary text result.

`text_metrics` 统计码点、UTF-8 字节和行数，不保存输入、不发网络请求。
码点不是字形；空文本为0行。输入上限8000个UTF-16码元。

Development baseline: DSH and dsh-tools 0.2.1-rc.4, Node 22.19+. Supports DSH >=0.2.1-rc.2 <0.3.0-0.
Run `npm install --ignore-scripts` and `npm test` before installing this local bundle.
This tutorial package is private; choose a unique name and a license before publishing.
```

## 3. 测试并检查原生视图

在插件目录执行：

```sh
npm install --ignore-scripts
npm test
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/check.mjs" . --load
```

这里的单测使用真实的 `@deepseek-ai/dsh-tools` 定义和输出校验。注册用的 `ctx.tools.register` 是测试收集器；这一步不等于主机完整启动。正常结果为 4 项通过，检查器显示注册了 `text_metrics`。“没有 dshGo 清单：只有工具卡（presentationMeta）这类零成本扩展”是这个示例的正常提示。

把一个确定的调用结果导出为视图 JSON，供检查器和预览使用：

```sh
node --input-type=module > card.json <<'JS'
import { measure } from './lib/measure.js'
import { metricsView, toolCard } from './lib/view.js'
const args = { text: '你好\nA', language: 'en' }
const value = { ...measure(args.text), language: args.language }
console.log(JSON.stringify(toolCard((_args, v) => metricsView(v))(args, value), null, 2))
JS
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/check.mjs" card.json --lang en
```

结果应是 4 个码点、8 个 UTF-8 字节、2 行，卡片检查无问题。中文与英文显示都要检查，不能只在一种语言里量标题。

### 可选：用 App 的原生组件生成图片

开发源码中的 App 已装好 Flutter 依赖、生成本地化并备齐字体时，可以用 App 自己的渲染器出图（详见[在本机预览视图 JSON](preview.md)）：

```sh
node "$DSHGO_DEV_ROOT/sdk/plugin-kit/bin/preview.mjs" card.json \
  --out preview-320-2x --width 320 --height 900 --scale 2 \
  --theme both --lang en --flutter /absolute/path/to/flutter/bin/flutter
```

输出目录必须是新目录。查看 `light.png`、`dark.png` 和对应的 JSON 诊断，再换一个新目录用 `--scale 1.3 --lang zh` 跑一次。图片只包含第一屏，`remainingScrollExtent` 大于零表示下面还有内容；预览不连接主机，也不执行按钮动作。

## 4. 安装到你实际使用的主机

```sh
# 仍在插件目录；路径属于引擎所在的那台机器。
DSH_TUTORIAL_PLUGIN_DIR="$PWD"
dsh plugin --profile web add "$DSH_TUTORIAL_PLUGIN_DIR"
dsh --profile web --dump-config
```

`--dump-config` 只能确认 bundle 层被组合，不能证明 JavaScript 入口已成功加载。还要在运行中的 `web` profile 查看插件加载结果；尚未启动时运行 `dsh web`。然后让模型调用 `text_metrics`，文本传入两行的“你好”和“A”，应同时看到普通结果和原生卡片。

| 主机 | 安装位置与检查 |
|---|---|
| 手机本机引擎 | 在 App 的本机终端中执行，插件目录要留在本机环境内 |
| SSH 主机 | 在远端终端中执行；本地电脑上的路径不会自动传到远端 |
| relay 主机 | 在实际运行 DSH 的机器上安装；工具卡随已有工具记录传给 App，本例不需要新增 REST 隧道 |

这个版本的本地路径安装会链接目录，删除目录会使入口失效。修改 `lib/` 后按[本地重载说明](local-development.md)处理；本机重启内核会中断当前任务。卸载再安装不应被当作一定使模块缓存失效。旧聊天记录也不会重新计算新卡片，要做一次新的工具调用。

## 5. 检查真正要分发的包

```sh
npm pack --dry-run --json --ignore-scripts
npm pack --ignore-scripts
```

检查 tarball 中确有 `package.json`、`cordis.patch.yml`、`lib/index.js`、`lib/measure.js`、`lib/view.js` 和 README；它应能独立装载，不能依赖开发仓库的相对路径。检查输出中不要包含账号配置、测试主机状态或临时数据。开发依赖不会随 `node_modules` 打包；宿主共享实例依赖由 peer 声明约束。

再用一个空的测试 home 安装实际 tarball，避免原目录链接掩盖漏文件：

```sh
DSH_TUTORIAL_HOME="$(mktemp -d)/dsh-home"
DSH_HOME="$DSH_TUTORIAL_HOME" dsh plugin --profile web add "$PWD/dsh-text-metrics-demo-0.1.0.tgz"
DSH_HOME="$DSH_TUTORIAL_HOME" dsh web --no-open
```

修改包名后，请使用 `npm pack` 实际报告的 tarball 文件名。

这是独立的配置目录，不会自动带上原主机的模型设置。可先核对启动与加载；需要通过模型调用时，在这个测试环境配置模型后再验。tarball 验证结束后退出这个测试进程。纯 JavaScript 示例无需安装时构建；如果以后改成 TypeScript，请先生成入口再打包，并实际检查 tarball。Git 源码安装有独立的构建脚本许可规则，不能据 npm 包测试推断它一定能用。

## 6. 发布自己的版本

练习包使用 `private:true` 防止误发布。真正发布前，把下面各项改成自己的值并重跑第 3–5 步：

| 位置 | 要做的改动 |
|---|---|
| `package.json.name` | 使用自己拥有的唯一包名，例如 `@your-scope/dsh-text-metrics`，替换示意 scope |
| `cordis.patch.yml` 的 `name` | 与包名完全一致 |
| patch 的 `id`、模块的 `export const name`、工具的 `name` | 选择自己的前缀，避免多个教程衍生包占用同一行或同名工具；同步测试期望 |
| `version`、`engines.dsh` 与 peer 范围 | `engines.dsh` 和 peer 写实际验证过的版本范围（下限是测过的最低版本，上限停在下一个次版本之前）；已发布的同名同版本不能重复使用 |
| `repository` | 指向这个包的真实公开 GitHub 仓库；单仓多包还应填写正确的 `directory` |
| `keywords` | 可加入 `dsh-plugin` 和 `dsh-bundle`，使发现源能识别用途 |
| README、许可与 `files` | 说明安装、用途、数据流、兼容版本；选择许可并提供相应 LICENSE，元数据与实际内容一致 |
| `private` | 确认其余准备完成后才删除 |

包名/仓库元数据示意，需合入自己的完整 `package.json`，不是替代整个文件：

```json
{
  "name": "@your-scope/dsh-text-metrics",
  "repository": { "type": "git", "url": "git+https://github.com/your-account/your-repo.git" },
  "keywords": ["dsh-plugin", "dsh-bundle"]
}
```

带 scope 的包名以 `@` 开头，在 YAML 中要加引号。例如重命名后的 patch：

```yaml
- insert:
    - id: your-prefix-text-metrics
      name: "@your-scope/dsh-text-metrics"
```

离线的 `npm publish --dry-run --offline` 可检查本地打包结果，但不验证账号权限、包名可用性或能否被市场收录。

在自己的 npm 账号中确认目标 registry、包名和访问范围，再预演：

```sh
npm publish --dry-run --access public --ignore-scripts
```

预演不会真正发布。确认文件清单无误后正式发布，按 npm 的登录与 2FA 流程完成：

```sh
npm publish --access public --ignore-scripts
npm view @your-scope/dsh-text-metrics name version repository dist.integrity --json
```

示例没有 `prepare`/`prepublishOnly` 等构建脚本，所以这里明确关闭脚本；将来依赖这些脚本构建时，先完成构建与测试再采用相应发布流程。不要仅把 GitHub 源码仓库上传成功当成 npm 包已可安装。npm 的[发布说明](https://docs.npmjs.com/cli/v11/commands/npm-publish/)是账号操作和参数的依据。

## 7. 核对 dsh-go 实际使用的市场索引

> 官方市场（dsh-go-market）的投稿与上架规则见[发布与上架](market.md)。本节只讲默认的发现索引。

当前 App 默认读取 dshfind 的 **format-1 索引**：`https://api.dshfind.com/market/dsh-index.json`。dshfind 网站目录发现和这个索引有不同的准入规则。

先在自己的公开 GitHub 仓库添加 `dsh-plugin` topic，并核对 npm 包的 `repository` 回链。dshfind 的发现任务会在后续刷新时处理它；不能承诺固定几分钟到账。仓库中的发现逻辑也会识别 npm 的 `dsh-plugin` / `dsh-bundle` 关键词。

索引的收录条件（2026 年 10 月）：被识别为插件、未被标记风险、带 bundle、已发布到 npm、npm 的仓库回链匹配、包名和版本有效；DSH 自带的 `@deepseek-ai/*` 包不收录。版本兼容性由安装端另行检查；风险标记由市场给出，作者无法自行设置。

用精确包名核对索引：

```sh
DSH_PLUGIN_PACKAGE_NAME=@your-scope/dsh-text-metrics node --input-type=module <<'JS'
const response = await fetch('https://api.dshfind.com/market/dsh-index.json')
if (!response.ok) throw new Error(`index HTTP ${response.status}`)
const index = await response.json()
const entry = index.plugins?.find(p => p.name === process.env.DSH_PLUGIN_PACKAGE_NAME)
console.log(entry ? JSON.stringify(entry, null, 2) : 'Not in this index yet')
JS
```

最后在 App 的插件市场搜索包名，核对显示的版本、来源和安装目标主机，安装后再做一次工具调用。网站已有页面、npm 已发布、索引已有条目、App 已能安装是四个独立的状态，逐一确认即可。若迟迟未被收录，可附上公开仓库地址、准确的 npm 版本和索引查询结果，通过 dshfind 的反馈渠道联系；无需在 dsh-go 提交上架申请。

## 8. 常见问题

| 现象 | 先核对 |
|---|---|
| 安装后插件不挂载 | `dsh.bundle.patch`、tarball 中的 patch 文件、patch `name` 与包名是否一致 |
| CLI 认为版本不兼容 | `dsh --version` 与 `engines.dsh`；先验证目标版本，不靠删除约束跳过问题 |
| `--load` 过了但真实主机加载失败 | 实际 profile、模块解析、peer 依赖、日志；测试收集器不是完整主机 |
| 普通工具结果成功但没有卡片 | 新工具调用的 `meta`；构造异常、体积超限会正常退回 `{}` |
| 卡片局部出现占位 | 运行检查器查看具体 JSON 路径，修该节点并重新调用工具 |
| 改代码没有生效 | 引擎实际加载的文件位置和模块重载；不要只检查开发副本 |
| 网站能搜到，App 仍没有 | npm 回链、bundle、精确版本、format-1 索引结果及 App 当前筛选 |

## 参考

实现细节可对照仓库的[快速开始](quickstart.md)、[主机覆盖](hosts.md)、[自查清单](checklist.md)，以及 SDK 和 [weather 示例](../../examples/plugins/dsh-go-example-weather/)源码。

发布层参考 [DSH 官方 bundle/profile 教程](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。市场条件来自 [dshfind 发现说明](https://github.com/hikariming/dshfind/blob/3ee8543f3ec60792cae0523d4a149cba0d68770c/README.zh-CN.md)及[索引生成器](https://github.com/hikariming/dshfind/blob/3ee8543f3ec60792cae0523d4a149cba0d68770c/scripts/lib/dsh-index.mjs)。
