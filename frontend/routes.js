
(function(){
const GRAY = "#7d9196", GREEN = "#27ae60", AMBER = "#e6a100";

const st = document.createElement("style");
st.textContent = `
.rcard.rk{display:flex;gap:12px;align-items:flex-start;border-left-color:var(--line)}
.rcard.rk.sel{border-color:var(--safe);border-left-color:var(--safe);box-shadow:0 0 0 3px rgba(15,139,141,.15)}
.rank{flex:none;width:28px;height:28px;border-radius:50%;background:var(--soft);display:grid;place-items:center;font-weight:800;font-size:.85rem}
.rk.sel .rank{background:var(--safe);color:var(--safe-ink)}
.rb{flex:1;min-width:0}
.tags{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.meter{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin-top:10px}
.meter i{display:block;height:100%;border-radius:99px}
.ml{display:flex;justify-content:space-between;font-size:.78rem;color:var(--muted);margin-top:4px}
.ml b{color:var(--ink)}
.chips{display:flex;gap:6px;margin:0 0 12px}
.chips button{flex:1;border:1px solid var(--line);background:transparent;border-radius:99px;padding:7px 4px;font-size:.8rem;font-weight:600}
.chips button.on{background:var(--ink);color:var(--panel);border-color:var(--ink)}
.rlab{position:absolute;transform:translate(-50%,-50%);white-space:nowrap;width:max-content;background:var(--panel);color:var(--ink);
  border:2px solid ${GRAY};border-radius:99px;padding:3px 10px;font-size:.78rem;font-weight:600;box-shadow:0 3px 10px rgba(0,0,0,.25);cursor:pointer}
.rlab.sel{background:var(--safe);color:var(--safe-ink);border-color:#fff;font-size:.85rem}
.rcount{color:var(--muted);font-size:.85rem;margin:0 0 10px}`;
document.head.appendChild(st);

let routes = [], selected = 0, sortBy = "match", userAlpha = .6;
const meterColor = p => p >= 70 ? GREEN : p >= 45 ? AMBER : css("--fast");

/* ---- parsing ---- */
function pr(raw){
  const r = pickRoute(raw);
  if(r) r.min = raw.duration_min ?? raw.time_min ?? (raw.duration_s != null ? raw.duration_s / 60 : null);
  return r;
}
function sig(r){
  const p = r.path, n = p.length, s = [];
  for(let i = 0; i < 8; i++){ const q = p[Math.floor(i * (n - 1) / 7)]; s.push(q[0].toFixed(4) + "," + q[1].toFixed(4)); }
  return n + "|" + s.join(";");
}
function collect(d){
  const out = [], add = (raw, tag) => { const r = pr(raw); if(r) out.push({r, tag}); };
  add(d.fastest, "fast"); add(d.recommended, "rec");
  ["alternatives", "alternates", "others", "routes"].forEach(k => Array.isArray(d[k]) && d[k].forEach(x => add(x, "alt")));
  return out;
}

/* ---- scoring and ranking ---- */
function score(){
  const maxRisk = Math.max(...routes.map(r => r.risk));
  routes.forEach(r => {
    const pct = maxRisk <= 1 ? (1 - r.risk) * 100 : (1 - r.risk / (maxRisk * 1.25)) * 100;
    r.safety = Math.max(0, Math.min(100, Math.round(pct)));
  });
  const byTime = routes.every(r => r.min != null);
  const key = r => byTime ? r.min : r.distance_km;
  const fastest = routes.reduce((a, b) => key(b) < key(a) ? b : a);
  const safest = routes.reduce((a, b) => b.risk < a.risk ? b : a);
  routes.forEach(r => { r.tags = []; if(r.isRec) r.tags.push("Recommended"); if(r === fastest) r.tags.push("Fastest"); if(r === safest) r.tags.push("Safest"); });
  routes.forEach(r => r.key = key(r));
  return {maxRisk, maxKey: Math.max(...routes.map(key))};
}
function sortRoutes(ctx){
  const comp = r => userAlpha * (r.risk / (ctx.maxRisk || 1)) + (1 - userAlpha) * (r.key / (ctx.maxKey || 1));
  const f = {match: (a, b) => (b.isRec - a.isRec) || comp(a) - comp(b),
             safe: (a, b) => a.risk - b.risk || a.key - b.key,
             fast: (a, b) => a.key - b.key || a.risk - b.risk}[sortBy];
  routes.sort(f);
}
let ctx = null;

/* ---- drawing ---- */
function drawLine(r, i, sel, bounds){
  const c = L.polyline(r.path, {color:"#fff", weight:sel ? 11 : 8, opacity:.95}).addTo(routeLayer);
  const l = L.polyline(r.path, {color:sel ? css("--safe") : GRAY, weight:sel ? 7 : 5, opacity:1, lineCap:"round"}).addTo(routeLayer);
  [c, l].forEach(x => x.on("click", () => pick(i)));
  bounds.extend(l.getBounds());
  const mid = r.path[Math.floor(r.path.length / 2)];
  const extra = r.min != null ? ` · ${Math.round(r.min)} min` : ` · ${r.distance_km.toFixed(1)} km`;
  L.marker(mid, {zIndexOffset:sel ? 1000 : 0, icon:L.divIcon({className:"", iconSize:null,
    html:`<div class="rlab${sel ? " sel" : ""}"><b>${r.safety}%</b> safe${extra}</div>`})})
    .on("click", () => pick(i)).addTo(routeLayer);
}
function render(fit){
  routeLayer.clearLayers();
  const box = $("results"); box.innerHTML = ""; $("resultsSec").style.display = "block";
  const bounds = L.latLngBounds([]);
  routes.forEach((r, i) => i !== selected && drawLine(r, i, false, bounds));
  drawLine(routes[selected], selected, true, bounds);

  const chips = document.createElement("div"); chips.className = "chips";
  [["match", "Best match"], ["safe", "Safest"], ["fast", "Fastest"]].forEach(([k, t]) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = t;
    b.className = k === sortBy ? "on" : "";
    b.onclick = () => { sortBy = k; sortRoutes(ctx); selected = 0; render(false); };
    chips.appendChild(b);
  });
  box.appendChild(chips);
  const p = document.createElement("p"); p.className = "rcount";
  p.textContent = routes.length === 1 ? "Only one route found for these points." : `${routes.length} routes found. Tap one to show it on the map.`;
  box.appendChild(p);

  routes.forEach((r, i) => {
    const b = document.createElement("button"); b.type = "button";
    b.className = "rcard rk" + (i === selected ? " sel" : "");
    const name = r.tags[0] ? r.tags[0] + " route" : "Alternative route";
    const tags = r.tags.slice(1).map(t => `<span class="tag">${t}</span>`).join("");
    b.innerHTML = `<div class="rank">${i + 1}</div><div class="rb">
      <div class="t"><span>${name}</span><div class="tags">${tags}</div></div>
      <div class="m"><span><b>${r.distance_km.toFixed(1)} km</b></span>${r.min != null ? `<span><b>${Math.round(r.min)} min</b></span>` : ""}<span>Risk <b>${r.risk.toFixed(1)}</b></span></div>
      <div class="meter" title="Safety is relative to the other routes shown"><i style="width:${r.safety}%;background:${meterColor(r.safety)}"></i></div>
      <div class="ml"><span>Safety</span><b>${r.safety}%</b></div></div>`;
    b.onclick = () => pick(i);
    box.appendChild(b);
  });
  if(fit && bounds.isValid()) map.fitBounds(bounds, {padding:[70, 70]});
}
function pick(i){ selected = i; render(false); }

/* ---- main entry (replaces the original findRoutes) ---- */
window.findRoutes = async function(){
  setMode(null);
  const go = $("go"); go.classList.add("busy"); go.disabled = true; $("goTxt").textContent = "Finding routes…";
  const done = () => { go.classList.remove("busy"); $("goTxt").textContent = routed ? "Update routes" : "Find routes"; updateGo(); };
  userAlpha = +$("alpha").value;
  const ws = [...new Set([userAlpha, 0, .3, .6, .95].map(x => +x.toFixed(2)))];
  const res = await Promise.allSettled(ws.map(w => post(CONFIG.ROUTE_PATH,
    {origin:[from.lat, from.lng], destination:[to.lat, to.lng], safety_weight:w, womens_mode:$("women").checked})));

  let cands = [];
  if(res.every(x => x.status === "rejected")){
    const err = res[0].reason;
    if(err.fromApi || !CONFIG.USE_MOCK_IF_API_DOWN){
      toast(err.fromApi ? err.message : "Could not reach the API: " + err.message, true); return done();
    }
    const m = mockRoutes(from, to);
    cands = [{r:m.fast, tag:"fast"}, {r:m.safe, tag:"rec", mine:true}];
    toast("API not reachable. Showing sample routes.", true);
  }else{
    res.forEach((x, i) => { if(x.status === "fulfilled") collect(x.value).forEach(c => cands.push({...c, mine:i === 0 && c.tag === "rec"})); });
  }
  const seen = new Map();
  cands.forEach(c => { const k = sig(c.r); if(!seen.has(k)) seen.set(k, c.r); if(c.mine) seen.get(k).isRec = true; });
  routes = [...seen.values()];
  if(!routes.length){ toast("The API returned no routes for those points.", true); return done(); }
  routes.forEach(r => r.isRec = !!r.isRec);
  ctx = score(); sortBy = "match"; sortRoutes(ctx); selected = 0;
  render(true); routed = true; done();
};
$("go").onclick = window.findRoutes;
})();