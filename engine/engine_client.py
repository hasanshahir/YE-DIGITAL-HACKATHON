"""
PathWise engine client  (Hasan's lane)  -  bridges the FastAPI service and the C++ engine.

The C++ engine runs as ONE long-lived child process (`pathwise_engine --serve`): the graph is
loaded once, and every /route call is a single line over stdin/stdout. Standard library only.

How the API uses it  (api/main.py, inside call_engine):

    from engine.engine_client import route as engine_route
    ENGINE_STATUS = "cpp"

    def call_engine(o_node, d_node, alpha, womens_mode, overrides):
        return engine_route(o_node, d_node, alpha, womens_mode, overrides)

`route()` returns exactly the frozen /route response shape:
    {"recommended": {"path", "distance_m", "time_s", "avg_risk", "cost"},
     "fastest":     {same fields; searched with alpha = 0, cost scored under alpha},
     "benchmark":   {"astar_nodes", "dijkstra_nodes", "astar_ms", "dijkstra_ms", "cost_match"}}

If the binary is missing it is compiled automatically when g++ is on PATH.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path

ENGINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = ENGINE_DIR.parent
DATA_DIR = REPO_ROOT / "data"
BINARY = ENGINE_DIR / ("pathwise_engine.exe" if os.name == "nt" else "pathwise_engine")
SOURCES = [ENGINE_DIR / "main.cpp", ENGINE_DIR / "graph.hpp", ENGINE_DIR / "search.hpp"]
BUILD_CMD = ["g++", "-O2", "-std=c++17", "-o", str(BINARY), str(ENGINE_DIR / "main.cpp")]


class EngineError(RuntimeError):
    """Raised when the engine cannot be started or rejects a request."""


def build(force: bool = False) -> Path:
    """Compile the engine if the binary is missing or older than its sources."""
    if BINARY.exists() and not force:
        newest_src = max(p.stat().st_mtime for p in SOURCES if p.exists())
        if BINARY.stat().st_mtime >= newest_src:
            return BINARY
    if shutil.which("g++") is None:
        raise EngineError(
            f"engine binary not found at {BINARY} and g++ is not on PATH. "
            f"Build it with: {' '.join(BUILD_CMD)}")
    print(f"[engine] building: {' '.join(BUILD_CMD)}", file=sys.stderr)
    res = subprocess.run(BUILD_CMD, capture_output=True, text=True)
    if res.returncode != 0:
        raise EngineError("engine build failed:\n" + res.stderr)
    return BINARY


class Engine:
    """One persistent engine process. Thread-safe: requests are serialised with a lock."""

    def __init__(self, data_dir: Path | str = DATA_DIR, binary: Path | str | None = None):
        self.data_dir = str(data_dir)
        self.binary = Path(binary) if binary else None
        self.proc: subprocess.Popen | None = None
        self.info: dict = {}
        self._lock = threading.Lock()

    # -- process management -------------------------------------------------
    def start(self) -> None:
        exe = self.binary or build()
        self.proc = subprocess.Popen(
            [str(exe), "--serve", "--data", self.data_dir],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,  # stderr -> console
            text=True, bufsize=1, encoding="utf-8",
        )
        line = self.proc.stdout.readline()
        try:
            self.info = json.loads(line)
        except json.JSONDecodeError:
            self.close()
            raise EngineError(f"engine did not start (got: {line!r})")
        if not self.info.get("ready"):
            self.close()
            raise EngineError(f"engine failed to load data: {self.info.get('error')}")

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def close(self) -> None:
        if self.proc is None:
            return
        try:
            if self.proc.poll() is None:
                self.proc.stdin.write("QUIT\n")
                self.proc.stdin.flush()
                self.proc.wait(timeout=2)
        except Exception:
            self.proc.kill()
        self.proc = None

    # -- requests -----------------------------------------------------------
    def _send(self, payload: str) -> dict:
        if not self.alive():
            self.start()
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise EngineError("engine process exited unexpectedly")
        return json.loads(line)

    def route(self, o_node: int, d_node: int, alpha: float,
              womens_mode: bool = False, overrides: list | None = None) -> dict:
        overrides = overrides or []
        lines = [f"ROUTE {int(o_node)} {int(d_node)} {float(alpha):.6f} "
                 f"{1 if womens_mode else 0} {len(overrides)}"]
        for ov in overrides:
            lines.append(f"{int(ov['u'])} {int(ov['v'])} {float(ov['S']):.12g} {float(ov['S_women']):.12g}")
        payload = "\n".join(lines) + "\n"

        with self._lock:
            try:
                result = self._send(payload)
            except (BrokenPipeError, OSError, EngineError, json.JSONDecodeError):
                self.close()                 # one automatic restart, then give up
                result = self._send(payload)
        if "error" in result:
            raise EngineError(result["error"])
        return result


# Module-level default engine (lazy) so the API only needs `route(...)`.
_default: Engine | None = None
_default_lock = threading.Lock()


def get_engine() -> Engine:
    global _default
    with _default_lock:
        if _default is None:
            _default = Engine()
            _default.start()
        return _default


def route(o_node: int, d_node: int, alpha: float, womens_mode: bool = False,
          overrides: list | None = None) -> dict:
    """Same signature as api/main.py call_engine(); returns the frozen response shape."""
    return get_engine().route(o_node, d_node, alpha, womens_mode, overrides)


if __name__ == "__main__":
    # quick manual check:  python engine/engine_client.py 4291 37218 0.6
    o, d = int(sys.argv[1]), int(sys.argv[2])
    a = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
    r = route(o, d, a, womens_mode="--womens" in sys.argv)
    for key in ("recommended", "fastest"):
        r[key]["path"] = f"<{len(r[key]['path'])} points>"
    print(json.dumps(r, indent=2))

