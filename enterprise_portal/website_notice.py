from django.db.models import F
from django.utils import timezone
from .models import WebsiteNotice


def current():
    notice = WebsiteNotice.objects.get(pk=1)
    return {"text": notice.text, "revision": notice.revision,
            "updated_at": notice.updated_at.isoformat() if notice.updated_at else None}


def replace(text, revision):
    if not isinstance(text, str) or len(text) > 500 or type(revision) is not int or revision < 0:
        raise ValueError("Invalid notice")
    # Compare-and-swap in one SQL statement: stale writers cannot overwrite a newer notice.
    return WebsiteNotice.objects.filter(pk=1, revision=revision).update(
        text=text.strip(), revision=F("revision") + 1, updated_at=timezone.now()) == 1
