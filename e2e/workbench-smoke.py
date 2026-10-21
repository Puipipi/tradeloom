from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "data" / "runtime"
CSV_PATH = RUNTIME / "e2e-export.csv"
SCREENSHOT = RUNTIME / "workbench-preview.png"
BASE = os.environ.get("TRADELOOM_URL", "http://127.0.0.1:8000")


def main() -> None:
    RUNTIME.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            locale="zh-CN",
            viewport={"width": 1440, "height": 1000},
            accept_downloads=True,
        )
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(f"{BASE}/tasks/new", wait_until="domcontentloaded")
            page.get_by_test_id("load-demo").click()
            page.wait_for_url(re.compile(r".*/tasks/[0-9a-f]{32}$"))
            task_id = page.url.rstrip("/").split("/")[-1]
            page.get_by_test_id("task-detail").wait_for()

            page.get_by_test_id("nav-agents").click()
            page.get_by_test_id("agent-map").wait_for()
            page.get_by_test_id("agent-task-select").select_option(task_id)
            page.wait_for_url(f"**/agents?task={task_id}")
            page.get_by_test_id("run-agent-product_profile").click()
            page.get_by_test_id("agent-result").wait_for()
            assert page.get_by_test_id("result-pending").inner_text() == "1"
            page.get_by_test_id("agent-run-row").first.wait_for()
            page.reload(wait_until="domcontentloaded")
            assert page.get_by_test_id("agent-task-select").input_value() == task_id

            page.goto(f"{BASE}/tasks/{task_id}", wait_until="domcontentloaded")
            page.get_by_test_id("edit-DEMO-002").click()
            card = page.get_by_test_id("product-DEMO-002")
            card.get_by_test_id("material-input").fill("缎面织物")
            card.get_by_test_id("save-product").click()
            page.get_by_test_id("product-DEMO-002").get_by_text("资料齐全").wait_for()
            page.get_by_test_id("confirm-task").click()
            page.get_by_text("confirmed", exact=True).first.wait_for()

            with page.expect_download() as download_info:
                page.get_by_test_id("export-csv").click()
            download_info.value.save_as(CSV_PATH)
            csv = CSV_PATH.read_text(encoding="utf-8")
            assert csv.splitlines()[0] == (
                "sku,name,category,material,size,color,image_filename"
            )
            assert (
                "DEMO-002,装饰蝴蝶结 香槟金,蝴蝶结,缎面织物,8cm,香槟金,DEMO-002.svg"
                in csv
            )
            page.screenshot(path=str(SCREENSHOT), full_page=True)
            if errors:
                raise RuntimeError(" | ".join(errors))
            print(f"SMOKE_OK csv={CSV_PATH}")
            print(f"SMOKE_OK screenshot={SCREENSHOT}")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
