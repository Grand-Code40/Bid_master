from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import threading

from .controller import CenterController
from .reviews import Conflict, NotFound

APP_ID = "caigraph-command-center"
STATIC = Path(__file__).with_name("static")
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
LOG = logging.getLogger(__name__)


def instance_key(root):
    return hashlib.sha256(os.path.normcase(str(root.resolve())).encode("utf-8")).hexdigest()


class CenterServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server_version = "CAIgraph"
    sys_version = ""

    def log_message(self, *_):
        pass

    def send_content(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(body)

    def host_allowed(self):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            self.send_content(403, dict(error="invalid_host"))
            return False
        return True

    def do_GET(self):
        if not self.host_allowed():
            return
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/health":
                self.send_content(200, dict(app=APP_ID, instance=instance_key(self.server.center.paths.root), pid=os.getpid()))
            elif path == "/api/state":
                self.send_content(200, self.server.center.snapshot() | dict(token=self.server.token))
            elif path in ASSETS:
                filename, content_type = ASSETS[path]
                self.send_content(200, (STATIC / filename).read_bytes(), content_type)
            else:
                self.send_content(404, dict(error="not_found"))
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            LOG.exception("Cannot read command-center data")
            self.send_content(503, dict(error="storage_unavailable"))

    def do_POST(self):
        if not self.host_allowed():
            return
        # Consume a bounded body before rejecting credentials. Closing a Windows
        # socket with unread request bytes can reset it before the 403 is received.
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 40000:
                raise ValueError("Invalid request size")
            raw_body = self.rfile.read(length)
            if len(raw_body) != length:
                raise ValueError("Incomplete request body")
        except (ValueError, OSError):
            self.send_content(400, dict(error="invalid_request"))
            return
        origin = f"http://127.0.0.1:{self.server.server_port}"
        token = self.headers.get("X-CAIgraph-Token", "")
        if self.headers.get("Origin", origin) != origin or not token.isascii() or not secrets.compare_digest(token, self.server.token):
            self.send_content(403, dict(error="invalid_token_or_origin"))
            return
        if self.headers.get_content_type() != "application/json":
            self.send_content(415, dict(error="json_required"))
            return
        try:
            data = json.loads(raw_body)
            if not isinstance(data, dict):
                raise ValueError("Expected object")
            if self.path == "/api/scan":
                accepted = self.server.center.start_scan()
                self.send_content(202 if accepted else 409, dict(accepted=accepted))
            elif self.path == "/api/monitor":
                self.server.center.set_monitor(data.get("enabled"), data.get("interval_minutes"))
                self.send_content(200, dict(saved=True))
            elif self.path in {"/api/review/" + action for action in ("prepare", "save", "approve", "queue", "cancel")}:
                self.send_content(200, self.server.center.review_action(self.path.rsplit("/", 1)[1], data))
            elif self.path == "/api/stop":
                self.send_content(200, dict(stopping=True))
                def stop():
                    self.server.shutdown()
                    self.server.center.close()
                threading.Thread(target=stop, name="caigraph-stop", daemon=True).start()
            else:
                self.send_content(404, dict(error="not_found"))
        except Conflict as exc:
            self.send_content(409, dict(error=str(exc)))
        except NotFound as exc:
            self.send_content(404, dict(error=str(exc)))
        except (ValueError, UnicodeError):
            self.send_content(400, dict(error="invalid_request"))
        except (OSError, sqlite3.Error):
            LOG.exception("Cannot save command-center settings")
            self.send_content(503, dict(error="storage_unavailable"))


def create_server(controller, port=8765):
    server = CenterServer(("127.0.0.1", port), Handler)
    server.center = controller
    server.token = secrets.token_urlsafe(32)
    return server

