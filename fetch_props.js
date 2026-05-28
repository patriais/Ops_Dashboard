const https = require('https');
const TOKEN = process.env.HS_TOKEN;
const PIPELINE = '3845142727';

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.hubapi.com', path, method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}` } },
      res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); }
    );
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  // 1. request_type options
  const rt = await get('/crm/v3/properties/tickets/request_type');
  console.log('\n=== request_type options ===');
  (rt.options || []).forEach(o => console.log(`  '${o.value}': '${o.label}',`));

  // 2. pipeline stages
  const ps = await get(`/crm/v3/pipelines/tickets/${PIPELINE}/stages`);
  console.log('\n=== pipeline stages ===');
  (ps.results || []).forEach(s => console.log(`  '${s.id}': '${s.label}',  // displayOrder: ${s.displayOrder}`));
}

run().catch(e => console.error(e));
