"""
PathWise API  (Arbish's lane)  -  v0.5

Endpoints
  GET  /health   status, node/edge counts, engine status
  POST /route    validate -> snap to nodes -> C++ engine (Hasan) -> frozen response shape
  POST /report   validate -> dedup -> snap to a road -> live rescoring of that road
  POST /reset    restore the CSV risk values and forget recent reports

Run from the REPO ROOT, single worker (live state lives in this process):
    uvicorn api.main:app --port 8000
Do not use --reload on Windows (the engine process can keep its .exe locked).
Docs / manual testing: http://localhost:8000/docs
"""
import json
import math
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from scipy.spatial import cKDTree

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:      # so `import engine.engine_client` works
    sys.path.insert(0, str(REPO_ROOT))

# =============================================================================
# CONFIG  (everything you may need to change lives here)
# =============================================================================
DATA_DIR = REPO_ROOT / "data"

# From Maheen's data: severity_num is 1..4 (Low, Medium, High, Critical).
SEVERITY_MIN = 1
SEVERITY_MAX = 4

# The 14 crime types in karachi_incidents_clean.csv.
CRIME_TYPES = [
    "Motorbike Snatching", "Mobile Phone Snatching", "Cash Snatching", "Car Snatching",
    "Street Robbery", "Motorbike Theft", "Car Theft", "House Burglary", "Pickpocketing",
    "Shop Theft", "Armed Assault", "Extortion", "Murder", "Kidnapping for Ransom",
]
# The frozen contract example uses plain "Snatching", so generic names are accepted too.
CRIME_ALIASES = ["Snatching", "Harassment"]
CRIME_LOOKUP = {c.lower(): c for c in CRIME_TYPES + CRIME_ALIASES}

WOMEN_KEYWORDS = ("harassment", "snatching")   # 2.5x on S_women for these types
# A report applies to BOTH directions of a two-way road (u->v and v->u).
REPORT_BOTH_DIRECTIONS = True

ALPHA_MAX = 0.95          # safety slider range is 0.0 .. 0.95
MAX_SNAP_M = 500          # a click further than this from any node = outside the map
DUP_RADIUS_M = 100        # duplicate report: within 100 m ...
DUP_WINDOW_S = 3600       # ... in the last hour
REPORT_SNAP_M = 150       # a report must be within 150 m of a road
N_CANDIDATES = 12         # nearest edge midpoints examined when snapping a report
DEBUG_REPORT_INFO = True  # adds an "edges" block to /report responses; set False before submission

R_EARTH_M = 6_371_000.0

# =============================================================================
# LOAD DATA (once, at startup)
# =============================================================================
nodes = pd.read_csv(DATA_DIR / "nodes.csv").sort_values("node_id").reset_index(drop=True)
edges = pd.read_csv(DATA_DIR / "edges.csv")
with open(DATA_DIR / "meta.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

K = float(meta["K"])                              # never recalibrate at runtime
L_MIN_KM = float(meta.get("L_MIN_KM", 0.05))
WOMEN_MULT = float(meta.get("WOMEN_MULT", 2.5))

N_NODES = len(nodes)
N_EDGES = len(edges)
assert (nodes["node_id"].to_numpy() == np.arange(N_NODES)).all(), \
    "node_id must be contiguous 0..N-1"

node_lat = nodes["lat"].to_numpy(dtype=float)
node_lon = nodes["lon"].to_numpy(dtype=float)

edge_u = edges["u"].to_numpy(dtype=int)
edge_v = edges["v"].to_numpy(dtype=int)
edge_length_m = edges["length_m"].to_numpy(dtype=float)

# (u, v) -> edge index, used to find the reverse direction of a road
edge_index = {(int(u), int(v)): i for i, (u, v) in enumerate(zip(edge_u, edge_v))}

# LIVE state: these four arrays are what /report changes.
LIVE_FIELDS = ["risk_raw", "risk_raw_women", "S", "S_women"]
live = {name: edges[name].to_numpy(dtype=float).copy() for name in LIVE_FIELDS}
original = {name: arr.copy() for name, arr in live.items()}   # for /reset and diffing

recent_reports: list = []      # (x_m, y_m, unix_time) of accepted reports, for dedup
state_lock = threading.Lock()  # FastAPI runs these functions in threads; guard shared state

# =============================================================================
# GEOMETRY + SPATIAL INDEXES
# =============================================================================
LAT0 = float(node_lat.mean())
LON0 = float(node_lon.mean())
COS_LAT0 = math.cos(math.radians(LAT0))


def to_xy(lat, lon):
    """lat/lon (scalars or arrays) -> meters from the map centre."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    return (np.radians(lon - LON0) * R_EARTH_M * COS_LAT0,
            np.radians(lat - LAT0) * R_EARTH_M)


node_x, node_y = to_xy(node_lat, node_lon)
edge_mid_x = (node_x[edge_u] + node_x[edge_v]) / 2.0
edge_mid_y = (node_y[edge_u] + node_y[edge_v]) / 2.0

node_tree = cKDTree(np.column_stack([node_x, node_y]))
edge_tree = cKDTree(np.column_stack([edge_mid_x, edge_mid_y]))


def snap_to_node(lat: float, lon: float) -> int:
    """Nearest graph node id, or a clean 422 if the point is outside the map."""
    x, y = to_xy(lat, lon)
    dist, idx = node_tree.query([float(x), float(y)])
    if dist > MAX_SNAP_M:
        raise HTTPException(status_code=422,
                            detail="Point is outside the Central Karachi map area.")
    return int(idx)


def point_to_segment_m(px, py, ax, ay, bx, by):
    """Distance in meters from point P to segment AB (works on arrays)."""
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    safe = np.where(seg2 > 0, seg2, 1.0)
    t = np.clip(((px - ax) * dx + (py - ay) * dy) / safe, 0.0, 1.0)
    t = np.where(seg2 > 0, t, 0.0)
    return np.hypot(px - (ax + t * dx), py - (ay + t * dy))


# =============================================================================
# LIVE-REPORT LOGIC
# =============================================================================
def pick_edges(x: float, y: float) -> list:
    """
    Edge indices a report applies to; [] if no road is within REPORT_SNAP_M.

    The nearest edge wins (ties: lowest index). If REPORT_BOTH_DIRECTIONS is on and
    the road is two-way, its reverse edge (v->u) is included as well.
    """
    k = min(N_CANDIDATES, N_EDGES)
    _, cand = edge_tree.query([x, y], k=k)
    cand = np.atleast_1d(cand)
    d = point_to_segment_m(x, y,
                           node_x[edge_u[cand]], node_y[edge_u[cand]],
                           node_x[edge_v[cand]], node_y[edge_v[cand]])
    d_min = float(d.min())
    if d_min > REPORT_SNAP_M:
        return []
    e = int(cand[d <= d_min + 1e-6].min())
    chosen = [e]
    if REPORT_BOTH_DIRECTIONS:
        rev = edge_index.get((int(edge_v[e]), int(edge_u[e])))
        if rev is not None and rev != e:
            chosen.append(rev)
    return chosen


def is_womens_incident(crime_type: str, victim_gender: str | None) -> bool:
    ct = crime_type.lower()
    if any(word in ct for word in WOMEN_KEYWORDS):
        return True
    return (victim_gender or "").strip().lower() == "female"


def is_duplicate(x: float, y: float, now: float) -> bool:
    """True if another report exists within DUP_RADIUS_M in the last DUP_WINDOW_S."""
    recent_reports[:] = [r for r in recent_reports if now - r[2] <= DUP_WINDOW_S]
    return any(math.hypot(x - rx, y - ry) <= DUP_RADIUS_M for rx, ry, _ in recent_reports)


def changed_edges() -> list:
    """
    Edges whose live risk differs from the CSV, as [{u, v, S, S_women}, ...].
    This is what the routing engine needs on top of its own copy of edges.csv.
    Call it while holding state_lock.
    """
    idx = np.flatnonzero((live["S"] != original["S"]) |
                         (live["S_women"] != original["S_women"]))
    return [{"u": int(edge_u[i]), "v": int(edge_v[i]),
             "S": float(live["S"][i]), "S_women": float(live["S_women"][i])}
            for i in idx]


# =============================================================================
# ROUTING ENGINE  (Hasan's C++ engine via engine/engine_client.py)
# =============================================================================
ENGINE_STATUS = "not_connected"   # "cpp" once the engine started, "unavailable" if it failed
ENGINE_INFO: dict = {}
_engine_route = None
_engine_error_cls = RuntimeError


def start_engine() -> None:
    """Start the long-lived C++ engine once (compiles it first if g++ is available)."""
    global ENGINE_STATUS, ENGINE_INFO, _engine_route, _engine_error_cls
    try:
        from engine.engine_client import EngineError, get_engine, route as engine_route
        _engine_error_cls = EngineError
        ENGINE_INFO = dict(get_engine().info)
        _engine_route = engine_route
        ENGINE_STATUS = "cpp"
        if (ENGINE_INFO.get("nodes") != N_NODES) or (ENGINE_INFO.get("edges") != N_EDGES):
            print(f"[api] WARNING: engine graph {ENGINE_INFO.get('nodes')}/{ENGINE_INFO.get('edges')} "
                  f"differs from API graph {N_NODES}/{N_EDGES}", file=sys.stderr)
    except Exception as exc:       # keep the API (and /report) alive even if the engine is down
        ENGINE_STATUS = "unavailable"
        print(f"[api] engine not available: {exc}", file=sys.stderr)


def stop_engine() -> None:
    try:
        from engine.engine_client import get_engine
        get_engine().close()
    except Exception:
        pass


def call_engine(o_node: int, d_node: int, alpha: float,
                womens_mode: bool, overrides: list) -> dict:
    """Returns the frozen /route response shape (computed by the C++ engine)."""
    if _engine_route is None:
        raise HTTPException(status_code=503, detail="Routing engine is not available.")
    try:
        return _engine_route(o_node, d_node, alpha, womens_mode, overrides)
    except _engine_error_cls as exc:
        if "no path" in str(exc).lower():
            raise HTTPException(status_code=404, detail="No route found between these points.")
        raise HTTPException(status_code=503, detail="Routing engine error.")
    except Exception:
        raise HTTPException(status_code=503, detail="Routing engine error.")


# =============================================================================
# REQUEST MODELS (the frozen contracts)
# =============================================================================
class RouteRequest(BaseModel):
    origin: list[float] = Field(min_length=2, max_length=2)        # [lat, lon]
    destination: list[float] = Field(min_length=2, max_length=2)   # [lat, lon]
    safety_weight: float = 0.6
    womens_mode: bool = False

    @field_validator("safety_weight")
    @classmethod
    def clamp_alpha(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("safety_weight must be a finite number")
        return min(max(v, 0.0), ALPHA_MAX)

    @field_validator("origin", "destination")
    @classmethod
    def finite_point(cls, v: list) -> list:
        if not all(math.isfinite(c) for c in v):
            raise ValueError("coordinates must be finite numbers")
        return v


class ReportRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    crime_type: str = Field(min_length=1, max_length=50)
    severity_num: int = Field(ge=SEVERITY_MIN, le=SEVERITY_MAX)
    victim_gender: str | None = None     # optional: "Female" also counts for women's mode

    @field_validator("crime_type")
    @classmethod
    def known_crime_type(cls, v: str) -> str:
        canonical = CRIME_LOOKUP.get(v.strip().lower())
        if canonical is None:
            raise ValueError("crime_type must be one of: " + ", ".join(CRIME_TYPES))
        return canonical


# =============================================================================
# APP + CORS
# =============================================================================
@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_engine()          # load the graph in the engine now, not on the first request
    yield
    stop_engine()


app = FastAPI(title="PathWise API", version="0.5", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],     # fine for a local hackathon demo
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "nodes": N_NODES,
        "edges": N_EDGES,
        "K": K,
        "live_reports": len(recent_reports),
        "engine": ENGINE_STATUS,
        "engine_graph": {"nodes": ENGINE_INFO.get("nodes"), "edges": ENGINE_INFO.get("edges")},
    }


# =============================================================================
# ENDPOINTS  (plain `def`, so FastAPI runs them in worker threads and the blocking
# engine call does not freeze the server)
# =============================================================================
@app.post("/route")
def route(req: RouteRequest):
    o_node = snap_to_node(req.origin[0], req.origin[1])
    d_node = snap_to_node(req.destination[0], req.destination[1])

    with state_lock:                       # consistent snapshot of the live changes
        overrides = changed_edges()

    return call_engine(o_node, d_node, req.safety_weight, req.womens_mode, overrides)


@app.post("/report")
def report(req: ReportRequest):
    x, y = to_xy(req.lat, req.lon)
    x, y = float(x), float(y)
    now = time.time()

    with state_lock:
        if is_duplicate(x, y, now):
            return {"status": "duplicate", "updated_edges": 0}

        chosen = pick_edges(x, y)
        if not chosen:
            return {"status": "rejected", "updated_edges": 0}

        s = float(req.severity_num)
        s_women = s * WOMEN_MULT if is_womens_incident(req.crime_type, req.victim_gender) else s

        debug = []
        for e in chosen:
            length_km = max(edge_length_m[e] / 1000.0, L_MIN_KM)
            s_before = float(live["S"][e])
            live["risk_raw"][e] += s / length_km
            live["risk_raw_women"][e] += s_women / length_km
            live["S"][e] = 1.0 - math.exp(-live["risk_raw"][e] / K)
            live["S_women"][e] = 1.0 - math.exp(-live["risk_raw_women"][e] / K)
            debug.append({"index": int(e), "u": int(edge_u[e]), "v": int(edge_v[e]),
                          "S_before": round(s_before, 4),
                          "S_after": round(float(live["S"][e]), 4)})

        recent_reports.append((x, y, now))

        result = {"status": "accepted", "updated_edges": len(chosen)}
        if DEBUG_REPORT_INFO:
            result["edges"] = debug
        return result


@app.post("/reset")
def reset():
    """Restore all live risk values to the CSV values and forget recent reports."""
    with state_lock:
        for name in LIVE_FIELDS:
            live[name][:] = original[name]
        recent_reports.clear()
    return {"status": "reset"}