# PathWise — YE Digital Hackathon 2026 Submission & Pitch Guide

**Track:** Open Innovation Track  
**Live Prototype (Vercel):** https://ye-digital-hackathon-frontend.vercel.app/  
**Live Backend API (Render):** https://ye-digital-hackathon.onrender.com  
**Repository:** https://github.com/hasanshahir/YE-DIGITAL-HACKATHON  

---

## 1. Executive Summary

**PathWise** is a safety-aware route planner for Central Karachi. Standard navigation apps optimize purely for travel time or distance. PathWise lets commuters balance **travel time** against **exposure to recorded street-crime incidents** on a real 48,089-node, 133,504-edge road network of Central Karachi, showing the **Recommended (Safe)** route side-by-side with the **Fastest** route so the trade-off is transparent.

Key capabilities:
- **Configurable Safety Weight (`alpha`):** Slider from `0%` (fastest) to `95%` (maximum safety), defaulting to `60%` safety / `40%` time.
- **Women's Safety Mode:** Applies a **2.5x** severity multiplier to harassment, snatching, and female-victim records without recalibrating the baseline risk scale `K`.
- **High-Speed C++17 Routing Engine:** Custom A\* and Dijkstra implementations over CSR adjacency lists, answering queries in ~1.5 ms with **100/100 optimal cost match**.
- **Live Incident Reporting:** Users can report an incident from the map; duplicate reports within 100 m / 1 hour are filtered, the nearest road's risk updates in memory (both directions on two-way roads), and the next route query immediately avoids the newly risky segment.

---

## 2. System Architecture & Technical Highlights

```
Kaggle Crime CSV + OpenStreetMap Roads
        |
  [ Python Data Pipeline ]  -->  data/nodes.csv, edges.csv, meta.json
        |
  [ C++17 Routing Engine ]  <--stdin/stdout--  [ FastAPI Service ]  <--HTTPS--  [ Leaflet Web UI ]
  (A* + Dijkstra, ~1.5 ms)                     (/route, /report,                 (Vercel)
                                                /reset, /health)
```

| Component | Technology | Key Metrics / Details |
|---|---|---|
| **Graph & Risk Model** | Python (`osmnx`, `shapely`, `scipy`) | 48,089 nodes, 133,504 directed edges; 49,523 incidents snapped (97.8% within 150 m, median 13 m); exponential time decay (`tau = 365` days). |
| **Temporal Validation** | Hold-out AUC & Lift | 60/40 AUC **0.725**, 70/30 AUC **0.750**, 80/20 AUC **0.775** (vs 0.499 shuffled baseline); **8.1x** lift at top 5% risk edges. |
| **Routing Engine** | C++17 (`g++ -O2`) | CSR graph; consistent haversine A\* heuristic (`h_scale = 0.999891`). **100/100 cost match** vs Dijkstra across all modes; **0.56x** nodes explored, **1.49x** median speedup. |
| **Backend API** | FastAPI + Uvicorn + Docker | Persistent C++ child process (`--serve`), in-memory live edge overrides, `cKDTree` spatial snapping, deduplication, CORS enabled. |
| **Frontend Client** | HTML/JS + Leaflet | Dual route comparison, safety slider, Women's Safety Mode toggle, interactive incident reporting, automatic fallback to offline demo routes if API is sleeping. |

---

## 3. Responsible Scope & Limitations

- **Synthetic Base Data:** Built on Kaggle benchmark data (`ahsanneural/karachi-crime`), not official police FIR records. Live reporting demonstrates how real-time incident feeds integrate.
- **No False Safety Guarantee:** PathWise minimizes exposure to *recorded* incidents in its dataset; it does not claim any route is guaranteed safe in the real world.
- **Geographic & Runtime Scope:** Covers Central Karachi (Saddar, Clifton, PECHS, Gulshan-e-Iqbal, Nazimabad, Karsaz). Live report state is in-memory and resets when the server restarts (or via `POST /reset`).

---

## 4. Team & Contributions

| Member | Role & Deliverables |
|---|---|
| **Maheen** | Data pipeline (`pipeline/`), temporal risk model & validation, UI/UX styling (`frontend/`), pitch deck. |
| **Hasan Shahir** | C++17 A\*/Dijkstra routing engine (`engine/`), 100-pair benchmark (`data/benchmark_results.csv`), Python bridge & verification (`verify_engine.py`), map integration. |
| **Arbish** | FastAPI backend (`api/main.py`), live incident rescoring & deduplication, Render deployment, pitch. |

---

## 5. Submission Portal Checklist (YE Digital Hackathon 2026)

- [x] **Prototype URL:** `https://ye-digital-hackathon-frontend.vercel.app/`
- [x] **Backend Health Check:** `https://ye-digital-hackathon.onrender.com/health` (`"engine": "cpp"`)
- [x] **Supporting Documentation:** `README.md` and `docs/SUBMISSION.md`
- [ ] **Pitch Deck:** Uploaded by Maheen — **team to do a 5-minute final review** before submission lock.
- [ ] **Demo Video URL:** Record a 2–3 minute walkthrough (script below) and paste link in portal.
- [ ] **Source Code ZIP:** Package repository excluding `.venv/`, `__pycache__/`, and compiled binaries, and upload to portal.

---

## 6. Pitch & Demo Video Guide (8:30 PM – 10:00 PM Session)

**Session Rules Reminder:**
- **2 presenters max** per team (decide who presents and who drives the live screen share).
- Update WhatsApp group tagline to **`[Your Name] - [Group Name]`**.
- Be online **before** your slot — missed slots get **no second chance**.
- Wake up the Render backend 2 minutes before your slot by opening `https://ye-digital-hackathon.onrender.com/health` so there is zero cold-start delay during the live demo!

### Suggested 2–3 Minute Demo Flow
1. **The Problem (20s):** Standard maps only minimize time. In Karachi, the fastest shortcut can pass high-risk segments—especially at night or for women commuters.
2. **Live Route Comparison (30s):** Open `https://ye-digital-hackathon-frontend.vercel.app/`, pick an origin & destination (e.g., Saddar to Gulshan). Show the **Recommended (Teal)** vs **Fastest (Red)** routes side by side.
3. **Safety Slider & Women's Mode (30s):** Move the safety slider from `0%` to `95%` and toggle **Women's Safety Mode** (2.5x weight on harassment/snatching) to show the route dynamically adapting.
4. **Live Incident Report (30s):** Click **Report Incident** on a road along the current route, submit a report, and re-run routing to show PathWise immediately routing around the newly reported hotspot.
5. **Engineering & Validation (30s):** Highlight the 48k-node C++17 A\* engine (~1.5 ms, 100/100 optimal cost match against Dijkstra) and the 0.775 AUC / 8.1x lift temporal validation.
