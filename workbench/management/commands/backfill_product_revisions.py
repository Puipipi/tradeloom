from __future__ import annotations

from django.core.management.base import BaseCommand

from workbench.products.versions import backfill_legacy_product_revisions


class Command(BaseCommand):
    help = "为没有版本的 legacy Product 创建 v1 ProductRevision。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只报告计划创建数量，不写数据库。",
        )

    def handle(self, *args, **options):
        report = backfill_legacy_product_revisions(dry_run=options["dry_run"])
        mode = "dry-run" if report.dry_run else "applied"
        statuses = ",".join(
            f"{status}:{count}" for status, count in sorted(report.by_status.items())
        )
        self.stdout.write(
            f"{mode} scanned={report.scanned} created={report.created} "
            f"skipped={report.skipped} by_status={statuses}"
        )
