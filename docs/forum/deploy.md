# 自建 dsh-go 论坛（可选）

> 2026-10-24。用 Discourse 自建论坛的模板，配置文件都在 `infra/forum/`。不自建论坛的话，App 照常可用。
> 所有要你填的值都标成 `<<FILL: …>>`，汇总表在文末。

## 0. 文件一览

| 文件 | 作用 |
|---|---|
| `infra/forum/containers/app.yml` | 容器配置 · 独占模式：Discourse 自己占 80/443、自动签证书（3A） |
| `infra/forum/containers/app.reverse-proxy.yml` | 容器配置 · 反向代理模式：服务器上已有 nginx / Caddy 等占着 80/443（3B） |
| `infra/forum/settings/site_settings.yml` | 站点设置：App 登录回调、信任等级、反垃圾、登录方式端点、备份 |
| `infra/forum/settings/community.yml` | 分类（公告、插件、配置分享、玩法、求助、反馈）、标签、登录按钮文字 |
| `infra/forum/settings/secrets.example.yml` | OAuth / S3 密钥模板，复制成 `secrets.yml` 填写（不进仓库） |
| `infra/forum/scripts/apply.sh` | 把上面三份设置写进论坛，可重复执行 |
| `infra/forum/scripts/install_theme.sh` | 安装 / 更新分享码卡片主题组件 |
| `infra/forum/theme-dshgo/` | 主题组件：帖子里的 dsh-go 分享链接显示成安装卡片 |

## 1. 服务器放哪里

> 下面是编写时对相关规定的理解，不是法律意见。规定和执行口径会变，请按你所在地区、接入商和主管部门的最新要求自行核实。

**境内服务器**
- 网站要先办 ICP 备案。论坛属于交互式服务，个人主体备案一般办不了，需要企业主体（以接入商和省通信管理局的要求为准）。
- 《互联网论坛社区服务管理规定》要求发帖用户“后台实名、前台自愿”，即发帖前要完成手机号等实名认证，Discourse 默认没有这项功能。
- 《具有舆论属性或社会动员能力的互联网信息服务安全评估规定》要求论坛上线前做安全评估，并报网信、公安部门；上线后 30 日内还要办公安联网备案。

**境外服务器**
- 不需要 ICP 备案。
- 国内访问速度和稳定性没有保障。香港、日本、新加坡等地区带 CN2 GIA 等优化线路的机器体验更好，但价格更高。
- 帖子内容的法律责任仍由运营者承担。

本套配置按境外服务器编写。

## 2. 准备

- [ ] **VPS**：Ubuntu 22.04 / 24.04 LTS，64 位；内存 2 GB 起（4 GB 更从容），2 核，磁盘 40 GB。开放 22、80、443 端口。
- [ ] **选模式**：80/443 空着 → 独占模式（3A）；已经有反向代理和别的网站 → 反向代理模式（3B）。
- [ ] **域名**：用子域名，如 `forum.example.com`。`<<FILL: 论坛域名>>`
- [ ] **DNS**：添加 A 记录 `forum → <<FILL: 服务器 IPv4>>`。服务器有可用的 IPv6 再加 AAAA 记录。
  - 如果用 Cloudflare：先设成灰色云朵（仅 DNS），等证书签好再考虑开代理。开代理后要把 SSL 模式设为 Full (strict)，并在 `app.yml` 里取消 `cloudflare.template.yml` 那一行的注释。
- [ ] **邮件服务**（注册验证、通知都靠它；VPS 一般封了 25 端口，用 587 或 465 端口）：

| 服务 | 适合 | 说明 |
|---|---|---|
| Amazon SES | 境外，量大便宜 | 新账号要先申请移出沙箱 |
| Brevo / Mailgun / Postmark / Resend | 境外，配置简单 | 有免费额度或低价套餐 |
| 阿里云邮件推送 / 腾讯云邮件推送 | 收件人以 QQ、163 邮箱为主 | 需要实名的云账号；服务器在境外也能用 |

  发件域名在服务商那里完成 SPF、DKIM 验证（按服务商给的 DNS 记录添加），再加一条 DMARC 记录。
  需要：`<<FILL: SMTP 服务器>>`、`<<FILL: SMTP 端口>>`、`<<FILL: SMTP 用户名>>`、`<<FILL: SMTP 密码>>`、`<<FILL: 发件地址>>`。

## 3. 安装

在服务器上以 root 执行。3.1–3.2 两种模式通用。

```bash
# 3.1 内存 2 GB 时加 2 GB swap（4 GB 以上可跳过）
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile swap swap auto 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness = 10' > /etc/sysctl.d/30-discourse-swap.conf

# 3.2 Docker（已装可跳过）、Discourse 官方启动器、本仓库的论坛配置
curl -fsSL https://get.docker.com | sh
git clone https://github.com/discourse/discourse_docker.git /var/discourse
git clone <<FILL: dsh-app 仓库地址>> /opt/dsh-app
```

两种模式都把配置复制成 `/var/discourse/containers/app.yml`。文件名决定容器名，`scripts/` 下的脚本默认找名为 `app` 的容器；用别的名字时，执行脚本前要设 `DISCOURSE_CONTAINER=<名字>`。

### 3A 独占模式（Discourse 自己占 80/443）

```bash
cp /opt/dsh-app/infra/forum/containers/app.yml /var/discourse/containers/app.yml
chmod 600 /var/discourse/containers/app.yml
nano /var/discourse/containers/app.yml    # 替换全部 <<FILL: …>>
cd /var/discourse && ./launcher rebuild app   # 约 10 分钟，HTTPS 证书在这一步自动签发
```

### 3B 反向代理模式（服务器上已有代理占着 80/443）

Discourse 只在本机提供 HTTP；证书、HTTPS、80→443 跳转都交给现有代理。与独占模式的区别：

| 项 | 独占模式 `app.yml` | 反向代理模式 `app.reverse-proxy.yml` |
|---|---|---|
| 模板 | `web.ssl` + `web.letsencrypt.ssl` | 去掉这两个，加 `web.socketed`（或改用端口） |
| `expose` | `80:80`、`443:443` | 无（socket）；端口模式为 `127.0.0.1:8080:80` |
| HTTPS 标记 | 由 letsencrypt 模板设置 | 手动设 `DISCOURSE_FORCE_HTTPS: true` |
| `volumes` | 相同：`/var/discourse/shared/standalone` → `/shared` | 相同 |

`DISCOURSE_FORCE_HTTPS` 对应站点设置 `force_https`（默认 `false`）。它决定 Discourse 生成的链接、邮件里的链接和 OAuth 回调地址（`OmniAuth.config.full_host` 取 `Discourse.base_url`）是否用 https，并给登录 Cookie 加 Secure。TLS 在外面终止时必须设成 `true`，否则第三方登录会回调到 http 地址而失败。

```bash
cp /opt/dsh-app/infra/forum/containers/app.reverse-proxy.yml /var/discourse/containers/app.yml
chmod 600 /var/discourse/containers/app.yml
nano /var/discourse/containers/app.yml    # 替换全部 <<FILL: …>>；按内存调 db_shared_buffers / UNICORN_WORKERS
cd /var/discourse && ./launcher rebuild app
ls -l /var/discourse/shared/standalone/nginx.http.sock   # socket 模式：这个文件出现即就绪
```

**两种对接方式**

| 方式 | 现有代理转发到 | 什么时候用 |
|---|---|---|
| unix socket（默认，官方推荐） | `/var/discourse/shared/standalone/nginx.http.sock` | 代理直接跑在宿主机上（nginx、Caddy） |
| 本机端口 | `http://127.0.0.1:8080` | 代理连不了 unix socket（如 Traefik），或代理在另一个容器里 |

改用端口：在 `app.yml` 里删掉 `web.socketed` 那行模板，取消 `expose` 两行的注释，再 rebuild。代理跑在容器里时，`127.0.0.1` 指的是代理容器自己：要么把 `/var/discourse/shared/standalone` 挂进代理容器、用 socket，要么让代理容器能访问宿主机端口（如 `host.docker.internal` / 宿主机网桥 IP）。

**现有代理要做到**
- 转发 `Host`，带上 `X-Forwarded-For`、`X-Forwarded-Proto: https`，以及 `X-Real-IP: <访客 IP>`。容器里的 nginx 用 `X-Real-IP` 还原真实 IP（socket 模式信任 `unix:`，端口模式信任 Docker 私有网段，见 `app.reverse-proxy.yml` 末尾的 `run`）。不传这个头，所有访客会被当成同一个 IP，一起被限流。
- 请求体上限 ≥ 容器内的 `upload_size`（默认 10m）。下面示例给 20m；想在后台网页上传备份文件来恢复，两边都要调大。
- 超时 ≥ 60 秒。Discourse 的实时更新走 HTTP 长轮询（约 25 秒一次），不用 WebSocket；关掉代理缓冲，消息能即时到达。
- 80 端口跳转到 https；证书由代理自己签发和续期。

**nginx（宿主机）**：`/etc/nginx/sites-available/forum.conf`，然后 `ln -s` 到 `sites-enabled`、`nginx -t && systemctl reload nginx`。

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name <<FILL: 论坛域名>>;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;          # nginx ≥ 1.25.1 可改成 listen 443 ssl; + http2 on;
    listen [::]:443 ssl http2;
    server_name <<FILL: 论坛域名>>;

    ssl_certificate     /etc/letsencrypt/live/<<FILL: 论坛域名>>/fullchain.pem;   # 如用 certbot --nginx 签发
    ssl_certificate_key /etc/letsencrypt/live/<<FILL: 论坛域名>>/privkey.pem;

    client_max_body_size 20m;

    location / {
        proxy_pass http://unix:/var/discourse/shared/standalone/nginx.http.sock:;
        # 端口模式：proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $http_host;
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }
}
```

证书可以先只开 80 端口那个 server，用 `certbot --nginx -d <论坛域名>` 签发，再补 443 段。

**Caddy（宿主机）**：Caddyfile 里加一段，`systemctl reload caddy`。Caddy 自动签证书、自动做 80→443 跳转，默认已经带上 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host`，默认不限制请求体大小。

```caddy
<<FILL: 论坛域名>> {
    reverse_proxy unix//var/discourse/shared/standalone/nginx.http.sock {
        # 端口模式：reverse_proxy 127.0.0.1:8080 {
        header_up X-Real-IP {remote_host}
        flush_interval -1
    }
}
```

**Traefik 和其他代理**：用端口模式（`127.0.0.1:8080`，或把 Discourse 容器接入 Traefik 所在的 Docker 网络），路由到该服务；入口点开 HTTP→HTTPS 跳转，证书用代理自带的 ACME；Traefik 默认就会带 `X-Forwarded-*` 和 `X-Real-Ip`。其他代理照「现有代理要做到」那几条配置即可。

例：临时域名可以用 `forum.<IP 用横线连接>.sslip.io`（如 `forum.38-58-58-219.sslip.io`），它直接解析到该 IP，不用改 DNS。换成正式域名前请看 §10「更换域名」。

### 装好后检查

- [ ] 浏览器打开 `https://<论坛域名>`，能看到页面、证书有效、`http://` 会跳到 `https://`。
- [ ] 反向代理模式确认 https 标记生效：`docker exec app rails runner 'puts SiteSetting.force_https'` 输出 `true`（由环境变量锁定的设置不会出现在后台设置页里）。
- [ ] 打不开时：`cd /var/discourse && ./launcher logs app`；反向代理模式再看代理自己的错误日志（如 `/var/log/nginx/error.log`）。502 一般是 socket 还没生成或路径写错。

## 4. 第一个管理员

- [ ] 用 `DISCOURSE_DEVELOPER_EMAILS` 里的邮箱在网页上注册，点验证邮件，账号自动成为管理员。
- [ ] 收不到邮件（还没配 SMTP，或配置有误）时，用命令行创建。这个命令是交互式的，需要人在终端里操作：

```bash
cd /var/discourse && ./launcher enter app
rake admin:create     # 按提示输入邮箱、密码，最后选 Y 授予管理员
exit
```

- [ ] 登录后会出现站点向导，可以直接跳过：第 5 步的脚本会写入同样的设置。

## 5. 第三方登录：注册 OAuth 应用

三个都是可选的；没填的那个不会显示登录按钮。回调地址里的 `<论坛域名>` 换成你的论坛域名。

**GitHub**
1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
2. Homepage URL：`https://<论坛域名>`。
3. Authorization callback URL：`https://<论坛域名>/auth/github/callback`。
4. 创建后生成 Client Secret。记下 `<<FILL: GitHub Client ID>>`、`<<FILL: GitHub Client Secret>>`。

**LINUX DO**（走 OpenID Connect）
1. 用 LINUX DO 账号登录 `https://connect.linux.do`，新建应用接入（入口名称以页面为准）。
2. 回调地址：`https://<论坛域名>/auth/oidc/callback`。
3. 记下 `<<FILL: LINUX DO Client ID>>`、`<<FILL: LINUX DO Client Secret>>`。

**Gitee**
1. Gitee → 设置 → 第三方应用（`https://gitee.com/oauth/applications`）→ 创建应用。
2. 应用回调地址：`https://<论坛域名>/auth/oauth2_basic/callback`。
3. 权限只勾 `user_info`。
4. 记下 `<<FILL: Gitee Client ID>>`、`<<FILL: Gitee Client Secret>>`。

## 6. 写入站点设置、分类和标签

```bash
cd /opt/dsh-app/infra/forum/settings
cp secrets.example.yml secrets.yml && chmod 600 secrets.yml
nano secrets.yml          # 填第 5 步的 Client ID / Secret
nano site_settings.yml    # 替换 title、site_description 等 <<FILL: …>>
sudo /opt/dsh-app/infra/forum/scripts/apply.sh
```

没有 `secrets.yml`、`site_settings.yml` 里还有占位符时也可以先执行：占位符项和没凭据的登录方式会被跳过并打印 `!`，其余照常写入；补齐后再执行一次即可。

- [ ] 输出里没有 `!` 开头的行（有的话按提示改好文件，再执行一次）。
- [ ] 登录页能看到 GitHub / LINUX DO / Gitee 按钮，逐个试登一次。
- [ ] 分类页能看到 公告、插件、配置分享、玩法、求助、反馈。新站自带的「网站反馈」会被改名为「反馈」；「常规」分类不需要的话到后台删掉。
- [ ] 第三方登录失败时：后台 → 日志 → 错误日志。LINUX DO 可以临时把 `openid_connect_verbose_logging` 改成 `true`，Gitee 改 `oauth2_debug_auth`，然后重试。

这些设置会写入：
- App 登录：`allowed_user_api_auth_redirects` 加入 `dshgo://forum/auth`；授权范围 `read,write,notifications,session_info`；0 级新用户也能在 App 里登录。
- 帖子里的 `dshgo://` 链接保留可点（`allowed_href_schemes` 加入 `dshgo`）。
- 默认中文、中文分词搜索。中文的最短标题 / 正文 / 搜索词等默认值要显式写入：用环境变量锁定语言时 Discourse 仍按 en 计算这些默认值（2026.10 实测），`site_settings.yml` 的「中文默认值」一节已逐项列出。
- 新分类的「关于」帖按站点语言生成；写完分类会清分类缓存（否则匿名 `/site.json` 约 30 分钟内还是旧分类）。
- 新社区的信任等级和反垃圾设置、每日备份。每一项在 `site_settings.yml` 里都有注释。

## 7. 分享码卡片主题组件

```bash
sudo /opt/dsh-app/infra/forum/scripts/install_theme.sh
```

- [ ] 后台 → 外观 → 主题 → 组件 →「dsh-go 分享码卡片」→ 设置：
  - `download_url`：`<<FILL: dsh-go 下载页，https 开头>>`（留空则不显示「下载 dsh-go」按钮）；
  - `landing_urls`：分享码落地页地址，默认 `https://go.dshtui.com/share/|https://ccch1mneyyy.github.io/dsh-go/share/`（新域名在前，旧的 github.io 地址保留，老链接照样认）。要与 App 里 `app/lib/share_code/share_link.dart` 的 `shareLandingUrl` 一致，换域名时两边一起改。
- [ ] 发一个带分享链接的测试帖，确认显示成卡片，「用 dsh-go 安装」能拉起 App。
- [ ] 以后改了组件，重新执行上面的脚本即可更新。

## 8. App 侧

- [ ] dsh-go 里论坛地址的常量是 `https://<论坛域名>`（`app/lib/forum/forum_config.dart` 的 `forumDefaultBaseUrl`，当前 `https://forum.dshtui.com`；App 里「论坛设置」也能临时改）。
- [ ] 在 App 里走一遍：浏览 → 登录（会打开浏览器授权页，确认后回到 App）→ 发帖 → 退出登录。

## 9. 备份

- [ ] 默认每天自动备份一次，保留 7 份，位置：`/var/discourse/shared/standalone/backups/default/`。
- [ ] 异地备份二选一：
  - 对象存储：在 `secrets.yml` 填 S3 相关项，`site_settings.yml` 里 `backup_location: "s3"`，再执行 `apply.sh`；
  - 定期把上面的目录同步到另一台机器（如 cron + rsync）。
- [ ] 恢复（新服务器装好同版本 Discourse 后，把备份文件放进上面的目录）：

```bash
cd /var/discourse && ./launcher enter app
discourse enable_restore
discourse restore <备份文件名>.tar.gz
exit
```

## 10. 升级与日常运维

- [ ] 升级 Discourse：浏览器打开 `https://<论坛域名>/admin/upgrade` 点升级；或命令行 `cd /var/discourse && git pull && ./launcher rebuild app`（会停机几分钟）。
- [ ] 系统更新：`apt update && apt upgrade`，并开启 `unattended-upgrades`。
- [ ] 改了 `app.yml` 要执行 `./launcher rebuild app`；改了 `settings/` 下的文件只要再执行 `apply.sh`。
- [ ] 遇到垃圾帖潮：把 `site_settings.yml` 里的 `approve_unless_allowed_groups` 改成 `"1|2|11"`（0 级用户发帖先审核），执行 `apply.sh`。
- [ ] 很多用户反馈 429（请求过多）：国内移动网络大量用户共用出口 IP，可以在 `app.yml` 的 `params` 里调高 `web.ratelimited` 模板的 `reqs_per_minute` / `burst_per_minute`，然后 rebuild。反向代理模式下先确认代理传了 `X-Real-IP`（§3B），否则所有人共用一个限流额度。

### 更换域名（如从临时的 sslip.io 换到正式域名）

1. 新域名的 DNS 指向服务器；反向代理模式下，在现有代理里加上新域名并签好证书。
2. 改 `app.yml` 的 `DISCOURSE_HOSTNAME`（发件地址也一并改），然后 `cd /var/discourse && ./launcher rebuild app`。
3. 把站内已有内容里的旧地址换掉：

```bash
cd /var/discourse && ./launcher enter app
discourse remap <旧域名> <新域名>
rake posts:rebake
exit
```

4. GitHub / LINUX DO / Gitee 三个 OAuth 应用的回调地址改成新域名。
5. App 里论坛地址的常量（`app/lib/forum/forum_config.dart` 的 `forumDefaultBaseUrl`）改成新域名。

## 11. 已知风险

- **LINUX DO 登录未实测**：端点和授权范围取自 `connect.linux.do` 的 OIDC 发现文档。Discourse 的 OIDC 插件会核对用户信息接口（`/api/user`）返回的 `sub` 与 ID Token 是否一致，这一点没法在拿到凭据前验证。如果登录报 `sub mismatch`，改用下面的备选方案。
- **备选方案**：用 oauth2-basic 接 LINUX DO。这样同一站点就不能再接 Gitee，因为 oauth2-basic 每个站点只能配一个服务。把 `site_settings.yml` 里的 Gitee 段换成：

```yaml
oauth2_authorize_url: "https://connect.linux.do/oauth2/authorize"
oauth2_token_url: "https://connect.linux.do/oauth2/token"
oauth2_user_json_url: "https://connect.linux.do/api/user"
oauth2_json_user_id_path: "id"
oauth2_json_username_path: "username"
oauth2_json_name_path: "name"
oauth2_json_avatar_path: "avatar_url"   # 未核实
oauth2_json_email_path: "email"         # 未核实
oauth2_send_auth_header: true            # 只用 Basic 头，与已知可用的接入方式一致
oauth2_send_auth_body: false
oauth2_scope: ""
oauth2_button_title: "LINUX DO"
```

  回调地址相应改成 `/auth/oauth2_basic/callback`，`secrets.yml` 里的 `oauth2_*` 填 LINUX DO 的凭据，`openid_connect_*` 留空。
- **Gitee 邮箱**：Gitee 只返回用户设为公开的邮箱，多数为空。为空时 Discourse 会让用户自己填邮箱并验证，所以 SMTP 必须可用。

## 12. 需要你提供的值

| 值 | 填在哪里 |
|---|---|
| 论坛域名 | `app.yml` `DISCOURSE_HOSTNAME`；App 论坛地址常量；三个 OAuth 回调地址 |
| 服务器 IP | DNS A 记录 |
| 管理员邮箱 | `app.yml` `DISCOURSE_DEVELOPER_EMAILS`（`LETSENCRYPT_ACCOUNT_EMAIL` 可同填） |
| SMTP 服务器 / 端口 / 用户名 / 密码 | `app.yml` `DISCOURSE_SMTP_*` |
| 发件地址（已做 SPF / DKIM） | `app.yml` `DISCOURSE_NOTIFICATION_EMAIL` |
| 论坛名称、一句话介绍、短介绍、联系邮箱 | `site_settings.yml` `title` / `site_description` / `short_site_description` / `contact_email` |
| GitHub Client ID / Secret | `secrets.yml` |
| LINUX DO Client ID / Secret | `secrets.yml` |
| Gitee Client ID / Secret | `secrets.yml` |
| dsh-app 仓库地址（服务器上拉取配置用） | 第 3.2 步 |
| dsh-go 下载页地址 | 主题组件设置 `download_url` |
| 分享码落地页地址（如果换了） | 主题组件设置 `landing_urls`，并与 App 的 `shareLandingUrl` 一致 |
| 可选：S3 访问密钥、区域、桶名、端点 | `secrets.yml` + `site_settings.yml` `backup_location` |
| 可选：MaxMind 账号 ID / License Key | `app.yml` |
| 可选：服务条款里的主体名称、适用法律、争议管辖地 | `site_settings.yml` `company_name` / `governing_law` / `city_for_disputes` |

## 13. 必须人工完成的步骤

脚本能做的都在 `scripts/` 里；下面这些需要账号或人工判断，自动部署时要交给站长：

| 步骤 | 原因 |
|---|---|
| 注册 SMTP 服务、在 DNS 里加 SPF / DKIM / DMARC | 需要站长的账号和域名控制权；没有 SMTP 时注册验证邮件发不出去 |
| 在 GitHub、LINUX DO、Gitee 注册 OAuth 应用（§5），把凭据填进 `secrets.yml` | 需要站长本人的账号 |
| 填 `site_settings.yml` 的论坛名称、介绍、联系邮箱 | 文案由站长决定 |
| 第一个管理员（§4） | 要么收验证邮件，要么在终端里交互执行 `rake admin:create` |
| 主题组件的 `download_url`（§7） | 下载页地址由站长决定；在后台设置页填写 |
| 反向代理模式：现有代理的站点配置和证书（§3B） | 取决于服务器上现有代理的类型和配置方式 |
| 从临时域名换到正式域名（§10） | 需要正式域名 |
