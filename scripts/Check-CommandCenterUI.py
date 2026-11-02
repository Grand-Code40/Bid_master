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
             title="Тестовый пример: план квартиры из PDF в DWG", description="Нужен редактируемый план квартиры. Сохранить размеры и разделить стены, двери и размеры по слоям. Исходный файл предоставим.",
             listing_kind="order", availability="open", budget_max="8000", currency="RUB", bids_count=3,
             requested_formats=["DWG", "PDF"], observed_at="2026-11-02T09:00:00Z"),
        dict(source_id="fl", external_id="90000001", canonical_url="https://www.fl.ru/projects/90000001/test.html",
             title="Тестовый пример: 3D-модель корпуса по эскизу", description="Подготовить модель и чертёж с размерами.",
             listing_kind="order", availability="open", bids_count=0, requested_formats=["STEP"],
             observed_at="2026-11-02T09:00:00Z"),
        dict(source_id="fl", external_id="90000002", canonical_url="https://www.fl.ru/projects/90000002/test.html",
             title='<img src=x onerror="window.injected=1">', description='<script>window.injected=1</script>',
             listing_kind="order", availability="open", observed_at="2026-11-02T09:00:00Z"),
        dict(source_id="fl", external_id="90000003", canonical_url="https://www.fl.ru/projects/90000003/test.html",
             title="Тестовый пример: закрытый проект", description="Сохранённое описание закрытого проекта.",
             listing_kind="order", availability="closed", observed_at="2026-11-02T09:00:00Z"),
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
            page.wait_for_function("() => document.querySelectorAll('.listing-action').length === 4")
            assert set(text.strip() for text in page.locator(".listing-action").all_text_contents()) == {"Ответить"}
            order = page.locator('.listing[data-listing-key="freelance:13089"]')
            order.get_by_role("button", name="Ответить", exact=True).click()
            assert page.locator("#editor-panel").evaluate("(node) => node.matches(':modal')")
            # Background controls remain outside the modal focus scope; the
            # browser may move focus to its own chrome at a Tab boundary.
            for _ in range(14):
                page.keyboard.press("Tab")
                assert page.evaluate("document.activeElement === document.body || document.querySelector('#editor-panel').contains(document.activeElement)")
            page.wait_for_function("() => !document.querySelector('#reply-text').disabled")
            assert "DWG" in page.locator("#reply-text").input_value()
            assert "план квартиры" in page.locator("#reply-text").input_value()
            page.locator("#reply-text").fill("Здравствуйте! Подготовим DWG и PDF. Предварительно 5 000 ₽, точный срок — после просмотра исходника.")
            # A background refresh must leave unsaved editing intact.
            page.wait_for_timeout(2700)
            assert "5 000" in page.locator("#reply-text").input_value()
            confirmations=[]
            def keep_edits(dialog):
                confirmations.append(dialog.message)
                dialog.dismiss()
            page.once("dialog", keep_edits)
            page.keyboard.press("Escape")
            assert confirmations, "Closing dirty text must ask before discarding"
            assert page.locator("#editor-panel").evaluate("(node) => node.open")
            assert "5 000" in page.locator("#reply-text").input_value()
            page.locator("#approve-reply").click()
            page.wait_for_function("() => !document.querySelector('#queue-reply').hidden")
            assert center.reviews.get("freelance","13089")["state"] == "approved"
            page.evaluate("window.scrollTo(0,0)")
            assert page.locator("#queue-reply").bounding_box()["y"] < 960
            page.screenshot(path=str(root / "desktop-approved.png"), full_page=True)
            page.keyboard.press("Escape")
            assert not page.locator("#editor-panel").evaluate("(node) => node.open")
            assert page.evaluate("document.activeElement.closest('.listing').dataset.listingKey") == "freelance:13089"
            order.get_by_role("button", name="Ответить", exact=True).click()
            page.mouse.click(8, 8)
            assert not page.locator("#editor-panel").evaluate("(node) => node.open")
            order.get_by_role("button", name="Ответить", exact=True).click()
            assert "5 000" in page.locator("#reply-text").input_value()
            page.locator("#queue-reply").click()
            page.wait_for_function("() => document.querySelector('#review-state').textContent === 'В очереди'")
            assert center.reviews.get("freelance","13089")["state"] == "queued"
            page.reload()
            page.get_by_role("button", name="Тестовый пример: план квартиры из PDF в DWG", exact=True).click()
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
            page.get_by_role("button", name="Тестовый пример: план квартиры из PDF в DWG", exact=True).click()
            page.set_viewport_size({"width":390,"height":844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            assert page.locator("#editor-panel").evaluate("(node) => node.matches(':modal')")
            box=page.locator("#editor-panel").bounding_box()
            assert box["x"] >= 0 and box["y"] >= 0 and box["x"]+box["width"] <= 390
            assert box["y"]+box["height"] <= 844
            assert page.locator("#editor-panel").evaluate("(node) => node.scrollWidth <= node.clientWidth")
            page.screenshot(path=str(root / "mobile-editor.png"), full_page=True)
            page.locator(".editor-scroll").evaluate("(node) => node.scrollTop = node.scrollHeight")
            assert page.locator(".editor-scroll").evaluate("(node) => node.scrollTop > 0")
            page.locator("#close-details").click()
            order.get_by_role("button", name="Ответить", exact=True).click()
            assert page.locator(".editor-scroll").evaluate("(node) => node.scrollTop === 0")
            page.locator("#close-details").click()
            assert page.locator(".feed").is_visible()
            page.screenshot(path=str(root / "mobile-list.png"), full_page=True)
            page.set_viewport_size({"width":1440,"height":1000})
            closed=page.locator('.listing[data-listing-key="fl:90000003"]')
            closed.get_by_role("button", name="Ответить", exact=True).click()
            assert page.locator("#reply-unavailable").is_visible()
            assert page.locator("#approve-reply").is_hidden()
            page.locator("#close-details").click()
            # A slow initial draft must not trap the user in a modal or reopen it.
            pending=[]
            page.route("**/api/review/prepare", lambda route:pending.append(route))
            page.locator('.listing[data-listing-key="fl:90000001"]').get_by_role("button", name="Ответить", exact=True).click()
            page.wait_for_timeout(150)
            assert pending
            page.locator("#close-details").click()
            assert not page.locator("#editor-panel").evaluate("(node) => node.open")
            pending.pop().continue_()
            page.unroute("**/api/review/prepare")
            page.wait_for_timeout(500)
            assert not page.locator("#editor-panel").evaluate("(node) => node.open")
            # Closing a stalled save must not lock the UI, approve after close,
            # or replace another order's text when the old response arrives.
            order.get_by_role("button", name="Ответить", exact=True).click()
            page.locator("#reply-text").fill("Сохранение, закрытое до одобрения")
            pending_save=[]
            page.route("**/api/review/save", lambda route:pending_save.append(route))
            page.locator("#approve-reply").click()
            page.wait_for_timeout(150)
            assert pending_save
            assert page.locator("#close-details").is_enabled()
            page.once("dialog", lambda dialog:dialog.accept())
            page.locator("#close-details").click()
            assert not page.locator("#editor-panel").evaluate("(node) => node.open")
            page.locator('.listing[data-listing-key="fl:90000001"]').get_by_role("button", name="Ответить", exact=True).click()
            page.wait_for_function("() => !document.querySelector('#reply-text').disabled")
            other_text=page.locator("#reply-text").input_value()
            with page.expect_response("**/api/review/save") as saved_response:
                pending_save.pop().continue_()
            assert saved_response.value.json()["text"] == "Сохранение, закрытое до одобрения"
            page.unroute("**/api/review/save")
            page.wait_for_timeout(300)
            assert center.reviews.get("freelance","13089")["state"] == "draft"
            assert center.reviews.get("freelance","13089")["text"] == "Сохранение, закрытое до одобрения"
            assert "3D-модель корпуса" in page.locator("#details-title").inner_text()
            assert page.locator("#reply-text").input_value() == other_text
            assert not page.locator("#save-reply").is_enabled()
            page.locator("#close-details").click()
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
        print(json.dumps({"workflow":"passed","reply_dialog":"passed","editing_conflict":"passed","unknown_values_and_xss":"passed","mobile":"passed","monitor_failure_and_recovery":"passed","console_errors":console},ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()
        center.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    run(parser.parse_args().data_root.resolve())
