"""Import a structural copy of a desktop v1 workflow into the enterprise portal."""

import json
import math
import re

from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db.models import F
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.utils import timezone
from django.views.decorators.cache import never_cache
from django.views.decorators.http import require_GET, require_http_methods

from .models import PortableCanvas
from .policy import can_view_business_workflows

MAX_FILE_SIZE = 2 * 1024 * 1024
KINDS = {"input": "输入", "agent": "助手", "review": "人工确认", "external": "外部步骤", "output": "输出"}
IDENTIFIER = re.compile(r"[a-z0-9][a-z0-9_-]{0,47}")
# ECMAScript String.trim whitespace, also used by the desktop schema.
DESKTOP_WHITESPACE = "\t\n\v\f\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
LABEL_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")
POSITION_LIMIT = 100_000
DRAFT_KINDS = {kind: KINDS[kind] for kind in ("input", "review", "output")}
MAX_NODES = 40
MAX_EDGES = 80


def display_label(value, limit):
    # Desktop validates the original UTF-16 length, then trims the stored label.
    # The portal uses single-line input fields, so reject embedded controls.
    if not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > limit:
        raise ValueError
    trimmed = value.strip(DESKTOP_WHITESPACE)
    if not trimmed or LABEL_CONTROLS.search(trimmed):
        raise ValueError
    return trimmed


def project(document):
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 1:
        raise ValueError
    if not isinstance(document.get("id"), str) or not IDENTIFIER.fullmatch(document["id"]):
        raise ValueError
    source_nodes, source_edges = document.get("nodes"), document.get("edges")
    if not isinstance(source_nodes, list) or not 1 <= len(source_nodes) <= MAX_NODES:
        raise ValueError
    if not isinstance(source_edges, list) or len(source_edges) > MAX_EDGES:
        raise ValueError
    nodes, ids = [], {}
    for source in source_nodes:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str) or not IDENTIFIER.fullmatch(source["id"]):
            raise ValueError
        identifier, kind = source["id"], source.get("kind")
        if identifier in ids or not isinstance(kind, str) or kind not in KINDS:
            raise ValueError
        ids[identifier] = len(nodes)
        position = source.get("position")
        node = {"kind": kind, "title": display_label(source.get("title"), 80)}
        if position is not None:
            if not isinstance(position, dict):
                raise ValueError
            for axis in ("x", "y"):
                coordinate = position.get(axis)
                if type(coordinate) not in (int, float) or not -POSITION_LIMIT <= coordinate <= POSITION_LIMIT:
                    raise ValueError
                node[axis] = math.floor(coordinate + 0.5)
        nodes.append(node)

    edges, inbound = set(), [set() for _ in nodes]
    for edge in source_edges:
        if not isinstance(edge, dict):
            raise ValueError
        sender, receiver = edge.get("from"), edge.get("to")
        if not isinstance(sender, str) or not isinstance(receiver, str) or sender not in ids or receiver not in ids:
            raise ValueError
        start, end = ids[sender], ids[receiver]
        if start == end or (start, end) in edges:
            raise ValueError
        edges.add((start, end))
        inbound[end].add(start)

    depth, rows = {}, {}
    while len(depth) < len(nodes):
        ready = [index for index, dependencies in enumerate(inbound)
                 if index not in depth and dependencies.issubset(depth)]
        if not ready:
            raise ValueError
        for index in ready:
            column = max((depth[parent] + 1 for parent in inbound[index]), default=0)
            depth[index] = column
            node = nodes[index]
            if "x" not in node:
                row = rows.get(column, 0)
                node.update(x=40 + column * 240, y=40 + row * 130)
                rows[column] = row + 1
    return display_label(document.get("title"), 100), {"nodes": nodes, "edges": sorted(edges)}


def portal_guard(user):
    if not can_view_business_workflows(user):
        raise PermissionDenied


@login_required
@require_http_methods(["GET", "POST"])
@never_cache
def canvas_list(request):
    portal_guard(request.user)
    error = None
    if request.method == "POST":
        upload = request.FILES.get("definition")
        if upload is None or upload.size > MAX_FILE_SIZE:
            error = "请选择不超过 2 MB 的桌面工作流 JSON 文件。"
        else:
            try:
                title, graph = project(json.loads(upload.read().decode("utf-8-sig")))
            except (ValueError, RecursionError):
                error = "无法导入。请检查桌面工作流格式、节点连线和标题。标题须为非空单行文本。"
            else:
                canvas = PortableCanvas.objects.create(owner=request.user, title=title, graph=graph)
                return redirect("enterprise-portable-canvas-detail", canvas_id=canvas.pk)
    objects = PortableCanvas.objects.filter(owner=request.user).only("title").order_by("-updated_at", "id")
    page = Paginator(objects, 30).get_page(request.GET.get("page"))
    return render(request, "enterprise_portal/portable_canvas.html", {"page": page, "error": error},
                  status=400 if error else 200)



def structural_document(identifier, title, nodes, edges):
    """Build the v1 structural fields. Export requires every kind to be portable."""
    return {
        "version": 1, "id": identifier, "title": title, "source": "manual", "confirmed": False,
        "nodes": [
            {"id": f"node-{index}", "kind": node["kind"], "title": node["title"],
             "position": {"x": node["x"], "y": node["y"]}}
            for index, node in enumerate(nodes)
        ],
        "edges": [{"from": f"node-{start}", "to": f"node-{end}"} for start, end in edges],
    }


def node_index(value, length):
    if not re.fullmatch(r"[0-9]{1,2}", value):
        raise ValueError
    result = int(value)
    if result >= length:
        raise ValueError
    return result


def coordinate(value):
    if not re.fullmatch(r"-?[0-9]{1,6}", value):
        raise ValueError
    result = int(value)
    if abs(result) > POSITION_LIMIT:
        raise ValueError
    return result


def edit_graph(canvas, form):
    title = display_label(form.get("title"), 100)
    nodes = [
        {**node, "title": display_label(form.get(f"node_{index}"), 80),
         **{axis: coordinate(form.get(f"{axis}_{index}", str(node[axis]))) for axis in ("x", "y")}}
        for index, node in enumerate(canvas.graph["nodes"])
    ]
    edges = [tuple(edge) for edge in canvas.graph["edges"]]
    action, *args = form.get("operation", "save").split(":")
    if action == "add-node" and not args:
        kind = form.get("new_kind")
        if kind not in DRAFT_KINDS or len(nodes) >= MAX_NODES:
            raise ValueError
        last = nodes[-1]
        y = last["y"] + 80 if last["y"] <= POSITION_LIMIT - 80 else last["y"] - 80
        nodes.append({"kind": kind, "title": display_label(form.get("new_title"), 80), "x": last["x"], "y": y})
    elif action == "remove-node" and len(args) == 1 and len(nodes) > 1:
        index = node_index(args[0], len(nodes))
        nodes.pop(index)
        edges = [(start - (start > index), end - (end > index))
                 for start, end in edges if index not in (start, end)]
    elif action == "add-edge" and not args:
        edges.append((node_index(form.get("edge_from", ""), len(nodes)),
                      node_index(form.get("edge_to", ""), len(nodes))))
    elif action == "remove-edge" and len(args) == 2:
        edges.remove(tuple(node_index(value, len(nodes)) for value in args))
    elif action != "save" or args:
        raise ValueError
    return project(structural_document("portable", title, nodes, edges))


@login_required
@require_GET
@never_cache
def canvas_export(request, canvas_id):
    portal_guard(request.user)
    canvas = get_object_or_404(PortableCanvas, owner=request.user, pk=canvas_id)
    if any(node["kind"] not in DRAFT_KINDS for node in canvas.graph["nodes"]):
        raise Http404
    identifier = f"mobile-{canvas.pk.hex}"
    response = JsonResponse(structural_document(identifier, canvas.title, canvas.graph["nodes"], canvas.graph["edges"]))
    response["Content-Disposition"] = f'attachment; filename="{identifier}.json"'
    return response


@login_required
@require_http_methods(["GET", "POST"])
@never_cache
def canvas_detail(request, canvas_id):
    portal_guard(request.user)
    objects = PortableCanvas.objects.filter(owner=request.user)
    canvas = get_object_or_404(objects, pk=canvas_id)
    error, status = None, 200
    if request.method == "POST":
        if request.POST.get("revision") != str(canvas.revision):
            return render_canvas(request, canvas, "工作流已在其他页面更新。请在当前版本上重新编辑。", 409)
        try:
            title, graph = edit_graph(canvas, request.POST)
        except ValueError:
            return render_canvas(request, canvas,
                                 "未保存。请检查名称、坐标和连线。至少保留一个节点，连线不可重复或成环。", 400)
        updated = objects.filter(pk=canvas.pk, revision=canvas.revision).update(
            title=title, graph=graph, revision=F("revision") + 1, updated_at=timezone.now()
        )
        if updated:
            return redirect("enterprise-portable-canvas-detail", canvas_id=canvas.pk)
        canvas.refresh_from_db()
        error, status = "工作流已在其他页面更新。请在当前版本上重新编辑。", 409
    return render_canvas(request, canvas, error, status)


def render_canvas(request, canvas, error, status):
    nodes = [{**node, "number": index + 1, "type_label": KINDS[node["kind"]], "parents": []}
             for index, node in enumerate(canvas.graph["nodes"])]
    for start, end in canvas.graph["edges"]:
        nodes[end]["parents"].append(start + 1)
    edges = [{"start": start, "end": end, "start_number": start + 1, "end_number": end + 1}
             for start, end in canvas.graph["edges"]]
    return render(request, "enterprise_portal/portable_canvas.html", {
        "canvas": canvas, "nodes": nodes, "error": error, "edges": edges,
        "draft_kinds": DRAFT_KINDS, "can_add_node": len(nodes) < MAX_NODES,
        "can_add_edge": len(nodes) > 1 and len(edges) < MAX_EDGES,
        "can_export": all(node["kind"] in DRAFT_KINDS for node in nodes),
    }, status=status)
