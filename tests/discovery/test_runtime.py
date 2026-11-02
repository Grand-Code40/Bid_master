from pathlib import Path
import os
import pytest
from autobid.discovery.runtime import RuntimePaths, RunLock, LockBusy, run_watch, runtime_environment


def test_lock_excludes_another_writer_and_releases_on_exception(tmp_path):
    with pytest.raises(RuntimeError, match="test failure"):
        with RunLock(tmp_path):
            with pytest.raises(LockBusy):
                with RunLock(tmp_path):
                    pytest.fail("concurrent writer entered")
            raise RuntimeError("test failure")
    with RunLock(tmp_path):
        pass


def test_paths_cannot_escape_root_and_environment_is_restored(tmp_path, monkeypatch):
    paths = RuntimePaths.from_root(tmp_path / "data")
    paths.prepare()
    with pytest.raises(ValueError):
        paths.child("../outside")
    monkeypatch.setenv("TEMP", "original-temp")
    with runtime_environment(paths):
        assert Path(os.environ["TEMP"]).is_relative_to(paths.root)
        assert Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"]).is_relative_to(paths.root)
    assert os.environ["TEMP"] == "original-temp"


@pytest.mark.skipif(os.name != "nt", reason="owner's Windows disk rule")
def test_no_silent_c_drive_fallback(tmp_path):
    with pytest.raises(ValueError):
        RuntimePaths.from_root(Path("C:/bid-master-forbidden"))
    with pytest.raises(ValueError):
        RuntimePaths.from_root(Path("Z:/missing-drive/bid-master"))


def test_watch_waits_interruptibly_and_never_runs_after_stop():
    current = [0]
    calls, waits = [], []
    class Stop:
        stopped = False
        def is_set(self):
            return self.stopped
        def wait(self, duration):
            waits.append(duration)
            self.stopped = True
            return True
    stop = Stop()
    def scan():
        calls.append("scan")
        current[0] += 10
    run_watch(scan, 60, stop=stop, clock=lambda: current[0])
    assert calls == ["scan"]
    assert waits == [50]
    run_watch(scan, 60, stop=stop, clock=lambda: current[0])
    assert calls == ["scan"]


def test_too_frequent_watcher_rejected():
    with pytest.raises(ValueError):
        run_watch(lambda: pytest.fail("must not run"), 0)

