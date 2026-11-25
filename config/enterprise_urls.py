from __future__ import annotations

from django.contrib import admin
from django.contrib.auth import views as auth_views
from django.contrib.auth.views import LogoutView
from django.urls import include, path, reverse_lazy
from django.views.generic import RedirectView

from enterprise_portal import business_workflows, views, workflow_creation, workflow_handoff
from enterprise_portal.business import read as business_read
from enterprise_portal.email_login import sign_in
from enterprise_portal.orders import order_api, order_search
from enterprise_portal.delivery_versions import download_version, preview_version, version_list


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
    path("enterprise/business/orders/", order_search, name="enterprise-orders"),
    path("enterprise/business/api/orders", order_api, name="enterprise-orders-api"),
    path("enterprise/workflow-handoff/", workflow_handoff.receive, name="enterprise-workflow-handoff-receive"),
    path("enterprise/workflows/<str:workflow_id>/handoff/", workflow_handoff.start, name="enterprise-workflow-handoff-start"),
    path("enterprise/business/batches/<str:batch_id>/create-workflow/", workflow_creation.create_from_batch,
         name="enterprise-create-from-batch"),
    path("enterprise/workflow-runs/", business_workflows.run_list, name="enterprise-workflow-runs"),
    path("enterprise/workflows/", business_workflows.workflow_list, name="enterprise-workflows"),
    path("enterprise/workflows/<str:workflow_id>/english-review/apply/",
         business_workflows.apply_workflow_english_review, name="enterprise-apply-english-review"),
    path("enterprise/workflows/<str:workflow_id>/english-review/<str:review_id>/submit/",
         business_workflows.submit_workflow_english_review, name="enterprise-submit-english-review"),
    path("enterprise/workflows/<str:workflow_id>/english-review/<str:review_id>/image/<str:task_file_id>/",
         business_workflows.preview_workflow_review_image, name="enterprise-review-image-preview"),
    path("enterprise/workflows/<str:workflow_id>/english-review/<str:review_id>/upload/",
         business_workflows.upload_workflow_review_image, name="enterprise-review-image-upload"),
    path("enterprise/workflows/<str:workflow_id>/english-review/<str:review_id>/upload/<str:upload_step_id>/",
         business_workflows.preview_workflow_review_upload, name="enterprise-review-image-upload-preview"),
    path("enterprise/workflows/<str:workflow_id>/dispatch-next/", business_workflows.dispatch_workflow_next,
         name="enterprise-dispatch-workflow-next"),
    path("enterprise/workflows/<str:workflow_id>/delivery/generate/", business_workflows.generate_workflow_delivery,
         name="enterprise-generate-workflow-delivery"),
    path("enterprise/workflows/<str:workflow_id>/complete/", business_workflows.complete_workflow_delivery,
         name="enterprise-complete-workflow-delivery"),
    path("enterprise/workflows/<str:workflow_id>/delivery/<str:step_id>/review/",
         business_workflows.review_workflow_delivery, name="enterprise-review-workflow-delivery"),
    path("enterprise/workflows/<str:workflow_id>/", business_workflows.workflow_detail, name="enterprise-workflow-detail"),
    path("enterprise/deliveries/", version_list, name="enterprise-delivery-versions"),
    path("enterprise/deliveries/<str:workflow_id>/<str:version_id>/preview", preview_version, name="enterprise-delivery-preview"),
    path("enterprise/deliveries/<str:workflow_id>/<str:version_id>/download", download_version, name="enterprise-delivery-download"),
    path("enterprise/", include("enterprise_portal.urls")),
    path("enterprise/console/", include("enterprise_portal.console_urls")),
    path("", include("enterprise_portal.local_console_urls")),
    path("api/enterprise/operations/", include("enterprise_portal.operations_urls")),
    path("enterprise/entries", views.create_entry, name="enterprise-create-entry"),
    path("api/enterprise/records", views.records_api, name="enterprise-records-api"),
    path("api/health", views.health, name="enterprise-health"),
]
