// PathWise routing engine - graph loading (Hasan's lane)
//
// Loads the three contract files written by the data pipeline:
//   data/nodes.csv   node_id, lat, lon            (node_id contiguous 0..N-1)
//   data/edges.csv   u, v, length_m, time_s, risk_raw, risk_raw_women, S, S_women, T, W
//   data/meta.json   W_SAFETY, T_MAX_S, V_MAX_m_per_s, K, ...
// and builds a CSR adjacency list (outgoing edges per node).
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace pw {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg2Rad = kPi / 180.0;
constexpr double kEarthRadiusM = 6371000.0;

struct Meta {
    double W_SAFETY = 0.6;
    double T_MAX_S = 0.0;
    double V_MAX_m_per_s = 0.0;
    double K = 0.0;
    double L_MIN_KM = 0.05;
    long n_nodes = -1;
    long n_edges = -1;
};

inline std::string read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

// Minimal lookup of a numeric value in a flat JSON object: "key": <number>
inline bool json_number(const std::string& s, const char* key, double& out) {
    const std::string pat = std::string("\"") + key + "\"";
    size_t p = s.find(pat);
    if (p == std::string::npos) return false;
    p = s.find(':', p + pat.size());
    if (p == std::string::npos) return false;
    const char* begin = s.c_str() + p + 1;
    char* end = nullptr;
    double v = std::strtod(begin, &end);
    if (end == begin) return false;
    out = v;
    return true;
}

// Splits CSV text into lines; parses the header into a name -> column map,
// and every data row into doubles (all contract columns are numeric).
class CsvTable {
public:
    std::unordered_map<std::string, int> col;
    std::vector<std::vector<double>> rows;

    explicit CsvTable(const std::string& path) {
        const std::string text = read_file(path);
        size_t pos = 0;
        bool header = true;
        while (pos < text.size()) {
            size_t eol = text.find('\n', pos);
            if (eol == std::string::npos) eol = text.size();
            std::string line = text.substr(pos, eol - pos);
            pos = eol + 1;
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (line.empty()) continue;
            if (header) {
                std::stringstream ss(line);
                std::string name;
                int i = 0;
                while (std::getline(ss, name, ',')) col[name] = i++;
                header = false;
                continue;
            }
            std::vector<double> row;
            row.reserve(col.size());
            const char* c = line.c_str();
            while (true) {
                char* end = nullptr;
                double v = std::strtod(c, &end);
                row.push_back(end == c ? std::nan("") : v);  // non-numeric -> NaN
                const char* comma = std::strchr(end, ',');
                if (!comma) break;
                c = comma + 1;
            }
            rows.push_back(std::move(row));
        }
    }

    int need(const std::string& name, const std::string& file) const {
        auto it = col.find(name);
        if (it == col.end()) throw std::runtime_error(file + ": missing column '" + name + "'");
        return it->second;
    }
};

struct Graph {
    int n = 0;  // nodes
    int m = 0;  // edges
    Meta meta;

    // nodes
    std::vector<double> lat, lon, lat_rad, cos_lat;

    // edges (index = row in edges.csv)
    std::vector<int> eu, ev;
    std::vector<double> length_m, time_s, T;
    std::vector<double> S_base, Sw_base;  // values from edges.csv
    std::vector<double> S, Sw;            // values used for routing (base + live overrides)

    // CSR adjacency: outgoing edge ids of node u are adj[off[u] .. off[u+1])
    std::vector<int> off, adj;

    // A* heuristic scale (see compute_heuristic_scale)
    double h_scale = 1.0;
    long h_violations = 0;

    double haversine_m(int a, int b) const {
        const double dlat = lat_rad[b] - lat_rad[a];
        const double dlon = (lon[b] - lon[a]) * kDeg2Rad;
        const double sa = std::sin(dlat * 0.5), so = std::sin(dlon * 0.5);
        const double h = sa * sa + cos_lat[a] * cos_lat[b] * so * so;
        return 2.0 * kEarthRadiusM * std::asin(std::sqrt(std::min(1.0, h)));
    }

    // Edge id for u->v, or -1. Degrees are tiny, so a linear scan is fastest.
    int find_edge(int u, int v) const {
        if (u < 0 || u >= n) return -1;
        for (int k = off[u]; k < off[u + 1]; ++k)
            if (ev[adj[k]] == v) return adj[k];
        return -1;
    }

    void load(const std::string& dir) {
        load_meta(dir + "/meta.json");
        load_nodes(dir + "/nodes.csv");
        load_edges(dir + "/edges.csv");
        build_csr();
        compute_heuristic_scale();
    }

private:
    void load_meta(const std::string& path) {
        const std::string s = read_file(path);
        double v;
        if (json_number(s, "W_SAFETY", v)) meta.W_SAFETY = v;
        if (!json_number(s, "T_MAX_S", meta.T_MAX_S)) throw std::runtime_error("meta.json: missing T_MAX_S");
        if (!json_number(s, "V_MAX_m_per_s", meta.V_MAX_m_per_s))
            throw std::runtime_error("meta.json: missing V_MAX_m_per_s");
        if (!json_number(s, "K", meta.K)) throw std::runtime_error("meta.json: missing K");
        if (json_number(s, "L_MIN_KM", v)) meta.L_MIN_KM = v;
        if (json_number(s, "n_nodes", v)) meta.n_nodes = static_cast<long>(v);
        if (json_number(s, "n_edges", v)) meta.n_edges = static_cast<long>(v);
        if (meta.T_MAX_S <= 0 || meta.V_MAX_m_per_s <= 0) throw std::runtime_error("meta.json: bad T_MAX_S / V_MAX");
    }

    void load_nodes(const std::string& path) {
        CsvTable t(path);
        const int c_id = t.need("node_id", path), c_lat = t.need("lat", path), c_lon = t.need("lon", path);
        n = static_cast<int>(t.rows.size());
        lat.assign(n, std::nan(""));
        lon.assign(n, std::nan(""));
        for (const auto& r : t.rows) {
            const long id = static_cast<long>(r[c_id]);
            if (id < 0 || id >= n) throw std::runtime_error("nodes.csv: node_id not contiguous 0..N-1");
            lat[id] = r[c_lat];
            lon[id] = r[c_lon];
        }
        lat_rad.resize(n);
        cos_lat.resize(n);
        for (int i = 0; i < n; ++i) {
            if (std::isnan(lat[i]) || std::isnan(lon[i])) throw std::runtime_error("nodes.csv: missing node id");
            lat_rad[i] = lat[i] * kDeg2Rad;
            cos_lat[i] = std::cos(lat_rad[i]);
        }
    }

    void load_edges(const std::string& path) {
        CsvTable t(path);
        const int cu = t.need("u", path), cv = t.need("v", path), cl = t.need("length_m", path),
                  ct = t.need("time_s", path), cs = t.need("S", path), csw = t.need("S_women", path),
                  cT = t.need("T", path);
        m = static_cast<int>(t.rows.size());
        eu.resize(m); ev.resize(m); length_m.resize(m); time_s.resize(m); T.resize(m);
        S_base.resize(m); Sw_base.resize(m);
        for (int i = 0; i < m; ++i) {
            const auto& r = t.rows[i];
            eu[i] = static_cast<int>(r[cu]);
            ev[i] = static_cast<int>(r[cv]);
            if (eu[i] < 0 || eu[i] >= n || ev[i] < 0 || ev[i] >= n)
                throw std::runtime_error("edges.csv: edge references unknown node");
            length_m[i] = r[cl];
            time_s[i] = r[ct];
            T[i] = r[cT];
            S_base[i] = r[cs];
            Sw_base[i] = r[csw];
            if (!(T[i] >= 0) || !(S_base[i] >= 0) || !(Sw_base[i] >= 0))
                throw std::runtime_error("edges.csv: negative or missing T / S / S_women");
        }
        S = S_base;
        Sw = Sw_base;
    }

    void build_csr() {
        off.assign(n + 1, 0);
        for (int e = 0; e < m; ++e) off[eu[e] + 1]++;
        for (int i = 0; i < n; ++i) off[i + 1] += off[i];
        adj.resize(m);
        std::vector<int> fill(off.begin(), off.end() - 1);
        for (int e = 0; e < m; ++e) adj[fill[eu[e]]++] = e;
    }

    // A* uses h(n) = (1 - alpha) * haversine(n, goal) / (V_MAX * T_MAX_S).
    // That is a lower bound on the remaining cost only if every edge satisfies
    //   T(e) >= haversine(u, v) / (V_MAX * T_MAX_S)
    // (S >= 0, so alpha * S * T only adds cost). Rounding in edges.csv can break this
    // by a hair on very short edges, so we measure the worst ratio and shrink the
    // heuristic by it. With that scale h is consistent, and A* is provably optimal
    // (same cost as Dijkstra) for every alpha, mode and live override.
    void compute_heuristic_scale() {
        const double denom = meta.V_MAX_m_per_s * meta.T_MAX_S;
        double worst = 1.0;
        h_violations = 0;
        for (int e = 0; e < m; ++e) {
            const double d = haversine_m(eu[e], ev[e]);
            if (d <= 0) continue;
            const double ratio = T[e] * denom / d;
            if (ratio < 1.0) {
                ++h_violations;
                worst = std::min(worst, ratio);
            }
        }
        h_scale = worst * (1.0 - 1e-12);  // tiny margin for floating-point error
        if (h_scale < 0) h_scale = 0;
    }
};

}  // namespace pw
