from __future__ import annotations

from django.urls import path

from . import api, views, workflow_views
from .customers import api as customer_api
from .customers import views as customer_views
from .erpnext import api as erpnext_api
from .intake import api as intake_api
from .requirements import api as requirement_api
from .execution_plans import api as execution_plan_api
from .procurement import api as procurement_api
from .materials import api as material_api
from .sku import api as sku_api
from . import canvas_workflow_api, native_artifact_api, dispatch_api, canvas_workflow_definition_api
from . import orders_api


urlpatterns = [
    path("api/native-artifacts", native_artifact_api.register),
    path("api/native-artifacts/<uuid:run_id>/<uuid:version_id>/<str:action>", native_artifact_api.read),
    path("api/canvas-workflow-runs", canvas_workflow_api.runs),
    path("api/canvas-workflow-definitions", canvas_workflow_definition_api.definitions),
    path("api/dispatches", dispatch_api.create_dispatch),
    path("api/dispatches/inbox", dispatch_api.list_dispatches),
    path("api/dispatches/<str:dispatch_id>/claim", dispatch_api.claim_dispatch),
    path("api/dispatches/<str:dispatch_id>/receipt", dispatch_api.receipt_dispatch),
    path("", views.task_list, name="task-list"),
    path("home", views.home, name="home"),
    path("products", views.products, name="products"),
    path("orders", views.orders, name="orders"),
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
    path("api/orders", orders_api.order_followup),
    path("api/erpnext/status", erpnext_api.status),
    path("api/erpnext/records", erpnext_api.records),
    path("api/erpnext/record", erpnext_api.record),
    path("api/erpnext/quotation-drafts", erpnext_api.quotation_drafts),
    path("api/erpnext/quotation-drafts/<str:operation_id>", erpnext_api.quotation_draft_operation),
    path("api/materials/status", material_api.status),
    path("api/materials/items", material_api.items),
    path("api/materials/items/<str:item_code>/update", material_api.item_update),
    path("api/materials/check", material_api.check),
    # ── SKU 成本台账 ────────────────────────────────────────────────────────
    # 读整份状态（含 144 行核算结果、期间费用、关税缺口），写接口各自回同一份 state，
    # 前端据此局部刷新而不整页 reload。
    path("api/sku", sku_api.library),
    path("api/sku/rows", sku_api.rows_update),
    path("api/sku/import", sku_api.import_csv),
    path("api/sku/export.csv", sku_api.export_csv),
    path("api/sku/catalog/import", sku_api.catalog_import),
    path("api/sku/catalog/push", sku_api.catalog_push),
    path("api/sku/catalog/template.csv", sku_api.catalog_template),
    path("api/sku/settings", sku_api.settings_update),
    path("api/sku/fx", sku_api.fx_rates),
    path("api/sku/duty", sku_api.duty_rates),
    path("api/sku/duty/lookup", sku_api.duty_lookup),
    path("api/sku/hs-bulk", sku_api.hs_bulk),
    path("api/sku/period", sku_api.period_cost),
    path("api/sku/advice", sku_api.advice),
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
    path("api/intake/candidates/<str:candidate_id>/apply-material", material_api.apply_material),
    path("api/intake/candidates/<str:candidate_id>/requirement-lines", requirement_api.apply_requirement_lines_view),
    path("api/intake/candidates/<str:candidate_id>/links", intake_api.create_candidate_link),
    path("api/intake/candidates/<str:candidate_id>/evidence", intake_api.evidence_collection),
    path("api/intake/candidates/<str:candidate_id>/requirement-drafts", requirement_api.create_requirement_draft),
    path("api/production-requirements/<str:requirement_id>", requirement_api.production_requirement_detail),
    path("api/production-requirements/<str:requirement_id>/revisions", requirement_api.create_requirement_revision),
    path("api/production-requirements/<str:requirement_id>/confirm", requirement_api.confirm_requirement),
    path("api/production-requirements/<str:requirement_id>/execution-plan-revisions", execution_plan_api.plan_revision_collection),
    path("api/execution-plans/<str:plan_revision_id>", execution_plan_api.execution_plan_detail),
    path("api/execution-plans/<str:plan_revision_id>/resolve-materials", execution_plan_api.resolve_execution_plan_materials),
    path("api/intake/candidates/<str:candidate_id>/documents", procurement_api.apply_documents_view),
    path("api/documents/<str:doc_type>", procurement_api.list_documents_view),
    path("api/documents/<str:doc_type>/<str:document_id>/confirm", procurement_api.confirm_document_view),
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
    path("api/tasks/demo", api.create_demo_task),
    path("api/tasks/<str:task_id>", api.get_task),
    path("api/batch-items/<str:item_id>", api.update_batch_item),
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
