"""
Independent check of the C++ engine  (Hasan's lane).  Standard library only.

    python engine/verify_engine.py

1. Re-implements the weight formula and Dijkstra in plain Python and compares the optimal
   cost with the engine for several OD pairs, alphas and both modes.
2. Checks the /route response shape matches the frozen contract.
3. Checks live overrides (what /report produces) change the route and do not leak
   into the next request.
4. Checks fastest-route invariants (never slower than recommended; recommended never costlier).
"""
import csv
import heapq
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from engine.engine_client import DATA_DIR, Engine  # noqa: E402

FAILS = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


def load_graph():
    adj = {}
    T, S, Sw = [], [], []
    with open(DATA_DIR / "edges.csv", newline="") as f:
        for i, r in enumerate(csv.DictReader(f)):
            u, v = int(r["u"]), int(r["v"])
            adj.setdefault(u, []).append((v, i))
            T.append(float(r["T"])); S.append(float(r["S"])); Sw.append(float(r["S_women"]))
    return adj, T, S, Sw


def ref_dijkstra(adj, T, Sa, s, t, alpha):
    dist = {s: 0.0}
    pq = [(0.0, s)]
    done = set()
    while pq:
        d, u = heapq.heappop(pq)
        if u in done:
            continue
        done.add(u)
        if u == t:
            return d
        for v, e in adj.get(u, ()):
            nd = d + T[e] * ((1 - alpha) + alpha * Sa[e])
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    return math.inf


def main():
    print("loading graph in Python ...")
    adj, T, S, Sw = load_graph()
    with open(DATA_DIR / "od_pairs.csv", newline="") as f:
        pairs = [(int(r["origin_id"]), int(r["dest_id"]), r["bucket"]) for r in csv.DictReader(f)]
    sample = pairs[::12]  # spread across short / medium / long

    eng = Engine()
    eng.start()
    print(f"engine ready: {eng.info}\n")

    print("1) optimal cost vs pure-Python Dijkstra")
    for o, d, bucket in sample:
        for alpha in (0.0, 0.6, 0.95):
            for women in (False, True):
                r = eng.route(o, d, alpha, women)
                ref = ref_dijkstra(adj, T, Sw if women else S, o, d, alpha)
                got = r["recommended"]["cost"]
                check(abs(got - ref) <= 1e-5 * max(1, ref) and r["benchmark"]["cost_match"],
                      f"{bucket:6s} {o}->{d} alpha={alpha} women={women}: engine {got:.6f} ref {ref:.6f}")

    print("\n2) response shape")
    r = eng.route(*sample[0][:2], 0.6, False)
    check(set(r) == {"recommended", "fastest", "benchmark"}, "top-level keys")
    for k in ("recommended", "fastest"):
        check(set(r[k]) == {"path", "distance_m", "time_s", "avg_risk", "cost"}, f"{k} keys")
        check(all(len(p) == 2 for p in r[k]["path"]), f"{k} path is [[lat, lon], ...]")
    check(set(r["benchmark"]) == {"astar_nodes", "dijkstra_nodes", "astar_ms", "dijkstra_ms", "cost_match"},
          "benchmark keys")
    check(json.loads(json.dumps(r)) == r, "JSON serialisable")

    print("\n3) live overrides (simulated /report on every edge of the recommended path)")
    o, d, _ = pairs[50]
    base = eng.route(o, d, 0.9, False)
    path = base["recommended"]["path"]
    # rebuild node ids of the path from coordinates
    coord_to_id = {}
    with open(DATA_DIR / "nodes.csv", newline="") as f:
        for row in csv.DictReader(f):
            coord_to_id[(round(float(row["lat"]), 7), round(float(row["lon"]), 7))] = int(row["node_id"])
    ids = [coord_to_id[(round(a, 7), round(b, 7))] for a, b in path]
    overrides = [{"u": u, "v": v, "S": 0.999, "S_women": 0.999} for u, v in zip(ids, ids[1:])]
    hot = eng.route(o, d, 0.9, False, overrides)
    check(hot["recommended"]["path"] != path, "route changes when its roads become high-risk")
    check(hot["recommended"]["cost"] > base["recommended"]["cost"], "optimal cost increases")
    check(hot["benchmark"]["cost_match"], "A* still matches Dijkstra with overrides")
    again = eng.route(o, d, 0.9, False)
    check(again["recommended"]["cost"] == base["recommended"]["cost"], "overrides do not leak into the next call")
    bad = eng.route(o, d, 0.9, False, [{"u": 0, "v": 0, "S": 1, "S_women": 1}])
    check(bad["recommended"]["cost"] == base["recommended"]["cost"], "unknown edge override is ignored")

    print("\n4) fastest vs recommended invariants (all 100 pairs, alpha 0.6, both modes)")
    ok_time = ok_cost = 0
    t0 = time.perf_counter()
    n = 0
    for o, d, _ in pairs:
        for women in (False, True):
            r = eng.route(o, d, 0.6, women)
            n += 1
            ok_time += r["fastest"]["time_s"] <= r["recommended"]["time_s"] + 0.5
            ok_cost += r["recommended"]["cost"] <= r["fastest"]["cost"] + 1e-6
    ms = (time.perf_counter() - t0) * 1000 / n
    check(ok_time == n, f"fastest is never slower than recommended ({ok_time}/{n})")
    check(ok_cost == n, f"recommended never costs more than fastest under alpha ({ok_cost}/{n})")
    print(f"  info average round-trip per /route call through the client: {ms:.1f} ms")

    print("\n5) same point twice")
    r = eng.route(o, o, 0.6, False)
    check(len(r["recommended"]["path"]) == 1 and r["recommended"]["distance_m"] == 0, "origin == destination")

    eng.close()
    print("\nALL CHECKS PASSED" if not FAILS else f"\n{len(FAILS)} CHECK(S) FAILED")
    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()

