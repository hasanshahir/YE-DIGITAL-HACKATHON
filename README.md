# PathWise
> **Live Prototype:** https://ye-digital-hackathon-frontend.vercel.app/  
> **Backend API:** https://ye-digital-hackathon.onrender.com

> **A hackathon project built for the YE Digital Hackathon 2026 (Open Innovation Track).**

A safety-aware route planner for Karachi. Instead of returning only the shortest or fastest route, it finds the route with the lowest combined cost of **travel time and exposure to recorded incidents**, and shows it next to the fastest route so the trade-off is visible.

## What it does

- Models the Central Karachi road network as a directed graph (intersections are nodes, road segments are edges).
- Scores every road segment for risk from historical incident data, with newer incidents weighted higher through exponential decay.
- Routes with A* search and benchmarks it against Dijkstra's algorithm (nodes explored and runtime). Both return the same optimal cost.
- Lets users report an incident from the map. Nearby road risk updates in memory and the route is recomputed.
- Has a Women's Safety Mode that applies a 2.5x severity multiplier to harassment, snatching and female-victim records.

Default behaviour is General Public Safety: 60% safety weight, 40% time weight. The safety slider moves the weight between 0% and 95%.

## What it does not do

Out of scope for v1: live traffic congestion, public transport routing, and turn-by-turn voice navigation.

The planner does **not** claim that any route is safe in the real world. It reports routes that minimise exposure to the incidents recorded in its dataset.

**The base dataset is synthetic.** It is Kaggle benchmark data (`ahsanneural/karachi-crime`), not real police records. Live reporting is how the system demonstrates real-time updates.

## Architecture

```
Kaggle CSV + OSM roads
        |
  [ Data pipeline ]  ->  data/nodes.csv, edges.csv, meta.json
        |
  [ C++ routing engine ]  <-  [ FastAPI: /route, /report, live edge state ]  <-  [ Leaflet map UI ]
```

| Layer | Component | Owner |
|---|---|---|
| Data pipeline | Raw incidents and OSM roads to risk scores and graph files | Maheen |
| Routing engine | C++ A* and Dijkstra, benchmark metrics | Hasan Shahir |
| Backend | FastAPI `/route` and `/report`, in-memory edge store, duplicate detection | Arbish |
| Client | Leaflet map UI: slider, women's mode toggle, dual routes, benchmark card, report modal | Maheen and Hasan |

## Repository layout

```
data/
  nodes.csv                    node_id, lat, lon
  edges.csv                    u, v, length_m, time_s, risk_raw, risk_raw_women, S, S_women, T, W
  meta.json                    constants used by the engine and API
  od_pairs.csv                 100 fixed origin-destination pairs for the benchmark
  karachi_incidents_clean.csv  cleaned incident data
  validation_results.csv       temporal validation output
  benchmark_results.csv        100-pair A* vs Dijkstra benchmark output
pipeline/                      data scripts (Maheen)
engine/                        C++ routing engine & Python bridge (Hasan)
api/                           FastAPI service (Arbish)
frontend/
  index.html                   Leaflet client (deployed on Vercel)
  routes.js                    offline/fallback demo routes
docs/
  SUBMISSION.md                hackathon submission & judging documentation
requirements.txt               API Python dependencies
.dockerfile                    container setup for API deployment
```

Run scripts from the repository root so the `data/` paths resolve.

## Quick start

The generated files in `data/` are committed, so the engine and API run without rebuilding the graph. Start at step 2 unless you are changing the data.

### 1. Data pipeline (Maheen)

```
python -m venv .venv
.venv\Scripts\activate
pip install osmnx pandas numpy pyproj shapely scipy folium matplotlib

python pipeline/explore_karachi.py karachi_crime.csv
python pipeline/build_graph.py --plot
python pipeline/analyze_graph.py
python pipeline/validate_risk.py
```

`explore_karachi.py` cleans the Kaggle CSV and writes `data/karachi_incidents_clean.csv`. `build_graph.py` builds the graph, scores risk and writes the three contract files. `analyze_graph.py` writes the OD pairs and a high-risk map. `validate_risk.py` runs the temporal hold-out. The raw Kaggle CSV is not committed; download it from Kaggle to rebuild.

### 2. C++ routing engine (Hasan)

The engine loads `data/nodes.csv`, `data/edges.csv` and `data/meta.json` into memory and answers routing queries.

```
g++ -O2 -std=c++17 -o engine/pathwise_engine engine/main.cpp
engine/pathwise_engine --help
engine/pathwise_engine --route 4291 37218 --alpha 0.6     # one query, prints the /route JSON
engine/pathwise_engine --bench                            # 100-pair benchmark
python engine/verify_engine.py                            # correctness checks
```

The API does not call the binary per request. `engine/engine_client.py` keeps one `--serve` process running, sends each query over stdin/stdout, and builds the binary automatically if `g++` is available. Details, protocol and integration steps are in [engine/README.md](engine/README.md).

What the engine does:

- **Edge weight at query time:** `W(e) = T(e) * ((1 - alpha) + alpha * S(e))`. In women's mode it uses `S_women` instead of `S`. The `W` column in `edges.csv` is only the default (alpha = 0.60, base S), so the engine must recompute weights for any other alpha or mode.
- **A\*:** heuristic `h(n) = (1 - alpha) * haversine(n, goal) / (V_MAX * T_MAX_S)`, using `V_MAX_m_per_s` and `T_MAX_S` from `meta.json`. At load time the engine checks every edge against this bound; rounding leaves 18 very short edges a hair under it, so the heuristic is scaled by the worst ratio (0.99989). That keeps it consistent, so A* returns the same optimal cost as Dijkstra.
- **Dijkstra:** the baseline for the benchmark and for correctness checks.
- **Fastest baseline:** the same search with alpha = 0.
- **Outputs per query:** the path (returned as `[[lat, lon], ...]`), distance in metres, time in seconds, average S along the path (length-weighted), total cost, plus benchmark numbers (nodes explored and runtime in ms for both algorithms, and whether the costs match).

Benchmark: run both algorithms on the 100 pairs in `data/od_pairs.csv` (30 short, 40 medium, 30 long by straight-line distance, fixed seed). The pass criterion is 100% cost match. Report the median and mean ratio of nodes explored and of runtime.

| Metric | Result |
|---|---|
| Cost match (A* vs Dijkstra) | 100 / 100 (100%) |
| Nodes explored, A* vs Dijkstra (median) | 7,156 vs 13,390 (A* explores 0.56x, mean 0.57x) |
| Runtime, A* vs Dijkstra (median, ms) | 1.49 vs 2.42 (A* takes 0.67x, mean 0.70x) |

Measured at alpha = 0.60, general mode, fastest of 5 runs per pair. Runtimes depend on the machine. Cost match is also 100/100 in women's mode and at alpha = 0 and 0.95. Per-pair results are in `data/benchmark_results.csv`, and the per-bucket breakdown is in [engine/README.md](engine/README.md).

### 3. API (Arbish)

A FastAPI service that holds the live edge state, calls the C++ engine for routes, and handles incident reports.

```
pip install -r requirements.txt
uvicorn api.main:app --port 8000
```

Run from the repository root with a single worker (live state lives in process memory; avoid `--reload` on Windows so the engine binary is not locked).

Endpoints (the contracts are in the section below):

- **`GET /health`** returns service status, graph counts, `K`, live report count, and engine status (`"cpp"`).
- **`POST /route`** runs the engine with the requested safety weight and with `alpha = 0` for the fastest baseline, and returns both plus the benchmark block.
- **`POST /report`** validates the incident, rejects duplicates, updates the nearest road's risk (both directions on two-way roads) and recomputes `S` and `S_women`, so the next `/route` call sees the change.
- **`POST /reset`** restores all live edge risk values back to `data/edges.csv` and clears recent reports.

Live state:

- Edge risk lives in memory, loaded from `data/edges.csv` at startup. It resets when the service restarts.
- `K` and the other constants are read from `data/meta.json`. Never recalibrate K at runtime.
- The engine must route on the updated values, not the CSV. How the updated S is passed to the engine is an integration detail between the API and engine owners.
- CORS must be enabled (`CORSMiddleware`) so the browser frontend can call the API.

### 4. Frontend

Visit the live deployment at https://ye-digital-hackathon-frontend.vercel.app/ or open `frontend/index.html` locally in a browser (requires internet for Leaflet and OpenStreetMap tiles).

In `frontend/index.html`, `CONFIG.API_BASE` points to the hosted backend (`https://ye-digital-hackathon.onrender.com`) with `USE_MOCK_IF_API_DOWN: true` as a fallback using `frontend/routes.js`. For local testing, set `CONFIG.API_BASE` to `"http://localhost:8000"`.

### Running the full demo

1. Start the API locally (`uvicorn api.main:app --port 8000`) or use the live Render deployment.
2. Open https://ye-digital-hackathon-frontend.vercel.app/ (or `frontend/index.html` pointed at localhost).
3. Pick or click an origin and destination in Central Karachi, then test the safety slider, Women's Safety Mode toggle, and live incident reporting.

## Risk model

```
R(e)  = (1 / max(L_km, 0.05)) * sum_i  s_i * exp(-age_i / tau)
S(e)  = 1 - exp(-R(e) / K)                  tau = 365 days, K = median non-zero R(e)
T(e)  = time_s / T_MAX_S
W(e)  = T(e) * ((1 - alpha) + alpha * S(e))  default alpha = 0.60
```

- Each incident snaps to its single nearest edge and is dropped if it is more than 150 m away.
- `age_i` is measured in days from the newest incident in the dataset (`reference_date` in `meta.json`). Live reports have age 0.
- `K` is calibrated once on the base risk and reused for women's mode, so the 2.5x multiplier is not normalised away.
- Women's mode flag: crime type contains harassment or snatching, **or** the victim is female.
- The graph keeps only the largest strongly connected component, and parallel edges are collapsed to the fastest one.

## Contracts

**`data/edges.csv`**: columns `u, v, length_m, time_s, risk_raw, risk_raw_women, S, S_women, T, W`. Node IDs are contiguous integers `0..N-1` matching `data/nodes.csv`. `risk_raw` and `risk_raw_women` are per-km values of R(e).

**`data/meta.json`**: `W_SAFETY`, `W_TIME`, `T_MAX_S`, `V_MAX_m_per_s`, `K`, `TAU_DAYS`, `reference_date`, plus `WOMEN_MULT`, `SNAP_M`, `L_MIN_KM` and graph counts.

**`POST /route`**

```
request:  { "origin": [lat, lon], "destination": [lat, lon], "safety_weight": 0.6, "womens_mode": false }
response: { "recommended": { "path": [[lat, lon], ...], "distance_m", "time_s", "avg_risk", "cost" },
            "fastest":     { same fields, computed with alpha = 0 },
            "benchmark":   { "astar_nodes", "dijkstra_nodes", "astar_ms", "dijkstra_ms", "cost_match" } }
```

**`POST /report`**

```
request:  { "lat": 24.918, "lon": 67.097, "crime_type": "Snatching", "severity_num": 4 }
response: { "status": "accepted", "updated_edges": 2 }
```

An optional `"victim_gender": "Female"` field is also accepted and triggers the women's mode multiplier. A report is a duplicate if another report exists within 100 m in the last hour. Otherwise it snaps to the nearest road within 150 m (updating both `u -> v` and `v -> u` on two-way streets, so `updated_edges` is `2` for two-way roads and `1` for one-way roads):

```
risk_raw       += s / max(length_m / 1000, 0.05)
risk_raw_women += s_women / max(length_m / 1000, 0.05)      s_women = 2.5 * s if the report matches the women's flag
S              = 1 - exp(-risk_raw / K)
S_women        = 1 - exp(-risk_raw_women / K)
```

On two-way roads, both directed edges (`u -> v` and `v -> u`) are updated (`updated_edges` is `2`, or `1` on one-way roads).

## Graph and data summary

| Item | Value |
|---|---|
| Nodes / edges | 48,089 / 133,504 |
| Incidents inside the area | 49,523 |
| Incidents snapped within 150 m | 97.8% (median distance 13 m) |
| Edges with zero recorded risk | 84.6% |
| Edges with S > 0.9 | 4.7% |

## Validation

The risk score was checked with a temporal hold-out: scores built from incidents before a cutoff date were evaluated against incidents after it.

| Split | AUC | Lift at top 5% |
|---|---|---|
| 60/40 | 0.725 | 8.1x |
| 70/30 | 0.750 | 8.1x |
| 80/20 | 0.775 | 8.1x |
| Shuffled-score baseline (70/30) | 0.499 | 0.96x |

Varying the decay constant (tau of 90, 365, 1000, or no decay) made no meaningful difference, which suggests the hotspots in this dataset are stable over time.

**Interpretation:** this shows the pipeline recovers the spatial structure in the dataset. Because the data is synthetic, it does not establish predictive accuracy for real-world incidents. The risk model is a data-driven scoring method with hand-chosen parameters. There is no trained machine learning model in the system.

## Limitations

- Synthetic base data, so results say nothing about real crime patterns.
- Risk reflects recorded incidents only. Unreported incidents and reporting bias are not modelled.
- Scope is Central Karachi (Saddar, Clifton, PECHS, Gulshan-e-Iqbal, Nazimabad, Karsaz).
- Live edge state is in memory only and resets when the API restarts.

## Team

| Name | Lane |
|---|---|
| Maheen | Data pipeline, risk model, validation, frontend styling |
| Hasan Shahir | C++ routing engine, benchmark, map integration |
| Arbish | FastAPI backend, live reports, pitch |
