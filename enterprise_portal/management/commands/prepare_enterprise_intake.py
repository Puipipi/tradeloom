from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from workbench.intake.storage import initialize_source_root


class Command(BaseCommand):
    help = "Prepare the private workbook intake directory for the enterprise server."

    def handle(self, *args, **options):
        try:
            initialize_source_root()
        except (OSError, ValidationError) as error:
            raise CommandError("无法初始化受控的企业工作簿目录。") from error
