#!/usr/bin/env python3
"""
validate_risk.py (PathWise, Maheen lane)

Temporal validation of the risk score.

Question: if we build the risk score using only incidents BEFORE a cutoff date,
does it rank road edges by where incidents happen AFTER the cutoff?

Method
  1. Snap all incidents to the nearest edge (<= 150 m), straight-line edge
     geometry from nodes.csv/edges.csv (close to, but not identical to, the
     OSM geometry used in build_graph.py).
  2. Split by time at several cutoffs (default: 60%, 70%, 80% of the date range).
  3. Score each edge from train incidents only, with age measured from the cutoff.
  4. Evaluate against test incidents on three metrics:
       AUC     does an edge with a test incident score higher than one without?
       Spearman  rank correlation of score with test incident count
       Lift@5%   share of test incidents on the top-5% scored edges / 0.05
  5. Compare variants: the model as built, no decay, other tau values, no length
     normalisation, and a shuffled-score null (should be ~0.5 AUC, ~1.0 lift).

Notes
  * S = 1 - exp(-R/K) is monotonic in R, so ranking metrics depend on R only.
    K does not matter here.
  * All edges are used for evaluation, including zero-risk ones (ties).

Usage:
    pip install pandas numpy shapely pyproj scipy
    python validate_risk.py
    python validate_risk.py --splits 0.5 0.65 0.8
"""
import argparse
import json
import os

import numpy as np
import pandas as pd
import shapely
from pyproj import Transformer
from scipy.stats import rankdata, spearmanr

UTM = "EPSG:32642"  # UTM 42N covers Karachi (67 E)
L_MIN_KM = 0.05


def snap_incidents(inc, nodes, edges, snap_m):
    tf = Transformer.from_crs("EPSG:4326", UTM, always_xy=True)
    nx, ny = tf.transform(nodes["lon"].to_numpy(), nodes["lat"].to_numpy())
    xy = np.column_stack([nx, ny])
    xy_by_id = np.zeros((nodes["node_id"].max() + 1, 2))
    xy_by_id[nodes["node_id"].to_numpy()] = xy
    u, v = edges["u"].to_numpy(), edges["v"].to_numpy()
    lines = shapely.linestrings(np.stack([xy_by_id[u], xy_by_id[v]], axis=1))
    tree = shapely.STRtree(lines)

    px, py = tf.transform(inc["lon"].to_numpy(), inc["lat"].to_numpy())
    pts = shapely.points(px, py)
    idx, dist = tree.query_nearest(pts, return_distance=True, all_matches=False)
    order = np.argsort(idx[0])
    edge_idx = np.full(len(inc), -1)
    edge_idx[idx[0][order]] = idx[1][order]
    dist_full = np.full(len(inc), np.inf)
    dist_full[idx[0][order]] = dist[order]
    edge_idx[dist_full > snap_m] = -1
    return edge_idx


def auc_from_scores(score, label):
    pos = label.astype(bool)
    n_pos, n_neg = pos.sum(), (~pos).sum()
    if n_pos == 0 or n_neg == 0:
        return np.nan
    ranks = rankdata(score)  # average ranks handle ties
    return (ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def lift_at(score, test_count, frac=0.05):
    k = max(1, int(len(score) * frac))
    top = np.argsort(-score, kind="stable")[:k]
    total = test_count.sum()
    return (test_count[top].sum() / total) / frac if total > 0 else np.nan


def build_R(edge_idx, ages, sev, L_km, n_edges, tau, length_norm):
    keep = edge_idx >= 0
    w = sev[keep] * (np.exp(-ages[keep] / tau) if tau else 1.0)
    sums = np.bincount(edge_idx[keep], weights=w, minlength=n_edges)
    return sums / L_km if length_norm else sums


def evaluate(R, test_count):
    label = test_count > 0
    rho = spearmanr(R, test_count).statistic
    return auc_from_scores(R, label), rho, lift_at(R, test_count)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--splits", type=float, nargs="+", default=[0.6, 0.7, 0.8])
    ap.add_argument("--snap-m", type=float, default=150.0)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    nodes = pd.read_csv(os.path.join(args.data, "nodes.csv"))
    edges = pd.read_csv(os.path.join(args.data, "edges.csv"))
    inc = pd.read_csv(os.path.join(args.data, "karachi_incidents_clean.csv"))
    meta = json.load(open(os.path.join(args.data, "meta.json")))
    tau_built = meta["TAU_DAYS"]

    inc["date"] = pd.to_datetime(inc["date"], errors="coerce")
    inc = inc.dropna(subset=["date", "lat", "lon", "severity_num"]).reset_index(drop=True)
    # Same bounding box as the graph
    inc = inc[(inc.lat >= nodes.lat.min() - 0.01) & (inc.lat <= nodes.lat.max() + 0.01) &
              (inc.lon >= nodes.lon.min() - 0.01) & (inc.lon <= nodes.lon.max() + 0.01)].reset_index(drop=True)

    print(f"Incidents in graph area: {len(inc)}   edges: {len(edges)}")
    edge_idx = snap_incidents(inc, nodes, edges, args.snap_m)
    print(f"Snapped within {args.snap_m:.0f} m: {(edge_idx >= 0).sum()} ({100 * (edge_idx >= 0).mean():.1f}%)")

    L_km = np.maximum(edges["length_m"].to_numpy() / 1000.0, L_MIN_KM)
    sev = inc["severity_num"].to_numpy(dtype=float)
    dates = inc["date"]
    tmin, tmax = dates.min(), dates.max()
    rng = np.random.default_rng(args.seed)
    all_rows = []

    for frac in args.splits:
        cutoff = tmin + (tmax - tmin) * frac
        is_train = (dates < cutoff).to_numpy()
        is_test = ~is_train
        ages = ((cutoff - dates).dt.total_seconds() / 86400.0).to_numpy()
        test_count = np.bincount(edge_idx[is_test & (edge_idx >= 0)], minlength=len(edges)).astype(float)
        n_test_snapped = int(test_count.sum())
        print(f"\n=== Split {int(frac * 100)}/{int(100 - frac * 100)}  cutoff {cutoff.date()}  "
              f"train {is_train.sum()}  test {is_test.sum()}  test snapped {n_test_snapped}  "
              f"edges with a test incident {int((test_count > 0).sum())} ===")

        et, st, at = edge_idx.copy(), sev, ages
        et[is_test] = -1  # train-only scoring

        variants = {
            f"as built (tau={tau_built:g}, per-km)": build_R(et, at, st, L_km, len(edges), tau_built, True),
            "no decay (per-km)": build_R(et, at, st, L_km, len(edges), None, True),
            "tau=90 (per-km)": build_R(et, at, st, L_km, len(edges), 90, True),
            "tau=1000 (per-km)": build_R(et, at, st, L_km, len(edges), 1000, True),
            "no length norm (tau built)": build_R(et, at, st, L_km, len(edges), tau_built, False),
        }
        base = variants[f"as built (tau={tau_built:g}, per-km)"]
        variants["NULL: shuffled scores"] = rng.permutation(base)

        print(f"{'variant':<34}{'AUC':>8}{'Spearman':>10}{'Lift@5%':>9}")
        for name, R in variants.items():
            auc, rho, lift = evaluate(R, test_count)
            print(f"{name:<34}{auc:>8.3f}{rho:>10.3f}{lift:>9.2f}")
            all_rows.append(dict(split=frac, variant=name, auc=auc, spearman=rho, lift5=lift))

    out = os.path.join(args.data, "validation_results.csv")
    pd.DataFrame(all_rows).to_csv(out, index=False)
    print(f"\nSaved {out}")
    print("\nHow to read: AUC 0.5 and Lift 1.0 = no better than random (see the NULL row).")


if __name__ == "__main__":
    main()
