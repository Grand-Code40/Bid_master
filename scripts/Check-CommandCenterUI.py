"""Real local HTTP/UI acceptance test. Uses an isolated D: data root on Windows."""
import argparse
import json
from pathlib import Path
import threading

from playwright.sync_api import sync_playwright

from autobid.command_center.controller import CenterController
from autobid.command_center.server import create_server
from autobid.command_center.agent import ingest
from autobid.discovery.runtime import RuntimePaths


def run(root):
    paths = RuntimePaths.from_root(root)
    ingest(paths, [
        dict(source_id="freelance", external_id="13089", canonical_url="https://freelance.ru/task/view/13089",
             title="Перевести план квартиры из PDF в DWG", description="Нужен редактируемый план квартиры. Сохранить размеры и разделить стены, двери и размеры по слоям. Исходный файл предоставим.",
             listing_kind="order", availability="open", budget_max="8000", currency="RUB", bids_count=3,
             requested_formats=["DWG", "PDF"], observed_at="2026-11-02T09:00:00Z"),
        dict(source_id="fl", external_id="90000001", canonical_url="https://www.fl.ru/projects/90000001/test.html",
             title="3D-модель корпуса по эскизу", description="Подготовить модель и чертёж с размерами.",
             listing_kind="order", availability="open", bids_count=0, requested_formats=["STEP"],
             observed_at="2026-11-02T09:00:00Z"),
        dict(source_id="fl", external_id="90000002", canonical_url="https://www.fl.ru/projects/90000002/test.html",
             title='<img src=x onerror="window.injected=1">', description='<script>window.injected=1</script>',
             listing_kind="order", availability="open", observed_at="2026-11-02T09:00:00Z"),
    ])
    center = CenterController(paths)
    server = create_server(center, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    console = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width":1440, "height":1000}, device_scale_factor=1)
            page.on("pageerror", lambda error: console.append(str(error)))
            page.goto(url)
            page.get_by_role("button", name="Перевести план квартиры из PDF в DWG", exact=True).click()
            page.wait_for_function("() => !document.querySelector('#reply-text').disabled")
            assert "DWG" in page.locator("#reply-text").input_value()
            assert "Перевести план" in page.locator("#reply-text").input_value()
            page.locator("#reply-text").fill("Здравствуйте! Подготовим DWG и PDF. Предварительно 5 000 ₽, точный срок — после просмотра исходника.")
            # A background refresh must leave unsaved editing intact.
            page.wait_for_timeout(2700)
            assert "5 000" in page.locator("#reply-text").input_value()
            page.get_by_role("button", name="Перевести план квартиры из PDF в DWG", exact=True).click()
            assert "5 000" in page.locator("#reply-text").input_value(), "Reopening the selected order discarded unsaved edits"
            page.locator("#approve-reply").click()
            page.wait_for_function("() => !document.querySelector('#queue-reply').hidden")
            assert center.reviews.get("freelance","13089")["state"] == "approved"
            page.evaluate("window.scrollTo(0,0)")
            assert page.locator("#queue-reply").bounding_box()["y"] < 960
            page.screenshot(path=str(root / "desktop-approved.png"), full_page=True)
            page.locator("#queue-reply").click()
            page.wait_for_function("() => document.querySelector('#review-state').textContent === 'В очереди'")
            assert center.reviews.get("freelance","13089")["state"] == "queued"
            page.reload()
            page.get_by_role("button", name="Перевести план квартиры из PDF в DWG", exact=True).click()
            assert page.locator("#reply-text").is_readonly() if hasattr(page.locator("#reply-text"), "is_readonly") else page.locator("#reply-text").evaluate("(el) => el.readOnly")
            assert "5 000" in page.locator("#reply-text").input_value()
            page.locator("#cancel-reply").click()
            page.wait_for_function("() => document.querySelector('#review-state').textContent === 'Черновик'")
            # Simulate a second tab saving while this tab has unsaved edits.
            page.locator("#reply-text").fill("Мои несохранённые правки")
            row=center.reviews.get("freelance","13089")
            center.reviews.save("freelance","13089","Текст из второй вкладки",row["revision"])
            page.wait_for_function("() => !document.querySelector('#reload-reply').hidden")
            assert page.locator("#reply-text").input_value()=="Мои несохранённые правки"
            assert page.locator("#approve-reply").is_disabled()
            page.locator("#reload-reply").click()
            assert page.locator("#reply-text").input_value()=="Текст из второй вкладки"
            page.locator("#close-details").click()
            page.get_by_role("button", name='<img src=x onerror="window.injected=1">', exact=True).click()
            assert page.locator("#details-title img").count()==0
            assert page.evaluate("window.injected") is None
            assert "<script>" in page.locator("#details-description").inner_text()
            page.locator("#close-details").click()
            page.get_by_role("button", name="Перевести план квартиры из PDF в DWG", exact=True).click()
            page.set_viewport_size({"width":390,"height":844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert page.locator(".feed").is_hidden()
            page.screenshot(path=str(root / "mobile-editor.png"), full_page=True)
            page.locator("#close-details").click()
            assert page.locator(".feed").is_visible()
            page.screenshot(path=str(root / "mobile-list.png"), full_page=True)
            page.set_viewport_size({"width":1440,"height":1000})
            page.locator("#settings-button").click()
            page.route("**/api/monitor", lambda route:route.fulfill(status=503,content_type="application/json",body='{"error":"storage_unavailable"}'))
            page.locator("#monitor-enabled").check()
            page.wait_for_function("() => !document.querySelector('#monitor-enabled').disabled && !document.querySelector('#monitor-enabled').checked")
            assert "Не удалось" in page.locator("#monitor-status").inner_text()
            page.unroute("**/api/monitor")
            page.locator("#monitor-enabled").check()
            page.wait_for_function("() => !document.querySelector('#monitor-enabled').disabled && document.querySelector('#monitor-enabled').checked")
            assert center.snapshot()["monitor"]["enabled"]
            page.locator("#monitor-enabled").uncheck()
            page.wait_for_function("() => !document.querySelector('#monitor-enabled').disabled")
            page.route("**/api/state", lambda route:route.fulfill(status=503,content_type="application/json",body='{}'))
            page.wait_for_function("() => document.querySelector('#connection').textContent.includes('Нет соединения')")
            page.unroute("**/api/state")
            page.wait_for_function("() => document.querySelector('#connection').textContent.includes('Центр работает')")
            assert page.locator("#notice").is_hidden()
            page.locator("#stop-button").click()
            page.wait_for_function("() => document.querySelector('#connection').textContent.includes('Центр выключен')")
            page.wait_for_timeout(2700)
            assert page.locator("#stop-button").is_disabled()
            assert not console, console
            browser.close()
        print(json.dumps({"workflow":"passed","editing_conflict":"passed","unknown_values_and_xss":"passed","mobile":"passed","monitor_failure_and_recovery":"passed","console_errors":console},ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()
        center.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    run(parser.parse_args().data_root.resolve())
