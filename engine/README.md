# Routing engine (Hasan)

C++17 A\* and Dijkstra over the Central Karachi road graph, plus the benchmark and the Python
bridge the API uses. No third-party C++ or Python dependencies.

```
engine/
  graph.hpp          loads nodes.csv, edges.csv, meta.json; CSR adjacency; heuristic bound check
  search.hpp         A* / Dijkstra (one implementation, heuristic on or off), path summary
  main.cpp           CLI: --serve (for the API), --route, --bench
  engine_client.py   Python bridge for api/main.py (stdlib only, auto-builds the binary)
  verify_engine.py   independent checks against a pure-Python Dijkstra
```

## Build

From the repository root:

```
g++ -O2 -std=c++17 -o engine/pathwise_engine engine/main.cpp
```

The binary is not committed (it is in `.gitignore`). `engine_client.py` compiles it automatically
on first use if it is missing or older than the sources and `g++` is on PATH.

## Use

```
engine/pathwise_engine --route 4291 37218                # one query, prints the /route JSON
engine/pathwise_engine --route 4291 37218 --alpha 0.95 --womens
engine/pathwise_engine --bench                           # 100 OD pairs -> data/benchmark_results.csv
engine/pathwise_engine --serve                           # persistent mode used by the API
python engine/verify_engine.py                           # correctness checks
```

On Windows the binary is `engine\pathwise_engine.exe`. Run from the repository root (or pass `--data DIR`).

## What it computes

- **Edge weight at query time:** `W(e) = T(e) * ((1 - alpha) + alpha * S(e))`, with `S_women` in women's
  mode. Weights are computed on the fly, so any alpha, either mode and live overrides all work
  without touching `edges.csv`.
- **A\*:** `h(n) = (1 - alpha) * haversine(n, goal) / (V_MAX * T_MAX_S)`.
  At load time the engine checks every edge against that bound. Rounding in `edges.csv` puts 18 very
  short edges a hair under it, so the heuristic is scaled by the worst ratio (0.99989). With that scale
  the heuristic is consistent, which guarantees A\* returns exactly Dijkstra's optimal cost for every
  alpha, mode and live update.
- **Dijkstra:** same code with the heuristic off. Both stop when the destination is settled.
  "Nodes explored" means nodes settled.
- **Fastest baseline:** A\* with alpha = 0. Its `cost` is then re-scored under the requested alpha,
  so the two routes' costs are comparable.
- **Per route:** `path` as `[[lat, lon], ...]`, `distance_m`, `time_s`, `avg_risk` (length-weighted mean
  of S, or S_women in women's mode, along the path) and `cost` (sum of W).
- **Per `/route` call:** the requested route by A\*, the same query by Dijkstra (for the benchmark block
  and the `cost_match` flag), and the fastest route.

## API integration (for Arbish)

The engine runs as one child process that loads the graph once (about 0.6 s) and then answers each
request over stdin/stdout. A full `/route` (A\* + Dijkstra + fastest) takes about 15 ms round trip.

In `api/main.py`, replace the body of `call_engine()`:

```python
from engine.engine_client import route as engine_route

ENGINE_STATUS = "cpp"

def call_engine(o_node, d_node, alpha, womens_mode, overrides):
    return engine_route(o_node, d_node, alpha, womens_mode, overrides)
```

- `overrides` is exactly what `changed_edges()` already returns: `[{u, v, S, S_women}, ...]`.
  They apply to that request only, so the API stays the single owner of live state and `/reset` needs
  no engine call.
- The return value is the frozen response shape. Errors raise `engine_client.EngineError`.
- Requests are serialised with a lock; the process restarts itself once if it dies.

### `--serve` protocol

```
-> ROUTE <origin_node> <dest_node> <alpha> <womens 0|1> <n_overrides>
-> <u> <v> <S> <S_women>                     (n_overrides lines)
<- {"recommended": {...}, "fastest": {...}, "benchmark": {...}}     one line
-> PING   <- {"ok":true}
-> QUIT
```

The first stdout line is `{"ready":true,"nodes":...,"edges":...,"h_scale":...}`. Errors come back as
`{"error":"..."}`. Diagnostics go to stderr only.

## Benchmark

`--bench` runs both algorithms on the 100 pairs in `data/od_pairs.csv` (30 short, 40 medium, 30 long).
Each search runs 5 times and the fastest run is kept. Results at alpha = 0.60, general mode:

| Bucket | Pairs | Cost match | A\* nodes | Dijkstra nodes | Node ratio | A\* ms | Dijkstra ms | Speed-up |
|---|---|---|---|---|---|---|---|---|
| short | 30 | 30/30 | 2,181 | 4,091 | 0.561 | 0.373 | 0.562 | 1.47x |
| medium | 40 | 40/40 | 7,156 | 13,942 | 0.509 | 1.487 | 2.522 | 1.64x |
| long | 30 | 30/30 | 19,084 | 32,134 | 0.637 | 4.813 | 6.641 | 1.24x |
| **all** | **100** | **100/100** | **7,156** | **13,390** | **0.560** | **1.485** | **2.419** | **1.49x** |

Values are medians per pair. Ratios are A\* / Dijkstra. Runtimes depend on the machine.

Cost match is also 100/100 for women's mode, alpha = 0.95 and alpha = 0. A\* gains less as alpha rises,
because the heuristic is multiplied by `(1 - alpha)`:

| Setting | Node ratio (median) | Speed-up (median) |
|---|---|---|
| alpha = 0 (fastest) | 0.484 | 1.66x |
| alpha = 0.60 | 0.560 | 1.49x |
| alpha = 0.60, women's mode | 0.570 | 1.44x |
| alpha = 0.95 | 0.673 | 1.21x |

## Verification

`python engine/verify_engine.py` checks:

1. Optimal cost equals a pure-Python Dijkstra for 9 OD pairs x 3 alphas x 2 modes.
2. The response matches the frozen `/route` contract.
3. Live overrides reroute the path, keep A\* = Dijkstra, and do not leak into the next request.
4. On all 100 pairs in both modes, the fastest route is never slower than the recommended one, and the
   recommended route never costs more than the fastest one under alpha.
5. Origin equal to destination returns a single-point path.

