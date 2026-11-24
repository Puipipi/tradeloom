from __future__ import annotations

from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.contrib.auth.views import LogoutView
from django.urls import include, path, reverse_lazy
from django.views.generic import RedirectView

from enterprise_portal import views


urlpatterns = [
    path("", RedirectView.as_view(url=reverse_lazy("enterprise-home"), permanent=False)),
    path("accounts/login/", auth_views.LoginView.as_view(template_name="enterprise_portal/login.html"), name="login"),
    path("accounts/logout/", LogoutView.as_view(next_page=reverse_lazy("login")), name="logout"),
    path("admin/", admin.site.urls),
    path("enterprise/", views.home, name="enterprise-home"),
    path("enterprise/entries", views.create_entry, name="enterprise-create-entry"),
    path("api/enterprise/records", views.records_api, name="enterprise-records-api"),
    path("api/health", views.health, name="enterprise-health"),
]
