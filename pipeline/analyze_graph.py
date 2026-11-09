#!/usr/bin/env python3
"""
analyze_graph.py (PathWise, Maheen lane)

Reads data/nodes.csv and data/edges.csv and produces:
  data/od_pairs.csv     100 stratified origin-destination pairs for the
                        A* vs Dijkstra benchmark (fixed seed, reproducible)
  data/high_risk_map.html   Leaflet map: edges with S > threshold, with a
                        layer toggle for base S vs women's S_women

Usage:
    pip install folium pandas numpy
    python analyze_graph.py
    python analyze_graph.py --threshold 0.8 --pairs 100
"""
import argparse
import os

import numpy as np
import pandas as pd
import folium


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def make_od_pairs(nodes, n_pairs, seed):
    """Stratified by straight-line distance: 30% short, 40% medium, 30% long."""
    rng = np.random.default_rng(seed)
    buckets = [("short", 1.0, 4.0, 0.3), ("medium", 4.0, 8.0, 0.4), ("long", 8.0, 15.0, 0.3)]
    lat = nodes["lat"].to_numpy()
    lon = nodes["lon"].to_numpy()
    ids = nodes["node_id"].to_numpy()
    rows = []
    for name, lo, hi, share in buckets:
        target = int(round(n_pairs * share))
        got, tries = 0, 0
        while got < target and tries < target * 500:
            tries += 1
            i, j = rng.integers(0, len(nodes), size=2)
            if i == j:
                continue
            d = haversine_km(lat[i], lon[i], lat[j], lon[j])
            if lo <= d < hi:
                rows.append((ids[i], ids[j], lat[i], lon[i], lat[j], lon[j], round(d, 3), name))
                got += 1
        if got < target:
            print(f"  WARNING: only found {got}/{target} {name} pairs")
    cols = ["origin_id", "dest_id", "origin_lat", "origin_lon",
            "dest_lat", "dest_lon", "straight_km", "bucket"]
    return pd.DataFrame(rows, columns=cols)


def make_map(nodes, edges, threshold, out_path):
    coords = nodes.set_index("node_id")[["lat", "lon"]]
    center = [nodes["lat"].mean(), nodes["lon"].mean()]
    m = folium.Map(location=center, zoom_start=12, tiles="cartodbpositron")

    def colour(s):
        # yellow -> red as S goes threshold -> 1
        t = min(max((s - threshold) / max(1 - threshold, 1e-9), 0), 1)
        r = 255
        g = int(220 * (1 - t))
        return f"#{r:02x}{g:02x}20"

    for col, label, show in [("S", "High risk (base S)", True),
                             ("S_women", "High risk (women's S_women)", False)]:
        sub = edges[edges[col] > threshold]
        fg = folium.FeatureGroup(name=f"{label}: {len(sub)} edges", show=show)
        for r in sub.itertuples():
            a, b = coords.loc[r.u], coords.loc[r.v]
            folium.PolyLine([(a.lat, a.lon), (b.lat, b.lon)],
                            color=colour(getattr(r, col)), weight=3, opacity=0.8).add_to(fg)
        fg.add_to(m)
    folium.LayerControl(collapsed=False).add_to(m)
    m.save(out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--threshold", type=float, default=0.9)
    ap.add_argument("--pairs", type=int, default=100)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    nodes = pd.read_csv(os.path.join(args.data, "nodes.csv"))
    edges = pd.read_csv(os.path.join(args.data, "edges.csv"))
    print(f"Loaded {len(nodes)} nodes, {len(edges)} edges")

    od = make_od_pairs(nodes, args.pairs, args.seed)
    od_path = os.path.join(args.data, "od_pairs.csv")
    od.to_csv(od_path, index=False)
    print(f"Wrote {od_path}: {len(od)} pairs")
    print(od["bucket"].value_counts().to_string())

    map_path = os.path.join(args.data, "high_risk_map.html")
    make_map(nodes, edges, args.threshold, map_path)
    n_hi = int((edges["S"] > args.threshold).sum())
    print(f"Wrote {map_path} ({n_hi} edges with S > {args.threshold})")


if __name__ == "__main__":
    main()
