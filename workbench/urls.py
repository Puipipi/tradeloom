from __future__ import annotations

from django.urls import path

from . import api, views, workflow_views
from .customers import api as customer_api
from .customers import views as customer_views
from .erpnext import api as erpnext_api
from .intake import api as intake_api
from .requirements import api as requirement_api
from .execution_plans import api as execution_plan_api
from . import canvas_workflow_api, native_artifact_api


urlpatterns = [
    path("api/native-artifacts", native_artifact_api.register),
    path("api/native-artifacts/<uuid:run_id>/<uuid:version_id>/<str:action>", native_artifact_api.read),
    path("api/canvas-workflow-runs", canvas_workflow_api.runs),
    path("", views.task_list, name="task-list"),
    path("home", views.home, name="home"),
    path("products", views.products, name="products"),
    path("customers", customer_views.customer_list, name="customer-list"),
    path("customers/<str:customer_id>", customer_views.customer_detail, name="customer-detail"),
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
    path("api/erpnext/quotation-drafts", erpnext_api.quotation_drafts),
    path("api/erpnext/quotation-drafts/<str:operation_id>", erpnext_api.quotation_draft_operation),
    path("api/intake/sources", intake_api.source_collection),
    path("api/intake/narratives", intake_api.narrative_collection),
    path("api/intake/narratives/<str:narrative_id>/lines", intake_api.narrative_lines),
    path("api/intake/narratives/<str:narrative_id>/annotations", intake_api.narrative_annotations),
    path("api/intake/sources/<str:source_id>/previews", intake_api.create_preview),
    path("api/intake/sources/<str:source_id>/download", intake_api.download_source),
    path("api/intake/images/<str:image_id>/preview", intake_api.image_preview),
    path("api/intake/previews/<str:snapshot_id>", intake_api.preview),
    path("api/intake/previews/<str:snapshot_id>/mappings", intake_api.create_mapping),
    path("api/intake/mappings/<str:mapping_id>/candidates", intake_api.create_candidate),
    path("api/intake/candidates", intake_api.candidates),
    path("api/intake/candidates/<str:candidate_id>", intake_api.candidate),
    path("api/intake/candidates/<str:candidate_id>/apply", intake_api.apply_product_candidate),
    path("api/intake/candidates/<str:candidate_id>/links", intake_api.create_candidate_link),
    path("api/intake/candidates/<str:candidate_id>/evidence", intake_api.evidence_collection),
    path("api/intake/candidates/<str:candidate_id>/requirement-drafts", requirement_api.create_requirement_draft),
    path("api/production-requirements/<str:requirement_id>", requirement_api.production_requirement_detail),
    path("api/production-requirements/<str:requirement_id>/revisions", requirement_api.create_requirement_revision),
    path("api/production-requirements/<str:requirement_id>/confirm", requirement_api.confirm_requirement),
    path("api/production-requirements/<str:requirement_id>/execution-plan-revisions", execution_plan_api.plan_revision_collection),
    path("api/execution-plans/<str:plan_revision_id>", execution_plan_api.execution_plan_detail),
    path("api/agents", api.list_agents),
    path("api/customers", customer_api.customer_collection),
    path("api/customers/<str:customer_id>", customer_api.customer_detail),
    path("api/customers/<str:customer_id>/analysis", customer_api.customer_analysis),
    path("api/customers/<str:customer_id>/backtest", customer_api.customer_backtest),
    path("api/customers/<str:customer_id>/reconcile", customer_api.customer_reconcile),
    path("api/customers/<str:customer_id>/evaluate", customer_api.evaluate_customer),
    path("api/customers/<str:customer_id>/merge", customer_api.customer_merge),
    path("api/customer-events/from-candidate", customer_api.event_from_candidate),
    path("api/customer-aliases/<str:alias_id>/decision", customer_api.alias_decision),
    path("api/customer-aliases/<str:alias_id>/reassign", customer_api.alias_reassignment),
    path("api/customer-actions/<str:action_id>/decision", customer_api.action_decision),
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
        "api/workflow-tasks/<str:workflow_id>/subtasks/<str:subtask_id>/native-assignment",
        api.begin_native_workflow_assignment,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/native-assignments/<str:assignment_id>/submit",
        api.submit_native_workflow_assignment,
    ),
    path(
        "api/workflow-tasks/<str:workflow_id>/native-assignments/<str:assignment_id>/bind",
        api.bind_native_workflow_assignment,
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
