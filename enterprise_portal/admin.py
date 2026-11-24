from django.contrib import admin

from .models import EnterpriseEntry


@admin.register(EnterpriseEntry)
class EnterpriseEntryAdmin(admin.ModelAdmin):
    list_display = ("id", "task", "created_by", "factory_group", "created_at")
    list_filter = ("factory_group", "created_at")
    search_fields = ("body", "task__title", "created_by__username")
    readonly_fields = ("created_by", "created_at")
