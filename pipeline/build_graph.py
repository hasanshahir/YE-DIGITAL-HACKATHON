#!/usr/bin/env python3
"""
build_graph.py  (PathWise, Maheen lane)

Builds the Central Karachi road graph, scores every edge for risk from
incident data, and writes the frozen contract files:

    data/nodes.csv   node_id, lat, lon
    data/edges.csv   u, v, length_m, time_s, risk_raw, risk_raw_women,
                     S, S_women, T, W
    data/meta.json   W_SAFETY, W_TIME, T_MAX_S, V_MAX_m_per_s, K, TAU_DAYS,
                     reference_date, ...

Model (from blueprint v2.0):
    R(e) = (1 / max(L_km, 0.05)) * sum_i s_i * exp(-age_i / tau)
    S(e) = 1 - exp(-R(e) / K)          K = median of non-zero base R(e)
    T(e) = time_s / T_MAX_S
    W(e) = T(e) * ((1 - alpha) + alpha * S(e))

Design decisions (tell Hasan and Arbish):
  * Each incident snaps to its SINGLE nearest edge, dropped if > 150 m away.
    /report must use the same rule.
  * Node ids are remapped to contiguous ints 0..N-1 (easier for the C++ loader).
  * Only the largest strongly connected component is kept, and parallel
    edges are collapsed to the fastest one, so (u, v) is unique.
  * K is calibrated once on base risk and reused for S_women, so the 2.5x
    women multiplier is not normalised away.
  * risk_raw / risk_raw_women are per-km R(e) values. For a live report on
    edge e: R += s * 1.0 / max(length_m / 1000, L_MIN_KM), then recompute S
    with the K from meta.json.
  * V_MAX is the max of length/time over all edges, so the A* heuristic
    h(n) = (1 - alpha) * haversine / (V_MAX * T_MAX_S) is admissible.

Usage:
    pip install osmnx pandas numpy pyproj shapely
    python build_graph.py
    python build_graph.py --incidents data/karachi_incidents_clean.csv --plot
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import osmnx as ox
from pyproj import Transformer
from shapely.geometry import box

# Central Karachi: Saddar, Clifton, PECHS, Gulshan-e-Iqbal, Nazimabad, Karsaz
# (west, south, east, north). Adjust after looking at the map if needed.
DEFAULT_BBOX = (66.99, 24.80, 67.15, 24.95)

L_MIN_KM = 0.05          # floor on segment length in the R(e) division
MIN_TIME_S = 0.5         # avoids zero-time edges (T must be > 0)
WOMEN_KEYWORDS = ("harass", "snatch")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--incidents", default="data/karachi_incidents_clean.csv")
    p.add_argument("--out", default="data")
    p.add_argument("--alpha", type=float, default=0.60, help="default safety weight")
    p.add_argument("--tau", type=float, default=365.0, help="decay constant, days")
    p.add_argument("--snap-m", type=float, default=150.0, help="max snap distance")
    p.add_argument("--women-mult", type=float, default=2.5)
    p.add_argument("--bbox", type=float, nargs=4, metavar=("W", "S", "E", "N"),
                   default=DEFAULT_BBOX)
    p.add_argument("--plot", action="store_true", help="save S histogram PNG")
    return p.parse_args()


# --------------------------------------------------------------------------
# Graph
# --------------------------------------------------------------------------
def build_road_graph(bbox):
    west, south, east, north = bbox
    print(f"Downloading drivable network for bbox W{west} S{south} E{east} N{north} ...")
    G = ox.graph_from_polygon(box(west, south, east, north), network_type="drive",
                              simplify=True)
    G = ox.add_edge_speeds(G)          # km/h, imputed from highway type where missing
    # NEW: repair zero / NaN / absurdly low speeds before computing travel time
    for _, _, d in G.edges(data=True):
        sp = d.get("speed_kph")
        if sp is None or not np.isfinite(sp) or sp < 5:
            d["speed_kph"] = 20.0

    G = ox.add_edge_travel_times(G)    # seconds
    print(f"  raw graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    # Collapse parallel edges (keep fastest) and drop self-loops
    best = {}
    for u, v, k, d in G.edges(keys=True, data=True):
        if u == v:
            continue
        if (u, v) not in best or d["travel_time"] < best[(u, v)][1]:
            best[(u, v)] = (k, d["travel_time"])
    drop = [(u, v, k) for u, v, k in G.edges(keys=True)
            if u == v or best[(u, v)][0] != k]
    G.remove_edges_from(drop)

    # Largest strongly connected component only (guarantees a route exists)
    G = ox.truncate.largest_component(G, strongly=True)
    print(f"  cleaned graph (largest SCC): {G.number_of_nodes()} nodes, "
          f"{G.number_of_edges()} edges")
    return G


# --------------------------------------------------------------------------
# Incidents
# --------------------------------------------------------------------------
def load_incidents(path, bbox):
    if not os.path.exists(path):
        sys.exit(f"Incident file not found: {path} (run explore_karachi.py first)")
    df = pd.read_csv(path)
    df.columns = [c.strip().lower() for c in df.columns]
    need = {"date", "lat", "lon", "crime_type", "severity_num", "victim_gender"}
    missing = need - set(df.columns)
    if missing:
        sys.exit(f"Incident file is missing columns: {sorted(missing)}")

    n0 = len(df)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df["severity_num"] = pd.to_numeric(df["severity_num"], errors="coerce")
    df = df.dropna(subset=["date", "lat", "lon", "severity_num"])

    west, south, east, north = bbox
    df = df[(df.lon >= west) & (df.lon <= east) & (df.lat >= south) & (df.lat <= north)]
    print(f"Incidents: {n0} rows -> {len(df)} valid and inside bbox")
    return df.reset_index(drop=True)


def women_flag(df):
    """Women's mode flag: harassment OR snatching OR female victim."""
    ct = df["crime_type"].astype(str).str.lower()
    vg = df["victim_gender"].astype(str).str.strip().str.lower()
    by_type = ct.apply(lambda s: any(k in s for k in WOMEN_KEYWORDS))
    by_victim = vg.isin(["f", "female", "woman", "women"])
    return (by_type | by_victim).to_numpy()


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)

    G = build_road_graph(args.bbox)
    inc = load_incidents(args.incidents, args.bbox)

    # Contiguous node ids
    osm_ids = list(G.nodes())
    nid = {osm: i for i, osm in enumerate(osm_ids)}

    # Edge table (one row per directed edge)
    rows = []
    for u, v, k, d in G.edges(keys=True, data=True):
        rows.append((u, v, k, float(d["length"]), max(float(d["travel_time"]), MIN_TIME_S)))
    E = pd.DataFrame(rows, columns=["u_osm", "v_osm", "key", "length_m", "time_s"])
    edge_index = {(r.u_osm, r.v_osm, r.key): i for i, r in enumerate(E.itertuples())}

    # ---- snap incidents to nearest edge (projected CRS, meters) ----
    Gp = ox.project_graph(G)
    tf = Transformer.from_crs("EPSG:4326", Gp.graph["crs"], always_xy=True)
    X, Y = tf.transform(inc["lon"].to_numpy(), inc["lat"].to_numpy())
    ne, dist = ox.distance.nearest_edges(Gp, X, Y, return_dist=True)
    dist = np.asarray(dist)
    keep = dist <= args.snap_m
    print(f"Snapped within {args.snap_m:.0f} m: {keep.sum()} / {len(inc)} "
          f"({100 * keep.mean():.1f}%). Median snap distance: {np.median(dist):.0f} m")
    if keep.mean() < 0.5:
        print("  WARNING: under half the incidents survive snapping. S will be sparse. "
              "Check whether the synthetic lat/lon fall on roads.")

    # ---- severity, decay, women multiplier ----
    ref_date = inc["date"].max()
    age_days = (ref_date - inc["date"]).dt.total_seconds().to_numpy() / 86400.0
    decay = np.exp(-age_days / args.tau)
    s = inc["severity_num"].to_numpy(dtype=float)
    s_women = np.where(women_flag(inc), s * args.women_mult, s)

    contrib = s * decay
    contrib_w = s_women * decay

    sum_base = np.zeros(len(E))
    sum_women = np.zeros(len(E))
    for idx in np.flatnonzero(keep):
        u, v, k = ne[idx]
        row = edge_index[(u, v, k)]
        sum_base[row] += contrib[idx]
        sum_women[row] += contrib_w[idx]

    # ---- risk model ----
    L_km = np.maximum(E["length_m"].to_numpy() / 1000.0, L_MIN_KM)
    R = sum_base / L_km
    R_w = sum_women / L_km

    nonzero = R[R > 0]
    if len(nonzero) == 0:
        sys.exit("No edge received any incident. Cannot calibrate K.")
    K = float(np.median(nonzero))

    S = 1.0 - np.exp(-R / K)
    S_w = 1.0 - np.exp(-R_w / K)       # same K on purpose

    # ---- time, cost, heuristic constants ----
    T_MAX = float(E["time_s"].max())
    V_MAX = float((E["length_m"] / E["time_s"]).max())
    T = E["time_s"].to_numpy() / T_MAX
    W = T * ((1 - args.alpha) + args.alpha * S)

    # ---- write outputs ----
    nodes = pd.DataFrame({
        "node_id": range(len(osm_ids)),
        "lat": [G.nodes[o]["y"] for o in osm_ids],
        "lon": [G.nodes[o]["x"] for o in osm_ids],
    })
    edges = pd.DataFrame({
        "u": E["u_osm"].map(nid),
        "v": E["v_osm"].map(nid),
        "length_m": E["length_m"].round(2),
        "time_s": E["time_s"].round(3),
        "risk_raw": R,
        "risk_raw_women": R_w,
        "S": S,
        "S_women": S_w,
        "T": T,
        "W": W,
    })
    nodes.to_csv(os.path.join(args.out, "nodes.csv"), index=False)
    edges.to_csv(os.path.join(args.out, "edges.csv"), index=False, float_format="%.6f")

    meta = {
        "W_SAFETY": args.alpha,
        "W_TIME": round(1 - args.alpha, 6),
        "T_MAX_S": T_MAX,
        "V_MAX_m_per_s": V_MAX,
        "K": K,
        "TAU_DAYS": args.tau,
        "reference_date": ref_date.strftime("%Y-%m-%d"),
        "WOMEN_MULT": args.women_mult,
        "SNAP_M": args.snap_m,
        "L_MIN_KM": L_MIN_KM,
        "n_nodes": int(len(nodes)),
        "n_edges": int(len(edges)),
        "n_incidents_used": int(keep.sum()),
    }
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    # ---- sanity report ----
    print("\n=== Sanity report ===")
    print(f"nodes: {len(nodes)}   edges: {len(edges)}")
    print(f"T_MAX_S: {T_MAX:.1f}   V_MAX: {V_MAX:.2f} m/s ({V_MAX * 3.6:.0f} km/h)   K: {K:.4f}")
    print(f"edges with zero risk: {100 * (R == 0).mean():.1f}%")
    q = [50, 75, 90, 95, 99]
    print("S percentiles   " + "  ".join(f"p{p}={np.percentile(S, p):.3f}" for p in q))
    print("S_women pctls   " + "  ".join(f"p{p}={np.percentile(S_w, p):.3f}" for p in q))
    print(f"edges with S > 0.9: {100 * (S > 0.9).mean():.1f}%   (high = K too small / saturated)")
    assert (T > 0).all() and (T <= 1.0 + 1e-9).all(), "T out of (0, 1]"
    assert (S >= 0).all() and (S <= 1).all(), "S out of [0, 1]"
    assert (S_w >= S - 1e-12).all(), "S_women must be >= S"
    print("Checks passed. Commit data/nodes.csv, data/edges.csv, data/meta.json")

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(1, 2, figsize=(10, 3.5))
        ax[0].hist(S, bins=50)
        ax[0].set_title("S(e)")
        ax[0].set_yscale("log")
        ax[1].hist(S_w, bins=50)
        ax[1].set_title("S_women(e)")
        ax[1].set_yscale("log")
        fig.tight_layout()
        out = os.path.join(args.out, "S_hist.png")
        fig.savefig(out, dpi=120)
        print(f"Saved {out}")


if __name__ == "__main__":
    main()
