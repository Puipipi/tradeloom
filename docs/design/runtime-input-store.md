# 固定运行时输入原件库

`runtime/lib/input_store.py` 保留构建所需的原始归档字节，使用原有 SHA256 / npm SRI 寻址。它以 UTF-8 读取 `runtime/build-runtime.sh` 的版本默认值、`PIN` 和源地址，以及 Ubuntu / npm 锁；不执行 shell，不另维护一份 pin，不发布到外部。

这是 Linux 构建主机工具，要求 Python 3.11 或更新版本。npm 预热另需已有的 host Node/npm；脚本不安装系统工具。原件库必须支持同盘硬链接，批次临时目录建在库内。这里的文件同步和原子替换保证正常错误路径不发布半文件，不宣称完整的断电持久性。

## 清单与原始字节

永久对象名为 `sha256-<小写十六进制摘要>` 或 `sha512-<小写十六进制摘要>`，没有扩展名。一个对象可以有多份锁或 ABI 引用；清单保留原 URL、来源位置、版本、ABI、npm 可选/平台字段及许可字段。未知许可用 `null` 和待核说明表示，不推定许可证。

默认清单覆盖当前两 ABI 与 x64 host Node：723 个对象，其中 62 个非 npm、661 个 npm。npm 两份当前锁共 662 条引用，包含全部 optional 平台包；不以采集机器实际会安装哪些包缩减备份。`--all-locks` 还纳入历史 DSH 锁，共 1061 个对象。数字对应本次固定源码，更新 pin/锁后由工具重新计算。

在仓库根目录运行：

```sh
python3 -I runtime/lib/input_store.py inventory > runtime-inputs.json
python3 -I runtime/lib/input_store.py inventory --all-locks > runtime-inputs-all.json
```

`--repo /absolute/repository` 可指定源码根。`--npm-lock /absolute/package-lock.json` 可重复使用，替换默认 npm 锁选择，非 npm 部分仍来自该仓库。默认和 `--all-locks` 都必须包含源文件声明的当前 DSH / pnpm 两锁，缺失即失败；当前 pnpm 锁的版本和 SRI 必须与 shell 的 `PNPM_VERSION` / `PNPM_INTEGRITY` 一致。显式 `--npm-lock` 仍是替换选择，不声称涵盖默认闭包。工具支持当前锁使用的单一 SHA256 / SHA512 SRI；缺 resolved、缺摘要、未知摘要算法或本地 link 条目明确失败，不能静默漏掉原件。PIN 块里的非注释未解析条目、尚无来源映射的新 pin 也明确失败；新增输入不能被默认清单静默略过。环境版本覆盖不会改变 inventory；它清点源文件中的默认版本。新版本应先更新源 pin/锁，重新生成清单和收集差集。

```sh
python3 -I runtime/lib/input_store.py import --store /absolute/input-store \
  /absolute/recovered/proot_5.1.107.98_aarch64.deb \
  /absolute/recovered/proot_5.1.107.98_x86_64.deb
python3 -I runtime/lib/input_store.py collect --store /absolute/input-store
python3 -I runtime/lib/input_store.py verify --store /absolute/input-store
```

`import` 按内容摘要识别所选清单中的原件，不依赖输入文件名；只处理显式给出的文件，不递归扫描其他目录。可先导入已恢复的原版 PRoot、旧构建缓存等，再 collect 缺失项。成功导入一部分不代表清单齐全；`verify` 逐项报告缺失/损坏，只有全齐且原摘要相符才退出 0。恢复到普通构建缓存由独立的构建读取接线（file:// CAS 回落）完成，恢复到 npm cache 由下述 warm-npm 完成，不再增加只转手的 restore 子命令。

`collect` 顺序为：校验过的本地对象 → 清单中的现有主源/已有官方回落 → 显式自留源。自留源可选：

```sh
python3 -I runtime/lib/input_store.py collect --store /absolute/input-store \
  --mirror-base file:///absolute/retained-originals
```

HTTPS 自留地址也接受同样的扁平对象名；URL 必须由 owner 明确提供，工具没有预置的公共自留库。`--mirror-base` 不允许账号密码、query 或 fragment。未配置时，JSON 的 `self_mirror` 明确写「自留回落不可用（未配置 --mirror-base）」；主源正常仍可成功，无法从主源取得的对象会列为错误，不能当作已归档。

下载先写库内临时文件；逐块计算原摘要、核对锁中已知大小，成功后 `fsync` 文件并 `os.replace` 到最终对象名。建立响应时的 HTTP 协议异常和读取中的传输中断均可继续下一来源；内容摘要/大小不符、坏的已存对象、写盘或替换失败立即停止本轮收集，不用下一来源掩盖错误。不可达对象会汇总报告，其他独立对象可继续收集。正常异常路径清理临时文件；进程被强杀可能留下 `.part-*`，它不被当作完整对象。

新对象读取最多接受锁中已知的字节数；大小未知时上限为 1 GiB。这是传输限制，不是原件大小的测量。最多多读一个字节判定超限，该块不写盘，临时文件清理，既有对象保持；超限直接报内容错误，不换来源重试。`import` 的新对象写入同样受此限制。

所有子命令的 stdout 是一个 JSON 结果；错误时退出非零。`collect` 输出对象总数、缓存/新取数量、已取得字节数及错误；`verify` 输出逐项缺失/损坏。总字节是本轮实际核验对象的统计，不能据此宣称尚未收齐的全库大小。标准错误保留 npm 等诊断。

## 导出待上传原件

```sh
python3 -I runtime/lib/input_store.py collect --store /absolute/input-store \
  --output /absolute/runtime-input-release
```

`--output` 可省略，默认收集行为不变。指定时把本轮取得并通过原摘要校验的对象复制成平铺的 `sha256-<hex>` 文件，同时写 `SHA256SUMS`；复制沿用临时文件校验和替换，不与 CAS 共享硬链接。输出目录可重用；`SHA256SUMS` 每次只列本轮成功导出的对象，旧的无关文件不删除。缺件仍非零退出，已经成功的原件可以单独使用，不能把这个子集称为全量备份。

导出不读取许可材料，不创建 release、不上传。何时发布由 owner 决定。原本以 SHA256 寻址的二进制可直接使用导出的名字作回落；npm 的 SHA512 SRI 保留在原锁中，仅有 SHA256 文件名的导出目录不能直接当作 npm 的 SHA512 镜像。下载回来后将这些数据文件交给既有 `import --store ... <文件...>`，它按内容计算原锁摘要、恢复原 CAS 名称，再使用 `warm-npm`。不要把 `SHA256SUMS` 当成原件传给 `import`。

### 对应源码材料缺口（只读报告）

以下仅记录 `8020294de0d3e0d286ddf392da1b411f69e32eca` 的源 pin/锁没有提供的材料，不作法律判断，也不成为导出或发布门禁：

- `runtime/build-runtime.sh` 的 Ubuntu base pin 没有归档内组件、版本与对应源码清单；`runtime/locks/ubuntu-noble-{arm64,amd64}.json` 只记录额外 deb 的二进制版本、摘要和大小，不能替代基础归档清点，也没有精确 source package 与打包材料。
- 同一脚本的 Termux `proot`、`libtalloc`、`libandroid-shmem` pin 没有实际 recipe、补丁与构建材料的对应记录。已有 `proot-v5.1.107.98.zip` 源码 pin 可作为来源材料，不能据它推定其余打包材料齐全。
- Node 与 Python 原始归档的 pin 没有复合归档组件及其对应源码/构建材料清单。
- `runtime/locks/dsh-0.2.2-rc.1/package-lock.json` 中 `@img/sharp-libvips-*`、`@img/sharp-win32-*`、`@img/sharp-wasm32` 声明含 LGPL，`@deepseek-ai/libreoffice-kit*` 声明 MPL；锁有包版本和 SRI，但没有匹配归档内实际组件的源码与构建材料记录。`inventory` 可列出当前各平台引用，不能仅按采集机器的平台略过备份中的其它包。

这些缺口由 owner 结合实际原件补齐；工具不会猜测源码 URL、修改许可声明或要求填写审核状态。升级 pin/锁后应重新查看实际材料，报告没有固定对象数量断言。

## npm 预热与原锁离线安装

构建接线仅在显式配置 `RUNTIME_INPUT_STORE_URL` 且已有 npm 锁时启用预热，未配置时保持原 npm 路径。shell 接线是单独的改动；此工具本身不改变默认构建行为。

```sh
python3 -I runtime/lib/input_store.py warm-npm \
  --repo /absolute/repository \
  --lock /absolute/repository/runtime/locks/dsh-0.2.2-rc.1/package-lock.json \
  --store /absolute/input-store \
  --mirror-base file:///absolute/retained-originals \
  --npm /absolute/host-node/bin/npm \
  --npm-cache /absolute/npm-cache \
  --userconfig /absolute/empty-user-npmrc \
  --globalconfig /absolute/empty-global-npmrc
```

两个 npmrc 必须已存在且为空。工具给 npm 的 PATH 优先放指定 npm 所在 bin 目录，沿用 host Node；每批最多 64 个归档，调用公开的 `npm cache add`。全部取到并核对原 SRI 后才开始 npm 缓存导入；失败返回非零，调用方不得进入 npm ci。工具不调用 npm ci、不改原锁、不开包脚本；调用方成功后以原有 flags 加 `--offline` 执行原 `npm ci`。

**npm 11.9.0 的实测约束：**直接把无扩展名 `sha512-<hex>` 交给 `npm cache add`，npm 将其当作目录，报 `DirFetcher` 错误。因此工具在库内为本批对象创建临时 `.tgz` 硬链接；npm 只读取这些已验证原件的同一 inode。批次结束或正常失败均移除临时目录，永久库仍只用摘要名，不额外存一份 tgz。没有硬链接支持时明确失败，不添加复制回退。npm 的 cwd/prefix 指向新建批次目录，user/global config 使用显式空文件，缓存路径由参数固定。

想完全离线使用时，先把原件库收齐或导入；已有对象经复核后不会联系来源。若库尚有缺失，工具仍按主源优先逐项尝试，显式配置自留源不等于禁止访问主源。原件库和 npm cache 是不同东西：后者可重新生成，不能替代留存原 tgz。锁中的 resolved URL 不改写。

## 验证与发布边界

```sh
python3 -I runtime/tests/test_input_store.py -v
```

小测使用临时目录、合成字节、本地 file:// 来源、受控失败和已有 npm。真实 npm 集成从两个临时 tgz 开始，经无扩展名 CAS、工具临时别名、批量 cache add，再用不变的 resolved/integrity 锁执行 `npm ci --offline --ignore-scripts`，逐字核对锁与安装 payload。没有现成 npm 时该项明确 SKIP，可用 `INPUT_STORE_TEST_NPM` 指向已有 host npm；不为测试下载或安装 npm。

这些检查不代表 661 个真实 npm 对象已收齐或完整运行时构建通过。真实构建、release APK 及分层缓存复用按项目批次验证。工具不上传、不建 release、不绕过摘要；owner 自行选址和发布。二进制、源码、许可证与构建材料的分发义务仍需逐组件确认，清单有 license 字段不等于完成审查。
