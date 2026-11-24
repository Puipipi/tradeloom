from django.urls import path

from .console_views import console
from .registrar_setup import setup

urlpatterns = [path("", console, name="enterprise-console"), path("registrars/", setup, name="enterprise-registrar-setup")]
