from django.apps import AppConfig


class EnterprisePortalConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "enterprise_portal"
    verbose_name = "企业服务"

    def ready(self):
        from django.contrib.auth import get_user_model
        from django.db.models.signals import pre_save, post_save
        from .signals import detect_login_change, invalidate_login_challenge
        pre_save.connect(detect_login_change, sender=get_user_model(), dispatch_uid="enterprise-email-login-change-detect")
        post_save.connect(invalidate_login_challenge, sender=get_user_model(), dispatch_uid="enterprise-email-login-change")
