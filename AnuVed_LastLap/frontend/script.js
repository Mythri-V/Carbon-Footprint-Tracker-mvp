// frontend/script.js
// Full frontend logic for Supply Chain CO2 Dashboard
// - file upload (drag/drop + file picker)
// - POST to /api/compute (FormData)
// - renders Stage, Scope and Hotspot charts with Chart.js
// - DPR canvas fix, chart value plugin, modal export
// Replace entire file with this content.

//
// === GLOBAL STATE & DOM REFS ===
//
let selectedFile = null;
let lastResult = null;

const uploadBox = document.getElementById('uploadBox');
const fileInput = document.getElementById('fileInput');
const pickFileBtn = document.getElementById('pickFileBtn');
const fileNameEl = document.getElementById('fileName');

const computeBtn = document.getElementById('computeBtn');
const downloadBtn = document.getElementById('downloadBtn');
const presetSelect = document.getElementById('presetSelect');
const messages = document.getElementById('messages');
const sensitivityToggle = document.getElementById('sensitivityToggle');
const sensitivityPanel = document.getElementById('sensitivityPanel');
const sensitivityTable = document.getElementById('sensitivityTable');

const totalVal = document.getElementById('totalVal');
const scope1Val = document.getElementById('scope1Val');
const scope2Val = document.getElementById('scope2Val');
const scope3Val = document.getElementById('scope3Val');

const stageCanvas = document.getElementById('stageChart');
const scopeCanvas = document.getElementById('scopeChart');
const hotspotCanvas = document.getElementById('hotspotMiniChart');

const hsMode = document.getElementById('hsMode');
const hsStage = document.getElementById('hsStage');
const hsDistance = document.getElementById('hsDistance');
const hsWeight = document.getElementById('hsWeight');
const hsMaterial = document.getElementById('hsMaterial');
const hsEnergy = document.getElementById('hsEnergy');
const hsBreak = document.getElementById('hotspotBreakdown');
const hsSuggest = document.getElementById('hotspotSuggestion');
const hsViewRowBtn = document.getElementById('hsViewRowBtn');
const hsDownloadBtn = document.getElementById('hsDownloadBtn');

const chartModal = document.getElementById('chartModal');
const modalCanvas = document.getElementById('modalCanvas');
const modalTitle = document.getElementById('modalTitle');
const modalClose = document.getElementById('modalClose');
const exportPNG = document.getElementById('exportPNG');

let stageChart = null;
let scopeChart = null;
let hotspotMiniChart = null;

//
// === HELPERS ===
//
function numberFormat(x) {
  const n = Number(x || 0);
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return (Math.round(n * 100) / 100).toLocaleString();
}
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Ensures canvas pixel density matches devicePixelRatio for crisp charts
function fixCanvasForDPR(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

//
// === Chart plugin: value labels (small, safe) ===
//
const BarValuePlugin = {
  id: 'barValuePlugin',
  afterDatasetsDraw(chart, args, options) {
    const { ctx, chartArea } = chart;
    ctx.save();
    chart.data.datasets.forEach((dataset, dsIndex) => {
      const meta = chart.getDatasetMeta(dsIndex);
      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (value == null) return;
        const text = (typeof options.format === 'function') ? options.format(value) : String(value);
        ctx.font = `${options.fontSize || 12}px Inter, system-ui, Arial`;
        ctx.textBaseline = 'middle';
        const textWidth = ctx.measureText(text).width;
        const buffer = 8;
        const canvasRight = chartArea.right;
        // place outside if enough room, otherwise inside left of bar end
        if (bar.x + buffer + textWidth < canvasRight) {
          ctx.fillStyle = options.color || '#0f172a';
          ctx.textAlign = 'left';
          ctx.fillText(text, bar.x + buffer, bar.y);
        } else {
          ctx.fillStyle = options.insideColor || '#fff';
          ctx.textAlign = 'right';
          ctx.fillText(text, bar.x - 10, bar.y);
        }
      });
    });
    ctx.restore();
  }
};
Chart.register(BarValuePlugin);

//
// === FILE UPLOAD HANDLERS ===
//
if (uploadBox) {
  uploadBox.addEventListener('click', () => fileInput && fileInput.click());
  uploadBox.addEventListener('dragover', (e) => { e.preventDefault(); uploadBox.classList.add('drag'); });
  uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('drag'));
  uploadBox.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadBox.classList.remove('drag');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFileSelect(f);
  });
}
if (pickFileBtn) pickFileBtn.addEventListener('click', () => fileInput && fileInput.click());
if (fileInput) fileInput.addEventListener('change', (e) => handleFileSelect(e.target.files && e.target.files[0]));

function handleFileSelect(file) {
  if (!file) return;
  selectedFile = file;
  if (fileNameEl) fileNameEl.textContent = `${file.name} • ${Math.round(file.size/1024)} KB`;
  if (messages) messages.textContent = '';
  if (downloadBtn) downloadBtn.disabled = true;
  lastResult = null;
}

//
// === NETWORK: POST to backend ===
//
async function postCompute(form) {
  // expects backend route /api/compute (flask); returns json or CSV blob when download flag used
  const resp = await fetch('/api/compute', { method: 'POST', body: form });
  if (!resp.ok) {
    const txt = await resp.text().catch(()=>`HTTP ${resp.status}`);
    throw new Error(txt || `Server ${resp.status}`);
  }
  const ct = resp.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    return resp.json();
  }
  // fallback - CSV blob
  return resp.blob();
}

//
// === COMPUTE & DOWNLOAD HANDLERS ===
//
if (computeBtn) {
  computeBtn.addEventListener('click', async () => {
    if (!selectedFile) { if (messages) messages.textContent = 'Please select a CSV file first.'; return; }
    computeBtn.disabled = true;
    messages && (messages.textContent = 'Uploading & computing...');
    const form = new FormData();
    form.append('file', selectedFile);
    form.append('preset', presetSelect ? presetSelect.value : 'baseline');
    form.append('compare_all', sensitivityToggle && sensitivityToggle.checked ? '1' : '0');

    try {
      const res = await postCompute(form);
      if (res instanceof Blob) {
        // server returned a file (download)
        const url = URL.createObjectURL(res);
        const a = document.createElement('a'); a.href = url; a.download = 'emissions_results.csv'; document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        messages && (messages.textContent = 'Download started.');
      } else {
        handleResultJSON(res);
      }
    } catch (err) {
      console.error(err);
      messages && (messages.textContent = `Error: ${err.message}`);
    } finally {
      computeBtn.disabled = false;
    }
  });
}

if (downloadBtn) {
  downloadBtn.addEventListener('click', async () => {
    if (!selectedFile) { messages && (messages.textContent = 'Upload and compute first.'); return; }
    downloadBtn.disabled = true;
    messages && (messages.textContent = 'Preparing download...');
    const form = new FormData();
    form.append('file', selectedFile);
    form.append('preset', presetSelect ? presetSelect.value : 'baseline');
    form.append('compare_all', sensitivityToggle && sensitivityToggle.checked ? '1' : '0');
    form.append('download', '1');

    try {
      const resp = await fetch('/api/compute', { method: 'POST', body: form });
      if (!resp.ok) throw new Error(`Server ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'emissions_results.csv'; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      messages && (messages.textContent = 'Download started.');
    } catch (err) {
      console.error(err);
      messages && (messages.textContent = `Download error: ${err.message}`);
    } finally {
      downloadBtn.disabled = false;
    }
  });
}

//
// === PROCESS SERVER JSON RESULT ===
// expected shape (example):
// {
//   total_kgCO2: 12345,
//   scope: { scope1: X, scope2: Y, scope3: Z },
//   stage_breakdown: [{stage:"supplier_to_factory", kg: 1000}, ...],
//   hotspot: { ... row object ...},
//   suggestion: "..."
//
// }
function handleResultJSON(data) {
  lastResult = data;
  const scope1 = Number((data.scope && data.scope.scope1) || 0);
  const scope2 = Number((data.scope && data.scope.scope2) || 0);
  const scope3 = Number((data.scope && data.scope.scope3) || 0);

  if (totalVal) totalVal.innerText = numberFormat(data.total_kgCO2 || 0);
  if (scope1Val) scope1Val.innerText = numberFormat(scope1);
  if (scope2Val) scope2Val.innerText = numberFormat(scope2);
  if (scope3Val) scope3Val.innerText = numberFormat(scope3);

  const stages = (data.stage_breakdown || []).slice(0, 10);
  const labels = stages.map(s => s.stage || s[0]);
  const values = stages.map(s => Number(s.kg || s.value || 0));
  renderStageChart(labels, values);

  renderScopeBarChart(['Scope1','Scope2','Scope3'], [scope1, scope2, scope3]);

  if (data.hotspot) renderHotspot(data.hotspot, data.suggestion || '');

  if (data.sensitivity && Array.isArray(data.sensitivity) && data.sensitivity.length) {
    sensitivityPanel && (sensitivityPanel.hidden = false);
    renderSensitivity(data.sensitivity);
  } else {
    sensitivityPanel && (sensitivityPanel.hidden = true);
    if (sensitivityTable) sensitivityTable.innerText = 'No sensitivity data.';
  }

  if (downloadBtn) downloadBtn.disabled = false;
  messages && (messages.textContent = 'Computation done.');
}

//
// === STAGE CHART (full replace) ===
//
function renderStageChart(labels, values) {
  if (!stageCanvas) return;
  const ctx = fixCanvasForDPR(stageCanvas);
  if (stageChart) stageChart.destroy();

  const nums = values.map(v => Number(v || 0));
  const total = nums.reduce((a,b)=>a+b,0) || 1;
  const maxVal = Math.max(...nums,1);
  const suggestedMax = Math.ceil(maxVal * 1.12);

  // gradient
  const grad = ctx.createLinearGradient(0,0,stageCanvas.getBoundingClientRect().width,0);
  grad.addColorStop(0, '#60a5fa');
  grad.addColorStop(1, '#2563eb');

  stageChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: nums,
        backgroundColor: grad,
        borderRadius: 20,
        barThickness: 36,
        maxBarThickness: 60
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${numberFormat(ctx.parsed.x)} kg — ${((ctx.parsed.x/total)*100).toFixed(2)}%`
          }
        },
        barValuePlugin: {
          color: '#fff',
          insideColor: '#fff',
          fontSize: 13,
          format: (v) => {
            const pct = ((v/total)*100).toFixed(2);
            return `${numberFormat(v)} kg — ${pct}%`;
          }
        }
      },
      layout: { padding: { left: 18, right: 24, top: 10, bottom: 10 } },
      scales: {
        x: {
          beginAtZero: true,
          suggestedMax: suggestedMax,
          grid: { color: '#f1f5f9' },
          ticks: { callback: v => Number(v).toLocaleString(), font: { size: 13 }, color: '#6b7280' }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 15 }, color: '#111827', padding: 8 }
        }
      }
    }
  });

  stageCanvas.style.cursor = 'zoom-in';
  stageCanvas.onclick = () => openModal(stageCanvas, 'Stage breakdown (expanded)');
}

//
// === SCOPE CHART (full replace) ===
//
function renderScopeBarChart(labels, values) {
  if (!scopeCanvas) return;
  const ctx = fixCanvasForDPR(scopeCanvas);
  if (scopeChart) scopeChart.destroy();

  const nums = values.map(v => Number(v || 0));
  const total = nums.reduce((a,b)=>a+b,0) || 1;
  const maxVal = Math.max(...nums,1);
  const suggestedMax = Math.ceil(maxVal * 1.12);

  const colors = ['#2563eb','#fb7185','#fb923c'];

  scopeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: nums,
        backgroundColor: colors,
        borderRadius: 16,
        barThickness: 40,
        maxBarThickness: 54
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function(context) {
              const v = Number(context.parsed.x || 0);
              const pct = total > 0 ? ((v/total)*100).toFixed(2) : '0.00';
              return `${numberFormat(v)} kg — ${pct}%`;
            }
          }
        },
        barValuePlugin: {
          color: '#0f172a',
          insideColor: '#fff',
          fontSize: 13,
          format: (v) => {
            const pct = total > 0 ? ((v/total)*100) : 0;
            return `${numberFormat(v)} kg — ${pct.toFixed(2)}%`;
          }
        }
      },
      layout: { padding: { left: 12, right: 18, top: 6, bottom: 6 } },
      scales: {
        x: {
          beginAtZero: true,
          suggestedMax: suggestedMax,
          grid: { color: '#f1f5f9' },
          ticks: { callback: v => Number(v).toLocaleString(), font: { size: 13 }, color: '#6b7280' }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 14 }, color: '#111827', padding: 8 }
        }
      }
    }
  });

  scopeCanvas.style.cursor = 'zoom-in';
  scopeCanvas.onclick = () => openModal(scopeCanvas, 'Scope breakdown (expanded)');

  // update textual summary
  let summaryEl = document.getElementById('scopeSummary');
  if (!summaryEl) {
    summaryEl = document.createElement('div');
    summaryEl.id = 'scopeSummary';
    summaryEl.style.marginTop = '10px';
    summaryEl.style.fontSize = '13px';
    scopeCanvas.parentElement.appendChild(summaryEl);
  }
  let html = '<strong>Scope summary:</strong><br/>';
  for (let i=0;i<labels.length;i++){
    const pct = ((nums[i]/total)*100).toFixed(2);
    html += `<div style="margin:8px 0;display:flex;align-items:center;">
      <span style="display:inline-block;width:14px;height:14px;background:${colors[i]};margin-right:10px;border-radius:4px;"></span>
      <div><strong>${labels[i]}</strong>: ${numberFormat(nums[i])} kg — <span style="color:#111827">${pct}%</span></div>
    </div>`;
  }
  summaryEl.innerHTML = html;
}

//
// === HOTSPOT RENDER ===
//
function renderHotspot(hotspotObj, suggestionText) {
  if (!hsMode || !hsStage || !hsDistance || !hsWeight || !hsMaterial || !hsEnergy || !hsBreak || !hsSuggest) return;

  if (!hotspotObj) {
    hsMode.innerText = '—'; hsStage.innerText = '—'; hsDistance.innerText = '—'; hsWeight.innerText = '—';
    hsMaterial.innerText = '—'; hsEnergy.innerText = '—'; hsBreak.innerHTML = ''; hsSuggest.innerText = 'Suggestion: —';
    const pctEl = document.getElementById('hsContributionPct'); if (pctEl) pctEl.innerText = '—';
    const rowTotalEl = document.getElementById('hsRowTotal'); if (rowTotalEl) rowTotalEl.innerText = '—';
    if (hotspotMiniChart) { hotspotMiniChart.destroy(); hotspotMiniChart = null; }
    const donut = document.getElementById('hsContribution'); if (donut) donut.style.background = 'conic-gradient(var(--accent) 0deg, #eef2f7 0deg)';
    return;
  }

  hsMode.innerText = hotspotObj.mode || '—';
  hsStage.innerText = hotspotObj.stage || '—';
  hsDistance.innerText = numberFormat(hotspotObj.distance_km || 0);
  hsWeight.innerText = numberFormat(hotspotObj.weight_kg || 0);
  hsMaterial.innerText = hotspotObj.material_type || '—';
  hsEnergy.innerText = numberFormat(hotspotObj.manufacturing_energy_kwh || 0);

  const transport = Number(hotspotObj.transport_kgCO2 || 0);
  const material = Number(hotspotObj.material_kgCO2 || 0);
  const manufacturing = Number(hotspotObj.manufacturing_kgCO2 || 0);
  const rowTotal = Number(hotspotObj.total_kgCO2 || (transport+material+manufacturing));
  const totalAll = Number(lastResult && lastResult.total_kgCO2 ? lastResult.total_kgCO2 : 1);
  const contributionPct = totalAll > 0 ? Math.min(100, (rowTotal / totalAll) * 100) : 0;

  // donut visual update
  const donut = document.getElementById('hsContribution');
  if (donut) {
    const angle = Math.round((contributionPct / 100) * 360);
    let color = 'var(--accent)';
    if (contributionPct > 60) color = 'var(--accent-2)';
    donut.style.background = `conic-gradient(${color} 0deg ${angle}deg, #eef2f7 ${angle}deg 360deg)`;
    const pctEl = document.getElementById('hsContributionPct');
    if (pctEl) pctEl.innerText = `${Math.round(contributionPct)}%`;
    const rowTotalEl = document.getElementById('hsRowTotal');
    if (rowTotalEl) rowTotalEl.innerText = numberFormat(rowTotal) + ' kg';
  }

  // textual breakdown and suggestion
  if (hsBreak) {
    hsBreak.innerHTML = `<div><strong>Transport:</strong> ${numberFormat(transport)} kg</div>
                         <div><strong>Material:</strong> ${numberFormat(material)} kg</div>
                         <div><strong>Manufacturing:</strong> ${numberFormat(manufacturing)} kg</div>
                         <div style="margin-top:6px"><strong>Total (row):</strong> ${numberFormat(rowTotal)} kg</div>`;
  }
  if (hsSuggest) hsSuggest.innerText = `Suggestion: ${suggestionText || 'No suggestion available.'}`;

  // component chart
  if (hotspotCanvas) {
    const ctx = fixCanvasForDPR(hotspotCanvas);
    if (hotspotMiniChart) hotspotMiniChart.destroy();
    const labels = ['Transport','Material','Manufacturing'];
    const dataVals = [transport, material, manufacturing];
    const colors = ['#2563eb','#fb923c','#10b981'];
    const maxVal = Math.max(...dataVals,1);
    const suggestedMax = Math.ceil(maxVal * 1.12);

    hotspotMiniChart = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data: dataVals, backgroundColor: colors, borderRadius: 10, barThickness: 24, maxBarThickness: 40 }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                const v = Number(context.parsed.x || 0);
                const pct = rowTotal > 0 ? ((v/rowTotal)*100).toFixed(2) : '0.00';
                return `${numberFormat(v)} kg — ${pct}% of row`;
              }
            }
          },
          barValuePlugin: { color: '#0f172a', insideColor: '#fff', fontSize: 13, format: v => numberFormat(v) + ' kg' }
        },
        scales: { x: { beginAtZero:true, suggestedMax: suggestedMax, ticks: { callback: v => Number(v).toLocaleString(), font: { size: 12 } }, grid: { color:'#f1f5f9' } }, y: { ticks: { font: { size: 13 }, padding: 8 }, grid: { display:false } } }
      }
    });
  }

  if (hsViewRowBtn) hsViewRowBtn.onclick = () => {
    const preview = JSON.stringify(hotspotObj, (k,v) => (typeof v === 'number' ? Math.round(v*100)/100 : v), 2);
    const win = window.open('', '_blank', 'width=700,height=500,scrollbars=yes');
    if (win) { win.document.title = 'Hotspot row'; win.document.body.style.fontFamily = 'monospace'; const pre = win.document.createElement('pre'); pre.textContent = preview; win.document.body.appendChild(pre); }
    else alert('Popup blocked — view details in console.');
  };

  if (hsDownloadBtn) hsDownloadBtn.onclick = () => {
    const keys = Object.keys(hotspotObj);
    const vals = keys.map(k => `"${String(hotspotObj[k] ?? '').replace(/"/g, '""')}"`);
    const csv = keys.join(',') + '\n' + vals.join(',');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'hotspot_row.csv'; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  hotspotCanvas.style.cursor = 'zoom-in';
  hotspotCanvas.onclick = () => openModal(hotspotCanvas, 'Hotspot components (expanded)');
}

//
// === SENSITIVITY / PRESET TABLE ===
//
function renderSensitivity(arr) {
  if (!sensitivityTable) return;
  let html = '<table class="sens"><thead><tr><th>Preset</th><th>Total</th><th>Scope1</th><th>Scope2</th><th>Scope3</th></tr></thead><tbody>';
  for (const r of arr) {
    html += `<tr>
      <td>${escapeHtml(r.preset || '')}</td>
      <td>${numberFormat(r.total_kgCO2 || r.total || 0)}</td>
      <td>${numberFormat(r.scope1_kgCO2 || r.scope1 || 0)}</td>
      <td>${numberFormat(r.scope2_kgCO2 || r.scope2 || 0)}</td>
      <td>${numberFormat(r.scope3_kgCO2 || r.scope3 || 0)}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  sensitivityTable.innerHTML = html;
}

//
// === SIDE NAV INTERACTIONS ===
//
(function setupSideNav(){
  const nav = document.getElementById('sideNav');
  if (!nav) return;
  function getTargetElement(key){
    if (!key) return document.documentElement;
    if (key === 'top') return document.documentElement;
    if (key === 'charts') return document.getElementById('charts') || document.querySelector('.charts-grid') || document.body;
    return document.getElementById(key);
  }
  nav.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const key = btn.getAttribute('data-target');
      const el = getTargetElement(key);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      btn.focus({preventScroll:true});
      nav.querySelectorAll('.nav-link').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
})();

//
// === MODAL EXPAND & EXPORT ===
//
function openModal(sourceCanvas, title) {
  if (!chartModal || !modalCanvas) return;
  modalTitle.innerText = title || 'Chart';
  chartModal.style.display = 'flex';
  // draw snapshot of canvas into modalCanvas
  try {
    const url = sourceCanvas.toDataURL('image/png');
    const ctx = modalCanvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
      const rect = modalCanvas.getBoundingClientRect();
      modalCanvas.width = rect.width * (window.devicePixelRatio || 1);
      modalCanvas.height = rect.height * (window.devicePixelRatio || 1);
      ctx.setTransform(window.devicePixelRatio || 1,0,0,window.devicePixelRatio || 1,0,0);
      ctx.clearRect(0,0,rect.width,rect.height);
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
    };
    img.src = url;
  } catch (e) {
    console.warn('Modal render failed', e);
  }
}
if (modalClose) modalClose.addEventListener('click', () => chartModal.style.display = 'none');
if (chartModal) chartModal.addEventListener('click', (e) => { if (e.target === chartModal) chartModal.style.display = 'none'; });
if (exportPNG) exportPNG.addEventListener('click', () => {
  if (!modalCanvas) return;
  const url = modalCanvas.toDataURL('image/png');
  const a = document.createElement('a'); a.href = url; a.download = (modalTitle.innerText || 'chart') + '.png'; document.body.appendChild(a); a.click(); a.remove();
});

//
// === INITIALIZE EMPTY VISUALS ===
//
(function init() {
  renderStageChart([], []);
  renderScopeBarChart(['Scope1','Scope2','Scope3'], [0,0,0]);
  renderHotspot(null, '');
})();
