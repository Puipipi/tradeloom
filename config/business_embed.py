class EmbedFramePolicyMiddleware:
    """Allow only same-origin child frames in the isolated DSH Django process."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        existing = response.get("Content-Security-Policy", "")
        if "frame-src" not in existing.lower():
            response["Content-Security-Policy"] = f"{existing}; frame-src 'self'".strip("; ")
        return response
