// =============================================================
// BCAS - Centro de Operaciones
// Uso: node ops_dashboard.js
// =============================================================

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { Client } = require('pg');

// Load .env for local development
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  });
} catch {}

// =============================================================
// CONFIG
// =============================================================
const HS_TOKEN = process.env.HS_TOKEN;
const DB_URL   = process.env.DB_URL;

if (!HS_TOKEN || !DB_URL) {
  console.error('Error: faltan variables de entorno HS_TOKEN y/o DB_URL');
  console.error('Crea un fichero .env con esas variables o exportalas antes de ejecutar.');
  process.exit(1);
}
const OUT_DIR  = path.join(__dirname, 'public');
const OUTPUT   = path.join(OUT_DIR, 'index.html');

const DASHBOARDS = [
  {
    id:             'reclamaciones',
    name:           'Reclamaciones Legal',
    icon:           'RE',
    category:       'Reclamaciones',
    pipelineId:     '3845142727',
    staleAlertDays: 5,
    stageMap: {
      '5422927042': 'Sin asignar',
      '5424979163': 'Asignado',
      '5444889823': 'En gestión',
      '5422927043': 'Pendiente de resolución del organismo',
      '5422927044': 'Requerimiento adicional',
      '5424886986': 'Resolución',
      '5429547203': 'Archivado / desistido',
    },
    closedStages:    ['5424886986', '5429547203'],
    stageEntryProps: {
      '5422927042': 'hs_date_entered_5422927042',
      '5424979163': 'hs_date_entered_5424979163',
      '5444889823': 'hs_date_entered_5444889823',
      '5422927043': 'hs_date_entered_5422927043',
      '5422927044': 'hs_date_entered_5422927044',
      '5424886986': 'hs_date_entered_5424886986',
      '5429547203': 'hs_date_entered_5429547203',
    },
    typeMap: {
      withdrawal:               'Desistimiento',
      rgpd:                     'GDPR',
      non_judicial_claim:       'Reclamación no judicial',
      judicial_claim:           'Requerimiento judicial',
      contractual_modification: 'Modificación contractual',
      informacion_request:      'Solicitud de información',
      other:                    'Otros',
    },
    ownerMap: {
      '737499105':  'Jaime Nunez',
      '1430947002': 'Lara Maino',
      '1295768209': 'Alan Marini',
      '2136671500': 'Julieta Darias',
      '2024313463': 'David Morera',
      '1988214614': 'German Blanco',
      '737483001':  'Manuel Avello',
      '29234237':   'Pablo Ortiz',
      '31766869':   'Mariana Gonzalez',
      '33849520':   'Lara Garcia',
      '33137020':   'Camila Garcia',
      '737482466':  'Javier Ausin',
      '12207485':   'Antonio Fernandez',
    },
  },
  // Añade aqui nuevos dashboards copiando el bloque de arriba
];

// =============================================================
// HELPERS
// =============================================================
function hsGet(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function hsPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HS_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function businessDays(from, to) {
  let days = 0, cur = new Date(from);
  cur.setHours(0,0,0,0);
  const end = new Date(to); end.setHours(0,0,0,0);
  while (cur < end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) days++;
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function toChartJson(map, topN = 99) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([label, value]) => ({ label, value }));
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
}

// =============================================================
// FETCH TICKETS (paginado)
// =============================================================
async function fetchTickets(cfg) {
  const tickets = [];
  let after = null;
  const props = [
    'subject','hs_pipeline_stage','hubspot_owner_id',
    'createdate','hs_lastmodifieddate','request_type',
    ...Object.values(cfg.stageEntryProps),
  ];
  do {
    const body = {
      filterGroups: [{ filters: [{ propertyName: 'hs_pipeline', operator: 'EQ', value: cfg.pipelineId }] }],
      properties: props,
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const resp = await hsPost('/crm/v3/objects/tickets/search', body);
    if (resp.results) tickets.push(...resp.results);
    after = resp.paging?.next?.after ?? null;
  } while (after);
  return tickets;
}

// =============================================================
// GET CONTACT EMAILS VIA ASSOCIATIONS (batch)
// =============================================================
async function getContactEmails(ticketIds) {
  // Returns { ticketId -> email }
  const result = {};
  if (!ticketIds.length) return result;

  // Batch associations: tickets -> contacts
  const CHUNK = 100;
  const contactIdsByTicket = {};

  for (let i = 0; i < ticketIds.length; i += CHUNK) {
    const chunk = ticketIds.slice(i, i + CHUNK);
    const body  = { inputs: chunk.map(id => ({ id: String(id) })) };
    const resp  = await hsPost('/crm/v4/associations/tickets/contacts/batch/read', body);
    if (resp.results) {
      resp.results.forEach(r => {
        const contactIds = (r.to || []).map(t => t.toObjectId);
        if (contactIds.length) contactIdsByTicket[r.from.id] = contactIds[0]; // primer contacto
      });
    }
  }

  // Batch read contacts -> email
  const uniqueContactIds = [...new Set(Object.values(contactIdsByTicket))];
  if (!uniqueContactIds.length) return result;

  for (let i = 0; i < uniqueContactIds.length; i += CHUNK) {
    const chunk = uniqueContactIds.slice(i, i + CHUNK);
    const body  = { inputs: chunk.map(id => ({ id: String(id) })), properties: ['email'] };
    const resp  = await hsPost('/crm/v3/objects/contacts/batch/read', body);
    if (resp.results) {
      const emailById = {};
      resp.results.forEach(c => { if (c.properties.email) emailById[c.id] = c.properties.email; });
      // Map ticket -> email
      for (const [ticketId, contactId] of Object.entries(contactIdsByTicket)) {
        if (emailById[String(contactId)]) result[ticketId] = emailById[String(contactId)];
      }
    }
  }

  return result;
}

// =============================================================
// QUERY DB: email -> school name
// =============================================================
async function getSchoolsByEmail(emails) {
  // Returns { email -> { school, loanId } }
  if (!emails.length) return {};
  const db = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const res = await db.query(
    `SELECT DISTINCT ON (ls.email) ls.email, ss.name AS school, ls.loan_id
     FROM loan_stats ls
     JOIN school_stats ss ON ls.school_id = ss.school_id
     WHERE ls.email = ANY($1)
     ORDER BY ls.email, ls.loan_id DESC`,
    [emails]
  );
  await db.end();
  const map = {};
  res.rows.forEach(r => { map[r.email.toLowerCase()] = { school: r.school, loanId: r.loan_id }; });
  return map;
}

// =============================================================
// PROCESS ONE DASHBOARD
// =============================================================
async function processDashboard(cfg) {
  process.stdout.write(`  Cargando ${cfg.name}...`);
  const tickets = await fetchTickets(cfg);
  process.stdout.write(` ${tickets.length} tickets\n`);

  // Get contact emails
  process.stdout.write(`  Obteniendo emails de contactos...`);
  const ticketIds      = tickets.map(t => t.id);
  const emailByTicket  = await getContactEmails(ticketIds);
  const uniqueEmails   = [...new Set(Object.values(emailByTicket).map(e => e.toLowerCase()))];
  process.stdout.write(` ${Object.keys(emailByTicket).length} con contacto\n`);

  // Query DB
  process.stdout.write(`  Consultando base de datos...`);
  const schoolByEmail = await getSchoolsByEmail(uniqueEmails);
  process.stdout.write(` ${Object.keys(schoolByEmail).length} matches\n`);

  // Aggregations
  const byStage = {}, byOwner = {}, byType = {}, bySchool = {};
  const resDays = [];
  const today   = new Date();

  const rows = tickets.map(t => {
    const s   = t.properties.hs_pipeline_stage;
    const sn  = cfg.stageMap[s] || `Etapa ${s}`;
    const o   = t.properties.hubspot_owner_id;
    const on  = (o && cfg.ownerMap[o]) ? cfg.ownerMap[o] : (o ? `Agente ${o}` : 'Sin asignar');
    const r   = t.properties.request_type;
    const rn  = (r && cfg.typeMap[r]) ? cfg.typeMap[r] : 'Sin categorizar';
    const email   = emailByTicket[t.id];
    const dbData  = email ? (schoolByEmail[email.toLowerCase()] || null) : null;
    const school  = dbData ? dbData.school : 'N/A';
    const loanId  = dbData ? String(dbData.loanId) : 'N/A';
    const subj = (t.properties.subject || '').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const dt   = fmtDate(t.properties.createdate);

    byStage[sn]  = (byStage[sn]  || 0) + 1;
    byOwner[on]  = (byOwner[on]  || 0) + 1;
    byType[rn]   = (byType[rn]   || 0) + 1;
    bySchool[school] = (bySchool[school] || 0) + 1;

    // Resolution time
    let rt = 'En curso';
    if (cfg.closedStages.includes(s)) {
      const msC = Object.entries(cfg.stageEntryProps)
        .filter(([sid]) => cfg.closedStages.includes(sid))
        .map(([, prop]) => t.properties[prop])
        .find(v => v);
      if (msC && t.properties.createdate) {
        const days = (new Date(+msC) - new Date(t.properties.createdate)) / 86400000;
        if (days >= 0) { rt = `${Math.round(days * 10) / 10} d`; resDays.push(days); }
      }
    }

    // Stale alert
    let stale = false;
    if (!cfg.closedStages.includes(s) && cfg.stageEntryProps[s]) {
      const msE = t.properties[cfg.stageEntryProps[s]];
      if (msE && businessDays(new Date(+msE), today) >= cfg.staleAlertDays) stale = true;
    }

    return { lid: loanId, s: subj, st: sn, o: on, ty: rn, sc: school, d: dt, rt, al: stale };
  });

  const total      = tickets.length;
  const closed     = tickets.filter(t => cfg.closedStages.includes(t.properties.hs_pipeline_stage)).length;
  const open       = total - closed;
  const unassigned = tickets.filter(t => !t.properties.hubspot_owner_id).length;
  const noType     = byType['Sin categorizar'] || 0;
  const avgR       = resDays.length ? `${Math.round(resDays.reduce((a,b)=>a+b,0)/resDays.length*10)/10} d` : '-';

  return {
    total, open, closed, unassigned, noType, avgR,
    sJ: toChartJson(byStage),
    oJ: toChartJson(byOwner, 15),
    tJ: toChartJson(byType),
    scJ: toChartJson(bySchool, 20),
    rJ: rows,
    typeOptions:  Object.values(cfg.typeMap),
    stageOptions: Object.values(cfg.stageMap),
  };
}

// =============================================================
// BUILD HTML
// =============================================================
function buildHtml(dashData, now) {
  // Nav
  const categories = {};
  DASHBOARDS.forEach(cfg => {
    if (!categories[cfg.category]) categories[cfg.category] = [];
    categories[cfg.category].push({ id: cfg.id, name: cfg.name, icon: cfg.icon });
  });

  const navJ     = JSON.stringify(Object.entries(categories).map(([cat, items]) => ({ cat, items })));
  const dashMapJ = JSON.stringify(Object.fromEntries(Object.entries(dashData)));
  const firstId  = DASHBOARDS[0].id;

  const css = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f4f8;color:#1a202c;display:flex;height:100vh;overflow:hidden}
#sb{width:240px;min-width:240px;background:#1a202c;color:#e2e8f0;display:flex;flex-direction:column;overflow-y:auto;transition:width .2s}
#sb.col{width:56px;min-width:56px}
.sbh{padding:16px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2d3748}
.sbh b{font-size:13px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden}
.sbt{background:none;border:none;color:#a0aec0;cursor:pointer;font-size:18px;padding:2px 5px;flex-shrink:0}
.sbt:hover{color:#fff}
.sbs{margin-top:6px}
.sbc{display:flex;align-items:center;justify-content:space-between;padding:8px 14px 4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#718096;cursor:pointer;user-select:none}
.sbc:hover{color:#a0aec0}
.sbc .ar{font-size:10px;transition:transform .2s}
.sbc.open .ar{transform:rotate(90deg)}
.sbi{overflow:hidden;transition:max-height .25s ease;max-height:500px}
.sbi.closed{max-height:0}
.sbn{display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;border-radius:6px;margin:1px 6px;transition:background .15s;white-space:nowrap;overflow:hidden}
.sbn:hover{background:#2d3748}
.sbn.act{background:#3182ce}
.sbic{width:28px;height:28px;border-radius:7px;background:#2d3748;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#a0aec0;flex-shrink:0}
.sbn.act .sbic{background:rgba(255,255,255,.2);color:#fff}
.sbnm{font-size:12.5px;font-weight:500;color:#cbd5e0;overflow:hidden;text-overflow:ellipsis}
.sbn.act .sbnm{color:#fff;font-weight:600}
#sb.col .sbh b,.#sb.col .sbnm,.#sb.col .sbc span:first-child,.#sb.col .ar{display:none}
#sb.col .sbn{justify-content:center;padding:8px}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.top{background:#fff;border-bottom:1px solid #e2e8f0;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.top h1{font-size:15px;font-weight:700}
.top small{font-size:11px;color:#a0aec0}
.cnt{flex:1;overflow-y:auto;padding:20px 24px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:11px;margin-bottom:16px}
.kpi{background:#fff;border-radius:9px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.kpi .l{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:4px}
.kpi .v{font-size:26px;font-weight:800}
.k0 .v{color:#2d3748}.k1 .v{color:#3182ce}.k2 .v{color:#38a169}.k3 .v{color:#e53e3e}.k4 .v{color:#d69e2e}.k5 .v{color:#0987a0;font-size:18px;padding-top:4px}
.charts{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:11px;margin-bottom:16px}
.card{background:#fff;border-radius:9px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:12px}
.cw{position:relative;height:220px}
.tc{background:#fff;border-radius:9px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.tc h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#718096;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.tc h2 em{font-style:normal;font-weight:400;font-size:11px;color:#a0aec0;text-transform:none;letter-spacing:0}
.fi{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:flex-end}
.fi label{display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#718096;margin-bottom:2px}
.fi input,.fi select{border:1px solid #e2e8f0;border-radius:6px;padding:6px 9px;font-size:12px;background:#f7fafc;outline:none;color:#2d3748;min-width:130px}
.fi input:focus,.fi select:focus{border-color:#3182ce;background:#fff}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:7px 11px;background:#f7fafc;color:#4a5568;font-weight:700;border-bottom:2px solid #e2e8f0;font-size:10px;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td{padding:7px 11px;border-bottom:1px solid #edf2f7;color:#2d3748;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#f7fafc}
.b{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700}
.bo{background:#ebf8ff;color:#2b6cb0}.bc{background:#f0fff4;color:#276749}.bt{background:#faf5ff;color:#6b46c1}.bn{background:#fff5f5;color:#c53030}
.bs{background:#fefce8;color:#854d0e}
.emp{text-align:center;padding:28px;color:#a0aec0;font-size:13px}
.ac{display:inline-flex;align-items:center;gap:5px;background:#fff5f5;border:1.5px solid #fc8181;color:#c53030;border-radius:20px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}
.ac.on{background:#c53030;color:#fff;border-color:#c53030}
.ac:hover{opacity:.85}
.tbar{display:flex;gap:0;flex-wrap:wrap;border-bottom:2px solid #e2e8f0;margin-bottom:16px}
.tab{background:none;border:none;border-bottom:3px solid transparent;margin-bottom:-2px;padding:10px 20px;font-size:13px;font-weight:600;color:#718096;cursor:pointer;transition:color .15s;white-space:nowrap}
.tab:hover{color:#2d3748}
.tab.act{color:#3182ce;border-bottom-color:#3182ce}
.stbar{display:flex;gap:6px;flex-wrap:wrap;padding:0 0 12px;margin-bottom:8px}
.subtab{background:#fff;border:1.5px solid #e2e8f0;padding:4px 14px;font-size:11px;font-weight:600;color:#718096;cursor:pointer;border-radius:20px;transition:all .15s}
.subtab:hover{background:#ebf8ff;border-color:#bee3f8;color:#2b6cb0}
.subtab.act{background:#3182ce;color:#fff;border-color:#3182ce}`;

  const sidebarHtml = Object.entries(categories).map(([cat, items]) => `
    <div class="sbs">
      <div class="sbc open" onclick="toggleCat(this)"><span>${cat}</span><span class="ar">&#9654;</span></div>
      <div class="sbi">
        ${items.map(item => `
        <div class="sbn${item.id === firstId ? ' act' : ''}" id="nav-${item.id}" onclick="loadDash('${item.id}')">
          <div class="sbic">${item.icon}</div>
          <span class="sbnm">${item.name}</span>
        </div>`).join('')}
      </div>
    </div>`).join('');

  const js = `
const NAV=${navJ};
const DASH=${dashMapJ};
const CL=['Resolución','Archivado / desistido'];
const C=['#3182ce','#805ad5','#e53e3e','#d69e2e','#38a169','#dd6b20','#0987a0','#97266d','#553c9a','#2f855a','#b7791f','#2c7a7b'];
const TABS=[
  {id:'reclamaciones',label:'Reclamaciones',types:['Reclamación no judicial','Requerimiento judicial','Consumo'],
   subtabs:[{id:'all',label:'Todas',types:null},{id:'judicial',label:'Proceso judicial',types:['Requerimiento judicial']},{id:'consumo',label:'Consumo',types:['Consumo']},{id:'no_judicial',label:'Proceso no judicial',types:['Reclamación no judicial']}]},
  {id:'gdpr',label:'GDPR',types:['GDPR'],subtabs:null},
  {id:'otros',label:'Otros',types:['Otros','Desistimiento','Modificación contractual'],subtabs:null},
  {id:'info',label:'Solicitud de información',types:['Solicitud de información'],subtabs:null},
  {id:'sin_cat',label:'Sin categorizar',types:['Sin categorizar'],subtabs:null}
];
let curCharts=[],onlyAlert=false,curId='',curTab='reclamaciones',curSubtab='all',curTabRows=[];

function mkD(id,d){var el=document.getElementById(id);if(!el)return;var c=new Chart(el,{type:'doughnut',data:{labels:d.map(function(x){return x.label;}),datasets:[{data:d.map(function(x){return x.value;}),backgroundColor:C,borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:10},padding:7,boxWidth:10}}}}});curCharts.push(c);}
function mkB(id,d){var el=document.getElementById(id);if(!el)return;var c=new Chart(el,{type:'bar',data:{labels:d.map(function(x){return x.label;}),datasets:[{data:d.map(function(x){return x.value;}),backgroundColor:C,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{grid:{color:'#edf2f7'},ticks:{font:{size:10}}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});curCharts.push(c);}
function chJ(rows,key){var m={};rows.forEach(function(r){if(r[key])m[r[key]]=(m[r[key]]||0)+1;});return Object.entries(m).sort(function(a,b){return b[1]-a[1];}).map(function(e){return{label:e[0],value:e[1]};});}
function uniq(key){return[...new Set(curTabRows.map(function(r){return r[key];}))].filter(Boolean).sort();}
function addOpts(sid,vals){var el=document.getElementById(sid);if(!el)return;vals.forEach(function(v){var o=document.createElement('option');o.value=v;o.textContent=v;el.appendChild(o);});}

function getTabRows(all,tabId,subId){
  var tab=TABS.find(function(t){return t.id===tabId;});
  if(!tab)return all;
  var sub=tab.subtabs&&subId!=='all'?tab.subtabs.find(function(s){return s.id===subId;}):null;
  var types=sub?sub.types:tab.types;
  return all.filter(function(r){return types&&types.includes(r.ty);});
}

function calcKpis(rows){
  var rd=rows.map(function(r){var v=parseFloat(r.rt);return isNaN(v)?null:v;}).filter(function(v){return v!==null;});
  var sum=rd.reduce(function(a,b){return a+b;},0);
  return{
    total:rows.length,
    open:rows.filter(function(r){return !CL.includes(r.st);}).length,
    closed:rows.filter(function(r){return CL.includes(r.st);}).length,
    unassigned:rows.filter(function(r){return r.o==='Sin asignar';}).length,
    noType:rows.filter(function(r){return r.ty==='Sin categorizar';}).length,
    avgR:rd.length?(Math.round(sum/rd.length*10)/10)+' d':'-'
  };
}

function loadDash(id){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];onlyAlert=false;curId=id;curTab='reclamaciones';curSubtab='all';
  document.querySelectorAll('.sbn').forEach(function(el){el.classList.remove('act');});
  var nav=document.getElementById('nav-'+id);if(nav)nav.classList.add('act');
  var d=DASH[id];if(!d)return;
  var title='';NAV.forEach(function(g){g.items.forEach(function(i){if(i.id===id)title=i.name;});});
  document.getElementById('dashTitle').textContent=title;
  var tabHtml=TABS.map(function(t){return '<button class="tab'+(t.id==='reclamaciones'?' act':'')+'" onclick="switchTab(\''+t.id+'\')">'+t.label+'</button>';}).join('');
  var recTab=TABS[0];
  var stHtml=recTab.subtabs.map(function(s){return '<button class="subtab'+(s.id==='all'?' act':'')+'" onclick="switchSubtab(\''+s.id+'\')">'+s.label+'</button>';}).join('');
  document.getElementById('content').innerHTML=
    '<div class="tbar">'+tabHtml+'</div>'+
    '<div class="stbar" id="stbar">'+stHtml+'</div>'+
    '<div id="kpiArea"></div>'+
    '<div id="chartArea"></div>'+
    '<div id="tableArea"></div>';
  renderTab();
}

function switchTab(tabId){
  curTab=tabId;curSubtab='all';
  document.querySelectorAll('.tab').forEach(function(b){b.classList.toggle('act',b.getAttribute('onclick')==="switchTab('"+tabId+"')");});
  var stbar=document.getElementById('stbar');
  if(stbar){
    stbar.style.display=tabId==='reclamaciones'?'':'none';
    if(tabId==='reclamaciones'){document.querySelectorAll('.subtab').forEach(function(b,i){b.classList.toggle('act',i===0);});}
  }
  renderTab();
}

function switchSubtab(subId){
  curSubtab=subId;
  document.querySelectorAll('.subtab').forEach(function(b){b.classList.toggle('act',b.getAttribute('onclick')==="switchSubtab('"+subId+"')");});
  renderTab();
}

function renderTab(){
  curCharts.forEach(function(c){c.destroy();});curCharts=[];onlyAlert=false;
  var d=DASH[curId];if(!d)return;
  curTabRows=getTabRows(d.rJ,curTab,curSubtab);
  var k=calcKpis(curTabRows);
  document.getElementById('kpiArea').innerHTML=
    '<div class="kpis">'+
    '<div class="kpi k0"><div class="l">Total tickets</div><div class="v">'+k.total+'</div></div>'+
    '<div class="kpi k1"><div class="l">Abiertos</div><div class="v">'+k.open+'</div></div>'+
    '<div class="kpi k2"><div class="l">Cerrados</div><div class="v">'+k.closed+'</div></div>'+
    '<div class="kpi k3"><div class="l">Sin asignar</div><div class="v">'+k.unassigned+'</div></div>'+
    '<div class="kpi k4"><div class="l">Sin categorizar</div><div class="v">'+k.noType+'</div></div>'+
    '<div class="kpi k5"><div class="l">T. medio resolucion</div><div class="v">'+k.avgR+'</div></div>'+
    '</div>';
  document.getElementById('chartArea').innerHTML=
    '<div class="charts">'+
    '<div class="card"><h2>Por tipo de solicitud</h2><div class="cw"><canvas id="cT"></canvas></div></div>'+
    '<div class="card"><h2>Por estado</h2><div class="cw"><canvas id="cS"></canvas></div></div>'+
    '<div class="card"><h2>Por responsable</h2><div class="cw"><canvas id="cO"></canvas></div></div>'+
    '<div class="card"><h2>Por escuela</h2><div class="cw"><canvas id="cSc"></canvas></div></div>'+
    '</div>';
  mkD('cT',chJ(curTabRows,'ty'));
  mkD('cS',chJ(curTabRows,'st'));
  mkB('cO',chJ(curTabRows,'o'));
  mkD('cSc',chJ(curTabRows,'sc'));
  document.getElementById('tableArea').innerHTML=
    '<div class="tc">'+
    '<h2>Todos los tickets <em id="cnt"></em></h2>'+
    '<div class="fi">'+
    '<div><label>Buscar</label><input id="fSe" type="text" placeholder="Asunto..." oninput="rnd()"></div>'+
    '<div><label>Tipo solicitud</label><select id="fT" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Estado</label><select id="fSt" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Responsable</label><select id="fO" onchange="rnd()"><option value="">Todos</option></select></div>'+
    '<div><label>Escuela</label><select id="fSc" onchange="rnd()"><option value="">Todas</option></select></div>'+
    '<div><button class="ac" id="btnAl" onclick="toggleAl()">⚠️ Solo alertas</button></div>'+
    '</div>'+
    '<table><thead><tr><th>Loan ID</th><th>Escuela</th><th>Asunto</th><th>Tipo solicitud</th><th>Estado</th><th>Responsable</th><th>Fecha</th><th>T. resolucion</th></tr></thead><tbody id="tb"></tbody></table>'+
    '</div>';
  addOpts('fT',uniq('ty'));
  addOpts('fSt',d.stageOptions);
  addOpts('fO',uniq('o'));
  addOpts('fSc',uniq('sc'));
  rnd();
}

function toggleAl(){onlyAlert=!onlyAlert;var b=document.getElementById('btnAl');if(b)b.classList.toggle('on',onlyAlert);rnd();}

function rnd(){
  var s=(document.getElementById('fSe')||{}).value||'';
  var ft=(document.getElementById('fT')||{}).value||'';
  var fs=(document.getElementById('fSt')||{}).value||'';
  var fo=(document.getElementById('fO')||{}).value||'';
  var fsc=(document.getElementById('fSc')||{}).value||'';
  var f=curTabRows.filter(function(r){
    return(!s||(r.s||'').toLowerCase().includes(s.toLowerCase()))&&
    (!ft||r.ty===ft)&&(!fs||r.st===fs)&&(!fo||r.o===fo)&&(!fsc||r.sc===fsc)&&
    (!onlyAlert||r.al);
  });
  var cnt=document.getElementById('cnt');if(cnt)cnt.textContent=f.length+' resultado'+(f.length!==1?'s':'');
  var tb=document.getElementById('tb');if(!tb)return;
  if(!f.length){tb.innerHTML='<tr><td colspan=8 class="emp">Sin resultados</td></tr>';return;}
  tb.innerHTML=f.map(function(r){
    return '<tr style="'+(r.al?'background:#fffbeb':'')+'">'
      +'<td style="font-family:monospace;font-size:11px;color:#4a5568">'+r.lid+'</td>'
      +'<td><span class="b '+(r.sc==='N/A'?'bn':'bs')+'">'+r.sc+'</span></td>'
      +'<td title="'+r.s+'">'+(r.al?'⚠️ ':'')+(r.s||'(sin asunto)')+'</td>'
      +'<td><span class="b '+(r.ty==='Sin categorizar'?'bn':'bt')+'">'+r.ty+'</span></td>'
      +'<td><span class="b '+(CL.includes(r.st)?'bc':'bo')+'">'+r.st+'</span></td>'
      +'<td>'+r.o+'</td>'
      +'<td>'+r.d+'</td>'
      +'<td style="color:'+(r.rt==='En curso'?'#3182ce':'#276749')+';font-weight:600">'+r.rt+'</td>'
      +'</tr>';
  }).join('');
}

function toggleSb(){document.getElementById('sb').classList.toggle('col');}
function toggleCat(el){el.classList.toggle('open');el.nextElementSibling.classList.toggle('closed');}

loadDash('${firstId}');`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><title>Bcas Ops</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>${css}</style></head><body>
<div id="sb">
  <div class="sbh"><b>Bcas Ops</b><button class="sbt" onclick="toggleSb()">&#8942;</button></div>
  ${sidebarHtml}
</div>
<div id="main">
  <div class="top"><h1 id="dashTitle">Cargando...</h1><small>Actualizado: ${now}</small></div>
  <div class="cnt" id="content"></div>
</div>
<script>${js}</script>
</body></html>`;
}

// =============================================================
// MAIN
// =============================================================
async function main() {
  console.log('\nBcas - Centro de Operaciones');
  console.log('─────────────────────────────');

  const dashData = {};
  for (const cfg of DASHBOARDS) {
    dashData[cfg.id] = await processDashboard(cfg);
  }

  console.log('\nGenerando HTML...');
  const now  = new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const html = buildHtml(dashData, now);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT, html, 'utf8');
  const LOCAL = path.join(__dirname, 'ops_dashboard.html');
  fs.writeFileSync(LOCAL, html, 'utf8');
  console.log(`Dashboard guardado: ${OUTPUT}`);
  console.log(`Copia local:        ${LOCAL}`);

  // Open in browser (only locally)
  if (!process.env.VERCEL) {
    const { exec } = require('child_process');
    exec(`start "" "${OUTPUT}"`);
  }
  console.log('Listo.\n');
}

// CLI: node ops_dashboard.js
if (require.main === module) {
  main().catch(e => { console.error('Error:', e); process.exit(1); });
}

// Serverless handler (Vercel)
module.exports = async (req, res) => {
  try {
    const dashData = {};
    for (const cfg of DASHBOARDS) {
      dashData[cfg.id] = await processDashboard(cfg);
    }
    const now = new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const html = buildHtml(dashData, now);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.end(html);
  } catch (e) {
    res.statusCode = 500;
    res.end(`<pre>Error: ${e.message}\n${e.stack}</pre>`);
  }
};
