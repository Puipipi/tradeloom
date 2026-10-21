from __future__ import annotations

from django.urls import path

from . import api, views, workflow_views
from .erpnext import api as erpnext_api


urlpatterns = [
    path("", views.task_list, name="task-list"),
    path("home", views.home, name="home"),
    path("products", views.products, name="products"),
    path("agent-center", views.agent_center, name="agent-center"),
    path("workflow-tasks/<str:workflow_id>", workflow_views.workflow_detail, name="workflow-detail"),
    path("artifacts", views.artifacts, name="artifacts"),
    path("runs", views.runs, name="runs"),
    path("tasks/new", views.new_task, name="new-task"),
    path("tasks/<str:task_id>", views.task_detail, name="task-detail"),
    path("agents", views.agents, name="agents"),
    path("api/health", api.health),
    path("api/erpnext/status", erpnext_api.status),
    path("api/erpnext/records", erpnext_api.records),
    path("api/erpnext/record", erpnext_api.record),
    path("api/agents", api.list_agents),
    path("api/tasks", api.tasks_collection),
    path("api/workflow-tasks", api.create_workflow_task),
    path("api/workflow-intent/preview", api.preview_workflow_intent),
    path("api/workflow-tasks/<str:workflow_id>", api.get_workflow_task),
    path(
        "api/workflow-tasks/<str:workflow_id>/task-files/<str:task_file_id>/preview",
        api.preview_workflow_task_image,
    ),
    path("api/workflow-tasks/<str:workflow_id>/deliverables", api.workflow_deliverables),
    path(
        "api/workflow-tasks/<str:workflow_id>/deliverables/<str:step_id>/takeover",
        api.take_over_workflow_generation,
    ),
    path("api/workflow-tasks/<str:workflow_id>/deliverables/<str:step_id>/review", api.review_workflow_deliverables),
    path("api/workflow-tasks/<str:workflow_id>/complete", api.complete_workflow_deliverables),
    path("api/workflow-tasks/<str:workflow_id>/artifact-versions/<str:version_id>/preview", api.preview_artifact),
    path("api/workflow-tasks/<str:workflow_id>/artifact-versions/<str:version_id>/download", api.download_artifact),
    path(
        "api/workflow-tasks/<str:workflow_id>/subtasks/<str:subtask_id>/dispatch",
        api.dispatch_workflow_subtask,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/subtasks/<str:subtask_id>/retry",
        api.retry_workflow_subtask,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/subtasks/<str:subtask_id>/interrupt",
        api.interrupt_workflow_subtask,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/reviews/<str:review_id>/submit",
        api.submit_workflow_review,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/reviews/<str:review_id>/image",
        api.upload_workflow_review_image,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/reviews/apply",
        api.apply_workflow_review_cycle,
    ),
    path("api/tasks/demo", api.create_demo_task),
    path("api/tasks/<str:task_id>", api.get_task),
    path("api/product-library", api.product_library),
    path(
        "api/products/<str:product_id>/revisions",
        api.product_revisions,
    ),
    path("api/products/<str:product_id>", api.update_product),
    path("api/tasks/<str:task_id>/confirm", api.confirm_task),
    path("api/tasks/<str:task_id>/export.csv", api.export_csv),
    path("api/tasks/<str:task_id>/runs", api.list_runs),
    path(
        "api/tasks/<str:task_id>/agents/<str:capability_id>",
        api.dispatch_agent,
    ),
    path(
        "api/tasks/<str:task_id>/agents/<str:capability_id>/runs",
        api.dispatch_agent_with_receipt,
    ),
]
