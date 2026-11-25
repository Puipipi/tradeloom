# 插件文案 locale 分隔符

基底：`63e255fab5cb9d817af30b631c3643ccce8e9231`（v1.0.11）。

本次只修正已被桥接 `LOCALE` 接受的多段 locale 标签在文案精确匹配时的分隔符归一化。例如 manifest 的 `zh_Hant_TW` 与请求的 `zh-Hant-TW` 应匹配同一项。原实现只替换第一个下划线，会在正确项存在时落入语言或默认项回退。

桥接 `parseText`、`resolveText` 与 SDK 公开 `localize` 将全部下划线替换为连字符，继续忽略大小写。不增加语言支持，不改请求或响应字段，不改回退顺序、locale 校验、feed 身份、注册或生命周期。

同义键按各自既有规则处理：桥接解析后的同一键由后项覆盖；SDK `localize` 保留第一个匹配的原始键。这两条原有行为不做统一。

## 可达范围

桥接的 contributions/view 读取接受 locale 参数，manifest 的插件标题、动作标签、静态条文案与面板标题走此解析。SDK 的 `localize(localeOrCaps, text)` 同样接受这些标签。

v1.0.11 App 的 `nativeLocaleProvider` 当前只发送 `en` 或 `zh-CN`。因此，本补丁不声称当前 App 已提供繁体或脚本/地区语言设置，也不声称已在手机上复现该多段 locale 症状。适用范围是现有公开桥接/SDK 合法输入。

## 生成与验证

权威输入是 `runtime/bridge/dsh-go-bridge/lib/native/util.js` 与 `sdk/plugin-kit/lib/caps.js`。依照本波不交生成文件/资产的要求，补丁不包含 SDK 桥接拷贝或 App 技能资产。应用源码后由合入方运行仓库已有生成器：

```sh
node sdk/plugin-kit/scripts/sync-bridge.mjs
node sdk/plugin-kit/scripts/sync-skill.mjs
node sdk/plugin-kit/scripts/sync-bridge.mjs --check
node sdk/plugin-kit/scripts/sync-skill.mjs --check
node --test runtime/tests/native-locale-separators.test.mjs
(cd sdk/plugin-kit && npm test)
```

本轮验证在隔离树中实际执行这些生成器。未生成的源补丁树会被 SDK 的同步检查报告为过期；不能把它写成可直接发布的完整制品。

Refs：W17-B 源码审计，未关联公开 issue，不编造 issue 编号。

会改 runtimeVersion（桥接源码进入运行时输入）；Android 未编译。手机与真实引擎插件页面未验收。
