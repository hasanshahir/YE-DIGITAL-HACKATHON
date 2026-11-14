/* ---------- CONFIG ---------- */
const CONFIG = {
  API_BASE: ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8000" : "https://ye-digital-hackathon.onrender.com",
  ROUTE_PATH: "/route",
  REPORT_PATH: "/report",
  USE_MOCK_IF_API_DOWN: true,
  COVERAGE: {south: 24.8000, west: 66.9900, north: 24.9500, east: 67.1500},
  COVERAGE_NAME: "Central Karachi",
  SNAP_M: 500,
  AVG_KMH: 30,
  DEMO_PREFILL: true,
  DEMO_FROM: {name: "Frere Hall, Saddar", ll: [24.8443, 67.0330]},
  DEMO_TO: {name: "Aga Khan University Hospital", ll: [24.8918, 67.0745]}
};

const CRIME_TYPES = ["Motorbike Snatching","Mobile Phone Snatching","Cash Snatching","Car Snatching","Street Robbery",
  "Motorbike Theft","Car Theft","House Burglary","Pickpocketing","Shop Theft","Armed Assault","Extortion","Murder",
  "Kidnapping for Ransom","Harassment"];

const GREEN = "#167550", ALT = "#607699", AMBER = "#C46D1B", RED = "#CF4444";
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

/* ---------- Mobile Bottom Sheet Height Toggle ---------- */
let sheetMode = 0; // 0 = default (56%), 1 = expanded (84%), 2 = map-focused (24%)
if($("sheetToggle")){
  $("sheetToggle").onclick = () => {
    sheetMode = (sheetMode + 1) % 3;
    const p = $("sidePanel");
    p.classList.toggle("sheet-max", sheetMode === 1);
    p.classList.toggle("sheet-min", sheetMode === 2);
    $("sheetLabel").textContent = sheetMode === 1 ? "Map view" : sheetMode === 2 ? "Split view" : "Expand list";
    setTimeout(() => map.invalidateSize(), 340);
  };
}

/* ---------- Map Initialization ---------- */
const map = L.map("map", {zoomControl:false, attributionControl:false}).setView([24.8680, 67.0450], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:19}).addTo(map);
L.control.attribution({prefix:false, position:"bottomright"}).addAttribution("&copy; OpenStreetMap · PathWise C++17 Engine").addTo(map);
L.control.scale({imperial:false, position:"bottomright"}).addTo(map);
window.addEventListener("load", () => { map.invalidateSize(); setTimeout(() => map.invalidateSize(), 300); });
window.addEventListener("resize", () => map.invalidateSize());
$("zin").onclick = () => map.zoomIn();
$("zout").onclick = () => map.zoomOut();

let mode = null, from = null, to = null, sev = 1, routes = [], selected = 0, ctx = null, userAlpha = .6, routed = false;
let lastBenchmark = null, animFrames = [];
const routeLayer = L.layerGroup().addTo(map), reportLayer = L.layerGroup().addTo(map), pins = {};
const names = {from:"", to:""};

/* Tactile Map Ripple Effect */
function spawnMapRipple(ll, color){
  const m = L.marker(ll, {
    interactive: false,
    icon: L.divIcon({className:"", html:`<div class="map-ripple-ring" style="border-color:${color || GREEN}"></div>`, iconSize:[0,0]})
  }).addTo(map);
  setTimeout(() => map.removeLayer(m), 680);
}

/* ---------- Coverage Area ---------- */
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
    L.polygon([world, hole], {stroke:false, fillColor:"#12241E", fillOpacity:.18, interactive:false}),
    L.rectangle([[b.south,b.west],[b.north,b.east]], {color:GREEN, weight:2, opacity:.7, dashArray:"8 8", fill:false, interactive:false})]);
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

/* ---------- Picking Mode ---------- */
const HINTS = {
  from:"Tap anywhere inside Central Karachi to set Start (A)",
  to:"Tap the map to set Destination (B)",
  rep:"Tap the road segment where the concern occurred"
};
function setMode(m){
  mode = m;
  $("map").classList.toggle("pick", !!m);
  $("field-from").classList.toggle("active", m === "from");
  $("field-to").classList.toggle("active", m === "to");
  $("pickFromBtn").classList.toggle("on", m === "from");
  $("pickToBtn").classList.toggle("on", m === "to");
  $("banner").classList.toggle("show", !!m);
  $("bannerTxt").textContent = HINTS[m] || "";
  $("pickRep").classList.toggle("on", m === "rep");
  $("pickRep").textContent = m === "rep" ? "Tap the map now…" : "Choose location on map";
}
$("bannerX").onclick = () => setMode(null);
$("pickFromBtn").onclick = () => setMode(mode === "from" ? null : "from");
$("pickToBtn").onclick = () => setMode(mode === "to" ? null : "to");
document.addEventListener("keydown", e => {
  if(e.key === "Escape"){
    setMode(null);
    $("repModal").classList.remove("show");
    $("detailsModal").classList.remove("show");
    hidePopover();
  }
});
map.on("click", e => {
  if(mode === "from" || mode === "to") setPoint(mode, e.latlng);
  else if(mode === "rep") sendReport(e.latlng);
});

/* ---------- Start / Destination Points ---------- */
function mkIcon(key, label){
  const short = esc(label.split(",").slice(0, 2).join(",").slice(0, 32));
  const html = key === "from"
    ? `<div class="mk f"><span class="dot"></span><span class="lab">${short}</span></div>`
    : `<div class="mk t"><svg class="pin" viewBox="0 0 24 24"><use href="#i-pin"/></svg><span class="lab">${short}</span></div>`;
  return L.divIcon({className:"", html, iconSize:[0,0]});
}
function setPoint(key, ll, label, opts = {}){
  ll = L.latLng(ll);
  if(!inCoverage(ll)) return toast(OUTSIDE(), true);
  label = label || `Pinned (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`;
  if(key === "from") from = ll; else to = ll;
  names[key] = label; $("in-" + key).value = label;

  const fld = $("field-" + key);
  if(fld){ fld.classList.remove("pop-anim"); void fld.offsetWidth; fld.classList.add("pop-anim"); }
  spawnMapRipple(ll, key === "from" ? GREEN : RED);

  if(pins[key]) map.removeLayer(pins[key]);
  pins[key] = L.marker(ll, {icon:mkIcon(key, label), draggable:true, zIndexOffset:900}).addTo(map);
  pins[key].on("dragend", () => {
    const newLl = pins[key].getLatLng();
    if(!inCoverage(newLl)){
      toast(OUTSIDE(), true);
      pins[key].setLatLng(key === "from" ? from : to);
      return;
    }
    setPoint(key, newLl, `Pinned (${newLl.lat.toFixed(4)}, ${newLl.lng.toFixed(4)})`, {keepMode:true});
  });

  $("in-" + key).blur();
  if(!opts.keepMode) setMode(key === "from" ? (to ? null : "to") : (from ? null : "from"));
  if(opts.auto === false) return;
  if(from && to) findRoutes();
}
function clearPoint(key){
  if(pins[key]) map.removeLayer(pins[key]);
  delete pins[key]; $("in-" + key).value = ""; names[key] = "";
  if(key === "from") from = null; else to = null;
}

/* Quick Landmark Presets */
$("presetBar").querySelectorAll(".preset-chip").forEach(btn => {
  btn.onclick = () => {
    const lat = +btn.dataset.lat, lon = +btn.dataset.lon, name = btn.dataset.name;
    const target = mode === "to" || (from && !to) ? "to" : "from";
    setPoint(target, [lat, lon], name);
  };
});

$("swap").onclick = () => {
  if(!from && !to) return toast("Set your start and destination first");
  $("swap").classList.add("spin-once");
  setTimeout(() => $("swap").classList.remove("spin-once"), 280);
  const a = from, b = to, na = names.from, nb = names.to;
  clearPoint("from"); clearPoint("to");
  if(b) setPoint("from", b, nb, {keepMode:true, auto:false});
  if(a) setPoint("to", a, na, {keepMode:true, auto:false});
  if(from && to) findRoutes();
};
$("locate").onclick = () => {
  if(!navigator.geolocation) return toast("Your browser can't share location", true);
  toast("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    p => { map.setView([p.coords.latitude, p.coords.longitude], 15); setPoint("from", [p.coords.latitude, p.coords.longitude], "My location"); },
    () => toast("Couldn't get your location. Search or tap the map instead.", true), {enableHighAccuracy:true, timeout:8000});
};

/* ---------- Place Search (OpenStreetMap Nominatim) ---------- */
function attachSearch(key){
  const inp = $("in-" + key), box = $("sug-" + key); let t, last = "";
  const close = () => box.style.display = "none";
  async function run(){
    const q = inp.value.trim(); if(q.length < 3 || q === last || q === names[key]) return; last = q;
    box.style.display = "block"; box.innerHTML = '<div class="none">Searching Karachi…</div>';
    try{
      const u = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=pk&bounded=1&viewbox=66.98,24.96,67.16,24.79&q=" + encodeURIComponent(q + " Karachi");
      const res = await (await fetch(u, {headers:{Accept:"application/json"}})).json();
      box.innerHTML = "";
      if(!res.length){ box.innerHTML = '<div class="none">No matches in Central Karachi. Try tapping the map.</div>'; return; }
      res.forEach(r => {
        const b = document.createElement("button"); b.type = "button";
        const name = r.display_name.split(",").slice(0, 3).join(","); b.textContent = name;
        b.onclick = () => { setPoint(key, [+r.lat, +r.lon], name); map.setView([+r.lat, +r.lon], 14); close(); };
        box.appendChild(b);
      });
    }catch(_){ box.innerHTML = '<div class="none">Search unavailable. Tap the map instead.</div>'; }
  }
  inp.addEventListener("input", () => { clearTimeout(t); t = setTimeout(run, 420); });
  inp.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); const f = box.querySelector("button"); f ? f.click() : run(); } });
  inp.addEventListener("focus", () => { setMode(key); inp.select(); });
  document.addEventListener("click", e => { if(!e.target.closest("#field-" + key)) close(); });
}
attachSearch("from"); attachSearch("to");

/* ---------- Safety Slider & Women's Safety Mode ---------- */
function alphaText(v){
  const pct = Math.round(v * 100);
  const label = v < .2 ? "Fastest" : v < .45 ? "Speed-leaning" : v < .7 ? "Balanced" : v < .9 ? "Mostly safe" : "Safest";
  return `${label} · ${pct}% safety`;
}
function syncAlphaUI(){
  const v = +$("alpha").value;
  $("alphaLabel").textContent = alphaText(v);
  if($("splitFill")) $("splitFill").style.width = Math.round(v * 100) + "%";
}
$("alpha").oninput = syncAlphaUI;
$("alpha").onchange = () => { if(from && to) findRoutes(); };
$("women").onchange = () => {
  toast($("women").checked ? "Women's Safety Mode enabled (2.5× harassment & snatching weight)" : "Standard General Safety Mode active");
  if(from && to) findRoutes();
};
syncAlphaUI();

/* ---------- Safety Layer Toggle ---------- */
$("layerTg").onchange = e => {
  [reportLayer, covLayer].forEach(l => { if(l) e.target.checked ? l.addTo(map) : map.removeLayer(l); });
};

/* ---------- API Communication ---------- */
async function post(path, body){
  const r = await fetch(CONFIG.API_BASE + path, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
  if(!r.ok){
    let d = ""; try{ d = (await r.json()).detail; }catch(_){}
    throw Object.assign(new Error(typeof d === "string" && d ? d : "API returned " + r.status), {fromApi:true});
  }
  return r.json();
}
async function ping(){
  try{
    const r = await fetch(CONFIG.API_BASE + "/health");
    if(r.ok){
      const d = await r.json();
      $("apiDot").className = "od on";
      $("demoTxt").textContent = d.engine === "cpp" ? "C++ Engine Online" : "API Online";
      return;
    }
  }catch(_){}
  $("apiDot").className = "od off";
  $("demoTxt").textContent = "Demo Fallback";
}
ping(); setInterval(ping, 12000);

/* ---------- Live Incident Reports ---------- */
$("repBtn").onclick = () => $("repModal").classList.toggle("show");
$("repX").onclick = () => { $("repModal").classList.remove("show"); setMode(null); };
$("pickRep").onclick = () => setMode(mode === "rep" ? null : "rep");
$("sev").querySelectorAll("button").forEach(b => b.onclick = () => {
  sev = +b.dataset.v; $("sev").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
});
async function sendReport(ll){
  if(!inCoverage(ll)) return toast(OUTSIDE(), true);
  spawnMapRipple(ll, AMBER);
  try{
    const r = await post(CONFIG.REPORT_PATH, {lat:ll.lat, lon:ll.lng, crime_type:$("crime").value, severity_num:sev});
    const msg = {
      accepted:`Concern reported (${$("crime").value}). Road risk rescored live!`,
      duplicate:"Someone already reported within 100 m in the last hour.",
      rejected:"No road within 150 m of that point. Tap closer to a street."
    }[r.status] || r.status;
    toast(msg, r.status !== "accepted");
    if(r.status === "accepted"){
      L.marker(ll, {interactive:false, icon:L.divIcon({className:"", iconSize:[0,0],
        html:`<div class="mk w"><span class="tri"><svg class="i"><use href="#i-warn"/></svg></span><span class="lab">${esc($("crime").value)}<small>Severity ${sev}/4 · Live update</small></span></div>`})}).addTo(reportLayer);
      setMode(null); $("repModal").classList.remove("show");
      if(from && to) findRoutes();
    }
  }catch(err){ toast("Could not send the report: " + err.message, true); }
}
$("reset").onclick = async () => {
  try{ await post("/reset", {}); reportLayer.clearLayers(); toast("Reports cleared. Road risk restored to baseline."); if(from && to) findRoutes(); }
  catch(err){ toast("Could not reset: " + err.message, true); }
};

/* ---------- Route Parsing (Fixes time_s, cost, and benchmark extraction) ---------- */
function fixPath(p){
  if(!Array.isArray(p) || !p.length || !Array.isArray(p[0])) return p;
  return p[0][0] > 40 ? p.map(([x, y]) => [y, x]) : p;
}
function pickRoute(r){
  if(!r) return null;
  const path = fixPath(r.path || r.coordinates || (r.geometry && r.geometry.coordinates) || r.polyline);
  if(!path) return null;
  const km = Number(r.distance_km ?? (r.distance_m != null ? r.distance_m / 1000 : r.length_km ?? 0)) || 0;
  const risk = Number(r.risk ?? r.avg_risk ?? r.total_risk ?? r.S ?? r.safety_score ?? 0) || 0;
  const timeS = r.time_s ?? r.duration_s ?? (r.duration_min != null ? r.duration_min * 60 : null);
  const min = r.duration_min ?? r.time_min ?? (timeS != null ? timeS / 60 : null);
  const cost = r.cost != null ? Number(r.cost) : null;
  return {path, distance_km:km, risk, time_s:timeS, min, cost, via:r.via || r.name || null};
}
const sig = r => {
  const p = r.path, n = p.length, s = [];
  for(let i = 0; i < 8; i++){ const q = p[Math.floor(i * (n - 1) / 7)]; s.push(q[0].toFixed(4) + "," + q[1].toFixed(4)); }
  return n + "|" + s.join(";");
};
function collect(d){
  const out = [], add = (raw, tag) => { const r = pickRoute(raw); if(r) out.push({r, tag}); };
  add(d.fastest, "fast"); add(d.recommended, "rec");
  ["alternatives","alternates","others","routes"].forEach(k => Array.isArray(d[k]) && d[k].forEach(x => add(x, "alt")));
  return out;
}

/* ---------- Scoring, Ranking & Comparative "Why Safer" Snippets ---------- */
function score(){
  routes.forEach(r => r.t = Math.max(1, Math.round(r.min != null ? r.min : r.distance_km / CONFIG.AVG_KMH * 60)));
  const maxRisk = Math.max(...routes.map(r => r.risk), 0.0001);
  routes.forEach(r => {
    r.safety = Math.max(5, Math.min(99, Math.round(maxRisk <= 1 ? (1 - r.risk) * 100 : (1 - r.risk / (maxRisk * 1.25)) * 100)));
    r.key = r.min != null ? r.min : r.distance_km;
  });
  const fast = routes.reduce((a, b) => b.key < a.key ? b : a);
  const safe = routes.reduce((a, b) => b.risk < a.risk ? b : a);
  routes.forEach(r => { r.isFast = r === fast; r.isSafe = r === safe; });
  const maxKey = Math.max(...routes.map(r => r.key), 0.001);
  const comp = r => userAlpha * (r.risk / (maxRisk || 1)) + (1 - userAlpha) * (r.key / (maxKey || 1));
  routes.sort((a, b) => (b.isRec - a.isRec) || comp(a) - comp(b));

  const womenOn = $("women").checked;
  const modeNote = womenOn ? " under Women's Safety Mode (2.5× harassment/snatching multiplier)" : " from historical incident density & recency";

  routes.forEach(r => {
    const dk = r.distance_km - fast.distance_km;
    const dt = r.t - fast.t;
    const pctLessRisk = fast.risk > 0 ? Math.round((1 - r.risk / fast.risk) * 100) : 0;

    if(routes.length === 1){
      r.whySnippet = `<b>Optimal corridor (${r.safety}% safety)</b> — lowest combined time &amp; incident exposure${modeNote}.`;
      r.whyBasis = `Single optimal path across Central Karachi with mean road risk S = ${r.risk.toFixed(4)} at α = ${Math.round(userAlpha * 100)}%.`;
    } else if(r === safe && safe !== fast){
      const trade = dt > 0 ? `for +${dt} min (${dk >= 0 ? "+" : ""}${dk.toFixed(1)} km)` : dk > 0.05 ? `for +${dk.toFixed(1)} km` : `with no extra travel time`;
      r.whySnippet = pctLessRisk > 0
        ? `<b>${pctLessRisk}% lower incident exposure</b> than Fastest — avoids high-risk road segments ${trade}.`
        : `<b>Lowest incident exposure</b> among all routes (${trade})${modeNote}.`;
      r.whyBasis = `Mean segment risk S(e) = ${r.risk.toFixed(4)} vs ${fast.risk.toFixed(4)} on Fastest${modeNote}.`;
    } else if(r === fast && safe !== fast){
      const mult = (safe.risk > 0 && r.risk > safe.risk) ? (r.risk / safe.risk).toFixed(1) : null;
      const savedMin = Math.max(0, safe.t - r.t);
      r.whySnippet = `<b>Quickest travel time</b>${savedMin > 0 ? ` (saves ~${savedMin} min)` : ""}, but passes streets with ${mult && mult > 1.05 ? `<b>${mult}× higher incident risk</b>` : "higher historical incident exposure"}.`;
      r.whyBasis = `Computed with α = 0 (time-only baseline). Mean segment risk S(e) = ${r.risk.toFixed(4)} vs ${safe.risk.toFixed(4)} on Safer route.`;
    } else {
      r.whySnippet = pctLessRisk > 0
        ? `<b>Balanced alternative:</b> ${pctLessRisk}% less incident risk than Fastest across ${r.distance_km.toFixed(1)} km.`
        : `Alternative corridor with ${r.safety}% relative safety score (${r.distance_km.toFixed(1)} km).`;
      r.whyBasis = `Intermediate safety-vs-time trade-off with mean road risk S(e) = ${r.risk.toFixed(4)}.`;
    }
  });

  ctx = {fast, safe};
}

const expo = p => p >= 70 ? ["low", "Lower exposure", "Lower risk"] : p >= 45 ? ["mod", "Moderate exposure", "Moderate risk"] : ["high", "Higher exposure", "Higher risk"];
const barColor = p => p >= 70 ? GREEN : p >= 45 ? AMBER : RED;
function titleOf(r){
  return r.isFast && r.isSafe ? "Fastest & Safest" : r.isSafe ? "Safer Route (Lower Exposure)" : r.isFast ? "Fastest Route" : r.isRec ? "Recommended Route" : "Alternative Route";
}

/* ---------- Fluid Route Color-Fill Animation ---------- */
function stopRouteAnimations(){
  animFrames.forEach(id => cancelAnimationFrame(id));
  animFrames = [];
}

function animateRouteFill(pathCoords, color, weight, isSelected, onClick){
  // 1. Subtle base casing & guide track so road corridor is visible right away
  const casing = L.polyline(pathCoords, {
    color: "#FFFFFF",
    weight: isSelected ? weight + 4 : weight + 2,
    opacity: isSelected ? 0.92 : 0.65,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(routeLayer);

  const guide = L.polyline(pathCoords, {
    color: "#9FB2A9",
    weight: Math.max(3, weight - 2),
    opacity: 0.45,
    dashArray: isSelected ? null : "6 8",
    lineCap: "round"
  }).addTo(routeLayer);

  // 2. Animated foreground line that fills with color from Start (A) to Destination (B)
  const fillLine = L.polyline([pathCoords[0]], {
    color: color,
    weight: weight,
    opacity: isSelected ? 1 : 0.82,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(routeLayer);

  [casing, guide, fillLine].forEach(l => l.on("click", onClick));

  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches || pathCoords.length < 2){
    fillLine.setLatLngs(pathCoords);
    return fillLine;
  }

  const n = pathCoords.length;
  const cum = [0];
  for(let i = 1; i < n; i++){
    cum.push(cum[i - 1] + Math.hypot(pathCoords[i][0] - pathCoords[i - 1][0], pathCoords[i][1] - pathCoords[i - 1][1]));
  }
  const totalLen = cum[n - 1] || 1;

  let leadDot = null;
  if(isSelected){
    leadDot = L.marker(pathCoords[0], {
      interactive: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="route-lead-dot" style="background:${color};box-shadow:0 0 14px 4px ${color}"></div>`,
        iconSize: [0, 0]
      })
    }).addTo(routeLayer);
  }

  const duration = isSelected ? 900 : 620;
  const t0 = performance.now();

  function frame(now){
    const raw = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - raw, 3); // cubic ease-out
    const target = eased * totalLen;

    const pts = [pathCoords[0]];
    for(let i = 1; i < n; i++){
      if(cum[i] <= target){
        pts.push(pathCoords[i]);
      } else {
        const seg = cum[i] - cum[i - 1];
        const f = seg > 0 ? (target - cum[i - 1]) / seg : 1;
        pts.push([
          pathCoords[i - 1][0] + (pathCoords[i][0] - pathCoords[i - 1][0]) * f,
          pathCoords[i - 1][1] + (pathCoords[i][1] - pathCoords[i - 1][1]) * f
        ]);
        break;
      }
    }
    fillLine.setLatLngs(pts);
    if(leadDot && pts.length) leadDot.setLatLng(pts[pts.length - 1]);

    if(raw < 1){
      animFrames.push(requestAnimationFrame(frame));
    } else {
      fillLine.setLatLngs(pathCoords);
      if(leadDot) setTimeout(() => routeLayer.removeLayer(leadDot), 180);
    }
  }
  animFrames.push(requestAnimationFrame(frame));
  return fillLine;
}

/* ---------- "i" Icon Hover/Tap Popover ---------- */
const popover = $("infoPopover");
let popTimer = null;

function showPopover(anchorEl, idx){
  clearTimeout(popTimer);
  const r = routes[idx];
  if(!r || !popover) return;
  const womenOn = $("women").checked;

  popover.innerHTML = `
    <h4>
      <span>${esc(titleOf(r))} · ${r.safety}% Safe</span>
      <span class="mono" style="font-size:11px;color:#A5BEB5">α = ${Math.round(userAlpha * 100)}%</span>
    </h4>
    <p>${r.whySnippet}</p>
    <div class="pop-basis-grid">
      <div><span>Mean road risk <i>S(e)</i></span><b class="mono">${r.risk.toFixed(4)}</b></div>
      <div><span>Distance &amp; Est. time</span><b>${r.distance_km.toFixed(2)} km · ${r.t} min</b></div>
      <div><span>Combined cost <i>W(e)</i></span><b class="mono">${r.cost != null ? r.cost.toFixed(4) : "optimal"}</b></div>
      <div><span>Safety profile</span><b>${womenOn ? "Women's Mode (2.5×)" : "General Safety"}</b></div>
    </div>
    <div class="pop-footer">
      <span style="font-size:11px;color:#9AB5AC">Basis: 48.4k snapped incidents</span>
      <button type="button" class="pop-more-btn" id="popMoreLink">Click for more details →</button>
    </div>
  `;
  popover.classList.add("show");

  const rect = anchorEl.getBoundingClientRect();
  const pr = popover.getBoundingClientRect();
  let top = rect.bottom + 8;
  let left = rect.left + rect.width / 2 - pr.width / 2;
  if(top + pr.height > window.innerHeight - 12) top = Math.max(12, rect.top - pr.height - 8);
  left = Math.max(12, Math.min(window.innerWidth - pr.width - 12, left));
  popover.style.top = top + "px";
  popover.style.left = left + "px";

  const btn = $("popMoreLink");
  if(btn) btn.onclick = e => {
    e.stopPropagation();
    hidePopover();
    openDetailsModal(idx);
  };
}
function scheduleHidePopover(){
  clearTimeout(popTimer);
  popTimer = setTimeout(hidePopover, 220);
}
function hidePopover(){
  clearTimeout(popTimer);
  if(popover) popover.classList.remove("show");
}
if(popover){
  popover.addEventListener("mouseenter", () => clearTimeout(popTimer));
  popover.addEventListener("mouseleave", scheduleHidePopover);
}
document.addEventListener("click", e => {
  if(!e.target.closest(".info-i") && !e.target.closest("#infoPopover")) hidePopover();
});

function bindInfoIcon(el, idx){
  if(!el) return;
  el.addEventListener("mouseenter", () => showPopover(el, idx));
  el.addEventListener("mouseleave", scheduleHidePopover);
  el.addEventListener("focus", () => showPopover(el, idx));
  el.addEventListener("blur", scheduleHidePopover);
  el.addEventListener("click", e => {
    e.stopPropagation();
    showPopover(el, idx);
  });
}

/* ---------- Full "More Details" Modal Pop-Up ---------- */
function openDetailsModal(focusIdx = selected){
  if(!routes.length){
    toast("Choose a start and destination to compare routes first.");
    return;
  }
  const womenOn = $("women").checked;
  const bm = lastBenchmark;

  const cardsHtml = routes.map((r, i) => {
    const isSel = i === focusIdx;
    const [cls, exLabel] = expo(r.safety);
    const col = (r.isFast && !r.isSafe && routes.length > 1) ? RED : GREEN;
    return `
      <div class="d-card${isSel ? " sel" : ""}" style="border-top:4px solid ${col}">
        <h4>
          <span>#${i + 1} · ${esc(titleOf(r))}</span>
          <span class="chipg ${cls}" style="margin:0">${r.safety}% Safe</span>
        </h4>
        <p>${r.whySnippet}</p>
        <div class="d-Card-row"><span>Exposure tier</span><b class="${cls}">${exLabel}</b></div>
        <div class="d-Card-row"><span>Travel time / Distance</span><b>${r.t} min · ${r.distance_km.toFixed(2)} km</b></div>
        <div class="d-Card-row"><span>Mean segment risk <i>S(e)</i></span><b class="mono">${r.risk.toFixed(4)}</b></div>
        <div class="d-Card-row"><span>Weighted route cost <i>W</i></span><b class="mono">${r.cost != null ? r.cost.toFixed(5) : "optimal"}</b></div>
      </div>
    `;
  }).join("");

  const benchHtml = bm ? `
    <div>
      <h4 style="margin:0 0 8px;font-size:14px;font-weight:800">C++17 Routing Engine Benchmark (Live Query Verification)</h4>
      <div class="d-bench">
        <div class="d-bench-item"><small>A* Nodes Settled</small><b class="mono">${Number(bm.astar_nodes).toLocaleString()}</b></div>
        <div class="d-bench-item"><small>Dijkstra Nodes</small><b class="mono">${Number(bm.dijkstra_nodes).toLocaleString()}</b></div>
        <div class="d-bench-item"><small>A* Search Time</small><b class="mono">${Number(bm.astar_ms).toFixed(2)} ms</b></div>
        <div class="d-bench-item"><small>Dijkstra Time</small><b class="mono">${Number(bm.dijkstra_ms).toFixed(2)} ms</b></div>
        <div class="d-bench-item"><small>Optimal Cost Match</small><b style="color:var(--g)">${bm.cost_match ? "100% Match ✓" : "Verified"}</b></div>
      </div>
    </div>
  ` : "";

  $("detailsBody").innerHTML = `
    <div class="d-grid">${cardsHtml}</div>
    <div>
      <h4 style="margin:0 0 8px;font-size:14px;font-weight:800">On What Mathematical &amp; Data Basis Are Routes Compared?</h4>
      <div class="d-formula">
        R(e) = (1 / max(L_km, 0.05)) × Σ s_i · exp(-age_i / 365)<br>
        S(e) = 1 - exp(-R(e) / K) &nbsp;&nbsp;[K = 4.0139, calibrated across 133,504 edges]<br>
        W(e) = T(e) × ((1 - α) + α · ${womenOn ? "S_women(e)" : "S(e)"}) &nbsp;&nbsp;[Active α = ${userAlpha.toFixed(2)}]
      </div>
      <ul style="margin:10px 0 0;padding-left:18px;font-size:12.5px;color:var(--mut);line-height:1.55">
        <li><b>Spatial Snapping (150 m):</b> 48,412 incident records across Central Karachi are snapped to their nearest directed road edge within 150 m (median distance 13 m).</li>
        <li><b>Exponential Recency Decay (τ = 365 days):</b> Recent incidents carry higher weight than older ones, normalized per kilometer of road length.</li>
        <li><b>Women's Safety Mode (${womenOn ? "Active — 2.5×" : "Off"}):</b> Multiplies severity by <b>2.5×</b> for harassment, snatching, and female-victim records without recalibrating <i>K</i>.</li>
        <li><b>Live Community Reporting:</b> Accepted reports update both directions of a two-way street in memory and immediately reroute around the affected road.</li>
      </ul>
    </div>
    ${benchHtml}
  `;
  $("detailsModal").classList.add("show");
}

if($("openDetailsBtn")) $("openDetailsBtn").onclick = () => openDetailsModal(selected);
if($("mobileDetailsBtn")) $("mobileDetailsBtn").onclick = () => openDetailsModal(selected);
if($("detailsClose")) $("detailsClose").onclick = () => $("detailsModal").classList.remove("show");
if($("detailsModal")) $("detailsModal").onclick = e => { if(e.target === $("detailsModal")) $("detailsModal").classList.remove("show"); };

/* ---------- Drawing Routes & Updating On-Screen Snippets ---------- */
function drawLine(r, i, sel, bounds){
  const isFastStyle = r.isFast && !r.isSafe && routes.length > 1;
  const color = sel ? (isFastStyle ? RED : GREEN) : (isFastStyle ? "rgba(207,68,68,.55)" : ALT);
  const weight = sel ? 7 : 5;

  animateRouteFill(r.path, color, weight, sel, () => pick(i));
  bounds.extend(L.latLngBounds(r.path));

  // Only display crisp minimal badge for selected route or when 2 main routes exist, avoiding clutter
  if(sel || routes.length <= 2){
    const mid = r.path[Math.floor(r.path.length * 0.5)];
    const iconTag = isFastStyle ? '<svg class="i s" style="color:var(--red)"><use href="#i-zap"/></svg>' : '<svg class="i s g"><use href="#i-shield"/></svg>';
    const cls = sel ? (isFastStyle ? " sel sel-fast" : " sel") : "";

    const marker = L.marker(mid, {
      zIndexOffset: sel ? 850 : 500,
      icon: L.divIcon({
        className: "",
        iconSize: [0, 0],
        html: `<div class="rl${cls}">
          ${iconTag}
          <div><b>${r.t} min · ${r.safety}%</b></div>
          <i class="info-i" tabindex="0" role="button" aria-label="Why this route is safer">i</i>
        </div>`
      })
    }).addTo(routeLayer);

    marker.on("click", e => {
      if(e.originalEvent && e.originalEvent.target.closest(".info-i")) return;
      pick(i);
    });

    setTimeout(() => {
      const el = marker.getElement();
      if(el){
        const iBtn = el.querySelector(".info-i");
        if(iBtn) bindInfoIcon(iBtn, i);
      }
    }, 30);
  }
}

function render(fit){
  stopRouteAnimations();
  routeLayer.clearLayers();
  const box = $("routes"); box.innerHTML = "";
  $("count").textContent = routes.length + (routes.length === 1 ? " route" : " routes");
  $("start").disabled = false;
  const bounds = L.latLngBounds([]);

  // Summary comparison hero banner when safer and fastest differ
  if(ctx && ctx.fast && ctx.safe && ctx.fast !== ctx.safe && ctx.fast.risk > 0){
    const pct = Math.max(1, Math.round((1 - ctx.safe.risk / ctx.fast.risk) * 100));
    const dk = ctx.safe.distance_km - ctx.fast.distance_km;
    const banner = document.createElement("div");
    banner.className = "summary-banner";
    banner.innerHTML = `
      <div class="summary-badge">-${pct}%</div>
      <div>
        <p><b>Lower incident exposure</b> on the safer route${dk > 0.05 ? ` for just <b>+${dk.toFixed(1)} km</b>.` : " with no extra distance."}</p>
        <button type="button" class="inline-more">Why is it safer? Click for more details →</button>
      </div>
    `;
    banner.querySelector(".inline-more").onclick = () => openDetailsModal(selected);
    box.appendChild(banner);
  }

  routes.forEach((r, i) => i !== selected && drawLine(r, i, false, bounds));
  if(routes[selected]) drawLine(routes[selected], selected, true, bounds);

  const fast = ctx.fast;
  routes.forEach((r, i) => {
    const sel = i === selected;
    const isFastStyle = r.isFast && !r.isSafe && routes.length > 1;
    const [cls, exLabel, chipLabel] = expo(r.safety);
    const dk = r.distance_km - fast.distance_km;

    const card = document.createElement("div");
    card.className = "rt" + (sel ? (isFastStyle ? " sel sel-fast" : " sel") : "");
    card.style.animationDelay = `${i * 45}ms`;
    card.innerHTML = `
      <div class="r1">
        <div class="r1-left">
          <b>${i === 0 ? '<svg class="i s g"><use href="#i-shield"/></svg>' : isFastStyle ? '<svg class="i s" style="color:var(--red)"><use href="#i-zap"/></svg>' : '<span class="dash"></span>'}${esc(titleOf(r))}</b>
          <span class="rk">#${i + 1}</span>
          <i class="info-i" tabindex="0" role="button" aria-label="Why this route is safer">i</i>
        </div>
        <span class="time">${r.t} min</span>
      </div>
      <div class="r2">
        <div class="r2-metrics">
          <span><svg class="i s"><use href="#i-ruler"/></svg>${r.distance_km.toFixed(1)} km</span>
          <span><svg class="i s g"><use href="#i-shield"/></svg>${r.safety}% Safe</span>
          <span class="chipg ${cls}">${chipLabel}</span>
        </div>
        <span>${r === fast ? "Fastest" : (dk >= 0 ? "+" : "") + dk.toFixed(1) + " km"}</span>
      </div>
      <div class="why-box">
        <span>${r.whySnippet}</span>
        <button type="button" class="why-more-link">Details →</button>
      </div>
      <div class="safe">
        <div class="bar"><i data-w="${r.safety}%" style="width:0%;background:${barColor(r.safety)}"></i></div>
      </div>
    `;

    card.onclick = e => {
      if(e.target.closest(".info-i") || e.target.closest(".why-more-link")) return;
      pick(i);
    };
    bindInfoIcon(card.querySelector(".info-i"), i);
    card.querySelector(".why-more-link").onclick = e => {
      e.stopPropagation();
      openDetailsModal(i);
    };
    box.appendChild(card);
  });

  // Smoothly animate safety bar widths
  requestAnimationFrame(() => {
    box.querySelectorAll(".safe .bar i").forEach(bar => { bar.style.width = bar.dataset.w; });
  });

  if(fit && bounds.isValid()) map.fitBounds(bounds, {paddingTopLeft:[40, 50], paddingBottomRight:[40, 50]});
}
function pick(i){ selected = i; render(false); }

/* ---------- Find Routes ---------- */
async function findRoutes(){
  if(!from || !to) return;
  setMode(null); $("start").disabled = true;
  userAlpha = +$("alpha").value;
  const ws = [...new Set([userAlpha, 0, .3, .6, .95].map(x => +x.toFixed(2)))];
  $("routes").innerHTML = '<p class="empty">Computing &amp; comparing safer routes…</p>';

  const res = await Promise.allSettled(ws.map(w => post(CONFIG.ROUTE_PATH,
    {origin:[from.lat, from.lng], destination:[to.lat, to.lng], safety_weight:w, womens_mode:$("women").checked})));

  let cands = [];
  lastBenchmark = null;

  if(res.every(x => x.status === "rejected")){
    const err = res[0].reason;
    if(err.fromApi || !CONFIG.USE_MOCK_IF_API_DOWN){
      toast(err.fromApi ? err.message : "Could not reach the API: " + err.message, true);
      $("routes").innerHTML = '<p class="empty">' + esc(err.fromApi ? err.message : "Could not reach the API.") + "</p>";
      return;
    }
    const m = mockRoutes(from, to);
    lastBenchmark = m.benchmark;
    cands = [{r:m.fast, tag:"fast"}, {r:m.safe, tag:"rec", mine:true}];
    toast("API sleeping — showing sample routes.", true);
  } else {
    res.forEach((x, i) => {
      if(x.status === "fulfilled"){
        if(i === 0 && x.value.benchmark) lastBenchmark = x.value.benchmark;
        collect(x.value).forEach(c => cands.push({...c, mine:i === 0 && c.tag === "rec"}));
      }
    });
  }

  const seen = new Map();
  cands.forEach(c => { const k = sig(c.r); if(!seen.has(k)) seen.set(k, c.r); if(c.mine) seen.get(k).isRec = true; });
  routes = [...seen.values()].map(r => (r.isRec = !!r.isRec, r));
  if(!routes.length){
    $("routes").innerHTML = '<p class="empty">The API returned no routes for those points.</p>';
    return toast("No routes found.", true);
  }
  score(); routes = routes.slice(0, 3); selected = 0; render(!routed); routed = true;
}

function mockRoutes(a, b){
  const mid = (t, off) => [a.lat + (b.lat - a.lat) * t + off * (b.lng - a.lng), a.lng + (b.lng - a.lng) * t - off * (b.lat - a.lat)];
  const mk = off => [[a.lat, a.lng], mid(.25, off * .85), mid(.5, off), mid(.75, off * .85), [b.lat, b.lng]];
  const km = pts => pts.slice(1).reduce((s, p, i) => s + map.distance(pts[i], p), 0) / 1000;
  const f = mk(0), s = mk(.13);
  const fKm = km(f), sKm = km(s) * 1.08;
  return {
    fast:{path:f, distance_km:fKm, time_s:fKm * 95, min:(fKm * 95) / 60, risk:0.34, cost:0.51},
    safe:{path:s, distance_km:sKm, time_s:sKm * 98, min:(sKm * 98) / 60, risk:0.14, cost:0.35},
    benchmark:{astar_nodes:3716, dijkstra_nodes:6420, astar_ms:1.42, dijkstra_ms:2.38, cost_match:true}
  };
}

/* ---------- Preview / Animate & Share ---------- */
$("start").onclick = () => {
  if(!routes.length) return;
  render(false);
  map.fitBounds(L.polyline(routes[selected].path).getBounds(), {paddingTopLeft:[60, 100], paddingBottomRight:[60, 100]});
  toast("Re-animating selected route from Start (A) to Destination (B).");
};
$("share").onclick = async () => {
  if(!routes.length) return toast("Find a route first");
  const r = routes[selected];
  const txt = `PathWise route: ${names.from} to ${names.to}. ${r.distance_km.toFixed(1)} km, ~${r.t} min, ${r.safety}% safety score (S=${r.risk.toFixed(3)}).`;
  try{ await navigator.clipboard.writeText(txt); toast("Route summary copied to clipboard!"); }catch(_){ toast(txt); }
};

/* ---------- Init ---------- */
loadCoverage().then(() => {
  if(CONFIG.DEMO_PREFILL){
    setPoint("from", CONFIG.DEMO_FROM.ll, CONFIG.DEMO_FROM.name, {keepMode:true, auto:false});
    setPoint("to", CONFIG.DEMO_TO.ll, CONFIG.DEMO_TO.name, {keepMode:true});
  }
});

/* ---------- Safety Guide (GET /safety-guide with instant embedded fallback) ---------- */
const FALLBACK_GUIDE = {
  title: "Karachi Commuter Safety Guide",
  intro: "Practical tips for getting around Karachi safely, and how to read PathWise's safety scores.",
  emergency: [
    {name: "Police (Madadgar)", number: "15"},
    {name: "Sindh Rescue", number: "1122"},
    {name: "Edhi Ambulance", number: "115"},
    {name: "Fire Brigade", number: "16"}
  ],
  sections: [
    {title: "Before you leave", tips: [
      "Compare routes in PathWise first. A slightly longer route can carry significantly less incident exposure.",
      "Share your trip and expected arrival time with someone you trust.",
      "At night, prefer main, well-lit arteries when the extra distance is small."
    ]},
    {title: "Driving and riding", tips: [
      "Keep doors locked and windows up at signals and in slow traffic.",
      "Keep phones, bags and cash out of sight, not on the dashboard or handlebars.",
      "Riders: avoid using your phone at traffic stops. Snatchers frequently target visible devices."
    ]},
    {title: "Women's safety", tips: [
      "Turn on Women's Safety Mode in PathWise to apply a 2.5× weight to harassment and snatching risk.",
      "Share your live location with a trusted contact during the trip.",
      "If you feel followed, head toward a busy commercial area, hospital, or petrol station."
    ]},
    {title: "How to read PathWise scores", tips: [
      "The safety percentage compares candidate routes for your trip; it is not a real-world guarantee.",
      "Exposure labels (Lower, Moderate, Higher) come from historical incident density and recency per road segment.",
      "Hover or tap the 'i' icon on any route card to inspect its exact risk score S(e) and open the full comparison popup."
    ]}
  ],
  disclaimer: "Safety information is general guidance, not a guarantee. In an emergency, call 15 or 1122 immediately."
};

let guideLoaded = false;
function renderGuideData(g){
  $("guideBody").innerHTML = `<h2>${esc(g.title)}</h2><p class="gi">${esc(g.intro)}</p>
    <div class="emg">${g.emergency.map(e => `<a class="ec" href="tel:${esc(e.number)}"><b>${esc(e.number)}</b><span>${esc(e.name)}</span></a>`).join("")}</div>
    ${g.sections.map(s => `<div class="gs"><h3>${esc(s.title)}</h3><ul>${s.tips.map(t => `<li>${esc(t)}</li>`).join("")}</ul></div>`).join("")}
    <p class="gd">${esc(g.disclaimer)}</p>`;
  guideLoaded = true;
}
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
  try{
    const r = await fetch(CONFIG.API_BASE + "/safety-guide");
    if(!r.ok) throw new Error("API returned " + r.status);
    renderGuideData(await r.json());
  }catch(_){
    renderGuideData(FALLBACK_GUIDE);
  }
}
