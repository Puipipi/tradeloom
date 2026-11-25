# 增量更新（DSHDLT01 补丁）

新版 APK 相对旧版往往只换了少数几个 zip 条目（Dart 代码 `libapp.so`、`classes.dex`、几份资源）。发版时为最近几个旧版各做一个补丁；装着其中某一版的 App 只下补丁，用手机上的旧 APK 拼出新 APK，SHA-256 对上了再照常安装。拼不出来、对不上，一律回到整包。

| 部分 | 位置 |
|---|---|
| 格式与参考实现（生成 `make`、应用 `apply`） | `tooling/apk_delta.py`，测试 `tooling/test_apk_delta.py` |
| 发版时生成、写进清单 | `tooling/release_assets.py --delta-from N`（默认 3），测试 `tooling/test_release_assets.py` |
| 上传到每条线路并回下核对 | `services/share-worker/scripts/publish-release.sh`（`SHA256SUMS` 里列的文件全部上传） |
| App 端选补丁、下载、拼装、回落 | `app/lib/update/`，按本文的契约实现 |

## 格式

大端。一个补丁 = 80 字节的头 + 一串操作，操作从前到后依次写出目标文件：

```text
头      "DSHDLT01"（8 字节）  旧 APK 的 SHA-256（32）  新 APK 的 SHA-256（32）  u64 新 APK 长度
0x01    COPY  u64 旧 APK 里的偏移  u64 长度        从旧 APK 复制这一段
0x02    DATA  u64 长度  然后是这么多字节           原样写出
0x00    END
```

- COPY 的区间在旧 APK 里可以任意顺序、可以重复；相邻的同类操作已经合并（不会出现两个相连的 DATA，也不会出现旧 APK 里首尾相接的两个 COPY）。
- END 之后不再读。
- 结果必须**正好**是头里的长度和 SHA-256，否则整个结果作废。

## 怎么生成（`apk_delta.py make BASE NEW OUT`）

按 zip 条目做，只用标准库（`python3 -I` 可跑）：

1. 读两个 APK 的中央目录；每个条目的压缩数据从哪开始，以本地文件头为准（zipalign 会在本地头的 extra 里补齐，和中央目录的不一样）。
2. 新 APK 的每个条目：旧 APK 里有同名条目，且 CRC-32、压缩后大小、压缩方式都相同，**再逐字节比对压缩数据**，相同就 COPY 旧 APK 里那一段。
3. 新 APK 里其余的一切都是 DATA：本地文件头、变了的条目、APK Signing Block、中央目录、EOCD、条目之间的空隙。
4. 写出补丁之前先应用一遍，结果和新 APK 的 SHA-256 一致才落盘。

COPY 的正确性不依赖对 zip 结构的理解：只要旧 APK 那一段和新 APK 这一段字节相同，拼出来就是对的；结构只用来找候选区间。

`release_assets.py` 在生成 `dist/` 时：

- `gh release list` 取最新的 N 个已发布版本（不含草稿和本版），`gh release download` 把各自的 arm64 APK 和 `SHA256SUMS` 下到 `~/.cache/dshgo-release/apk/<tag>/`，APK 必须和该版发布的 `SHA256SUMS` 一致（缓存里的对不上就重下）。第一次要下 N 个整包（每个约 200 MB，发版机器上一个要几分钟），之后走缓存。`fromVersion` 用 `aapt2` 从旧 APK 里读。
- 逐个生成 `dsh-go-<新版本>-from-<旧版本>-arm64.dshdelta`；**不到整包 60 % 的才留下**，其余删掉。60 % 以上省下的流量不值得多一条要维护、会出错的路径。
- 留下的补丁写进 `dist/`、`SHA256SUMS`，以及 `update.json`：

```json
"patches": {
  "arm64": [
    { "from": "<1.1.0 APK 的 SHA-256>", "fromVersion": "1.1.0+10201200",
      "name": "dsh-go-1.2.0-from-1.1.0-arm64.dshdelta", "size": 13278848, "sha256": "<补丁的 SHA-256>" }
  ]
}
```

- 没有补丁时没有 `patches` 字段；`--delta-from 0` 不联网、不出补丁。旧版 App 不认识这个字段，照常下整包。

`publish-release.sh` 把 `SHA256SUMS` 里的每个文件（APK 和补丁）传到每条线路并逐个下载回来核对；三份清单（R2 `beta/update.json`、公开桶 `dl.dshtui.com/update.json`、GitHub 的 `update.json`）都带同样的 `patches`。GitHub Release 正文说明 `*.dshdelta` 不用手动下载。

## App 端的规则（契约）

1. **选**：本机 flavor 的 `patches` 里 `from` 等于已装 APK（`ApplicationInfo.sourceDir`）SHA-256 的那一条。没有就下整包。
2. **地址**：补丁没有 `url`。它在每条线路上都和 APK 在同一目录（公开桶 `download/<版本>/`、R2 `beta/<版本>/`、GitHub Release、香港桶 `<版本>/`），按推 APK 地址的同一套办法推：把 APK 地址里的文件名换成补丁的 `name`；清单里 APK 也没有 `url` 时就是 GitHub 的 tag + 文件名。
3. **下载**：和 APK 一样续传、换源；下完按清单的 `size`、`sha256` 校验补丁本身。
4. **应用前**：头的 magic 是 `DSHDLT01`；旧 APK 的 SHA-256 现算一遍、等于头里的；头里的目标 SHA-256 和长度等于清单里 APK 的 `sha256`、`size`。
5. **应用**：流式读补丁、按 COPY 读旧 APK，写到临时文件；写的总量超过目标长度立即停。只需要一个复制缓冲区（参考实现 1 MiB）。
6. **应用后**：长度和 SHA-256 都等于目标，就当作下载好的整包，照常走签名预检和 PackageInstaller 安装。
7. **回落**：上面任何一步不对（没找到、下载失败、校验不过、旧 APK 读不了、op 不认识、越界、结果对不上），删掉补丁和半成品，**这次更新改下整包**，不再试别的补丁。补丁省的是流量，不是正确性的来源。
8. **空间**：补丁 + 拼出的 APK 都要放下；放不下就直接下整包。

安全性不变：拼出来的文件必须等于清单里 APK 的 SHA-256，之后的签名预检和系统校验一步不少。被篡改的补丁只会拼出对不上的文件，然后回落整包；`from` 只用来挑补丁，不被信任。

## 实测与预期大小

发版机器上实测（1.0.7 → 1.0.8 的 arm64 包，整包 205,180,162 字节；从 GitHub 取回的 1.0.7 和本地那份一致，补丁也一样）：

| | 字节 | 占整包 |
|---|---|---|
| **补丁 1.0.7 → 1.0.8** | 175,478,829（167.3 MiB） | 85.5 %：超过 60 %，不会发布 |
| 其中 运行时 `assets/runtime/rootfs-arm64-v8a.tar.xz`（1.0.8 换了运行时） | 158,284,672 | 补丁的 90.2 % |
| 其中 `lib/arm64-v8a/libapp.so` | 13,108,813 | |
| 其中 `classes.dex` | 3,536,553 | |
| 其中 `resources.arsc`、`libdartjni.so` ×3、`META-INF/` 签名、几份资源（共 27 个条目） | 433,798 | |
| 其中 本地头、Signing Block、中央目录（结构） | 99,121 | |
| 其中 操作头（607 个 COPY） | 15,872 | |
| 原样复制的 607 个条目 | 29,717,205 | |
| **估算：只改了 Dart 代码（只有 `libapp.so` 变）** | ≈ 13,278,848（12.7 MiB） | ≈ 6.5 % |
| 估算：`libapp.so` + `classes.dex`（改了插件或 Kotlin） | ≈ 16,815,401 | ≈ 8.2 % |

- 估算 = `libapp.so`（及 `classes.dex`）的压缩数据 + 每次都变的 v1 签名文件（`META-INF/MANIFEST.MF`、`CERT.SF`，约 55 KB）+ 结构 + 操作头。实际发版通常还会带几份资源，多几十 KB 到几百 KB。
- 耗时与内存：`make` 0.7 秒、`apply` 0.3 秒（文件在页缓存里），峰值内存 22 MB；读写都是流式，和 APK 大小无关。
- 运行时是**一个**整体压缩的 `.tar.xz`（stored 存进 APK）：里面改一点，xz 的输出就整段不同，这个条目只能整个重传。所以换运行时的版本一律走整包；以后要让运行时更新也走小补丁，得把运行时拆成几个条目（基础系统和常变的包分开），那是另一件事。

## 为什么按 zip 条目，而不是 bsdiff / zstd

- **APK 的大头本来就是压缩数据**（deflate 的 `.so`、`.dex`，xz 的运行时）。内容改一点，压缩后的字节几乎全变，直接对 APK 跑 bsdiff / `zstd --patch-from` 找不到多少公共部分；要做好得先解压、对原始内容做 diff、再按构建时完全相同的参数重压出逐字节一致的结果（Google 的 archive-patcher 就是这么做的），重压一旦有一个字节不同，签名就对不上，复杂且脆弱。
- **没变的条目字节完全相同**：同样的输入，构建出来的压缩数据相同（1.0.7 → 1.0.8 有 607 个条目原样复制）。按条目 COPY 已经拿到主要收益，典型的 Dart 发版只有整包的 6–8 %。
- **App 端没有 native 依赖**：只有 COPY / DATA 两种操作，Dart 或 Kotlin 百来行；bsdiff 要 bzip2 和 JNI，zstd 要带 native 库。
- **流式、内存小**：按顺序读补丁、按偏移读旧 APK，内存只要一个缓冲区；`zstd --patch-from` 要把整个旧文件当字典装进内存，200 MB 的 APK 就要几百 MB 的窗口，低端机上会被杀。
- **出错面小**：生成时已经应用验证过，App 端最终只认 SHA-256，格式越简单越不容易拼错。
- **代价**：改动落在大条目内部时（比如运行时），补丁和整包差不多大。这正是 60 % 门槛处理的情况：不发补丁，走整包。

## 测试

`python3 -m unittest discover -s tooling -p 'test_*.py'`

- `test_apk_delta.py`（临时生成的 zip）：没变的条目 → COPY、变了的条目 → DATA、条目重排后按旧位置乱序 COPY、stored 与 deflated（同名同 CRC 但换了压缩方式 → DATA）、头字段相同但字节不同 → DATA、双向往返逐字节一致、头与操作流的布局、旧 APK 不对被拒、损坏 / 截断 / 越界 / magic 不对的补丁报错且不留文件。
- `test_release_assets.py`（假的 `gh`，不联网）：补丁命名与清单字段、60 % 以上被丢掉、取最新几个已发布版本（排除本版）、下载一次后走缓存、缓存损坏重下、APK 与该版 `SHA256SUMS` 不符被拒、`gh` 失败时提示 `--delta-from 0`。
- `npm run smoke:publish`（`services/share-worker`）：假 dist 里带一个补丁，确认它和 APK 一样传到每条线路、被回下核对、出现在三份清单里。
