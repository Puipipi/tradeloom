from django.urls import path
from . import local_console_views

urlpatterns = [
    path("enterprise/local-console/", local_console_views.bootstrap, name="enterprise-local-console"),
    path("enterprise/local-console/redeem/", local_console_views.redeem, name="enterprise-local-console-redeem"),
]
