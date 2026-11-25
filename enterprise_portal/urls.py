from django.urls import path

from . import portable_canvas, views, workbooks

urlpatterns = [
    path("workbooks/", workbooks.workbook_list, name="enterprise-workbooks"),
    path("workbooks/<uuid:import_id>/", workbooks.workbook_detail, name="enterprise-workbook-detail"),
    path("workbooks/<uuid:import_id>/download/", workbooks.workbook_download, name="enterprise-workbook-download"),
    path("capabilities/", views.capabilities, name="enterprise-capabilities"),
    path("portable-canvas/", portable_canvas.canvas_list, name="enterprise-portable-canvas"),
    path("portable-canvas/<uuid:canvas_id>/export/", portable_canvas.canvas_export, name="enterprise-portable-canvas-export"),
    path("portable-canvas/<uuid:canvas_id>/", portable_canvas.canvas_detail, name="enterprise-portable-canvas-detail"),
]
