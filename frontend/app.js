/* ---------- CONFIG: change these to match the API ---------- */
const CONFIG = {
 API_BASE: ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8000" : "https://ye-digital-hackathon.onrender.com",
  ROUTE_PATH: "/route",
  REPORT_PATH: "/report",
  USE_MOCK_IF_API_DOWN: true,
  COVERAGE: null,               // {south,west,north,east} of the road graph, or expose GET /bounds on the API
  COVERAGE_NAME: "Central Karachi",
  SNAP_M: 500,
  AVG_KMH: 30,                  // used only when the engine gives no travel time
  DEMO_PREFILL: true,           // start with Frere Hall -> Aga Khan University Hospital (approximate coordinates)
  DEMO_FROM: {name: "Frere Hall, Saddar", ll: [24.8443, 67.0330]},
  DEMO_TO: {name: "Aga Khan University Hospital", ll: [24.8918, 67.0745]}
};
const CRIME_TYPES = ["Motorbike Snatching","Mobile Phone Snatching","Cash Snatching","Car Snatching","Street Robbery",
  "Motorbike Theft","Car Theft","House Burglary","Pickpocketing","Shop Theft","Armed Assault","Extortion","Murder",
  "Kidnapping for Ransom","Harassment"];
const GREEN = "#1b6b49", ALT = "#8795b3", AMBER = "#e08a1e", RED = "#c0392b";
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
CRIME_TYPES.forEach(c => $("crime").add(new Option(c, c)));

let toastT;
function toast(msg, err){
  const t = $("toast"); t.textContent = msg; t.classList.toggle("err", !!err); t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 4200);
}
document.querySelectorAll("[data-soon]").forEach(el => el.addEventListener("click", e => {
  e.preventDefault(); toast(el.dataset.soon || "Coming soon in a later version.");
}));

/* ---------- map ---------- */
const map = L.map("map", {zoomControl:false, attributionControl:false}).setView([24.8607, 67.0011], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19}).addTo(map);
L.control.attribution({prefix:false, position:"bottomright"}).addAttribution("&copy; OpenStreetMap contributors · Routing: PathWise engine").addTo(map);
L.control.scale({imperial:false, position:"bottomright"}).addTo(map);
window.addEventListener("load", () => { map.invalidateSize(); setTimeout(() => map.invalidateSize(), 300); });
$("zin").onclick = () => map.zoomIn(); $("zout").onclick = () => map.zoomOut();

let mode = null, from = null, to = null, sev = 1, routes = [], selected = 0, ctx = null, userAlpha = .6, routed = false;
const routeLayer = L.layerGroup().addTo(map), reportLayer = L.layerGroup().addTo(map), pins = {};
const names = {from:"", to:""};

/* ---------- coverage ---------- */
let coverage = null, covLayer = null;
function normBounds(d){
  if(!d) return null;
  if(Array.isArray(d) && d.length === 4) d = {south:d[0], west:d[1], north:d[2], east:d[3]};
  const b = {south:d.south ?? d.min_lat ?? d.lat_min ?? d.minLat, west:d.west ?? d.min_lon ?? d.lon_min ?? d.minLon,
             north:d.north ?? d.max_lat ?? d.lat_max ?? d.maxLat, east:d.east ?? d.max_lon ?? d.lon_max ?? d.maxLon};
  return Object.values(b).every(v => typeof v === "number") ? b : null;
}
function drawCoverage(b){
  coverage = b; if(covLayer) map.removeLayer(covLayer);
  const world = [[-85,-180],[-85,180],[85,180],[85,-180]], hole = [[b.south,b.west],[b.south,b.east],[b.north,b.east],[b.north,b.west]];
  covLayer = L.layerGroup([
    L.polygon([world, hole], {stroke:false, fillColor:"#0f2327", fillOpacity:.18, interactive:false}),
    L.rectangle([[b.south,b.west],[b.north,b.east]], {color:GREEN, weight:2, dashArray:"8 8", fill:false, interactive:false})]);
  if($("layerTg").checked) covLayer.addTo(map);
}
function inCoverage(ll){
  if(!coverage) return true;
  const pad = CONFIG.SNAP_M / 111000;
  return ll.lat >= coverage.south - pad && ll.lat <= coverage.north + pad && ll.lng >= coverage.west - pad && ll.lng <= coverage.east + pad;
}
const OUTSIDE = () => `That spot is outside the ${CONFIG.COVERAGE_NAME} area PathWise covers.`;
async function loadCoverage(){
  const tryB = d => { const b = normBounds(d); if(b){ drawCoverage(b); map.fitBounds([[b.south,b.west],[b.north,b.east]], {padding:[30,30]}); return true; } };
  if(CONFIG.COVERAGE && tryB(CONFIG.COVERAGE)) return;
  for(const p of ["/bounds", "/coverage"]){
    try{ const r = await fetch(CONFIG.API_BASE + p); if(r.ok && tryB(await r.json())) return; }catch(_){}
  }
}

/* ---------- picking mode ---------- */
const HINTS = {from:"Click the map to set your start", to:"Click the map to set your destination", rep:"Click the spot where it happened"};
function setMode(m){
  mode = m; $("map").classList.toggle("pick", !!m);
  $("banner").classList.toggle("show", !!m); $("bannerTxt").textContent = HINTS[m] || "";
  $("pickRep").classList.toggle("on", m === "rep");
  $("pickRep").textContent = m === "rep" ? "Click the map now" : "Choose location on map";
}
$("bannerX").onclick = () => setMode(null);
document.addEventListener("keydown", e => { if(e.key === "Escape"){ setMode(null); $("optPop").classList.remove("show"); $("repModal").classList.remove("show"); } });
map.on("click", e => {
  if(mode === "from" || mode === "to") setPoint(mode, e.latlng);
  else if(mode === "rep") sendReport(e.latlng);
});

/* ---------- start / destination points ---------- */
function mkIcon(key, label){
  const short = esc(label.split(",").slice(0, 2).join(",").slice(0, 34));
  const html = key === "from"
    ? `<div class="mk f"><span class="dot"></span><span class="lab">${short}</span></div>`
    : `<div class="mk t"><svg class="pin" viewBox="0 0 24 24"><use href="#i-pin"/></svg><span class="lab">${short}</span></div>`;
  return L.divIcon({className:"", html, iconSize:[0,0]});
}
function setPoint(key, ll, label, opts = {}){
  ll = L.latLng(ll);
  if(!inCoverage(ll)) return toast(OUTSIDE(), true);
  label = label || `Dropped pin (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`;
  if(key === "from") from = ll; else to = ll;
  names[key] = label; $("in-" + key).value = label;
  if(pins[key]) map.removeLayer(pins[key]);
  pins[key] = L.marker(ll, {icon:mkIcon(key, label), interactive:false, zIndexOffset:900}).addTo(map);
  $("in-" + key).blur();
  if(!opts.keepMode) setMode(key === "from" ? (to ? null : "to") : (from ? null : "from"));
  if(opts.auto === false) return;
  if(from && to) findRoutes();
}
function clearPoint(key){ if(pins[key]) map.removeLayer(pins[key]); delete pins[key]; $("in-" + key).value = ""; names[key] = ""; if(key === "from") from = null; else to = null; }
$("swap").onclick = () => {
  if(!from && !to) return toast("Set your points first");
  const a = from, b = to, na = names.from, nb = names.to;
  clearPoint("from"); clearPoint("to");
  if(b) setPoint("from", b, nb, {keepMode:true, auto:false});
  if(a) setPoint("to", a, na, {keepMode:true, auto:false});
  if(from && to) findRoutes();
};
$("locate").onclick = () => {
  if(!navigator.geolocation) return toast("Your browser can't share location", true);
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 15); setPoint("from", [p.coords.latitude, p.coords.longitude], "My location"); },
    () => toast("Couldn't get your location. Search or click the map instead.", true), {enableHighAccuracy:true, timeout:8000});
};

/* ---------- place search (OpenStreetMap Nominatim) ---------- */
function attachSearch(key){
  const inp = $("in-" + key), box = $("sug-" + key); let t, last = "";
  const close = () => box.style.display = "none";
  async function run(){
    const q = inp.value.trim(); if(q.length < 3 || q === last || q === names[key]) return; last = q;
    box.style.display = "block"; box.innerHTML = '<div class="none">Searching…</div>';
    try{
      const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=pk&bounded=1&viewbox=66.65,25.55,67.65,24.6&q=" + encodeURIComponent(q + " Karachi");
      const res = await (await fetch(u, {headers:{Accept:"application/json"}})).json();
      box.innerHTML = "";
      if(!res.length){ box.innerHTML = '<div class="none">No matches. Try another name or click the map.</div>'; return; }
      res.forEach(r => {
        const b = document.createElement("button"); b.type = "button";
        const name = r.display_name.split(",").slice(0, 3).join(","); b.textContent = name;
        b.onclick = () => { setPoint(key, [+r.lat, +r.lon], name); map.setView([+r.lat, +r.lon], 15); close(); };
        box.appendChild(b);
      });
    }catch(_){ box.innerHTML = '<div class="none">Search unavailable. Click the map instead.</div>'; }
  }
  inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 450); });
  inp.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); const f = box.querySelector("button"); f ? f.click() : run(); } });
  inp.addEventListener("focus", () => { setMode(key); inp.select(); });
  document.addEventListener("click", e => { if(!e.target.closest("#in-" + key) && !e.target.closest("#sug-" + key)) close(); });
}
attachSearch("from"); attachSearch("to");

/* ---------- options popover ---------- */
$("optBtn").onclick = e => { e.stopPropagation(); $("optPop").classList.toggle("show"); };
document.addEventListener("click", e => { if(!e.target.closest("#optPop") && !e.target.closest("#optBtn")) $("optPop").classList.remove("show"); });
const alphaText = v => v < .2 ? "Fastest" : v < .45 ? "Mostly fast" : v < .7 ? "Balanced" : v < .9 ? "Mostly safe" : "Safest";
$("alpha").oninput = () => $("alphaLabel").textContent = alphaText(+$("alpha").value);
$("alpha").onchange = () => { if(from && to) findRoutes(); };
$("women").onchange = () => { if(from && to) findRoutes(); };

/* ---------- safety layer ---------- */
$("layerTg").onchange = e => {
  [reportLayer, covLayer].forEach(l => { if(l) e.target.checked ? l.addTo(map) : map.removeLayer(l); });
};

/* ---------- API ---------- */
async function post(path, body){
  const r = await fetch(CONFIG.API_BASE + path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
  if(!r.ok){
    let d = ""; try{ d = (await r.json()).detail; }catch(_){}
    throw Object.assign(new Error(typeof d === "string" && d ? d : "API returned " + r.status), {fromApi:true});
  }
  return r.json();
}
async function ping(){
  try{ await fetch(CONFIG.API_BASE + "/docs", {mode:"no-cors"}); $("demoTxt").textContent = "Demo data"; }
  catch(_){ $("demoTxt").textContent = "Demo data · API offline"; }
}
ping(); setInterval(ping, 10000);

/* ---------- reports ---------- */
$("repBtn").onclick = () => $("repModal").classList.toggle("show");
$("repX").onclick = () => { $("repModal").classList.remove("show"); setMode(null); };
$("pickRep").onclick = () => setMode(mode === "rep" ? null : "rep");
$("sev").querySelectorAll("button").forEach(b => b.onclick = () => {
  sev = +b.dataset.v; $("sev").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
});
async function sendReport(ll){
  if(!inCoverage(ll)) return toast(OUTSIDE(), true);
  try{
    const r = await post(CONFIG.REPORT_PATH, {lat:ll.lat, lon:ll.lng, crime_type:$("crime").value, severity_num:sev});
    const msg = {accepted:"Concern reported. Routes updated.", duplicate:"Someone already reported here in the last hour.",
      rejected:"No road within 150 m of that point. Click closer to a road."}[r.status] || r.status;
    toast(msg, r.status !== "accepted");
    if(r.status === "accepted"){
      L.marker(ll, {interactive:false, icon:L.divIcon({className:"", iconSize:[0,0],
        html:`<div class="mk w"><span class="tri"><svg class="i"><use href="#i-warn"/></svg></span><span class="lab">Reported concern<small>Illustrative · not a live alert</small></span></div>`})}).addTo(reportLayer);
      setMode(null); $("repModal").classList.remove("show");
      if(from && to) findRoutes();
    }
  }catch(err){ toast("Could not send the report: " + err.message, true); }
}
$("reset").onclick = async () => {
  try{ await post("/reset", {}); reportLayer.clearLayers(); toast("Reports cleared. Risk is back to the original data."); if(from && to) findRoutes(); }
  catch(err){ toast("Could not reset: " + err.message, true); }
};

/* ---------- route parsing ---------- */
function fixPath(p){
  if(!Array.isArray(p) || !p.length || !Array.isArray(p[0])) return p;
  return p[0][0] > 40 ? p.map(([x, y]) => [y, x]) : p;   // [lon,lat] -> [lat,lon]
}
function pickRoute(r){
  if(!r) return null;
  const path = fixPath(r.path || r.coordinates || (r.geometry && r.geometry.coordinates) || r.polyline);
  if(!path) return null;
  const km = Number(r.distance_km ?? (r.distance_m != null ? r.distance_m / 1000 : r.length_km ?? 0)) || 0;
  const risk = Number(r.risk ?? r.avg_risk ?? r.total_risk ?? r.S ?? r.safety_score ?? 0) || 0;
  const min = r.duration_min ?? r.time_min ?? (r.duration_s != null ? r.duration_s / 60 : null);
  return {path, distance_km:km, risk, min, via:r.via || r.name || null};
}
const sig = r => { const p = r.path, n = p.length, s = []; for(let i = 0; i < 8; i++){ const q = p[Math.floor(i * (n - 1) / 7)]; s.push(q[0].toFixed(4) + "," + q[1].toFixed(4)); } return n + "|" + s.join(";"); };
function collect(d){
  console.log("route response:", d);
  const out = [], add = (raw, tag) => { const r = pickRoute(raw); if(r) out.push({r, tag}); };
  add(d.fastest, "fast"); add(d.recommended, "rec");
  ["alternatives","alternates","others","routes"].forEach(k => Array.isArray(d[k]) && d[k].forEach(x => add(x, "alt")));
  return out;
}

/* ---------- scoring and ranking ---------- */
function score(){
  routes.forEach(r => r.t = Math.max(1, Math.round(r.min != null ? r.min : r.distance_km / CONFIG.AVG_KMH * 60)));
  const maxRisk = Math.max(...routes.map(r => r.risk));
  routes.forEach(r => { r.safety = Math.max(0, Math.min(100, Math.round(maxRisk <= 1 ? (1 - r.risk) * 100 : (1 - r.risk / (maxRisk * 1.25)) * 100))); r.key = r.min != null ? r.min : r.distance_km; });
  const fast = routes.reduce((a, b) => b.key < a.key ? b : a), safe = routes.reduce((a, b) => b.risk < a.risk ? b : a);
  routes.forEach(r => { r.isFast = r === fast; r.isSafe = r === safe; });
  const maxKey = Math.max(...routes.map(r => r.key));
  const comp = r => userAlpha * (r.risk / (maxRisk || 1)) + (1 - userAlpha) * (r.key / (maxKey || 1));
  routes.sort((a, b) => (b.isRec - a.isRec) || comp(a) - comp(b));
  ctx = {fast};
}
const expo = p => p >= 70 ? ["low", "Lower exposure", "Lower risk"] : p >= 45 ? ["mod", "Moderate exposure", "Moderate risk"] : ["high", "Higher exposure", "Higher risk"];
const isDark = () => document.documentElement.dataset.theme === "dark";
const gcol = () => isDark() ? "#3fbf8a" : GREEN;
const barColor = p => p >= 70 ? gcol() : p >= 45 ? AMBER : RED;
function titleOf(r){ return r.isFast && r.isSafe ? "Fastest and safest" : r.isSafe ? "Lower exposure" : r.isFast ? "Fastest" : r.isRec ? "Recommended" : "Alternative route"; }

/* ---------- drawing ---------- */
function drawLine(r, i, sel, bounds){
  const c = L.polyline(r.path, {color:isDark() ? "#0f1814" : "#fff", weight:sel ? 10 : 8, opacity:.95}).addTo(routeLayer);
  const l = L.polyline(r.path, {color:sel ? gcol() : ALT, weight:sel ? 6 : 5, lineCap:"round"}).addTo(routeLayer);
  [c, l].forEach(x => x.on("click", () => pick(i)));
  bounds.extend(l.getBounds());
  const mid = r.path[Math.floor(r.path.length * [.5, .33, .67][i % 3])];
  const sub = sel ? expo(r.safety)[1] : (r.isFast ? "Fastest" : "Alternative");
  L.marker(mid, {zIndexOffset:sel ? 800 : 500, icon:L.divIcon({className:"", iconSize:[0,0],
    html:`<div class="rl${sel ? " sel" : ""}"><b>${r.t} min</b><small>${sub} · ${r.distance_km.toFixed(1)} km</small></div>`})})
    .on("click", () => pick(i)).addTo(routeLayer);
}
function render(fit){
  routeLayer.clearLayers(); const box = $("routes"); box.innerHTML = "";
  $("count").textContent = routes.length + (routes.length === 1 ? " route" : " routes"); $("start").disabled = false;
  const bounds = L.latLngBounds([]);
  routes.forEach((r, i) => i !== selected && drawLine(r, i, false, bounds));
  drawLine(routes[selected], selected, true, bounds);
  const fast = ctx.fast;
  routes.forEach((r, i) => {
    const sel = i === selected, [cls, exLabel, chipLabel] = expo(r.safety), dk = r.distance_km - fast.distance_km, dt = r.t - fast.t;
    const pct = fast.risk > 0 ? Math.round((1 - r.risk / fast.risk) * 100) : 0;
    const diff = r === fast ? "Quickest route" : `${dt > 0 ? dt + " min longer" : "Same travel time"} · ${pct > 0 ? pct + "% less risk" : "similar risk"}`;
    const desc = r.via ? "via " + esc(r.via) : i === 0 ? "Best match for your settings" : r.isFast ? "Shortest travel time" : "Alternative path";
    const b = document.createElement("button"); b.type = "button"; b.className = "rt" + (sel ? " sel" : "");
    b.innerHTML = `<div class="r1"><b>${i === 0 ? '<svg class="i" style="color:var(--g)"><use href="#i-shield"/></svg>' : '<span class="dash"></span>'}${titleOf(r)}<span class="rk">#${i + 1}</span></b><span class="time">${r.t} min</span></div>
      <div class="r2"><span>${desc}</span><span>${r.distance_km.toFixed(1)} km</span></div>
      <div class="r3">${sel ? `<span>${diff}</span>` : `<span class="${cls}">${exLabel}</span><span>${r === fast ? "Quickest" : (dk >= 0 ? "+" : "") + dk.toFixed(1) + " km"}</span>`}</div>
      ${sel ? `<div class="r3"><span><span class="chipg ${cls}">${chipLabel}</span>Example safety assessment</span></div>` : ""}
      <div class="safe"><span>Safety</span><div class="bar"><i style="width:${r.safety}%;background:${barColor(r.safety)}"></i></div><b>${r.safety}%</b></div>`;
    b.onclick = () => pick(i); box.appendChild(b);
  });
  if(fit && bounds.isValid()) map.fitBounds(bounds, {paddingTopLeft:[60, 100], paddingBottomRight:[60, 120]});
}
function pick(i){ selected = i; render(false); }

/* ---------- find routes ---------- */
async function findRoutes(){
  if(!from || !to) return;
  setMode(null); $("start").disabled = true;
  userAlpha = +$("alpha").value;
  const ws = [...new Set([userAlpha, 0, .3, .6, .95].map(x => +x.toFixed(2)))];
  $("routes").innerHTML = '<p class="empty">Finding routes…</p>';
  const res = await Promise.allSettled(ws.map(w => post(CONFIG.ROUTE_PATH,
    {origin:[from.lat, from.lng], destination:[to.lat, to.lng], safety_weight:w, womens_mode:$("women").checked})));
  let cands = [];
  if(res.every(x => x.status === "rejected")){
    const err = res[0].reason;
    if(err.fromApi || !CONFIG.USE_MOCK_IF_API_DOWN){
      toast(err.fromApi ? err.message : "Could not reach the API: " + err.message, true);
      $("routes").innerHTML = '<p class="empty">' + esc(err.fromApi ? err.message : "Could not reach the API.") + "</p>"; return;
    }
    const m = mockRoutes(from, to);
    cands = [{r:m.fast, tag:"fast"}, {r:m.safe, tag:"rec", mine:true}];
    toast("API not reachable. Showing sample routes.", true);
  }else{
    res.forEach((x, i) => x.status === "fulfilled" && collect(x.value).forEach(c => cands.push({...c, mine:i === 0 && c.tag === "rec"})));
  }
  const seen = new Map();
  cands.forEach(c => { const k = sig(c.r); if(!seen.has(k)) seen.set(k, c.r); if(c.mine) seen.get(k).isRec = true; });
  routes = [...seen.values()].map(r => (r.isRec = !!r.isRec, r));
  if(!routes.length){ $("routes").innerHTML = '<p class="empty">The API returned no routes for those points.</p>'; return toast("No routes found.", true); }
  score(); routes = routes.slice(0, 3); selected = 0; render(!routed); routed = true;
}
function mockRoutes(a, b){
  const mid = (t, off) => [a.lat + (b.lat - a.lat) * t + off * (b.lng - a.lng), a.lng + (b.lng - a.lng) * t - off * (b.lat - a.lat)];
  const mk = off => [[a.lat, a.lng], mid(.33, off), mid(.66, off), [b.lat, b.lng]];
  const km = pts => pts.slice(1).reduce((s, p, i) => s + map.distance(pts[i], p), 0) / 1000;
  const f = mk(0), s = mk(.12);
  return {fast:{path:f, distance_km:km(f), risk:10}, safe:{path:s, distance_km:km(s) * 1.08, risk:6}};
}

/* ---------- start and share ---------- */
$("start").onclick = () => {
  if(!routes.length) return;
  map.fitBounds(L.polyline(routes[selected].path).getBounds(), {paddingTopLeft:[60, 100], paddingBottomRight:[60, 120]});
  toast("Route preview ready. Turn-by-turn navigation is not part of this demo.");
};
$("share").onclick = async () => {
  if(!routes.length) return toast("Find a route first");
  const r = routes[selected];
  const txt = `PathWise route: ${names.from} to ${names.to}. ${r.distance_km.toFixed(1)} km, about ${r.t} min, ${r.safety}% safety score.`;
  try{ await navigator.clipboard.writeText(txt); toast("Route summary copied."); }catch(_){ toast(txt); }
};

/* ---------- init ---------- */
loadCoverage().then(() => {
  if(CONFIG.DEMO_PREFILL){
    setPoint("from", CONFIG.DEMO_FROM.ll, CONFIG.DEMO_FROM.name, {keepMode:true, auto:false});
    setPoint("to", CONFIG.DEMO_TO.ll, CONFIG.DEMO_TO.name, {keepMode:true});
  }
});

/* ---------- safety guide (GET /safety-guide) ---------- */
let guideLoaded = false;
function showTab(which){
  $("guide").classList.toggle("show", which === "guide");
  $("tab-guide").classList.toggle("on", which === "guide");
  $("tab-plan").classList.toggle("on", which !== "guide");
  if(which === "guide") loadGuide(); else setTimeout(() => map.invalidateSize(), 50);
}
$("tab-plan").onclick = e => { e.preventDefault(); showTab("plan"); };
$("tab-guide").onclick = e => { e.preventDefault(); showTab("guide"); };
$("helpBtn").onclick = () => showTab("guide");
async function loadGuide(){
  if(guideLoaded) return;
  const box = $("guideBody"); box.innerHTML = '<p class="empty">Loading the safety guide…</p>';
  try{
    const r = await fetch(CONFIG.API_BASE + "/safety-guide"); if(!r.ok) throw new Error("API returned " + r.status);
    const g = await r.json();
    box.innerHTML = `<h2>${esc(g.title)}</h2><p class="gi">${esc(g.intro)}</p>
      <div class="emg">${g.emergency.map(e => `<a class="ec" href="tel:${esc(e.number)}"><b>${esc(e.number)}</b><span>${esc(e.name)}</span></a>`).join("")}</div>
      ${g.sections.map(s => `<div class="gs"><h3>${esc(s.title)}</h3><ul>${s.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>`).join("")}
      <p class="gd">${esc(g.disclaimer)}</p>`;
    guideLoaded = true;
  }catch(err){
    box.innerHTML = '<p class="empty">Could not load the safety guide. Check that the API is running, then reopen this tab.</p>';
  }
}

/* ---------- dark theme ---------- */
function applyTheme(t, save){
  document.documentElement.dataset.theme = t;
  $("themeIco").setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
  $("themeBtn").setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  if(save){ try{ localStorage.setItem("pw-theme", t); }catch(_){} }
  if(routes.length) render(false);
}
$("themeBtn").onclick = () => applyTheme(isDark() ? "light" : "dark", true);
applyTheme(document.documentElement.dataset.theme || "light", false);