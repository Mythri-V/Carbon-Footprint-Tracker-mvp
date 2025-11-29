/* frontend/script.js — hotspot component breakdown + suggestions + top-hotspots
   NOTE: explicit canvas.height and style.height set to avoid infinite document height.
*/

function $id(id){ return document.getElementById(id); }
function fmt(n){ return (typeof n === 'number' ? Number(n.toFixed(2)) : n); }
function safeNumber(x){ const n = Number(String(x || '').replace(/[^0-9.\-eE]/g,'')); return isNaN(n) ? 0 : n; }

const MATERIAL_FACTORS_FRONT = { metal:6.0, plastic:3.0, textile:4.0, glass:1.8, food:2.5, paper:1.5, other:1.0 };
const GRID_KGCO2_PER_KWH = 0.233;

let RAW_ROWS = [];
let RESULTS = { total:0, scopes:{s1:0,s2:0,s3:0}, stageTotals:{}, hotspots:[], details:[] };

function parseCSV(text){
  if(!text) return [];
  text = text.replace(/\r\n/g,'\n').trim();
  const lines = text.split('\n').filter(l => l.trim().length>0);
  if(lines.length === 0) return [];
  const header = lines.shift();
  const cols = header.split(',').map(c => c.trim().replace(/^"|"$/g,'').toLowerCase());
  return lines.map(line=>{
    const cells = []; let cur = '', inQ = false;
    for(let i=0;i<line.length;i++){ const ch = line[i]; if(ch === '"'){ inQ = !inQ; continue; } if(ch === ',' && !inQ){ cells.push(cur); cur=''; continue; } cur+=ch; }
    cells.push(cur);
    const obj = {}; for(let i=0;i<cols.length;i++) obj[cols[i]] = (cells[i] ?? '').trim();
    return obj;
  });
}

/* ---------- Ensure hotspot DOM + explicit canvas sizing ---------- */
function ensureHotspotDOM(){
  let hot = $id('hotspotBreakdown');
  if(!hot){
    const hotspotCard = $id('hotspotContainer') || document.querySelector('.hotspot-card');
    hot = document.createElement("div"); hot.id = "hotspotBreakdown";
    (hotspotCard || document.body).appendChild(hot);
  }

  if(!$id('hotspotListInner')){
    const list = document.createElement('div'); list.id = 'hotspotListInner'; list.className = 'hotspot-list';
    hot.appendChild(list);
  }

  // create componentChart canvas if not present and set explicit pixel height
  if(!$id('componentChart')){
    const wrap = document.createElement('div'); wrap.className = 'component-chart-wrap';
    wrap.style.marginTop = '8px';
    const title = document.createElement('div'); title.style.fontWeight = 600; title.style.marginBottom = '6px'; title.textContent = 'Component breakdown';
    const canvas = document.createElement('canvas'); canvas.id = 'componentChart';
    // explicit pixel sizing prevents Chart.js from expanding document height
    canvas.width = 600;
    canvas.height = 260;
    canvas.style.width = '100%';
    canvas.style.height = '260px';
    wrap.appendChild(title); wrap.appendChild(canvas);
    hot.appendChild(wrap);
  }

  if(!$id('hotspotSuggestionList')){
    const s = document.createElement('div'); s.id = 'hotspotSuggestionList'; s.style.marginTop='10px';
    $id('hotspotContainer').querySelector('.card-body').appendChild(s);
  }
}

/* ---------- Wiring + others (unchanged majority) ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const uploadBox = $id("uploadBox");
  const fileInput = $id("fileInput");
  const fileName = $id("fileName");
  const pickFileBtn = $id("pickFileBtn");

  if(uploadBox && fileInput){
    uploadBox.addEventListener("click", () => fileInput.click());
    pickFileBtn?.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length > 0) {
        const f = fileInput.files[0];
        if (fileName) fileName.textContent = `${f.name} • ${Math.round(f.size/1024)} KB`;
        onFile({ target: { files: fileInput.files }});
      }
    });
    uploadBox.addEventListener("dragover", (e)=>{ e.preventDefault(); uploadBox.style.background="#f1f5f9"; });
    uploadBox.addEventListener("dragleave", ()=>{ uploadBox.style.background="white"; });
    uploadBox.addEventListener("drop",(e)=>{ e.preventDefault(); uploadBox.style.background="white"; const f = e.dataTransfer.files[0]; if(f){ fileInput.files = e.dataTransfer.files; if (fileName) fileName.textContent = `${f.name} • ${Math.round(f.size/1024)} KB`; onFile({ target:{ files:e.dataTransfer.files }}); }});
  }

  if($id('computeBtn')) $id('computeBtn').addEventListener('click', computeEmissions);
  if($id('downloadBtn')) $id('downloadBtn').addEventListener('click', downloadResults);

  ensureHotspotDOM();
  try { renderStageChart([],[]); renderScopeChart([0,0,0]); renderHotspotMiniChart([0,0,0]); } catch(e){ console.warn(e); }
  updateHotspotPanel(null);
});

function onFile(e){
  const f = e.target.files?.[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    RAW_ROWS = parseCSV(ev.target.result);
    if($id('messages')) $id('messages').textContent = `Loaded ${RAW_ROWS.length} rows. Click Compute emissions.`;
    if($id('downloadBtn')) $id('downloadBtn').disabled = true;
  };
  reader.readAsText(f);
}

function computeEmissions(){
  if(RAW_ROWS.length===0){ if($id('messages')) $id('messages').textContent = "No CSV loaded."; return; }

  RESULTS={ total:0, scopes:{s1:0,s2:0,s3:0}, stageTotals:{}, hotspots:[], details:[] };

  RAW_ROWS.forEach((row, idx)=>{
    const r = {}; for(const k in row) r[k.toLowerCase()] = (row[k] ?? '').toString().trim();
    const stage = (r.stage || r['stage_name'] || 'unknown');
    const mode = (r.mode || '').toLowerCase();
    const dist = safeNumber(r.distance_km || r.distance || r.km || r['distance (km)'] || 0);
    const weight = safeNumber(r.weight_kg || r.weight || r.qty || r.quantity || 0);
    const tons = weight / 1000.0;

    const TRANSPORT_FACTORS_G_TKM = { truck:62, road:62, rail:22, sea:15, ship:15, air:500, last_mile:90 };
    const t_factor_g = TRANSPORT_FACTORS_G_TKM[mode] || 62;
    const transport_kg = (dist * tons * t_factor_g) / 1000.0;

    const material_type = (r.material_type || r.material || 'other').toLowerCase();
    const mat_factor = MATERIAL_FACTORS_FRONT[material_type] || MATERIAL_FACTORS_FRONT['other'];
    const material_kg = mat_factor * weight;

    const energy_kwh = safeNumber(r.manufacturing_energy_kwh || r.manufacturing || r['manufacturing (kwh)'] || 0);
    const manufacturing_kg = energy_kwh * GRID_KGCO2_PER_KWH;

    const total = transport_kg + material_kg + manufacturing_kg;

    RESULTS.total += total;
    RESULTS.stageTotals[stage] = (RESULTS.stageTotals[stage] || 0) + total;

    let scope1 = 0, scope2 = 0, scope3 = 0;
    const owner = (r.ownership || '').toLowerCase();
    if (['owned','company','company_owned','own'].includes(owner) || stage.toLowerCase().includes('owned') || stage.toLowerCase().includes('on_site')) {
      scope1 = transport_kg;
    } else if (mode === 'air') {
      scope3 = transport_kg;
    } else {
      scope3 = transport_kg;
    }
    scope2 = manufacturing_kg;

    RESULTS.scopes.s1 += scope1;
    RESULTS.scopes.s2 += scope2;
    RESULTS.scopes.s3 += scope3 + material_kg;

    RESULTS.details.push({
      index: idx,
      total: total,
      transport_kg: transport_kg,
      material_kg: material_kg,
      manufacturing_kg: manufacturing_kg,
      stage: stage,
      mode: mode,
      distance_km: dist,
      weight_kg: weight,
      material_type: material_type,
      ownership: owner,
      raw: r
    });
  });

  RESULTS.hotspots = RESULTS.details.slice().sort((a,b)=>b.total - a.total).slice(0,5);

  populateUI();
  if($id('messages')) $id('messages').textContent = "Computation complete.";
  if($id('downloadBtn')) $id('downloadBtn').disabled = false;
}

function populateUI(){
  if($id('totalVal')) $id('totalVal').textContent = fmt(RESULTS.total);
  if($id('scope1Val')) $id('scope1Val').textContent = fmt(RESULTS.scopes.s1);
  if($id('scope2Val')) $id('scope2Val').textContent = fmt(RESULTS.scopes.s2);
  if($id('scope3Val')) $id('scope3Val').textContent = fmt(RESULTS.scopes.s3);

  ensureHotspotDOM();

  const hotlist = $id('hotspotListInner');
  if(hotlist){
    hotlist.innerHTML = RESULTS.hotspots.map((h, i) => {
      return `<div class="hotspot-row" data-idx="${i}">
                <div style="display:flex;justify-content:space-between;align-items:center">
                  <div><strong>${h.stage}</strong><div style="font-size:12px;color:#6b7280">${h.mode || 'n/a'}</div></div>
                  <div style="text-align:right"><div style="font-weight:700">${fmt(h.total)}</div><div style="font-size:12px;color:#6b7280">kg CO₂</div></div>
                </div>
              </div>`;
    }).join('');
    hotlist.querySelectorAll('.hotspot-row').forEach(el=>{
      el.style.cursor='pointer';
      el.addEventListener('click', ()=> {
        const idx = Number(el.getAttribute('data-idx') || 0);
        const row = RESULTS.hotspots[idx];
        updateHotspotPanel(row);
      });
    });
  }

  const primary = RESULTS.hotspots[0] || null;
  updateHotspotPanel(primary);

  const stages = Object.entries(RESULTS.stageTotals).sort((a,b)=>b[1]-a[1]);
  renderStageChart(stages.map(r=>r[0]), stages.map(r=>fmt(r[1])));
  renderScopeChart([fmt(RESULTS.scopes.s1), fmt(RESULTS.scopes.s2), fmt(RESULTS.scopes.s3)]);
  renderHotspotMiniChart([ fmt(primary?.transport_kg||0), fmt(primary?.manufacturing_kg||0), fmt(primary?.material_kg||0) ]);
  renderComponentChart(primary);
  renderSuggestions(primary);
}

function updateHotspotPanel(row){
  const set = (id,val)=>{ const el = $id(id); if(el) el.textContent = (val===undefined||val===null) ? "—" : val; };

  if(row && RESULTS.total > 0){
    const pct = (row.total / RESULTS.total) * 100;
    set('hsContributionPct', `${fmt(pct)}%`);
    set('hsRowTotal', fmt(row.total));
  } else { set('hsContributionPct', '—'); set('hsRowTotal', '—'); }

  set('hsMode', row?.mode || '—');
  set('hsStage', row?.stage || '—');
  set('hsDistance', (row?.distance_km !== undefined) ? String(row.distance_km) : '—');
  set('hsWeight', (row?.weight_kg !== undefined) ? String(row.weight_kg) : '—');
  set('hsMaterial', row?.material_type || '—');
  set('hsEnergy', row?.manufacturing_kg ? fmt(row.manufacturing_kg) : (row?.manufacturing_kg===0? '0' : '—'));

  const dl = $id('hsDownloadBtn') || $id('hsDownloadBtnBackup');
  if(dl){ dl.onclick = () => downloadHotspotCSV(row); dl.disabled = !row; }
}

function renderSuggestions(row){
  const container = $id('hotspotSuggestionList');
  if(!container) return;
  container.innerHTML = '';
  if(!row){ container.innerHTML = '<div style="color:#6b7280">No hotspot selected.</div>'; return; }

  const t = row.transport_kg || 0; const m = row.material_kg || 0; const e = row.manufacturing_kg || 0; const total = row.total || 0;
  const suggestions = [];
  if(row.mode === 'air') suggestions.push({text:"Shift air freight to sea/rail for long legs.", est: total*0.6});
  if(row.mode === 'truck' && row.distance_km > 500) suggestions.push({text:"Move long-distance truck legs to rail/sea or consolidate shipments.", est: total*0.3});
  if(m > t && m > e){
    if(row.material_type === 'plastic') suggestions.push({text:"Use recycled plastic or redesign packaging to reduce plastic mass.", est: total*0.25});
    else suggestions.push({text:"Reduce material weight or increase recycled content.", est: total*0.2});
  }
  if(t > m && t > e) suggestions.push({text:"Consolidate shipments and optimise routing to cut transport emissions.", est: total*0.18});
  if(e > Math.max(t,m)) suggestions.push({text:"Switch to renewable electricity for manufacturing to cut energy emissions.", est: total*0.4});
  if(suggestions.length===0) suggestions.push({text:"General: optimise routing, consolidation, and material weight reduction.", est: total*0.1});

  const ul = document.createElement('div'); ul.className = 'suggestion-list';
  suggestions.forEach(s=>{
    const rowEl = document.createElement('div'); rowEl.className = 'suggestion-item';
    rowEl.innerHTML = `<div class="s-text">${s.text}</div><div class="s-est">est. reduction: <strong>${fmt(s.est)}</strong> kg CO₂</div>`;
    ul.appendChild(rowEl);
  });
  container.appendChild(ul);

  const actions = document.createElement('div'); actions.style.marginTop='8px';
  actions.innerHTML = `<button id="hsDownloadBtn" class="btn small">Download hotspot CSV</button>`;
  container.appendChild(actions);
  const dl = $id('hsDownloadBtn'); if(dl) dl.onclick = () => downloadHotspotCSV(row);
}

/* Charts */
let stageChart=null;
function renderStageChart(labels,values){
  const el = $id("stageChart"); if(!el) return; const ctx = el.getContext("2d");
  if(stageChart) stageChart.destroy();
  stageChart = new Chart(ctx, { type: "bar", data: { labels: labels, datasets: [{ data: values, backgroundColor: "#2563eb" }] }, options: { indexAxis: "y", plugins: { legend: { display: false } }, responsive:true, maintainAspectRatio:false } });
}

let scopeChart = null;
function renderScopeChart(values){
  const el = $id("scopeChart"); if(!el) return; const ctx = el.getContext("2d");
  if(scopeChart) scopeChart.destroy();
  scopeChart = new Chart(ctx, { type: "doughnut", data: { labels: ["Scope 1","Scope 2","Scope 3"], datasets: [{ data: values }] }, options: { plugins:{ legend:{ display:false } }, responsive:true, maintainAspectRatio:false } });
}

let mini = null;
function renderHotspotMiniChart(values){
  const el = $id("hotspotMiniChart"); if(!el) return; const ctx = el.getContext("2d");
  if(mini) mini.destroy();
  mini = new Chart(ctx, { type: "doughnut", data: { labels:["Transport","Manufacturing","Material"], datasets:[{ data: values }] }, options: { plugins:{ legend:{ display:false } }, responsive:true, maintainAspectRatio:false } });
}

let compChart = null;
function renderComponentChart(row){
  const el = $id('componentChart'); if(!el) return; const ctx = el.getContext('2d');
  // ensure canvas has explicit pixel height to avoid growth
  el.width = 600; el.height = 260; el.style.height = '260px';
  const data = row ? [ row.transport_kg || 0, row.manufacturing_kg || 0, row.material_kg || 0 ] : [0,0,0];
  if(compChart) compChart.destroy();
  compChart = new Chart(ctx, { type: 'bar', data: { labels: ['Transport','Manufacturing','Material'], datasets: [{ data: data, backgroundColor: ['#3b82f6','#fb7185','#10b981'] }] }, options: { indexAxis: 'y', plugins:{ legend:{ display:false } }, responsive:true, maintainAspectRatio:false } });
}

/* downloads */
function downloadHotspotCSV(row){
  if(!row) return;
  const headers = ['index','stage','mode','distance_km','weight_kg','transport_kg','material_kg','manufacturing_kg','total_kg'];
  const vals = [ row.index, row.stage, row.mode, row.distance_km, row.weight_kg, fmt(row.transport_kg), fmt(row.material_kg), fmt(row.manufacturing_kg), fmt(row.total) ];
  const csv = headers.join(',') + '\n' + vals.join(',');
  const blob = new Blob([csv], {type:'text/csv'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'hotspot_row.csv'; a.click();
}

function downloadResults(){ const data = JSON.stringify(RESULTS,null,2); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([data],{type:"application/json"})); link.download="emissions_report.json"; link.click(); }


// ---------- Navigation for left-side buttons (smooth scroll + active toggle) ----------
(function initLeftNav(){
  document.querySelectorAll('.nav-link[data-target]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      // active class toggle
      document.querySelectorAll('.nav-link').forEach(n=>n.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.getAttribute('data-target');
      if(!target) return;
      if(target === 'top'){
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const el = document.getElementById(target) || document.querySelector(`[name="${target}"]`);
      if(el){
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // small offset if header covers content
        window.scrollBy(0, -24);
      } else {
        console.warn('Nav target not found:', target);
      }
    });
  });
})();
