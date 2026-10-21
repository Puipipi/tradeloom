from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.dateparse import parse_datetime

from workbench.models import AgentRun, Product, Task, TaskFile


def timestamp(value: str):
    parsed = parse_datetime(value)
    if parsed is None:
        parsed = datetime.fromisoformat(value)
    return parsed


class Command(BaseCommand):
    help = "显式一次性导入旧 workbench SQLite；源库只读且不会自动执行"

    def add_arguments(self, parser):
        parser.add_argument(
            "--path",
            required=True,
            help="旧 workbench.db 路径",
        )

    def handle(self, *args, **options):
        source = Path(options["path"]).resolve()
        if not source.is_file():
            raise CommandError(f"旧库不存在：{source}")
        uri = source.as_uri() + "?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        connection.row_factory = sqlite3.Row
        stats = {
            "tasks": {"created": 0, "skipped": 0},
            "files": {"created": 0, "skipped": 0},
            "products": {"created": 0, "skipped": 0},
            "agent_runs": {"created": 0, "skipped": 0},
        }
        try:
            with transaction.atomic():
                for row in connection.execute("SELECT * FROM tasks"):
                    _, created = Task.objects.get_or_create(
                        id=row["id"],
                        defaults={
                            "title": row["title"],
                            "mode": row["mode"],
                            "status": row["status"],
                            "created_at": timestamp(row["created_at"]),
                            "updated_at": timestamp(row["updated_at"]),
                        },
                    )
                    key = "created" if created else "skipped"
                    stats["tasks"][key] += 1
                for row in connection.execute("SELECT * FROM files"):
                    _, created = TaskFile.objects.get_or_create(
                        id=row["id"],
                        defaults={
                            "task_id": row["task_id"],
                            "kind": row["kind"],
                            "original_name": row["original_name"],
                            "stored_name": row["stored_name"],
                            "created_at": timestamp(row["created_at"]),
                        },
                    )
                    key = "created" if created else "skipped"
                    stats["files"][key] += 1
                for row in connection.execute("SELECT * FROM products"):
                    _, created = Product.objects.get_or_create(
                        id=row["id"],
                        defaults={
                            "task_id": row["task_id"],
                            "position": row["position"],
                            "sku": row["sku"],
                            "name": row["name"],
                            "category": row["category"],
                            "material": row["material"],
                            "size": row["size"],
                            "color": row["color"],
                            "image_filename": row["image_filename"],
                            "image_stored_name": row["image_stored_name"] or "",
                            "missing_fields": json.loads(row["missing_fields"]),
                            "created_at": timestamp(row["created_at"]),
                            "updated_at": timestamp(row["updated_at"]),
                        },
                    )
                    key = "created" if created else "skipped"
                    stats["products"][key] += 1
                for row in connection.execute("SELECT * FROM agent_runs"):
                    _, created = AgentRun.objects.get_or_create(
                        run_id=row["run_id"],
                        defaults={
                            "task_id": row["task_id"],
                            "capability_id": row["capability_id"],
                            "status": row["status"],
                            "started_at": timestamp(row["started_at"]),
                            "finished_at": (
                                timestamp(row["finished_at"])
                                if row["finished_at"]
                                else None
                            ),
                            "result": (
                                json.loads(row["result"])
                                if row["result"]
                                else None
                            ),
                            "error": row["error"],
                        },
                    )
                    key = "created" if created else "skipped"
                    stats["agent_runs"][key] += 1
        finally:
            connection.close()
        self.stdout.write(json.dumps(stats, ensure_ascii=False, sort_keys=True))
        self.stdout.write(self.style.SUCCESS(f"已导入旧库：{source}"))
