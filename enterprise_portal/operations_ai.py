"""Optional intent classification; provider text never becomes an operation or UI text."""
import json
import ssl
from urllib import request, error

from . import operations
from .operations_store import StoreUnavailable

ENDPOINT = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
ACTIONS = (*operations.COMMANDS, "open_website_notice_form")
SYSTEM = ('Classify the user message. Return only a JSON object with the single key "action". '
          'Allowed actions: ' + ', '.join(ACTIONS) + '. For publish, replace or clear a website notice, '
          'choose open_website_notice_form. Never execute writes. For unsupported requests return {"action":"unsupported"}.')


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def classify(message, key):
    body = json.dumps({"model": MODEL, "messages": [
        {"role": "system", "content": SYSTEM}, {"role": "user", "content": message}],
        "response_format": {"type": "json_object"}, "thinking": {"type": "disabled"},
        "max_tokens": 60, "stream": False}).encode()
    req = request.Request(ENDPOINT, data=body, headers={"Authorization": "Bearer " + key,
                                                      "Content-Type": "application/json"})
    opener = request.build_opener(NoRedirect(), request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(req, timeout=8) as response:
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError("Provider response too large")
    content = json.loads(raw)["choices"][0]["message"]["content"]
    choice = json.loads(content)
    if not isinstance(choice, dict) or set(choice) != {"action"} or choice["action"] not in ACTIONS:
        raise ValueError("Unsupported intent")
    return choice["action"]


def route(message, user, *, consent=False):
    if not operations.can_operate(user):
        raise PermissionError("Operations permission required")
    if not isinstance(message, str):
        raise ValueError("Invalid message")
    message = message.strip()
    if message == "撤下公告":
        from .policy import is_enterprise_owner
        from .website_notice import current
        if not is_enterprise_owner(user):
            raise PermissionError("Owner required for notice withdrawal")
        notice = current()
        if not notice["text"]:
            return {"result": {"detail": "当前没有公告，无需撤下。"}, "effect": "read", "proposal": None, "notice": notice}
        return {"result": {"detail": "已准备撤下提案；请核对当前公告全文和版本，再明确确认。尚未修改网站，未调用模型。"},
                "effect": "proposal", "proposal": {"action": "prepare_website_notice_withdrawal", "notice": notice}}
    for prefix in ("发布公告", "替换公告"):
        if message.startswith(prefix):
            from .policy import is_enterprise_owner
            from .website_notice import current
            if not is_enterprise_owner(user):
                raise PermissionError("Owner required for notice drafts")
            text = message[len(prefix):].lstrip(" \t\r\n:：").strip()
            if not 1 <= len(text) <= 500 or any(ord(c) < 32 and c not in "\r\n\t" for c in text):
                raise ValueError("Notice text must contain 1 to 500 plain-text characters")
            return {"result": {"detail": "已准备完整公告草稿；请核对正文并在公告表单明确确认发布。正文仅在本应用处理，未发送模型。"},
                    "effect": "proposal", "proposal": {"action": "prepare_website_notice", "text": text, "notice": current()}}
    if "登记员" in message:
        return {"result": {"detail": "登记员命令请通过当前助手的账号状态控件提交；未调用模型。"},
                "effect": "unavailable", "proposal": None}
    if not 1 <= len(message) <= 500:
        raise ValueError("Invalid message")
    unavailable = {"result": {"detail": "自然语言助手暂不可用，请使用固定诊断命令。"},
                   "effect": "unavailable", "proposal": None}
    if consent is not True:
        return {"result": {"detail": "尚未同意外发本次问题；未调用模型。请勾选同意，或使用本地登记员命令/手动检查。"},
                "effect": "consent_required", "proposal": None}
    try:
        store = operations.vault()
        if not store.metadata()["deepseek_api_key"]["configured"]:
            return unavailable
        action = classify(message.strip(), store._read_for_provider("deepseek_api_key"))
    except (StoreUnavailable, OSError, ValueError, KeyError, IndexError, TypeError, error.URLError):
        return unavailable
    if action == "open_website_notice_form":
        from .policy import is_enterprise_owner
        if not is_enterprise_owner(user):
            return {"result": {"detail": "仅企业老板可确认公告变更。"}, "effect": "unavailable", "proposal": None}
        return {"result": {"detail": "请打开公告表单，核对内容后明确确认发布或撤下。"},
                "effect": "proposal", "proposal": {"action": action}}
    return {"result": operations.execute(action, user), "command": action, "effect": "read", "proposal": None}
