from django.urls import path

from .console_views import console
from .registrar_setup import setup
from .login_security import settings_page

urlpatterns = [path("", console, name="enterprise-console"), path("registrars/", setup, name="enterprise-registrar-setup"), path("login-security/", settings_page, name="enterprise-login-security")]
