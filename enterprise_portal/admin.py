from django.contrib import admin

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
