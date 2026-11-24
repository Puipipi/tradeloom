"use strict";
(() => {
  const byId = id => document.getElementById(id);
  const credentialForm = byId("credential-form");
  const assistantForm = byId("assistant-form");
  const messageForm = byId("message-form");
  const websiteForm = byId("website-form");
  let noticeRevision = null;
  let draftBaseRevision = null;
  let withdrawal = null;
  let noticeLoaded = false;
  const labels = {id:"目标",path:"入口",operation:"支持操作",deepseek_api_key:"DeepSeek API Key",model_provider:"模型提供方",model_name:"模型名称",service:"网站服务", database:"数据库", database_type:"数据库类型", assistant:"运营助手", commands:"可用检查", credential_storage:"凭据存储", credentials:"凭据状态", cloudflare:"Cloudflare", websites:"网站", ssh:"SSH", local_authentication:"登录认证", model:"模型", configured:"已配置", operations:"服务运维", credential_lifecycle:"配置凭据", credential_readback:"读取凭据原文", arbitrary_network:"任意网络请求", shell:"命令行", status:"状态", targets:"网站目标", cloudflare_zone_id:"Cloudflare Zone ID",cloudflare_api_token:"Cloudflare API Token", cloudflare_oauth_client_secret:"Cloudflare OAuth 客户端密钥"};
  const values = {enterprise_portal:"企业登记站",website_notice:"企业公告",deepseek:"DeepSeek",postgresql:"PostgreSQL", running:"运行中", ok:"正常", unavailable:"不可用", ready:"可用", not_integrated:"未接入", not_configured:"未配置", allowlisted_commands:"仅允许固定检查", django_session_required:"需要企业账号登录", health:"服务健康", capabilities:"已接入能力", credentials:"凭据状态", permissions:"运维权限", websites:"网站状态"};
  function show(target, data) {
    target.replaceChildren();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const list = document.createElement("dl"); list.className = "status-list";
      Object.entries(data).forEach(([key, value]) => {
        const dt = document.createElement("dt"), dd = document.createElement("dd");
        dt.textContent = labels[key] || key;
        if (value && typeof value === "object" && !Array.isArray(value)) show(dd, value);
        else dd.textContent = format(value);
        list.append(dt, dd);
      }); target.append(list);
    } else target.textContent = format(data);
  }
  function format(value) {
    if (typeof value === "boolean") return value ? "是" : "否";
    if (Array.isArray(value)) return value.length ? value.map(format).join("、") : "暂无";
    if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => `${labels[key] || key}：${format(item)}`).join(" · ");
    return values[value] || String(value ?? "暂无");
  }
  async function request(endpoint, body, query = "") {
    const options = {credentials:"same-origin", cache:"no-store", headers:{Accept:"application/json"}};
    if (body) {
      options.method = "POST";
      options.headers["Content-Type"] = "application/json";
      options.headers["X-CSRFToken"] = assistantForm.querySelector('[name="csrfmiddlewaretoken"]').value;
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`/api/enterprise/operations/${endpoint}/${query}`, options);
    if (response.redirected || !response.headers.get("content-type")?.includes("application/json")) throw new Error("登录已失效，请重新登录。");
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.detail || "请求未完成，请稍后重试。");
      error.status = response.status; error.data = data; throw error;
    }
    return data;
  }
  async function refresh() {
    const button = byId("refresh-status"); button.disabled = true;
    try {
      const data = await request("status");
      byId("service-status").textContent = "已读取服务配置状态。";
      show(byId("credential-status"), data);
      credentialForm.hidden = credentialForm.dataset.canManage !== "true" || data.credential_storage !== "ready";
      assistantForm.querySelector("button").disabled = false;
      const modelConfigured = data.model === "configured";
      byId("model-status").textContent = modelConfigured ? `DeepSeek 已配置（${data.model_name || "服务器配置模型"}）。非固定公告命令的问题文本将发送到 DeepSeek；请勿填写客户信息或凭据。` : "DeepSeek 未配置；老板仍可输入固定公告命令本地准备变更提案，或使用下方手动检查。其它自然语言问题暂不可用。";
      messageForm.querySelector("button").disabled = !modelConfigured && messageForm.dataset.canDraft !== "true";
    } catch (error) {
      byId("service-status").textContent = error.message;
      credentialForm.hidden = true;
      assistantForm.querySelector("button").disabled = true;
      messageForm.querySelector("button").disabled = true;
      byId("model-status").textContent = "无法读取模型状态；可刷新重试。";
    } finally { button.disabled = false; }
  }
  byId("refresh-status").addEventListener("click", refresh);
  function setWithdrawal(notice) {
    withdrawal = notice?.text ? {...notice} : null;
    byId("withdraw-proposal").hidden = !withdrawal;
    byId("withdraw-text").textContent = withdrawal?.text || "";
    byId("withdraw-revision").textContent = withdrawal ? `准备撤下的版本：${withdrawal.revision}` : "";
    byId("clear-notice").textContent = withdrawal ? "确认撤下此公告" : "撤下公告";
  }
  byId("cancel-withdraw-proposal").addEventListener("click", () => {
    setWithdrawal(null); byId("notice-feedback").textContent = "已取消撤下提案；网站未修改。";
    byId("assistant-message").focus();
  });
  function renderNotice(data, fillDraft) {
    const notice = data.notice;
    noticeRevision = notice.revision;
    byId("website-notice").textContent = notice.text || "当前没有公告。";
    byId("notice-meta").textContent = `版本：${notice.revision} · 更新时间：${notice.updated_at || "暂无"}`;
    websiteForm.hidden = !data.can_write;
    if (fillDraft) websiteForm.elements.text.value = notice.text;
    noticeLoaded = true;
  }
  async function refreshNotice() {
    const button = byId("refresh-notice"); button.disabled = true;
    try { renderNotice(await request("website"), !noticeLoaded); }
    catch (error) { byId("notice-feedback").textContent = error.message; }
    finally { button.disabled = false; }
  }
  async function saveNotice(clear) {
    const text = clear ? "" : websiteForm.elements.text.value;
    if (!clear && !text.trim()) { byId("notice-feedback").textContent = "请输入公告；撤下请使用撤下公告按钮。"; return; }
    const targetWithdrawal = clear && withdrawal ? {...withdrawal} : null;
    if (!window.confirm(targetWithdrawal ? `确认撤下版本 ${targetWithdrawal.revision} 的以下公告？\n${targetWithdrawal.text}` : (clear ? "确认撤下企业登记站公告？" : "确认发布 / 替换企业登记站公告？"))) return;
    const buttons = websiteForm.querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
    try {
      renderNotice(await request("website", {text, revision:clear ? (targetWithdrawal?.revision ?? noticeRevision) : (draftBaseRevision ?? noticeRevision)}), true);
      draftBaseRevision = null;
      setWithdrawal(null);
      byId("notice-feedback").textContent = clear ? "公告已撤下。" : "公告已发布。";
    } catch (error) {
      if (error.status === 409 && error.data.notice) {
        renderNotice(error.data, false);
        if (targetWithdrawal) {
          setWithdrawal(error.data.notice);
          byId("notice-feedback").textContent = withdrawal ? "公告已更新，原提案未撤下。已展示最新全文与版本，请核对后重新明确确认。" : "公告已被撤下，无需再次提交。";
        } else {
          draftBaseRevision = null;
          byId("notice-feedback").textContent = "公告已被其他人更新，已刷新当前公告并保留你的草稿。请核对后重新提交。";
        }
      } else byId("notice-feedback").textContent = error.message;
    } finally { buttons.forEach(button => button.disabled = false); }
  }
  websiteForm.addEventListener("submit", event => { event.preventDefault(); saveNotice(false); });
  byId("clear-notice").addEventListener("click", () => saveNotice(true));
  byId("refresh-notice").addEventListener("click", refreshNotice);
  const cloudflareForm = byId("cloudflare-form");
  let cloudflareDomain = null;
  let cloudflareCanPurge = false;
  function clearCloudflare() {
    cloudflareDomain = null; cloudflareCanPurge = false;
    cloudflareForm.hidden = true; byId("cloudflare-site").hidden = true;
    byId("cloudflare-target").textContent = "";
  }
  function resourceTarget() {
    const path = cloudflareForm.elements.path.value;
    if (!cloudflareDomain || !/^\/[A-Za-z0-9_./~-]*$/.test(path) || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return null;
    try {
      const target = new URL(path, `https://${cloudflareDomain}`);
      if (target.protocol !== "https:" || target.hostname !== cloudflareDomain || target.username || target.password || target.hash) return null;
      return target.href;
    } catch { return null; }
  }
  cloudflareForm.elements.path.addEventListener("input", () => {
    byId("cloudflare-target").textContent = resourceTarget() || "请输入本站一个有效资源路径。";
  });
  byId("refresh-cloudflare").addEventListener("click", async () => {
    const button = byId("refresh-cloudflare"); button.disabled = true;
    clearCloudflare(); byId("cloudflare-feedback").textContent = "";
    byId("cloudflare-status").textContent = "正在向 Cloudflare 查询…";
    try {
      const data = await request("cloudflare");
      byId("cloudflare-status").textContent = data.detail;
      if (data.status === "ready" && typeof data.domain === "string" && /^[a-z0-9.-]+$/.test(data.domain)) {
        cloudflareDomain = data.domain; cloudflareCanPurge = data.can_purge === true;
        byId("cloudflare-domain").textContent = data.domain;
        byId("cloudflare-zone-status").textContent = data.zone_status || "暂无";
        byId("cloudflare-site").hidden = false; cloudflareForm.hidden = !cloudflareCanPurge;
        byId("cloudflare-target").textContent = resourceTarget() || "请输入本站一个有效资源路径。";
      }
    } catch (error) { byId("cloudflare-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  cloudflareForm.addEventListener("submit", async event => {
    event.preventDefault();
    const target = resourceTarget();
    if (!cloudflareCanPurge || !target) { byId("cloudflare-feedback").textContent = "请先查询网站状态并填写本站一个有效资源路径。"; return; }
    const domain = cloudflareDomain, path = cloudflareForm.elements.path.value;
    if (!window.confirm(`确认清除以下单个资源的 Cloudflare 缓存？\n域名：${domain}\n资源：${target}`)) return;
    const button = cloudflareForm.querySelector("button"); button.disabled = true;
    byId("refresh-cloudflare").disabled = true;
    byId("cloudflare-feedback").textContent = "正在请求 Cloudflare 清除缓存…";
    try {
      const data = await request("cloudflare", {path, expected_domain:domain, confirm:true});
      byId("cloudflare-feedback").textContent = data.purged === true ? `Cloudflare 已接受清理请求：${data.url}` : (data.detail || "Cloudflare 未确认清除成功。");
    } catch (error) { byId("cloudflare-feedback").textContent = error.message; clearCloudflare(); }
    finally { button.disabled = false; byId("refresh-cloudflare").disabled = false; }
  });
  const sshLabels = {service:"OpenSSH 服务",query_state:"服务查询结果",status:"运行状态",start_type:"启动类型",configuration_source:"配置来源",config:"配置读取",state:"读取状态",partial:"存在解析限制",reasons:"限制原因（原始代码）",directive_counts:"用户与组规则数量",auth_flags:"认证开关声明",declared_names:"配置声明的 Windows 名称",allowusers:"AllowUsers",denyusers:"DenyUsers",allowgroups:"AllowGroups",denygroups:"DenyGroups",passwordauthentication:"密码认证",pubkeyauthentication:"公钥认证",limitations:"检查范围与限制"};
  const sshValues = {ok:"已查询",not_installed:"未安装",denied:"权限不足",unavailable:"不可用",unsupported:"当前平台不支持",stopped:"已停止",running:"运行中",pending:"状态变更中",unknown:"未知",manual:"手动",automatic:"自动",disabled:"已禁用",default:"系统默认配置",customized:"自定义配置",read:"已读取",missing:"配置不存在",unsafe:"不安全路径，未读取",too_large:"配置过大，未读取",not_inspected:"未检查",yes:"yes（配置声明）",no:"no（配置声明）",unspecified:"未声明"};
  function renderSsh(target, data) {
    target.replaceChildren();
    const list = document.createElement("dl"); list.className = "status-list";
    Object.entries(data).forEach(([key, value]) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = sshLabels[key] || key;
      if (value && typeof value === "object" && !Array.isArray(value)) renderSsh(dd, value);
      else dd.textContent = Array.isArray(value) ? (value.join("、") || "无") : typeof value === "boolean" ? (value ? "是" : "否") : (sshValues[value] || String(value ?? "未知"));
      list.append(dt, dd);
    }); target.append(list);
  }
  byId("check-ssh-policy").addEventListener("click", async () => {
    const button = byId("check-ssh-policy"); button.disabled = true;
    byId("ssh-policy-result").replaceChildren();
    byId("ssh-policy-status").textContent = "正在读取 OpenSSH 状态…";
    try {
      const includeNames = byId("ssh-include-names")?.checked === true;
      const data = await request("ssh-policy", null, includeNames ? "?include_names=1" : "");
      const config = {...data.config};
      if (!includeNames || !data.names_included) delete config.declared_names;
      if (config.state !== "read") { delete config.directive_counts; delete config.auth_flags; }
      renderSsh(byId("ssh-policy-result"), {service:data.service,config,limitations:data.limitations});
      byId("ssh-policy-status").textContent = "只读检查完成。以下为服务状态与配置声明。";
    } catch (error) { byId("ssh-policy-status").textContent = error.message; }
    finally { button.disabled = false; }
  });
  function chatLine(speaker, data) {
    const line = document.createElement("div"); line.className = "chat-message";
    const title = document.createElement("strong"); title.textContent = speaker;
    const content = document.createElement("div"); show(content, data);
    line.append(title, content); byId("assistant-chat").append(line);
  }
  messageForm.addEventListener("submit", async event => {
    event.preventDefault();
    const message = messageForm.elements.message.value.trim();
    if (!message) return;
    const localNotice = /^(发布公告|替换公告)/.test(message) || message === "撤下公告";
    if (!localNotice && !messageForm.elements.consent.checked) {
      chatLine("运营助手", "非公告固定命令需要同意发送本次问题文本到模型。"); return;
    }
    const button = messageForm.querySelector("button"); button.disabled = true;
    chatLine("你", message);
    try {
      const data = await request("assistant", {message});
      chatLine("运营助手", data.result);
      if (message === "撤下公告" && data.effect === "read" && data.proposal === null && data.notice) {
        setWithdrawal(null);
        renderNotice({notice:data.notice, can_write:true}, false);
        byId("notice-feedback").textContent = "当前没有公告，旧撤下提案已取消；无需提交。";
      }
      if (data.proposal?.action === "prepare_website_notice" && messageForm.dataset.canDraft === "true") {
        setWithdrawal(null);
        renderNotice({notice:data.proposal.notice, can_write:true}, false);
        draftBaseRevision = data.proposal.notice.revision;
        websiteForm.elements.text.value = data.proposal.text;
        byId("notice-feedback").textContent = "完整草稿已填入；请核对正文，再点击确认发布。";
        byId("notice-text").focus(); byId("website").scrollIntoView({behavior:"smooth"});
      }
      if (data.proposal?.action === "prepare_website_notice_withdrawal" && messageForm.dataset.canDraft === "true") {
        renderNotice({notice:data.proposal.notice, can_write:true}, false);
        setWithdrawal(data.proposal.notice);
        byId("notice-feedback").textContent = "撤下提案已准备；网站尚未修改。请核对全文和版本后确认，或取消。";
        byId("withdraw-proposal").scrollIntoView({behavior:"smooth"});
      }
      if (data.proposal?.action === "open_cloudflare_instructions") {
        byId("refresh-cloudflare").focus(); byId("cloudflare").scrollIntoView({behavior:"smooth"});
      }
      if (data.proposal?.action === "open_website_notice_form" && !websiteForm.hidden) {
        byId("notice-text").focus(); byId("website").scrollIntoView({behavior:"smooth"});
      }
    } catch (error) { chatLine("运营助手", error.message); }
    finally { button.disabled = false; }
  });
  assistantForm.addEventListener("submit", async event => {
    event.preventDefault(); const button = assistantForm.querySelector("button"); button.disabled = true;
    byId("assistant-result").textContent = "正在检查…";
    try { const data = await request("assistant", {command:assistantForm.elements.command.value}); show(byId("assistant-result"), data.result); }
    catch (error) { byId("assistant-result").textContent = error.message; }
    finally { button.disabled = false; }
  });
  async function credentialAction(action) {
    const body = {action, slot:credentialForm.elements.slot.value};
    if (action === "set") {
      if (!credentialForm.elements.secret.value.trim()) { byId("credential-feedback").textContent = "请输入新凭据。"; return; }
      body.secret = credentialForm.elements.secret.value;
    } else if (!window.confirm("删除所选凭据后，依赖它的服务将无法连接。确认删除？")) return;
    const buttons = credentialForm.querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
    credentialForm.elements.secret.value = "";
    try { await request("credentials", body); clearCloudflare(); byId("cloudflare-status").textContent = "凭据已变更，请重新查询网站状态。"; byId("credential-feedback").textContent = action === "set" ? "凭据已保存。" : "凭据已删除。"; await refresh(); }
    catch (error) { byId("credential-feedback").textContent = error.message; }
    finally { delete body.secret; buttons.forEach(button => button.disabled = false); }
  }
  credentialForm.addEventListener("submit", event => { event.preventDefault(); credentialAction("set"); });
  byId("delete-credential").addEventListener("click", () => credentialAction("delete"));
  refresh();
  refreshNotice();
})();
