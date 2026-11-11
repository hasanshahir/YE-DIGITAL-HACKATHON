"""
PathWise API (Arbish's lane)
Step 1: data loader, spatial indexes, request models, CORS, /health, stub /route.

Run from the repo root:
    uvicorn api.main:app --reload --port 8000
Then open http://localhost:8000/docs

IMPORTANT: run with a single worker. Live risk state lives in this process's memory.
"""
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from scipy.spatial import cKDTree

# ----------------------------------------------------------------------------
# Constants (change these in ONE place when teammates confirm answers)
# ----------------------------------------------------------------------------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

SEVERITY_MIN = 1   # TODO: 
SEVERITY_MAX = 5   # TODO: 
ALPHA_MAX = 0.95   # slider range is 0.0 to 0.95
MAX_SNAP_M = 500   # a click further than this from any node is "outside the map"
R_EARTH_M = 6_371_000.0

# ----------------------------------------------------------------------------
# Load data once at startup
# ----------------------------------------------------------------------------
nodes = pd.read_csv(DATA_DIR / "nodes.csv").sort_values("node_id").reset_index(drop=True)
edges = pd.read_csv(DATA_DIR / "edges.csv")
with open(DATA_DIR / "meta.json", "r", encoding="utf-8") as f:
    meta = json.load(f)

K = float(meta["K"])  # never recalibrate at runtime
V_MAX = float(meta.get("V_MAX_m_per_s", 15.0))

N_NODES = len(nodes)
N_EDGES = len(edges)
assert (nodes["node_id"].to_numpy() == np.arange(N_NODES)).all(), \
    "node_id must be contiguous 0..N-1"

node_lat = nodes["lat"].to_numpy(dtype=float)
node_lon = nodes["lon"].to_numpy(dtype=float)

# Edge arrays. These are the LIVE values that /report will change.
edge_u = edges["u"].to_numpy(dtype=int)
edge_v = edges["v"].to_numpy(dtype=int)
edge_length_m = edges["length_m"].to_numpy(dtype=float)
edge_time_s = edges["time_s"].to_numpy(dtype=float)

LIVE_FIELDS = ["risk_raw", "risk_raw_women", "S", "S_women"]
live = {name: edges[name].to_numpy(dtype=float).copy() for name in LIVE_FIELDS}
original = {name: arr.copy() for name, arr in live.items()}  # for /reset later

# ----------------------------------------------------------------------------
# Lat/lon -> meters (equirectangular, accurate enough for one city)
# ----------------------------------------------------------------------------
LAT0 = float(node_lat.mean())
LON0 = float(node_lon.mean())
COS_LAT0 = math.cos(math.radians(LAT0))


def to_xy(lat, lon):
    """Convert lat/lon (scalars or arrays) to meters from the map centre."""
    lat = np.asarray(lat, dtype=float)
    lon = np.asarray(lon, dtype=float)
    x = np.radians(lon - LON0) * R_EARTH_M * COS_LAT0
    y = np.radians(lat - LAT0) * R_EARTH_M
    return x, y


node_x, node_y = to_xy(node_lat, node_lon)

# Edge midpoints (used later by /report to find candidate edges)
edge_mid_x = (node_x[edge_u] + node_x[edge_v]) / 2.0
edge_mid_y = (node_y[edge_u] + node_y[edge_v]) / 2.0

# Spatial indexes
node_tree = cKDTree(np.column_stack([node_x, node_y]))
edge_tree = cKDTree(np.column_stack([edge_mid_x, edge_mid_y]))


def snap_to_node(lat: float, lon: float) -> int:
    """Return the nearest graph node id, or raise a clean 422 if too far away."""
    x, y = to_xy(lat, lon)
    dist, idx = node_tree.query([float(x), float(y)])
    if dist > MAX_SNAP_M:
        raise HTTPException(
            status_code=422,
            detail="Point is outside the Central Karachi map area.",
        )
    return int(idx)


# ----------------------------------------------------------------------------
# Request models (match the frozen contracts)
# ----------------------------------------------------------------------------
class RouteRequest(BaseModel):
    origin: list[float] = Field(min_length=2, max_length=2)       # [lat, lon]
    destination: list[float] = Field(min_length=2, max_length=2)  # [lat, lon]
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


# ----------------------------------------------------------------------------
# App + CORS
# ----------------------------------------------------------------------------
app = FastAPI(title="PathWise API", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # fine for a hackathon demo
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
        "engine": "stub",  # change to "cpp" once Hasan's engine is wired in
    }


# ----------------------------------------------------------------------------
# /route  (STUB: straight line between the snapped nodes, dummy numbers)
# Replace _stub_route() with the real engine call later. Response shape is final.
# ----------------------------------------------------------------------------
def _stub_route(o_node: int, d_node: int) -> dict:
    path = [
        [float(node_lat[o_node]), float(node_lon[o_node])],
        [float(node_lat[d_node]), float(node_lon[d_node])],
    ]
    dist = float(math.hypot(node_x[o_node] - node_x[d_node],
                            node_y[o_node] - node_y[d_node]))
    return {
        "path": path,
        "distance_m": round(dist),
        "time_s": round(dist / V_MAX),
        "avg_risk": 0.0,
        "cost": 0.0,
    }


@app.post("/route")
def route(req: RouteRequest):
    o_node = snap_to_node(req.origin[0], req.origin[1])
    d_node = snap_to_node(req.destination[0], req.destination[1])

    result = _stub_route(o_node, d_node)
    return {
        "recommended": result,
        "fastest": dict(result),
        "benchmark": {
            "astar_nodes": 0,
            "dijkstra_nodes": 0,
            "astar_ms": 0.0,
            "dijkstra_ms": 0.0,
            "cost_match": True,
        },
    }