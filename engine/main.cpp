// PathWise routing engine - entry point (Hasan's lane)
//
// Build (from the repository root):
//   g++ -O2 -std=c++17 -o engine/pathwise_engine engine/main.cpp
//
// Modes:
//   pathwise_engine --serve                      persistent process used by the API (stdin/stdout)
//   pathwise_engine --route <o> <d> [--alpha A] [--womens]
//   pathwise_engine --bench [--alpha A] [--womens] [--reps N] [--csv FILE]
// Common: --data DIR (default: data)
//
// --serve protocol (one request -> one JSON line on stdout):
//   ROUTE <origin_node> <dest_node> <alpha> <womens 0|1> <n_overrides>
//   <u> <v> <S> <S_women>          (repeated n_overrides times: live risk from /report)
//   PING  -> {"ok":true}
//   QUIT  -> exit
// On start it prints {"ready":true,...}. Diagnostics go to stderr only.
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "graph.hpp"
#include "search.hpp"

using namespace pw;

namespace {

void usage() {
    std::fprintf(stderr,
        "PathWise routing engine (A* + Dijkstra)\n"
        "\n"
        "usage:\n"
        "  pathwise_engine --serve                         persistent mode for the API\n"
        "  pathwise_engine --route O D [--alpha A] [--womens]\n"
        "  pathwise_engine --bench [--alpha A] [--womens] [--reps N] [--csv FILE]\n"
        "\n"
        "options:\n"
        "  --data DIR    folder with nodes.csv, edges.csv, meta.json, od_pairs.csv (default: data)\n"
        "  --alpha A     safety weight 0..1 (default: W_SAFETY from meta.json, 0.6)\n"
        "  --womens      use S_women (women's safety mode)\n"
        "  --reps N      benchmark repetitions per pair, fastest kept (default: 5)\n"
        "  --csv FILE    benchmark per-pair output (default: <data>/benchmark_results.csv)\n");
}

std::string fmt(const char* f, double v) {
    char buf[64];
    std::snprintf(buf, sizeof buf, f, v);
    return buf;
}

void append_route(std::string& out, const Graph& g, const PathSummary& p) {
    out += "{\"path\":[";
    for (size_t i = 0; i < p.nodes.size(); ++i) {
        if (i) out += ',';
        out += '[' + fmt("%.7f", g.lat[p.nodes[i]]) + ',' + fmt("%.7f", g.lon[p.nodes[i]]) + ']';
    }
    out += "],\"distance_m\":" + fmt("%.1f", p.distance_m);
    out += ",\"time_s\":" + fmt("%.1f", p.time_s);
    out += ",\"avg_risk\":" + fmt("%.4f", p.avg_risk);
    out += ",\"cost\":" + fmt("%.6f", p.cost) + '}';
}

// The full /route answer in the frozen contract shape.
std::string route_json(const Graph& g, Searcher& sr, int o, int d, double alpha, bool womens) {
    const SearchResult astar = sr.run(o, d, alpha, womens, true);
    const SearchResult dijk = sr.run(o, d, alpha, womens, false);
    const SearchResult fast = sr.run(o, d, 0.0, womens, true);
    if (!astar.found || !dijk.found || !fast.found)
        return "{\"error\":\"no path between the selected points\"}";

    const PathSummary rec = sr.summarize(o, astar.edges, alpha, womens);
    const PathSummary fst = sr.summarize(o, fast.edges, alpha, womens);  // cost scored under alpha

    std::string out = "{\"recommended\":";
    append_route(out, g, rec);
    out += ",\"fastest\":";
    append_route(out, g, fst);
    out += ",\"benchmark\":{\"astar_nodes\":" + std::to_string(astar.settled);
    out += ",\"dijkstra_nodes\":" + std::to_string(dijk.settled);
    out += ",\"astar_ms\":" + fmt("%.3f", astar.ms);
    out += ",\"dijkstra_ms\":" + fmt("%.3f", dijk.ms);
    out += std::string(",\"cost_match\":") + (costs_match(astar.cost, dijk.cost) ? "true" : "false");
    out += "}}";
    return out;
}

// ---------------------------------------------------------------- --serve
int serve(Graph& g) {
    Searcher sr(g);
    std::printf("{\"ready\":true,\"nodes\":%d,\"edges\":%d,\"h_scale\":%.9f}\n", g.n, g.m, g.h_scale);
    std::fflush(stdout);

    std::string line;
    while (std::getline(std::cin, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty()) continue;

        if (line.rfind("PING", 0) == 0) {
            std::printf("{\"ok\":true}\n");
        } else if (line.rfind("QUIT", 0) == 0) {
            break;
        } else if (line.rfind("ROUTE", 0) == 0) {
            int o = -1, d = -1, wm = 0, nov = 0;
            double alpha = 0;
            const bool ok = std::sscanf(line.c_str(), "ROUTE %d %d %lf %d %d", &o, &d, &alpha, &wm, &nov) == 5;

            // read the override lines even if the header is bad, to stay in sync
            std::vector<std::pair<int, std::pair<double, double>>> saved;  // edge -> old (S, S_women)
            bool eof = false;
            for (int i = 0; i < std::max(nov, 0); ++i) {
                std::string ol;
                if (!std::getline(std::cin, ol)) { eof = true; break; }
                int u, v;
                double s, sw;
                if (!ok || std::sscanf(ol.c_str(), "%d %d %lf %lf", &u, &v, &s, &sw) != 4) continue;
                const int e = g.find_edge(u, v);
                if (e < 0 || !(s >= 0) || !(sw >= 0)) continue;  // unknown edge or bad value
                saved.push_back({e, {g.S[e], g.Sw[e]}});
                g.S[e] = s;
                g.Sw[e] = sw;
            }

            std::string out;
            if (!ok) out = "{\"error\":\"bad ROUTE header\"}";
            else if (o < 0 || o >= g.n || d < 0 || d >= g.n) out = "{\"error\":\"node id out of range\"}";
            else if (!(alpha >= 0.0 && alpha <= 1.0)) out = "{\"error\":\"alpha must be in [0, 1]\"}";
            else out = route_json(g, sr, o, d, alpha, wm != 0);

            // restore base values in reverse order (handles repeated edges correctly)
            for (auto it = saved.rbegin(); it != saved.rend(); ++it) {
                g.S[it->first] = it->second.first;
                g.Sw[it->first] = it->second.second;
            }
            std::printf("%s\n", out.c_str());
            if (eof) { std::fflush(stdout); break; }
        } else {
            std::printf("{\"error\":\"unknown command\"}\n");
        }
        std::fflush(stdout);
    }
    return 0;
}

// ---------------------------------------------------------------- --bench
double median(std::vector<double> v) {
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    const size_t k = v.size() / 2;
    return v.size() % 2 ? v[k] : 0.5 * (v[k - 1] + v[k]);
}

double mean(const std::vector<double>& v) {
    if (v.empty()) return 0;
    double s = 0;
    for (double x : v) s += x;
    return s / v.size();
}

int bench(const Graph& g, const std::string& data_dir, double alpha, bool womens, int reps, std::string csv) {
    const std::string od_path = data_dir + "/od_pairs.csv";
    CsvTable od(od_path);
    const int c_o = od.need("origin_id", od_path), c_d = od.need("dest_id", od_path);
    const auto bucket_it = od.col.find("bucket");
    const auto km_it = od.col.find("straight_km");

    // bucket is text; CsvTable stores numbers, so read bucket labels separately
    std::vector<std::string> buckets;
    if (bucket_it != od.col.end()) {
        const std::string text = read_file(od_path);
        size_t pos = text.find('\n') + 1;
        while (pos < text.size() && pos != 0) {
            size_t eol = text.find('\n', pos);
            if (eol == std::string::npos) eol = text.size();
            std::string line = text.substr(pos, eol - pos);
            pos = eol + 1;
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            std::vector<std::string> f;
            size_t a = 0, b;
            while ((b = line.find(',', a)) != std::string::npos) { f.push_back(line.substr(a, b - a)); a = b + 1; }
            f.push_back(line.substr(a));
            buckets.push_back(bucket_it->second < (int)f.size() ? f[bucket_it->second] : "");
        }
    }

    Searcher sr(g);
    if (csv.empty()) csv = data_dir + "/benchmark_results.csv";
    FILE* fo = std::fopen(csv.c_str(), "w");
    if (!fo) { std::fprintf(stderr, "cannot write %s\n", csv.c_str()); return 1; }
    std::fprintf(fo, "origin_id,dest_id,bucket,straight_km,astar_nodes,dijkstra_nodes,astar_ms,dijkstra_ms,"
                     "astar_cost,dijkstra_cost,cost_match,node_ratio,time_ratio\n");

    struct Agg { std::vector<double> an, dn, am, dm, nr, tr; int match = 0, total = 0; };
    std::map<std::string, Agg> per;  // "" = all pairs
    const std::vector<std::string> order = {"short", "medium", "long"};

    for (size_t i = 0; i < od.rows.size(); ++i) {
        const int o = static_cast<int>(od.rows[i][c_o]);
        const int d = static_cast<int>(od.rows[i][c_d]);
        if (o < 0 || o >= g.n || d < 0 || d >= g.n) { std::fprintf(stderr, "skip bad pair %d->%d\n", o, d); continue; }
        const std::string bucket = i < buckets.size() ? buckets[i] : "";
        const double km = km_it != od.col.end() ? od.rows[i][km_it->second] : 0.0;

        SearchResult a = sr.run(o, d, alpha, womens, true);   // warm-up + result
        SearchResult k = sr.run(o, d, alpha, womens, false);
        double a_ms = a.ms, d_ms = k.ms;
        for (int r = 1; r < reps; ++r) {
            a_ms = std::min(a_ms, sr.run(o, d, alpha, womens, true).ms);
            d_ms = std::min(d_ms, sr.run(o, d, alpha, womens, false).ms);
        }
        const bool match = a.found && k.found && costs_match(a.cost, k.cost);
        const double nr = k.settled ? double(a.settled) / k.settled : 0.0;
        const double tr = d_ms > 0 ? a_ms / d_ms : 0.0;

        std::fprintf(fo, "%d,%d,%s,%.3f,%ld,%ld,%.4f,%.4f,%.9f,%.9f,%d,%.4f,%.4f\n", o, d, bucket.c_str(), km,
                     a.settled, k.settled, a_ms, d_ms, a.cost, k.cost, match ? 1 : 0, nr, tr);

        auto add = [&](Agg& ag) {
            ag.an.push_back(a.settled); ag.dn.push_back(k.settled);
            ag.am.push_back(a_ms); ag.dm.push_back(d_ms);
            ag.nr.push_back(nr); ag.tr.push_back(tr);
            ag.total++; ag.match += match;
        };
        add(per[""]);                       // all pairs
        if (!bucket.empty()) add(per[bucket]);
    }
    std::fclose(fo);

    std::printf("Benchmark: %d OD pairs, alpha=%.2f, mode=%s, reps=%d (fastest run kept)\n",
                per[""].total, alpha, womens ? "women" : "general", reps);
    std::printf("Graph: %d nodes, %d edges, A* heuristic scale %.6f (%ld edges below the bound)\n\n",
                g.n, g.m, g.h_scale, g.h_violations);
    std::printf("%-7s %5s %10s %10s %11s %11s %10s %10s %10s %10s\n", "bucket", "pairs", "match",
                "A*_nodes", "Dijk_nodes", "node_ratio", "A*_ms", "Dijk_ms", "time_ratio", "speedup");
    auto row = [&](const std::string& name, Agg& ag) {
        const double tr = median(ag.tr);
        std::printf("%-7s %5d %6d/%-3d %10.0f %11.0f %11.3f %10.3f %10.3f %10.3f %9.2fx\n", name.c_str(), ag.total,
                    ag.match, ag.total, median(ag.an), median(ag.dn), median(ag.nr), median(ag.am), median(ag.dm),
                    tr, tr > 0 ? 1.0 / tr : 0.0);
    };
    for (const auto& b : order) if (per.count(b)) row(b, per[b]);
    row("all", per[""]);

    Agg& all = per[""];
    std::printf("\n(medians per pair; node_ratio and time_ratio are A* / Dijkstra)\n");
    std::printf("Mean node ratio %.3f, mean time ratio %.3f\n", mean(all.nr), mean(all.tr));
    std::printf("\nREADME table:\n");
    std::printf("| Cost match (A* vs Dijkstra) | %d / %d (%.0f%%) |\n", all.match, all.total,
                all.total ? 100.0 * all.match / all.total : 0.0);
    std::printf("| Nodes explored, A* vs Dijkstra (median) | %.0f vs %.0f (ratio %.3f median, %.3f mean) |\n",
                median(all.an), median(all.dn), median(all.nr), mean(all.nr));
    std::printf("| Runtime, A* vs Dijkstra (median, ms) | %.3f vs %.3f (ratio %.3f median, %.3f mean) |\n",
                median(all.am), median(all.dm), median(all.tr), mean(all.tr));
    std::printf("\nPer-pair results written to %s\n", csv.c_str());
    return all.match == all.total ? 0 : 2;
}

}  // namespace

int main(int argc, char** argv) {
    std::ios::sync_with_stdio(false);
    std::string mode, data_dir = "data", csv;
    double alpha = -1;
    bool womens = false;
    int reps = 5, o = -1, d = -1;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&](const char* what) -> std::string {
            if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", what); std::exit(1); }
            return argv[++i];
        };
        if (a == "--help" || a == "-h") { usage(); return 0; }
        else if (a == "--serve") mode = "serve";
        else if (a == "--bench") mode = "bench";
        else if (a == "--route") { mode = "route"; o = std::atoi(next("--route").c_str()); d = std::atoi(next("--route").c_str()); }
        else if (a == "--data") data_dir = next("--data");
        else if (a == "--alpha") alpha = std::atof(next("--alpha").c_str());
        else if (a == "--womens") womens = true;
        else if (a == "--reps") reps = std::max(1, std::atoi(next("--reps").c_str()));
        else if (a == "--csv") csv = next("--csv");
        else { std::fprintf(stderr, "unknown argument: %s\n\n", a.c_str()); usage(); return 1; }
    }
    if (mode.empty()) { usage(); return 1; }

    Graph g;
    try {
        const auto t0 = std::chrono::steady_clock::now();
        g.load(data_dir);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        std::fprintf(stderr, "[engine] loaded %d nodes, %d edges from %s in %.0f ms (h_scale %.6f, %ld edges below bound)\n",
                     g.n, g.m, data_dir.c_str(), ms, g.h_scale, g.h_violations);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[engine] load failed: %s\n", e.what());
        if (mode == "serve") std::printf("{\"ready\":false,\"error\":\"%s\"}\n", e.what());
        return 1;
    }
    if (alpha < 0) alpha = g.meta.W_SAFETY;
    if (!(alpha >= 0.0 && alpha <= 1.0)) { std::fprintf(stderr, "--alpha must be in [0, 1]\n"); return 1; }

    if (mode == "serve") return serve(g);
    if (mode == "bench") return bench(g, data_dir, alpha, womens, reps, csv);

    if (o < 0 || o >= g.n || d < 0 || d >= g.n) { std::fprintf(stderr, "node id out of range (0..%d)\n", g.n - 1); return 1; }
    Searcher sr(g);
    std::printf("%s\n", route_json(g, sr, o, d, alpha, womens).c_str());
    return 0;
}
