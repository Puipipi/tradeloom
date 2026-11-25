# dsh-go-example-weather

[English](README.en.md) | 中文

一个 DSH 插件示例：注册 `weather_forecast` 工具。模型读到的是一段文字，dsh-go App 里显示的是一张原生天气卡。

| 天数 | 卡片 |
|---|---|
| 1–3 天 | 每天一个数字块：最高 / 最低温、天气、降水概率；雷雨、大雨、降水概率 ≥ 70 % 标为提醒色 |
| 4–7 天 | 今天、明天两个数字块 + 一条温度折线 |

工具卡走 `presentationMeta`，不需要桥接、不需要清单：本机、SSH、中转三种主机都显示，重新打开对话后历史卡片还在。DSH 网页版照常显示官方的通用工具卡。

天气数据来自 [Open-Meteo](https://open-meteo.com)（免费、无需密钥，CC BY 4.0），卡片底部注明来源。

## 安装

需要 DSH 0.2.1-rc.2 及以上（`engines.dsh`）。把整个文件夹放到主机上，然后：

```sh
dsh plugin --profile web add /绝对路径/dsh-go-example-weather
```

| 主机 | 怎么放文件夹、在哪执行 |
|---|---|
| 手机本机引擎 | 放进本机环境（例如 `/root/.dsh/dsh-go/plugins/`，重置引擎时保留），在 App 的「终端」里执行上面的命令 |
| SSH / 中转主机 | 放到主机上任意目录，在主机终端执行；`--profile` 换成那台主机实际用的 profile |
| 开发机 | 同上；改完代码要重启 DSH 才会重新加载 |

装好后问一句「杭州未来三天天气」即可。卸载：`dsh plugin --profile web remove dsh-go-example-weather`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 注册工具；`toolCard()` 包住视图构造：出错、超过 8 KiB 或不是无损 JSON 时不出卡片，绝不让工具调用失败 |
| `lib/view.js` | 纯函数：预报 → 卡片视图、预报 → 给模型的文字 |
| `lib/open-meteo.js` | 城市名 → 坐标 → 逐日预报 |
| `cordis.patch.yml` | 组合包补丁：只有一条 `insert`，装上即挂载 |
| `test/` | `npm test`（Node 内置测试，找得到本机 DSH 时用真的 `defineTool` 校验输出 schema） |

## 关键几行

```js
output: {
  schema,
  render: (_args, value) => [{ type: 'text', text: forecastText(value) }],      // 模型看到的
  presentationMeta: toolCard((_args, value) => forecastView(value)),          // App 画的
}
```

`toolCard()` 返回 `{ "dsh-go/view": 视图 }`。视图格式、组件和上限见 [`docs/plugins/`](../../../docs/plugins/README.md)。

## 自查

```sh
npm test
npm run check        # 仓库里的 sdk/plugin-kit 校验器
```

## 许可

MIT © DSH-TUI (ccch1mneyyy)
