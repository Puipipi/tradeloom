# 0.2.2 升级：下一步实验 runbook

## 同固定路径更新与恢复（本批集中审前，尚未实际 apply）

QA 固定程序根为 `D:/TL-S5-DSH022RC2-ONLINE-20261112-R3/program`。后续 GUI 只从这里的普通 `启动工作台.exe` 启动；新生成物只作候选输入，不再从新的候选路径运行。保持 `target/app/织贸助手.exe` 路径，避免再次因测试换路径触发防火墙授权；不增删系统安全规则，不承诺 Windows 的其它安全策略永不提示。

官方获取入口现在可显式串接同路径应用，默认仍只生成隔离候选：

```text
python -B scripts/update-dsh-candidate.py <原有显式获取/依赖/新输出参数> --apply-to <已识别TradeLoom固定根> --target-manifest <该根当前完整entry清单> --target-manifest-sha256 <已审SHA256> --apply-work <同卷、程序和data外、不存在的新备份目录>
```

四个 apply 参数必须齐全。生成前检查目标身份和实际占用，出现目标/备份根内任意名称的实际进程即拒绝，不强杀；替换前再次检查。未知官方版本仍在下载前停止，不丢自有 overlay。apply 使用完整候选 manifest 及已审 SHA、逐文件/集合/树指纹、配方 ASAR 钉和原 `validateInstalledManifest`/4050 native-fs 业务校验；不是把任意目录复制进目标。

固定步骤只有：在新 work 内核好 staged app/wrapper；把原 `target/app` 改名备份为 `work/before-app`；把 staged app 放回同 `target/app`；把原 wrapper 改名为 `work/before-launcher.exe`，把已审候选 wrapper 放回同路径。目标 `launcher.json`、schema1/2 与 dataDirectory 选择逐字节保留，不把候选默认数据目录写回目标，不读取/复制/搬移 data/profile。正常运行时的应用写入另计，不能称零 data 写入。wrapper.exe 是可更新的程序 payload，有独立旧/新 pin 与回退；正式旧 `portable/Program.cs` 不改。

因此候选发布清单和实际安装身份允许且明确区分：`work/installed-entry-manifest.json` 重新记录保留的目标 config 实际 bytes/SHA 和完整有效树；不跳过其余 payload 校验，不假称与候选全部字节相等。现有 runtime log 不是静态代码篡改。schema2 wrapper 正常日志改到明确 dataRoot/logs；logger 不在 bootstrap 确认所有权之前创建数据目录。schema1 日志行为保留；无效配置尚不能确定安全外置根时保留原错误行为。

本次唯一已知 P3 定向迁移：`D:/TL-S5-DSH022RC2-ONLINE-20261112-R3/program/启动工作台.log` → 新 apply work 的 `before-runtime-launcher.log`，仅 schema2、停机且原 bytes/pin 未变时执行，历史保留，不删除；新 wrapper 不再写程序根正常日志，回退时原日志一起恢复。候选 ZIP 不改；没有其它已证可移材料。

程序替换异常自动恢复旧 app/wrapper（保留失败产物）。实际中断保留 `work/state.json` 和既定恢复点；不自动启动应用。用户正常关闭占用后执行：

```text
python -B scripts/apply-dsh-candidate.py recover --target <同一固定根> --work-root <本次work>
python -B scripts/apply-dsh-candidate.py rollback --target <同一固定根> --work-root <已完成更新的work>
```

recover 只处理中断；完成更新需明确 rollback。两者仍检查占用和原配置，配置被外部改动就停止，不覆盖新的数据选择。只在 target/app、wrapper、已知 schema2 旧日志及本次 work 的固定路径间改名，无递归删除、无 profile 回滚、无通用事务/迁移平台。备份只能恢复，不从备份目录运行软件。

本批 wrapper 日志行为与应用入口实际变化，审后需要生成一次新候选，仍要求 ASAR584f。未采用新 replay-cache 捷径：旧153项 source 记录覆盖生成脚本/工具源码、全部K、desktop与business，但没有独立封住当时 Node/Python/Git 执行器身份，不能把旧输出hash相等冒当前完整 runtime 输入等价。program-recipe.json 与 launcher patch 虽仅被 replay 记录、不参与 ASAR 生成，也不据此扩大忽略目录或重用旧 sourceBuild；当前源码由实际本次生成重新捕获，不反抄 P 成品。无需另重跑已过 SDK/样式 suites。

统一自动范围：`scripts/tests/apply-dsh-candidate.test.py` 的真实小文件改名/失败回退/五个中断边界（包括旧 runtime log 移存）、保留 config 与有效身份、schema2 历史 log 保留、任意名称目标内真实测试进程拒绝；以及现有 build 合同中受影响的实际候选 C# ReadConfig/log 分支。小 fixture 明确不证明实际 P3 更新，全部通过后才按已审 manifest/pins 实际应用 P3，再由原 Terra 统一补 provider/model、空会话未发送 scratch/scroll 并清自身 scratch 返回原会话。本批未读测试 API 内容，不脚本写 provider/appdata。

35条既有 Error 的直接生产代码归因：accountSidebarStatus 在 assertWindow 后仍要求当前 account 存在且 requester 为其 parent（controller967）；本次1次拒绝尚不能区分这两个条件，Settings 后续实开，不能据此删 guard。mandatory-status 在 main21795 严格检查父 window、WC 与自身主帧；preload1968 发初始 status 且原 vendor 自行 catch，2条不是未捕获启动异常，当前具体 caller 未采，保持 guard/日志。shortcuts-get 在 main23690 的 account/current/WC/frame/resolveGuest(account) 边界拒绝32次，preload2061 是直接 invoke 桥；未证明本轮具体 caller 与哪一条件失配，也未验证快捷键编辑功能，因此不放宽准入、吞日志或猜测修改。没有证据支持本批改 SDK/controller/main 权限。

原本体范围已具体化：桌面 TradeLoom 入口指向 `D:/TL-S5-A76532/TradeLoom-stage5-acceptance-76532-r1`；其顶层仅 app、data-ui-r2、wrapper exe/log、launcher.json，未见顶层开发材料。app 内 python-packages/postgresql/plugin-seed 仍是构建输入；data-ui-r2、config、全部恢复点均保护，未逐树证明可移则不动，不假称整个原本体净化完。官方 DeepSeek Harness 和独立 UI 复刻是另外两个桌面产品，不作为待删除 TradeLoom 材料。A76532本轮无自动迁移或写入。

## 官方获取到完整候选的一条命令（本批待集中验证）

```text
python -B scripts/update-dsh-candidate.py --cache-root <官方原件缓存目录> --work-root <不存在的新获取收据目录> --python-packages <已钉程序python-packages> --postgresql <已钉程序postgresql> --plugin-seed <已封存程序seed> --data-root D:/TradeLoom-private-data --output-root <不存在的新完整输出目录> --resource-editor <已核rcedit-x64.exe>
```

入口只读取实际官方 `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`；不猜 stable URL、不修改系统代理/TLS。先核版本有已审完整配方以及 feed 的 URL/size/SHA512 与配方一致，再获取资产。未知版本或新字节立即停止，不能套 rc2 pins、降级默认版本或丢 TradeLoom overlay；需要审核新 SDK 生命周期、desktop/main/preload、布局/自有资源和实际 pre/post 指纹后新增适用配方。

有效缓存会重新核 installer 长度/SHA512、Windows Authenticode `Valid` 和真实官方发布者完整主体，再核 extracted 的7892文件完整树；符合就复用，不再下载299MB。缓存布局沿用已核 `deepseek-harness-0.2.2-rc.2-win-x64.exe`、`container/`、`extracted/`。无缓存才流式下载到独占 `.part`，摘要通过后留为原件；失败/已有 part/漂移缓存均保留并停止，不自动覆盖重试。缓存须为程序原件缓存，不放入现用软件或数据目录。

新解包只用已存在且 bytes/SHA 匹配的7-Zip 23，不执行 NSIS/installer、不安装解包器或提权。外层完整15项先验路径/链接，精确取已核内层 archive；内层8802项完整列表先验路径、大小、重复/链接，再离线提取到新 partial 目录，实际文件集合/大小/完整树核对后才成为 extracted 缓存。旧私有 r1/r2 的 CRLF 与 `Attributes=D` 漏读记录保历史，不能冒事前绿；新入口按已核 r3 合同在提取前做完整验证。

获取后直接调用完整 builder；源码捕获包含真实外层获取脚本、签名脚本和配方，`update-receipt.json` 把实际 feed/签名/缓存验证与完整 build/source ZIP 身份连接。仅源码文件存在不证明该次运行过获取；内层离线 receipt 的 `channelDiscoveryOrDownloadExecuted=false` 仍准确。程序与数据路径的显式选择、无正式切换/无数据读建搬移合同保持不变。

审后统一验证：先运行 `python -B scripts/tests/update-dsh-candidate.test.py`，显式 `DSH_OFFICIAL_CACHE=<现成已核官方缓存>`；签名与真实7z完整列表用实际原件，不 skip。再用上面真实入口生成一次新隔离产物，新增证明为真实最新 metadata→配方拒绝/选择→实际摘要签名/完整缓存复用→完整生成以及外层源码进入快照；不单独重跑旧17项/样式5项/离线包。若最新版本不支持，真实结果应为停止，而非 stub 成功。缓存复用链不冒新下载或冷解包执行；这些分支须按实际命令单列覆盖边界。

这是一条生成隔离完整候选的命令，尚无正式切换、用户数据迁移、应用内更新按钮或 TradeLoom 自有发布签名平台；未执行/未验项不据此宣布整体升级或阶段5完成。

## 完整固定版本候选入口（本批待集中验证）

```text
python -B scripts/build-dsh-candidate.py --version 0.2.2-rc.2 --vendor-root <已核官方完整解包目录> --python-packages <已钉程序python-packages目录> --postgresql <已钉程序postgresql目录> --plugin-seed <已封存程序seed目录> --data-root D:/TradeLoom-private-data --output-root <不存在的新输出目录> --resource-editor <已核rcedit-x64.exe>
```

这是离线完整装配命令：复用仓库版本配方和 ASAR 重放器，保留官方输入原字节，产物 EXE 按已钉品牌资源转换，DLL/locales/unpacked/内置 runtime 保持原字节，加入当前仓库业务后端、自有壳和资源，并编译候选 launcher。Python/PG/seed 都是显式、逐文件核验的程序输入，不能传 profile 或现用定制程序树；完整官方树指纹、依赖树指纹和 seed 清单钉在 `program-recipe.json`。不会执行官方安装器、应用、PG、迁移或种子安装。

输出为 `program/`、完整程序 ZIP、`current-source.zip`、当前 tracked+dirty 实际输入的 `source-manifest.json`、逐物理文件来源的 `program-entry-manifest.json`、命令输出和 `build-receipt.json`。程序根仅含 app、launcher.json、启动工作台.exe；源和证据留在外层。ASAR 仍须等于已核 584f 指纹，业务库存使用实际 4050 validator/native fs 验证，完整 metadata 另调用原 `validateInstalledManifest`。编译器和新 launcher 的实际 bytes/SHA 单列，不冒旧编译产物身份；旧 345/旧完整部署清单不再作为当前源码声明。

候选 launcher 的 schema2 要求显式本地绝对外置数据目录；缺失、相对、UNC/device 或与程序根相交均拒绝，不默认切到 data-ui-r2。构建只写配置，不读取、创建、复制或迁移该目录。正式 schema1 启动器源码/配置和 rc3 基座钉保持原样；新目录为空也不证明保留了旧账号数据。后台额外源码仅按已证直接消费者加入：workflow validator 的3个 JS 依赖、services.py 的3个示例资源；未证明消费者的11个 phase1 示例不凑数带入。

当前支持只到已审 rc2。上面的新增获取入口正在本批集中验证；本离线命令自身不发现频道或下载原件。未知版本必须停止差异审核，不能套 rc2 pins、丢自有层或让官方安装器覆盖定制软件。正式切换/数据迁移未由这两个入口执行。

纯净化边界：新产物把开发源、fixture、证据放在程序根外；这不等于用户原软件本体已清理。本批不删除或搬移 ICT、旧软件、data、账号与恢复点。已知旧单个意外 pyc 的独立移存收据只能证明该单文件，不能扩写成整个本体完成清理。原本体待迁材料清单与实际引用未形成充分逐项证据，仍未验。

集中验证命令（审查通过后执行）：

```text
node --test packages/tradeloom-shell/tests/dsh-base-boundary.test.js
python -B scripts/tests/build-dsh-candidate.test.py
```

第二项实际编译仅调用 `ReadConfig` 的 .NET 合同 harness，不进入 launcher Main 或服务；核 schema1 保留、schema2 正反、三键 validator 合同和配置目标不创建。完整生成另运行上面的显式输入命令一次。既有角色/设置/主题和布局 CU 仅复用已验范围；真实登录、模型发消息、发送附件、两图片草稿留存和内容不足时的真实内部滚动仍不能冒通过。

## 当前固定rc2源码重放入口

正式基座钉仍为0.2.1-rc.3。0.2.2-rc.2候选使用仓库内显式SDK、desktop和business-shell配方，输入必须是已核官方原件及其匹配unpacked目录：

```text
python -B scripts/replay-dsh-candidate.py --source <官方resources/app.asar> --unpacked <同源resources/app.asar.unpacked> --output-root <不存在的新stage>
```

入口只离线生成ASAR、自有business-shell、实际sourceFiles与staging来源元数据；不复制完整程序树、不安装或启动服务，不接触既有profile。全量逻辑payload/1678侧文件合同和固定ASAR指纹须匹配；有差异保留输出报错，不更改expected或反复重包。业务库存由原installed-bootstrap实际函数和native fs核验。staging元数据不声明已复制或重新认证EXE/Python/PG等完整发行资产。

已有run06证据只覆盖角色输入、Settings开关和主题三态恢复，不能据此宣称整个升级或阶段5完成。以下为较早诊断记录，未被该重放入口执行。

> 前提：Shell 已恢复（`dsh-ops` 升到 0.5.2+ 后 `echo ok` 能返回）。
> 目标：判定 `@tradeloom/dsh-business-shell` 在 0.2.2 上是“没被加载”还是“加载了但路由没注册”。

## 0. 已知事实（不要重复验证）

- `webServer` API 未变：`super(ctx,"webServer")` + `register({kind:'exact',path,handler})`。
- 插件 inject 的 7 个服务在 0.2.2 全存在（`connection` 由 `dsh-client-connection` 第 710 行提供，两版一致）。
- 插件对 `@scope` 包 import 数为 0，无外部解析依赖。
- 插件装在 **profile**：`data-ui-r2/harness-home/profiles/desktop/node_modules/@tradeloom/dsh-business-shell`（改插件不必重打包）。
- bundle 顺序：`dsh-base → dsh-web-app → @tradeloom/dsh-business-shell → 19 个第三方`。
- **`oldbase-full` 不可用于内容比对**：它是修复 asar 填充偏移前抽的，整体偏移 2 字节（首行是 `}`）。

## 1. 打 trace（只改 profile 里的插件，秒级回路）

```bash
P="D:/TL-S5-A76532/TradeLoom-stage5-acceptance-76532-r1/data-ui-r2/harness-home/profiles/desktop/node_modules/@tradeloom/dsh-business-shell"
cp "$P/host.js" "$P/host.js.bak"
python - <<'PY'
from pathlib import Path
p=Path(r"D:/TL-S5-A76532/TradeLoom-stage5-acceptance-76532-r1/data-ui-r2/harness-home/profiles/desktop/node_modules/@tradeloom/dsh-business-shell/host.js")
t=p.read_text(encoding='utf-8')
t=t.replace("export function apply(ctx, config = {}) {",
            "const __tlTrace=(...a)=>{if(process.env.TRADELOOM_HOST_TRACE)console.error('[TLTRACE]',...a)}\nexport function apply(ctx, config = {}) {\n\t__tlTrace('apply enter')",1)
t=t.replace("  const disposeScenes = ctx.webServer.register({ kind: 'exact', path: SCENES_ROUTE, handler: createScenesHandler(ctx) })",
            "  __tlTrace('register scenes'); const disposeScenes = ctx.webServer.register({ kind: 'exact', path: SCENES_ROUTE, handler: createScenesHandler(ctx) }); __tlTrace('scenes registered')",1)
p.write_text(t,encoding='utf-8')
print('trace injected')
PY
```

## 2. 装升级包（asar 022d + 0.2.2 unpacked + 清单哈希）

```bash
APP="D:/TL-S5-A76532/TradeLoom-stage5-acceptance-76532-r1"
cp "D:/TL-S5-A20261111/asar-out/app-022d.asar" "$APP/app/resources/app.asar"
robocopy "C:/Users/23825/AppData/Local/Programs/DeepSeek Harness/resources/app.asar.unpacked/dsh" \
         "$APP/app/resources/app.asar.unpacked/dsh" /E /NFL /NDL /NJH /NJS /NP
```

`deployment.json` 的 `appMainSha256` 必须等于**包内 /lib/main.js 的 sha256（小写）**：

```bash
python - <<'PY'
# 从 022d.asar 取 /lib/main.js 字节 → sha256 → 替换 deployment.json 里旧哈希，并把 upstream.version 改成 0.2.2-rc.1
PY
```

## 3. 带 trace 启动并收集

```bash
powershell -NoProfile -Command "
  foreach(\$n in 'ELECTRON_RUN_AS_NODE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY'){Remove-Item (\"Env:\"+\$n) -ErrorAction SilentlyContinue}
  \$env:TRADELOOM_HOST_TRACE='1'
  \$root='D:\TL-S5-A76532\TradeLoom-stage5-acceptance-76532-r1'
  Start-Process -FilePath (Join-Path \$root 'app\织贸助手.exe') -WorkingDirectory (Join-Path \$root 'app') -PassThru `
    -RedirectStandardError 'D:\TL-S5-A20261110\evidence\trace-022.stderr.log' `
    -RedirectStandardOutput 'D:\TL-S5-A20261110\evidence\trace-022.stdout.log'
  Start-Sleep -Seconds 40
  foreach(\$p in 3088,3090,55432){\$r=@(Get-NetTCPConnection -State Listen -LocalPort \$p -ErrorAction SilentlyContinue); if(\$r.Count){'port '+\$p+' ok'}else{'port '+\$p+' free'}}"

grep -a 'TLTRACE' 'D:/TL-S5-A20261110/evidence/trace-022.stderr.log'
```

## 4. 结果判读

| 现象 | 结论 | 下一步 |
|---|---|---|
| 无任何 `TLTRACE` | 插件从未 apply（在等注入） | 说明某个 inject 服务在 host 里确实没提供：逐个从 `inject` 列表里减一个再试，定位到具体服务 |
| 有 `apply enter` 无 `register scenes` | apply 中途抛错 | 在 apply 体内包 try/catch 打 `e.stack`，按栈修 |
| 有 `scenes registered` 但仍 404 | 请求打到了别的 host（多实例/端口漂移） | 比对 `backend.host/hostUrl` 与 3088 实际监听的实例 |

## 5. 无论结果如何都要先恢复

```bash
APP="D:/TL-S5-A76532/TradeLoom-stage5-acceptance-76532-r1/app/resources"
cp "D:/TL-S5-A20261110/backup-asar-021/app.asar" "$APP/app.asar"
rm -rf "$APP/app.asar.unpacked"; cp -r "D:/TL-S5-A20261110/backup-asar-021/app.asar.unpacked" "$APP/app.asar.unpacked"
# deployment.json 从候选 zip 取原始，再按需替换
cp "$P/host.js.bak" "$P/host.js"
```

### Windows 品牌资源构建输入

rc2 完整构建显式接收 `--resource-editor`，必须匹配 `program-recipe.json.windowsBranding.editor` 的 electron/rcedit v2.0.0 固定 bytes/SHA256；不从 PATH 猜工具、不全局安装。工具来源为 https://github.com/electron/rcedit/releases/tag/v2.0.0 ，维护者源码固定于 `28a13190599ed35f472fbaea1179116a29ff8f10`。工具仅构建使用，不随程序交付。

`apps/tradeloom-launcher/branding/tradeloom.ico` 来自仓库 `integrations/dsh/patches/desktop-branding.patch` 的既有 Windows 品牌资源。先严格核官方完整输入，再仅在新产物修改应用 EXE 的 ProductName/FileDescription/ICO，替换托盘 ICO；启动器编译使用同一 ICO 并设置品牌名称。上游版本字符串保持；修改后的 PE 以实际最终 bytes/SHA256 进入清单，不宣称仍有上游签名或与官方 EXE 字节相同。应用内 Logo、窗口/任务栏实际显示需独立实机验收，不能由文件名或 PE 元数据代替。
