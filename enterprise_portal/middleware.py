from django.http import HttpResponseForbidden

class EnterpriseRoleBoundaryMiddleware:
    """Deny factory registrar admin access even with accidental staff/direct grants."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        user = request.user
        if (request.path.startswith("/admin/") and user.is_authenticated
                and user.groups.filter(name="工厂登记员").exists()):
            return HttpResponseForbidden("工厂登记员不能访问账号、权限或管理后台。")
        return self.get_response(request)
