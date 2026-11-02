from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
import threading
import time

DEFAULT_ROOT = Path(r"D:\DrawingAI_runs\bid-master-source-access-2026-11-02")


@dataclass(frozen=True)
class RuntimePaths:
    root: Path

    @classmethod
    def from_root(cls, root: Path):
        if not root.is_absolute():
            raise ValueError("An absolute data root on D: is required")
        resolved = root.resolve()
        if os.name == "nt" and resolved.drive.upper() != "D:":
            raise ValueError("Data, browser profiles and temporary files must be on D:")
        if not Path(resolved.anchor).is_dir():
            raise ValueError("Data drive is unavailable; no fallback directory was created")
        return cls(resolved)

    def child(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Runtime path escapes configured data root")
        return path

    def prepare(self):
        self.root.mkdir(parents=True, exist_ok=True)
        for relative in ("reports", "profiles", "tmp", "browsers"):
            self.child(relative).mkdir(parents=True, exist_ok=True)
        self.child("discovery.sqlite3")
        self.child(".discovery.lock")


class LockBusy(RuntimeError):
    pass


class RunLock:
    """OS-owned advisory lock. A crashed process automatically releases ownership."""

    def __init__(self, root: Path):
        self.path = root / ".discovery.lock"
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                self.handle.write(b"0")
                self.handle.flush()
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            self.handle = None
            raise LockBusy("Another scan, watcher or browser connection is using this data root") from None
        return self

    def __exit__(self, *exc):
        if self.handle:
            try:
                self.handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
            finally:
                self.handle.close()
                self.handle = None


@contextmanager
def runtime_environment(paths: RuntimePaths):
    values = {
        "TEMP": str(paths.child("tmp")), "TMP": str(paths.child("tmp")),
        "TMPDIR": str(paths.child("tmp")),
        "PLAYWRIGHT_BROWSERS_PATH": str(paths.child("browsers")),
    }
    old = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def run_watch(scan_once, interval_seconds: float, *, stop=None, clock=time.monotonic):
    if interval_seconds < 60:
        raise ValueError("Watcher interval must be at least 60 seconds")
    stop = stop if stop is not None else threading.Event()
    while not stop.is_set():
        deadline = clock() + interval_seconds
        scan_once()
        if stop.wait(max(0, deadline - clock())):
            break

