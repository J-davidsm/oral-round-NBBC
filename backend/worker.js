const divisions = ['primary', 'junior', 'senior'];
const idPattern = /^[a-zA-Z0-9-]{16,80}$/;
export function validateRecord(r) {
  if (!r || !idPattern.test(r.id || '') || !divisions.includes(r.division) ||
      !Number.isInteger(r.score) || r.score < 0 || r.score > 300 || r.possible !== 300 ||
      !Number.isInteger(r.timeLeftSec) || r.timeLeftSec < 0 || r.timeLeftSec > 86400 ||
      typeof r.date !== 'string' || !Number.isFinite(Date.parse(r.date)) ||
      !Array.isArray(r.details) || r.details.length > 12) throw new Error('Invalid round');
  const details = r.details.map(d => {
    if (d === null) return null;
    if (!d || typeof d.ref !== 'string' || d.ref.length > 120 ||
        !Number.isInteger(d.errors) || d.errors < 0 || d.errors > 10000 ||
        !Number.isInteger(d.points) || d.points < 0 || d.points > 25) throw new Error('Invalid passage');
    return {ref:d.ref, errors:d.errors, points:d.points};
  });
  return {id:r.id, date:new Date(r.date).toISOString(), score:r.score, possible:300,
    timeLeftSec:r.timeLeftSec, division:r.division, details};
}
export async function networkKey(ip, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2,'0')).join('');
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Vary':'Origin'};
    if (origin === env.ALLOWED_ORIGIN) Object.assign(headers, {
      'Access-Control-Allow-Origin':origin,
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type'
    });
    const reply = (body, status=200) => new Response(JSON.stringify(body), {status, headers});
    if (origin && origin !== env.ALLOWED_ORIGIN) return reply({error:'Origin not allowed'},403);
    if (request.method === 'OPTIONS') return new Response(null, {status:204,headers});
    const url = new URL(request.url);
    if (url.pathname !== '/rounds') return reply({error:'Not found'},404);
    if (!['GET','POST'].includes(request.method)) return reply({error:'Method not allowed'},405);
    // Trust only the IP supplied by Cloudflare, never a browser-supplied identifier.
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip || !env.NETWORK_SECRET || !env.DB) return reply({error:'Score service is not configured'},503);
    try {
      const network = await networkKey(ip, env.NETWORK_SECRET);
      if (request.method === 'GET') {
        const division = url.searchParams.get('division');
        const after = url.searchParams.get('after') || '';
        if (!divisions.includes(division) || (after && !idPattern.test(after))) return reply({error:'Invalid query'},400);
        const {results} = await env.DB.prepare('SELECT id, record FROM rounds WHERE network = ? AND division = ? AND id > ? ORDER BY id LIMIT 201').bind(network, division, after).all();
        const page = results.slice(0,200);
        return reply({rounds:page.map(row=>JSON.parse(row.record)), next:results.length>200?page[199].id:null});
      }
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return reply({error:'JSON required'},415);
      // Read a bounded stream so a client cannot submit an unbounded request body.
      const reader = request.body?.getReader();
      if (!reader) return reply({error:'Missing body'},400);
      let size=0; const chunks=[];
      while (true) {
        const {done,value}=await reader.read(); if (done) break;
        size+=value.byteLength;
        if (size>32768) { await reader.cancel(); return reply({error:'Round too large'},413); }
        chunks.push(value);
      }
      const bytes=new Uint8Array(size); let offset=0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
      let record;
      try { record=validateRecord(JSON.parse(new TextDecoder().decode(bytes))); }
      catch { return reply({error:'Invalid round'},400); }
      await env.DB.prepare('INSERT INTO rounds (network, id, division, record) VALUES (?, ?, ?, ?) ON CONFLICT(network, id) DO NOTHING').bind(network, record.id, record.division, JSON.stringify(record)).run();
      return reply({saved:true,id:record.id});
    } catch {
      return reply({error:'Scores temporarily unavailable'},503);
    }
  }
};
