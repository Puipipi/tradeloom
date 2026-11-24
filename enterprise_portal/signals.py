def detect_login_change(sender, instance, raw=False, update_fields=None, **kwargs):
    instance._invalidate_email_login = False
    if raw or not instance.pk or (update_fields is not None and not {"email", "password", "is_active"}.intersection(update_fields)):
        return
    old = sender.objects.filter(pk=instance.pk).values("email", "password", "is_active").first()
    if old and any(old[field] != getattr(instance, field) for field in old):
        instance._invalidate_email_login = True


def invalidate_login_challenge(sender, instance, raw=False, **kwargs):
    if not raw and getattr(instance, "_invalidate_email_login", False):
        from .models import EmailLoginChallenge
        EmailLoginChallenge.objects.filter(user_id=instance.pk).update(code_digest="", attempts_left=0)
