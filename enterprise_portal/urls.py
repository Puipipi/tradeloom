from django.urls import path
from . import views

urlpatterns = [path("capabilities/", views.capabilities, name="enterprise-capabilities")]
