from __future__ import annotations

from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.contrib.auth.views import LogoutView
from django.urls import include, path, reverse_lazy
from django.views.generic import RedirectView

from enterprise_portal import views
from enterprise_portal.business import read as business_read
from enterprise_portal.email_login import sign_in


def admin_login(request, extra_context=None):
    # AdminSite must never mint a password-only session through its own LoginView.
    from django.shortcuts import redirect
    from urllib.parse import urlencode
    return redirect("/accounts/login/?" + urlencode({"next": "/admin/"}))


admin.site.login = admin_login


urlpatterns = [
    path("", RedirectView.as_view(url=reverse_lazy("enterprise-home"), permanent=False)),
    path("accounts/login/", sign_in, name="login"),
    path("accounts/logout/", LogoutView.as_view(next_page=reverse_lazy("login")), name="logout"),
    path("admin/", admin.site.urls),
    path("enterprise/", views.home, name="enterprise-home"),
    path("enterprise/business/products/", business_read, {"kind": "products"}, name="enterprise-products"),
    path("enterprise/business/customers/", business_read, {"kind": "customers"}, name="enterprise-customers"),
    path("enterprise/business/quotations/", business_read, {"kind": "quotations"}, name="enterprise-quotations"),
    path("enterprise/", include("enterprise_portal.urls")),
    path("enterprise/console/", include("enterprise_portal.console_urls")),
    path("", include("enterprise_portal.local_console_urls")),
    path("api/enterprise/operations/", include("enterprise_portal.operations_urls")),
    path("enterprise/entries", views.create_entry, name="enterprise-create-entry"),
    path("api/enterprise/records", views.records_api, name="enterprise-records-api"),
    path("api/health", views.health, name="enterprise-health"),
]
