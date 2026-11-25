from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.admin import UserAdmin
from django.urls import reverse
from django.utils.html import format_html

from .models import EnterpriseEntry


@admin.register(EnterpriseEntry)
class EnterpriseEntryAdmin(admin.ModelAdmin):
    list_display = ("id", "task", "created_by", "factory_group", "created_at")
    list_filter = ("factory_group", "created_at")
    search_fields = ("body", "task__title", "created_by__username")
    readonly_fields = ("created_by", "created_at")

    def has_module_permission(self, request):
        from .policy import is_enterprise_owner
        return is_enterprise_owner(request.user) and super().has_module_permission(request)

    def has_view_permission(self, request, obj=None):
        from .policy import is_enterprise_owner
        return is_enterprise_owner(request.user) and super().has_view_permission(request, obj)

    def has_add_permission(self, request):
        from .policy import is_enterprise_owner
        return is_enterprise_owner(request.user) and super().has_add_permission(request)

    def has_change_permission(self, request, obj=None):
        from .policy import is_enterprise_owner
        return is_enterprise_owner(request.user) and super().has_change_permission(request, obj)

    def has_delete_permission(self, request, obj=None):
        from .policy import is_enterprise_owner
        return is_enterprise_owner(request.user) and super().has_delete_permission(request, obj)


admin.site.unregister(get_user_model())


@admin.register(get_user_model())
class VerifiedEmailUserAdmin(UserAdmin):
    # Password-login addresses are changed through the verified binding page.
    readonly_fields = (*UserAdmin.readonly_fields, "email", "login_email_binding")


    def get_fieldsets(self, request, obj=None):
        fieldsets = super().get_fieldsets(request, obj)
        if obj is None or not request.user.is_superuser:
            return fieldsets
        return tuple(
            (title, {**options, "fields": (*options["fields"], "login_email_binding")})
            if "email" in options["fields"] else (title, options)
            for title, options in fieldsets
        )

    @admin.display(description="登录邮箱维护")
    def login_email_binding(self, _user):
        return format_html('<a href="{}">前往登录安全验证新邮箱</a>', reverse("enterprise-login-security"))
