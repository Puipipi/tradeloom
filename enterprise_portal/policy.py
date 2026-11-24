"""Application authorization; never represents PostgreSQL table grants or OS ACLs."""
from django.db.models import Q
from .models import EnterpriseEntry


def is_enterprise_owner(user):
    return bool(user.is_authenticated and user.is_active and not user.groups.filter(name="工厂登记员").exists() and (
        user.is_superuser or (user.groups.filter(name="企业老板").exists()
        and user.has_perm("enterprise_portal.view_business_data")
        and user.has_perm("enterprise_portal.view_all_enterpriseentry"))))


def capability_policy(user):
    active = bool(user.is_authenticated and user.is_active)
    owner = is_enterprise_owner(user)
    registrar = active and user.groups.filter(name="工厂登记员").exists()
    ops = active and not registrar and (owner or user.has_perm("enterprise_portal.use_server_operations"))
    diagnostic_role = user.groups.filter(name="服务运维员").exists() or (
        not owner and user.has_perm("enterprise_portal.use_server_operations"))
    business_allowed = active and not registrar and not diagnostic_role
    return {
        "business_data": business_allowed and user.has_perm("enterprise_portal.view_business_data"),
        "customer_data": business_allowed and (owner or user.has_perm("workbench.view_customer")),
        "quotation_data": business_allowed and (owner or (
            user.has_perm("workbench.view_customer") and user.has_perm("workbench.view_customerevent"))),
        "records_read": active and user.has_perm("enterprise_portal.view_enterpriseentry"),
        "records_create": active and user.has_perm("enterprise_portal.add_enterpriseentry"),
        "records_all_factories": owner,
        "records_read_all_factories": owner and user.has_perm("enterprise_portal.view_enterpriseentry"),
        "records_create_all_factories": owner and user.has_perm("enterprise_portal.add_enterpriseentry"),
        "owner_tools": owner, "privileged_ai": ops, "local_workbench": owner,
        "server_ops": ops,
    }


def visible_entries(user):
    qs = EnterpriseEntry.objects.select_related("task", "created_by", "factory_group")
    caps = capability_policy(user)
    if not caps["records_read"]:
        return qs.none()
    if caps["records_all_factories"]:
        return qs
    factories = user.groups.filter(name__startswith="工厂:")
    return qs.filter(Q(created_by=user, factory_group__isnull=True) | Q(factory_group__in=factories)).distinct()


def permission_rows(user):
    """Safe effective app policy metadata, without account inventories or secrets."""
    caps = capability_policy(user)
    owner = is_enterprise_owner(user)
    definitions = [
        ("records", "工厂登记记录", "records_read", "records_create", "全部工厂登记记录" if caps["records_all_factories"] else "本人私有记录及所属工厂组记录"),
        ("business", "服务端批次与商品资料", "business_data", None, "企业数据库 Task/Product 固定字段只读；不含商品价格或个人本地工作台数据"),
        ("customer_directory", "服务端客户名录", "customer_data", None, "当前未合并客户名称与时间；不含联系方式、备注或原始来源"),
        ("quotation_records", "来源报价记录数值", "quotation_data", None, "确认客户关系及有效商业来源快照中的单价/金额/币种；非商品价目或ERP，不推算数量/价格"),
        ("factories", "其他工厂登记", "records_read_all_factories", "records_create_all_factories", "老板具备登记读取权限时可读全部工厂；具备创建权限时可向任意合法工厂新增；不代表可修改或删除现有记录"),
        ("operations", "服务状态、网站与凭据状态", "server_ops", None, "老板或显式授权技术员的只读安全诊断"),
        ("credentials", "固定凭据槽管理", "server_ops", "owner_tools", "老板可录入及删除；技术员仅看配置状态；均无秘密回读"),
        ("website_notice", "企业网站公告后台", "server_ops", "owner_tools", "老板可确认发布、替换或撤下；授权技术员仅查看；登记员只在登录网站阅读公告，无后台入口"),
        ("cloudflare", "Cloudflare 网站操作", "server_ops", "owner_tools", "仅已配置 Zone 状态；老板显式确认单资源清理，提交重新核权核站点；不含 DNS 或任意网站写入"),
        ("assistants", "服务端助手与 agent", "privileged_ai", None, "老板或显式授权技术员的运维助手；无任意命令、凭据或用户组修改"),
        ("workbench", "完整本地工作台", "local_workbench", None, "离线本地文件系统；不下发服务数据库凭据或受限数据"),
    ]
    rows = [{"key": key, "label": label, "read": bool(caps.get(read)), "write": bool(caps.get(write)),
             "scope": scope, "status": "application_policy", "group_label": "有效应用权限"}
            for key, label, read, write, scope in definitions]
    rows.extend([
        {"key": "erp_customer_prices", "label": "完整 ERP 与商品价目", "read": False, "write": False, "scope": "未接外部ERP或商品价格表；本地来源报价不代表ERP/正式售价", "status": "not_connected", "group_label": "业务边界"},
        {"key": "business_agents", "label": "业务 AI agent", "read": False, "write": False, "scope": "未接入企业业务 agent；运维助手仅允许固定诊断及打开表单建议", "status": "not_connected", "group_label": "业务边界"},
        {"key": "windows_login", "label": "Windows / SSH 登录授权", "read": False, "write": False, "scope": "由 Windows、ACL 和 OpenSSH 执行；网页不授系统登录。本机管理员可用 Manage-SshAccess.ps1 管理预配置专用组成员，成员身份不等于可登录", "status": "external_not_connected", "group_label": "外部权限边界"},
        {"key": "ssh", "label": "SSH 磁盘策略检查", "read": caps["server_ops"], "write": False, "scope": "仅查询 sshd 状态与默认配置声明；老板可显式查看声明名称，技术员仅摘要；不代表登录授权或运行时生效策略", "status": "read_only_policy", "group_label": "外部权限边界"},
        {"key": "accounts", "label": "用户账户", "read": bool(owner or (not user.groups.filter(name="工厂登记员").exists() and user.is_active and user.is_staff and user.has_perm("auth.view_user"))), "write": bool(not user.groups.filter(name="工厂登记员").exists() and user.is_active and user.is_staff and user.has_perm("auth.change_user")), "scope": "Django admin 原有逐项权限；老板角色不增加管理权限", "status": "django_admin", "group_label": "管理权限"},
        {"key": "groups", "label": "用户组", "read": bool(owner or (not user.groups.filter(name="工厂登记员").exists() and user.is_active and user.is_staff and user.has_perm("auth.view_group"))), "write": bool(not user.groups.filter(name="工厂登记员").exists() and user.is_active and user.is_staff and user.has_perm("auth.change_group")), "scope": "Django admin 原有用户组逐项权限", "status": "django_admin", "group_label": "管理权限"},
    ])
    return rows


def group_permission_projection(group):
    """Evaluate existing policy for one actual group on an ordinary active account.

    This is a contribution preview, not an authorization decision for any member.
    Staff, superuser, direct grants and other memberships are deliberately absent.
    """
    from django.contrib.auth.models import Group
    permissions = {f"{p.content_type.app_label}.{p.codename}" for p in group.permissions.all()}

    class Principal:
        is_authenticated = True
        is_active = True
        is_staff = False
        is_superuser = False
        groups = Group.objects.filter(pk=group.pk)

        def has_perm(self, permission):
            return permission in permissions

    if group.name.startswith("工厂:"):
        meaning = "工厂范围组：工厂范围身份本身只扩展所属工厂共享记录范围；显式授予的 Permission 仍另行计算，仍须具备登记读取/创建授权。"
    elif group.name in {"企业老板", "工厂登记员", "服务运维员"}:
        meaning = "固定角色：按当前实际权限声明及既有角色规则计算，名称本身不补发缺失权限。"
    else:
        meaning = "自定义组：名称没有内置企业含义；只计算实际授予的权限，不推断额外能力。"
    return {"group": group, "meaning": meaning, "permissions": sorted(permissions),
            "rows": permission_rows(Principal())}


def policy_payload(user):
    caps = capability_policy(user)
    return {"configuration_conflict": user.groups.filter(name="工厂登记员").exists() and user.groups.filter(name="企业老板").exists(), "role": "owner" if is_enterprise_owner(user) else "registrar" if user.groups.filter(name="工厂登记员").exists() else "member",
            "permissions": sorted(user.get_all_permissions()),
            "direct_permissions": sorted(user.get_user_permissions()),
            "group_permissions": sorted(user.get_group_permissions()),
            "authorization_layer": "django_application_policy_not_database_grants", "capabilities": caps,
            "permission_rows": permission_rows(user)}


def can_use_server_operations(user):
    return capability_policy(user)["server_ops"]
