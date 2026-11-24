"""Already-verified sessions for authorization fixtures; MFA tests use plain Client."""
from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from .email_login import VERIFIED, fingerprint


class EmailVerifiedClient(Client):
    def _mark_verified_fixture(self):
        session = self.session
        if session.get("_auth_user_id"):
            user = get_user_model().objects.get(pk=session["_auth_user_id"])
            session[VERIFIED] = fingerprint(user)
            session.save()

    def login(self, **credentials):
        result = super().login(**credentials)
        if result:
            self._mark_verified_fixture()
        return result

    def force_login(self, user, backend=None):
        super().force_login(user, backend)
        self._mark_verified_fixture()


class EmailVerifiedTestCase(TestCase):
    client_class = EmailVerifiedClient

    def setUp(self):
        super().setUp()
        # --keepdb plus TransactionTestCase flush can remove migration seed rows.
        from .models import WebsiteNotice
        WebsiteNotice.objects.get_or_create(pk=1)
