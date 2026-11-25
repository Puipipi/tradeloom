# 发包准备与执行说明

> 0.3.0 待发布：npm 正式发布并核验 tarball 后，把 `market/plugins/@ccch1mneyyy__dsh-media.json` 的 `version` 改为 `0.3.0`，再按 `market/VERIFICATION.md` 重建索引；在 npm 发布前不要把 market 指向 0.3.0。

当前版本 `@ccch1mneyyy/dsh-media@0.2.1` 已于 2026-10-31（Asia/Singapore）通过具备直发权限的 granular token 正式发布到 npm。HTTP 202 接受后，2026-10-30 19:55:51 UTC 匿名精确版本查询与公开 tarball 下载均为 200，registry SHA512 与本地 SHA256 双重核验通过。无需人工暂存审批。包名使用用户授权的备用组织；设置 namespace / bundle entry ID 保持 `dsh-media`，现有 App 支持 `/dsh-media` 包名，不需要发 App 新版。

发布包为 48,019 bytes、19 个常规文件，SHA256 为 `9829f5106dec8cb354c203c74cc0510656f0f94538c36abf0fb80226388d13c9`。与 306/306 通过的版本逐文件对比，只有 package.json 的版本从 0.2.0 变为 0.2.1，运行时代码完全一致。显式 files 清单不含测试、凭据、私有日志或开发依赖。

## 此次发布限制与版本选择

- 前一枚 GAT 虽有 Bypass 2FA 与 coarse package/write 元数据，实际属于仅暂存权限。首次发布返回 E404；staging 建立包后，同一令牌直发明确返回 `E_STAGE_REQUIRED`，不能据 earlier 404 断言组织无权或账号未开 2FA 是唯一原因。
- `0.2.0` 已通过官方 staging 上传并完成校验，stage ID 为 `87e228cd-1e3b-4014-8410-f49ab24581af`，暂存 tarball 与本地哈希一致。它尚未正式发布，不进入可安装市场。
- 最新令牌通过 direct-publish 权限检查，但直接发布 `0.2.0` 返回 409：已暂存版本不可覆盖。因此使用 `0.2.1` 正常直发，没有改动功能代码；不继续创建重复暂存，也不要求用户审批旧版本。
- 自动直发需要 Packages and scopes 的 `Read and write (publish and stage)` 且开启 Bypass 2FA；`Read and write (stage only)` 不满足。官方 staged 审批则独立要求人工 2FA，不能把该要求套用于所有 GAT 直发。

公开 tarball 已核对 registry SHA512 和本地 SHA256。市场真实扫描、24 项测试及 5 包构建通过，Pages 已部署；2026-10-30 19:58:47 UTC Worker 双文件均为 200、X-Market-Stale:false，官方格式与 Worker validator 通过，正式条目为 official / 0.2.1，SRI 与 npm 一致。独立验证插件分享页 HTTP 200，中文标题、版本与 App deep link 正确。市场只列正式版本，不列 npm staging 的占位版本。

## 本地验证和令牌发布

从仓库根按 VERIFICATION.md 准备依赖、运行全套测试与 headless；然后：

```sh
cd runtime/media/dsh-media
npm pack --dry-run --json
npm pack --pack-destination /absolute/private/release-dir
```

审查 tarball 内容和 SHA256 后，owner 可在本机选择短期、仅限该组织/包且满足发布 2FA 策略的 granular token。不要把真实令牌放入命令文本或仓库。以下是后续新版本常规发布步骤；本次 `0.2.1` 已通过该正常直发路径提交；发布新版本时先核对版本未被已发布或暂存记录占用：

```sh
umask 077
media_npmrc=$(mktemp)
trap 'rm -f "$media_npmrc"; unset NPM_TOKEN' EXIT
printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$media_npmrc"
read -rsp 'npm token: ' NPM_TOKEN
export NPM_TOKEN
NPM_CONFIG_USERCONFIG="$media_npmrc" npm whoami
NPM_CONFIG_USERCONFIG="$media_npmrc" npm publish /absolute/private/release-dir/ccch1mneyyy-dsh-media-0.2.1.tgz --access public
```

根据组织的 2FA / granular token 策略完成认证；不预设可以绕过组织策略。环境变量引用的 `.npmrc` 用法见 [npm token 文档](https://docs.npmjs.com/private-modules/ci-server-config/)。本机普通令牌发布不声称带 CI provenance。

## 旧 0.2.0 暂存记录（不作为本次发布前提）

```sh
npm stage view 87e228cd-1e3b-4014-8410-f49ab24581af --json
npm stage download 87e228cd-1e3b-4014-8410-f49ab24581af
npm stage approve 87e228cd-1e3b-4014-8410-f49ab24581af --auth-type=web
```

也可在 npm 网页的 Staged Packages 标签中审批 `@ccch1mneyyy/dsh-media@0.2.0`。官方要求维护者在正式审批时完成账号 2FA；Bypass 2FA 的 GAT 不能替代此步骤。首发 staging 可能生成 npm 管理的 `0.0.0-stage`，它不包含待发布版本内容，不是本插件可安装版本。见 [官方 staged publishing](https://docs.npmjs.com/staged-publishing/)。

## 可选 GitHub Actions provenance 模板（未启用）

本包尚未配置公开来源的 `repository.url` 或 provenance workflow，**不能直接宣称满足公开 provenance 要求**。启用前须明确公开插件源码位置，在 package.json 填入与该公开仓库大小写一致的 `repository.url`；保持完整验证输入，重新跑测试。npm 的 provenance 要求公开源码和受支持的托管 runner；OIDC trusted publishing 的绑定也必须在 npm 侧配置。见 [provenance](https://docs.npmjs.com/generating-provenance-statements/) 与 [trusted publishing](https://docs.npmjs.com/trusted-publishers/)。

下面是保留本仓库路径的模板，只有 owner 决定发布方案后才复制进 `.github/workflows/`。使用受保护 environment、显式 dispatch，并将 action tag 换成经 owner 审核的精确 commit。若抽出独立插件仓库，先移入两版已有 runtime 锁和 header golden，再调整路径。下面默认验证 `0.2.2-rc.1`；兼容性发布前还须用 `--dsh-version 0.2.1-rc.4` 准备另一套依赖并运行同样检查。

```yaml
name: Publish media with provenance
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-release
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24.x'
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - name: Install exact test graph
        run: |
          node runtime/media/dsh-media/test/headless-v2/prepare.mjs --out "$RUNNER_TEMP/media-deps"
          npm ci --ignore-scripts --prefix "$RUNNER_TEMP/media-deps"
          ln -s "$RUNNER_TEMP/media-deps/node_modules" runtime/media/dsh-media/node_modules
      - name: Verify
        env:
          TZ: Asia/Shanghai
        run: |
          node --test runtime/media/dsh-media/test/*.test.js
          node runtime/media/dsh-media/test/headless-v2/run.mjs --out "$RUNNER_TEMP/media-evidence"
      - name: Check and publish
        working-directory: runtime/media/dsh-media
        run: |
          npm pack --dry-run --json
          npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

此模板采用 npm 官方令牌 + provenance 模式。配置并验证 OIDC trusted publisher 后可按官方说明去掉 token；不能只删除环境变量就声称已配置成功。provenance 证明来源与构建，不代表代码无风险。模板未加入自动 tag / release 触发，当前分支没有可执行的发布 workflow。
