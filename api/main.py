"""
PathWise API  (Arbish's lane)  -  v0.4

What this file owns:
  * loads Maheen's graph files (nodes.csv, edges.csv, meta.json) into memory
  * keeps the LIVE edge risk state (S, S_women, risk_raw, risk_raw_women)
  * POST /report  -> dedup, snap to one edge, update risk (live rescoring)
  * POST /reset   -> restore the CSV values
  * POST /route   -> validates input, snaps points to nodes, calls the routing engine,
                     returns the frozen response shape
  * GET  /health

What it does NOT own (plug in later):
  * the routing itself  ->  call_engine()   (Hasan's C++ engine)
  * pending answers from Maheen -> the "TODO(Maheen)" lines in the CONFIG block

Run from the repo root (single worker only: live state lives in this process):
    uvicorn api.main:app --reload --port 8000
Docs / manual testing: http://localhost:8000/docs
"""
import json
import math
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from scipy.spatial import cKDTree

# =============================================================================
# CONFIG  (everything you may need to change lives here)
# =============================================================================
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# --- TODO(Maheen): confirm these two answers, then edit only this block -------
SEVERITY_MIN = 1          # valid range of severity_num (her answer pending)
SEVERITY_MAX = 5
TIE_BREAK = "lowest_index"  # two-way roads: which of u->v / v->u gets the report
#                             (used in pick_edge(); change that function if her rule differs)
# -----------------------------------------------------------------------------

ALPHA_MAX = 0.95          # safety slider range is 0.0 .. 0.95
MAX_SNAP_M = 500          # a click further than this from any node = outside the map
DUP_RADIUS_M = 100        # duplicate report: within 100 m ...
DUP_WINDOW_S = 3600       # ... in the last hour
REPORT_SNAP_M = 150       # a report must be within 150 m of a road
N_CANDIDATES = 12         # nearest edge midpoints examined when snapping a report
WOMEN_KEYWORDS = ("harassment", "snatching")
DEBUG_REPORT_INFO = True  # adds an "edge" block to /report responses; set False before submission

R_EARTH_M = 6_371_000.0

# =============================================================================
# LOAD DATA (once, at startup)
# =============================================================================
nodes = pd.read_csv(DATA_DIR / "nodes.csv").sort_values("node_id").reset_index(drop=True)
edges = pd.read_csv(DATA_DIR / "edges.csv")
with open(DATA_DIR / "meta.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

K = float(meta["K"])                              # never recalibrate at runtime
V_MAX = float(meta.get("V_MAX_m_per_s", 15.0))
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

# LIVE state: these four arrays are what /report changes.
LIVE_FIELDS = ["risk_raw", "risk_raw_women", "S", "S_women"]
live = {name: edges[name].to_numpy(dtype=float).copy() for name in LIVE_FIELDS}
original = {name: arr.copy() for name, arr in live.items()}   # for /reset and diffing

recent_reports: list = []   # (x_m, y_m, unix_time) of accepted reports, for dedup
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


def node_path_to_coords(path: list) -> list:
    """[node_id, ...] -> [[lat, lon], ...]  (handy when wiring in the engine)."""
    return [[float(node_lat[n]), float(node_lon[n])] for n in path]


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
def pick_edge(x: float, y: float):
    """
    Edge a report belongs to, or None if no road is within REPORT_SNAP_M.

    Two-way roads have two edges (u->v, v->u) with identical geometry, so their
    distances tie. Current rule: the LOWEST edge index wins.
    TODO(Maheen): if her pipeline breaks ties differently, change it here (only here).
    """
    k = min(N_CANDIDATES, N_EDGES)
    _, cand = edge_tree.query([x, y], k=k)
    cand = np.atleast_1d(cand)
    d = point_to_segment_m(x, y,
                           node_x[edge_u[cand]], node_y[edge_u[cand]],
                           node_x[edge_v[cand]], node_y[edge_v[cand]])
    d_min = float(d.min())
    if d_min > REPORT_SNAP_M:
        return None
    return int(cand[d <= d_min + 1e-6].min())


def is_womens_incident(crime_type: str) -> bool:
    ct = crime_type.lower()
    return any(word in ct for word in WOMEN_KEYWORDS)


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
        return min(max(v, 0.0), ALPHA_MAX)


class ReportRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    crime_type: str = Field(min_length=1, max_length=50)
    severity_num: int = Field(ge=SEVERITY_MIN, le=SEVERITY_MAX)


# =============================================================================
# APP + CORS
# =============================================================================
app = FastAPI(title="PathWise API", version="0.4")

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
    }


# =============================================================================
# ROUTING ENGINE INTEGRATION POINT  (Hasan's C++ engine plugs in here)
# =============================================================================
ENGINE_STATUS = "not_connected"   # set to "cpp" when the real engine is wired in


def call_engine(o_node: int, d_node: int, alpha: float,
                womens_mode: bool, overrides: list) -> dict:
    """
    >>> REPLACE THE BODY OF THIS FUNCTION WITH THE REAL ENGINE CALL <<<

    Inputs
      o_node, d_node : graph node ids (already snapped)
      alpha          : safety weight, 0.0 .. 0.95
      womens_mode    : True -> engine should use S_women instead of S
      overrides      : [{u, v, S, S_women}, ...] edges whose live risk differs from edges.csv

    Must return exactly the frozen response shape:
      {
        "recommended": {"path": [[lat, lon], ...], "distance_m", "time_s", "avg_risk", "cost"},
        "fastest":     {same fields, computed with alpha = 0 but COST scored under `alpha`},
        "benchmark":   {"astar_nodes", "dijkstra_nodes", "astar_ms", "dijkstra_ms", "cost_match"}
      }
    Helper available: node_path_to_coords(list_of_node_ids) -> [[lat, lon], ...]

    Until then this returns a straight-line placeholder so the frontend can be wired up.
    """
    path = node_path_to_coords([o_node, d_node])
    dist = float(math.hypot(node_x[o_node] - node_x[d_node], node_y[o_node] - node_y[d_node]))
    placeholder = {
        "path": path,
        "distance_m": round(dist),
        "time_s": round(dist / V_MAX),
        "avg_risk": 0.0,
        "cost": 0.0,
    }
    return {
        "recommended": placeholder,
        "fastest": dict(placeholder),
        "benchmark": {"astar_nodes": 0, "dijkstra_nodes": 0,
                      "astar_ms": 0.0, "dijkstra_ms": 0.0, "cost_match": True},
    }


# =============================================================================
# ENDPOINTS
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

        e = pick_edge(x, y)
        if e is None:
            return {"status": "rejected", "updated_edges": 0}

        s = float(req.severity_num)
        s_women = s * WOMEN_MULT if is_womens_incident(req.crime_type) else s
        length_km = max(edge_length_m[e] / 1000.0, L_MIN_KM)
        s_before = float(live["S"][e])

        live["risk_raw"][e] += s / length_km
        live["risk_raw_women"][e] += s_women / length_km
        live["S"][e] = 1.0 - math.exp(-live["risk_raw"][e] / K)
        live["S_women"][e] = 1.0 - math.exp(-live["risk_raw_women"][e] / K)

        recent_reports.append((x, y, now))

        result = {"status": "accepted", "updated_edges": 1}
        if DEBUG_REPORT_INFO:
            result["edge"] = {"index": e, "u": int(edge_u[e]), "v": int(edge_v[e]),
                              "S_before": round(s_before, 4),
                              "S_after": round(float(live["S"][e]), 4)}
        return result


@app.post("/reset")
def reset():
    """Restore all live risk values to the CSV values and forget recent reports."""
    with state_lock:
        for name in LIVE_FIELDS:
            live[name][:] = original[name]
        recent_reports.clear()
    return {"status": "reset"}