from __future__ import annotations

import argparse
import ctypes
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import threading
import time
from urllib.request import ProxyHandler, build_opener
import webbrowser

from ..discovery.runtime import DEFAULT_ROOT, RuntimePaths, runtime_environment


def is_running(url, paths):
    from .server import APP_ID, instance_key
    try:
        with build_opener(ProxyHandler({})).open(url + "api/health", timeout=1) as response:
            data = json.loads(response.read(4096))
        return data.get("app") == APP_ID and data.get("instance") == instance_key(paths.root)
    except (OSError, ValueError, AttributeError):
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description="CAIgraph command center")
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("DISCOVERY_DATA_ROOT", str(DEFAULT_ROOT))))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    center = server = handler = None
    try:
        from .controller import CenterController
        from .server import create_server

        if not 1 <= args.port <= 65535:
            raise ValueError("Port must be between 1 and 65535")
        paths = RuntimePaths.from_root(args.data_root)
        url = f"http://127.0.0.1:{args.port}/"
        if is_running(url, paths):
            if not args.no_browser:
                webbrowser.open(url)
            return 0
        paths.prepare()
        paths.child("command-center").mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(paths.child("command-center/server.log"), maxBytes=1_000_000, backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logging.getLogger("autobid.command_center").addHandler(handler)
        with runtime_environment(paths):
            center = CenterController(paths)
            try:
                server = create_server(center, args.port)
            except OSError:
                for _ in range(5):
                    if is_running(url, paths):
                        if not args.no_browser:
                            webbrowser.open(url)
                        return 0
                    time.sleep(.1)
                raise RuntimeError(f"Порт {args.port} занят другим приложением или другим хранилищем CAIgraph. Закройте его и повторите запуск.") from None
            center.start_scheduler()
            if not args.no_browser:
                threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
            server.serve_forever(poll_interval=.2)
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception as exc:
        message = f"Не удалось открыть командный центр CAIgraph.\n\n{exc}"
        logging.getLogger("autobid.command_center").exception("Startup failed")
        if os.name == "nt" and not args.no_browser:
            ctypes.windll.user32.MessageBoxW(None, message, "CAIgraph", 0x10)
        elif sys.stderr:
            print(message, file=sys.stderr)
        return 2
    finally:
        if center:
            center.close()
        if server:
            server.server_close()
        if handler:
            logging.getLogger("autobid.command_center").removeHandler(handler)
            handler.close()


if __name__ == "__main__":
    raise SystemExit(main())

