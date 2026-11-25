import os
from django.core.management.base import BaseCommand, CommandError
from enterprise_portal import local_console


class Command(BaseCommand):
    help = "Explicitly enable or open the Windows-account-bound local HTTP technician console."

    def add_arguments(self, parser):
        parser.add_argument("action", choices=["enable", "open"])

    def handle(self, *args, **options):
        try:
            if options["action"] == "enable":
                local_console.enable()
                self.stdout.write("本机技术员入口已启用，仅限当前安装账户。")
            else:
                token, port = local_console.issue()
                # ShellExecute receives the fragment directly; never stdout or subprocess argv.
                os.startfile(f"http://127.0.0.1:{port}/enterprise/local-console/#{token}")
                self.stdout.write("已打开本机控制台，授权将在一分钟内失效。")
        except Exception as exc:
            # Never stringify arbitrary exceptions from identity/DB operations.
            raise CommandError("本机入口不可用，请使用正常登录并检查安装账户、HTTP模式及显式启用状态。") from None
