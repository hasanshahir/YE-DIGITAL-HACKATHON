// PathWise routing engine - A* and Dijkstra (Hasan's lane)
//
// Edge weight at query time (README "Risk model"):
//   W(e) = T(e) * ((1 - alpha) + alpha * S(e))      S -> S_women in women's mode
// A* heuristic:
//   h(n) = h_scale * (1 - alpha) * haversine(n, goal) / (V_MAX * T_MAX_S)
// Both searches stop as soon as the goal is settled. "Nodes explored" = nodes settled.
#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <queue>
#include <utility>
#include <vector>

#include "graph.hpp"

namespace pw {

struct SearchResult {
    bool found = false;
    double cost = 0.0;           // optimal cost (sum of W along the path)
    std::vector<int> edges;      // path as edge ids, origin -> destination
    long settled = 0;            // nodes explored
    long pushes = 0;             // heap insertions
    double ms = 0.0;             // search runtime in milliseconds
};

struct PathSummary {
    std::vector<int> nodes;
    double distance_m = 0.0;
    double time_s = 0.0;
    double avg_risk = 0.0;       // length-weighted mean of S (or S_women) along the path
    double cost = 0.0;           // sum of W(e) under the given alpha
};

class Searcher {
public:
    explicit Searcher(const Graph& g)
        : g_(g), dist_(g.n), hval_(g.n), pedge_(g.n, -1), seen_(g.n, 0), done_(g.n, 0), hseen_(g.n, 0) {}

    SearchResult run(int s, int t, double alpha, bool womens, bool use_astar) {
        using clock = std::chrono::steady_clock;
        const auto t0 = clock::now();
        next_stamp();

        const double* Sa = womens ? g_.Sw.data() : g_.S.data();
        const double* T = g_.T.data();
        const int* ev = g_.ev.data();
        const int* off = g_.off.data();
        const int* adj = g_.adj.data();
        const double a1 = 1.0 - alpha;
        const double hk = use_astar ? g_.h_scale * a1 / (g_.meta.V_MAX_m_per_s * g_.meta.T_MAX_S) : 0.0;

        auto h = [&](int v) -> double {
            if (hk <= 0.0) return 0.0;
            if (hseen_[v] != stamp_) {
                hseen_[v] = stamp_;
                hval_[v] = hk * g_.haversine_m(v, t);
            }
            return hval_[v];
        };

        using Item = std::pair<double, int>;  // (f = g + h, node)
        std::priority_queue<Item, std::vector<Item>, std::greater<Item>> pq;

        SearchResult r;
        dist_[s] = 0.0;
        pedge_[s] = -1;
        seen_[s] = stamp_;
        pq.emplace(h(s), s);
        r.pushes = 1;

        while (!pq.empty()) {
            const int u = pq.top().second;
            pq.pop();
            if (done_[u] == stamp_) continue;  // stale heap entry
            done_[u] = stamp_;
            ++r.settled;
            if (u == t) {
                r.found = true;
                break;
            }
            const double du = dist_[u];
            for (int k = off[u], kend = off[u + 1]; k < kend; ++k) {
                const int e = adj[k];
                const int v = ev[e];
                if (done_[v] == stamp_) continue;
                const double nd = du + T[e] * (a1 + alpha * Sa[e]);
                if (seen_[v] != stamp_ || nd < dist_[v]) {
                    seen_[v] = stamp_;
                    dist_[v] = nd;
                    pedge_[v] = e;
                    pq.emplace(nd + h(v), v);
                    ++r.pushes;
                }
            }
        }
        r.ms = std::chrono::duration<double, std::milli>(clock::now() - t0).count();

        if (r.found) {
            r.cost = dist_[t];
            for (int v = t; v != s; v = g_.eu[pedge_[v]]) r.edges.push_back(pedge_[v]);
            std::reverse(r.edges.begin(), r.edges.end());
        }
        return r;
    }

    // Distance / time / risk / cost of a path. Cost is scored under `alpha`,
    // which lets the fastest route (searched with alpha = 0) be compared fairly.
    PathSummary summarize(int s, const std::vector<int>& edges, double alpha, bool womens) const {
        const std::vector<double>& Sa = womens ? g_.Sw : g_.S;
        PathSummary p;
        p.nodes.reserve(edges.size() + 1);
        p.nodes.push_back(s);
        double risk_len = 0.0;
        for (int e : edges) {
            p.nodes.push_back(g_.ev[e]);
            p.distance_m += g_.length_m[e];
            p.time_s += g_.time_s[e];
            risk_len += Sa[e] * g_.length_m[e];
            p.cost += g_.T[e] * ((1.0 - alpha) + alpha * Sa[e]);
        }
        p.avg_risk = p.distance_m > 0 ? risk_len / p.distance_m : 0.0;
        return p;
    }

private:
    void next_stamp() {
        if (++stamp_ == 0) {  // wrapped around: clear all marks once
            std::fill(seen_.begin(), seen_.end(), 0);
            std::fill(done_.begin(), done_.end(), 0);
            std::fill(hseen_.begin(), hseen_.end(), 0);
            stamp_ = 1;
        }
    }

    const Graph& g_;
    std::vector<double> dist_, hval_;
    std::vector<int> pedge_;
    std::vector<uint32_t> seen_, done_, hseen_;
    uint32_t stamp_ = 0;
};

inline bool costs_match(double a, double b) {
    return std::fabs(a - b) <= 1e-9 * std::max(1.0, std::fabs(b));
}

}  // namespace pw

