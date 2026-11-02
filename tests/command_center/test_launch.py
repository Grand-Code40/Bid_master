import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from urllib.request import ProxyHandler, Request, build_opener

from autobid.command_center.controller import CenterController
from autobid.command_center.server import create_server
from autobid.discovery.runtime import RuntimePaths

HTTP = build_opener(ProxyHandler({}))


def launcher():
    assert importlib.util.find_spec("autobid.command_center.__main__"), "One-button launcher is not implemented"
    from autobid.command_center.__main__ import main
    return main


def test_repeated_launch_reuses_matching_service(tmp_path):
    main = launcher()
    center = CenterController(RuntimePaths.from_root(tmp_path))
    server = create_server(center, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert main(["--data-root", str(tmp_path), "--port", str(server.server_port), "--no-browser"]) == 0
        assert thread.is_alive()
        with HTTP.open(f"http://127.0.0.1:{server.server_port}/api/health") as response:
            assert json.load(response)["pid"] == os.getpid()
    finally:
        server.shutdown()
        server.server_close()
        center.close()


def test_foreign_data_root_on_port_is_not_reused(tmp_path):
    main = launcher()
    center = CenterController(RuntimePaths.from_root(tmp_path / "other"))
    server = create_server(center, port=0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        assert main(["--data-root", str(tmp_path / "requested"), "--port", str(server.server_port), "--no-browser"]) == 2
        assert thread.is_alive()
    finally:
        server.shutdown()
        server.server_close()
        center.close()


def test_new_hidden_process_serves_ui_and_exits_after_stop(tmp_path):
    launcher()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(
        [sys.executable, "-B", "-m", "autobid.command_center", "--data-root", str(tmp_path), "--port", str(port), "--no-browser"],
        cwd=Path(__file__).parents[2], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with HTTP.open(url + "/api/state", timeout=.3) as response:
                    state = json.load(response)
                break
            except OSError:
                if process.poll() is not None:
                    raise AssertionError(process.communicate())
                time.sleep(.05)
        else:
            raise AssertionError("Command center failed to start")
        assert state["summary"]["total"] == 0
        for path, content_type in (("/", "text/html"), ("/app.js", "text/javascript"), ("/app.css", "text/css")):
            with HTTP.open(url + path, timeout=2) as response:
                assert response.headers.get_content_type() == content_type
                assert len(response.read()) > 100
        request = Request(url + "/api/stop", data=b"{}", method="POST",
                          headers={"Content-Type": "application/json", "X-CAIgraph-Token": state["token"]})
        with HTTP.open(request, timeout=3) as response:
            assert response.status == 200
        assert process.wait(8) == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(5)
        process.communicate()



def test_missing_dependency_reports_startup_error_instead_of_silent_exit(tmp_path):
    launcher()
    code = """
import builtins
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == 'bs4':
        raise ImportError('missing discovery dependency')
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from autobid.command_center.__main__ import main
raise SystemExit(main(['--no-browser', '--data-root', __import__('sys').argv[1]]))
"""
    result = subprocess.run([sys.executable, "-B", "-c", code, str(tmp_path)],
                            cwd=Path(__file__).parents[2], capture_output=True,
                            env=dict(os.environ, PYTHONIOENCODING="utf-8"), timeout=10)
    assert result.returncode == 2
    assert "Не удалось открыть командный центр" in result.stderr.decode("utf-8")

