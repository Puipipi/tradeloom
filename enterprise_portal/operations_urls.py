from django.urls import path
from . import operations_views as views

urlpatterns = [
    path("ssh-policy/", views.ssh_policy, name="enterprise-operations-ssh-policy"),
    path("cloudflare/", views.cloudflare, name="enterprise-operations-cloudflare"),
    path("website/", views.website, name="enterprise-operations-website"),
    path("status/", views.status, name="enterprise-operations-status"),
    path("assistant/", views.assistant, name="enterprise-operations-assistant"),
    path("credentials/", views.credentials, name="enterprise-operations-credentials"),
]
