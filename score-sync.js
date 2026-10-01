/* Import unsynced local rounds automatically. Successful imports stay on their
   original network rather than being republished when this device travels. */
window.ScoreSync = (() => {
  const base = () => (window.SCORE_API_URL || '').replace(/\/$/,'');
  function local() {
    try {
      const data = JSON.parse(localStorage.getItem('oralRounds') || '[]');
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }
  function deviceCode() {
    try { return localStorage.getItem('oralRoundDeviceCode') || ''; } catch { return ''; }
  }
  async function api(path, options={}, code=deviceCode()) {
    options={...options,headers:{...options.headers,...(code?{'X-Score-Link':code}:{})}};
    const response = await fetch(base()+path, {...options, signal:AbortSignal.timeout(15000)});
    if (!response.ok) { const error = new Error('Score service unavailable'); error.status = response.status; throw error; }
    return response.json();
  }
  async function save(record) {
    if (!base()) return false;
    const code=deviceCode();
    await api('/rounds', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)},code);
    // Read fresh storage: another round may have finished while this upload ran.
    try {
      const records=local();
      const saved=records.find(r=>r.id===record.id);
      if (saved) { saved.sharedScoreApi=base(); saved.sharedScoreLink=code; localStorage.setItem('oralRounds',JSON.stringify(records)); }
    } catch { /* A retry is safe because the server deduplicates by round ID. */ }
    return true;
  }
  async function list(division) {
    if (!base()) return {rounds:local().filter(r=>r.division===division), shared:false};
    const rounds=[]; let after=''; let historyId='';
    const code=deviceCode();
    do {
      const page=await api('/rounds?division='+encodeURIComponent(division)+'&after='+encodeURIComponent(after),{},code);
      historyId=page.historyId;
      rounds.push(...page.rounds); after=page.next;
    } while (after);
    rounds.sort((a,b)=>new Date(a.date)-new Date(b.date));
    return {rounds,shared:true,historyId,linked:Boolean(code)};
  }
  let importInFlight = null;
  function importLocal() {
    if (!base()) return Promise.resolve(0);
    if (!importInFlight) importInFlight = importPending().finally(()=>{ importInFlight=null; });
    return importInFlight;
  }
  async function importPending() {
    const records=local();
    // Persist IDs before sending: retrying an interrupted import cannot duplicate rounds.
    let changed=false;
    records.forEach(r=>{ if (!r.id) { r.id=crypto.randomUUID(); changed=true; } });
    if (changed) localStorage.setItem('oralRounds',JSON.stringify(records));
    let count=0; let invalid=false;
    for (const r of records) {
      if (!['primary','junior','senior'].includes(r.division)) continue;
      if (r.sharedScoreApi===base() && (r.sharedScoreLink || '')===deviceCode()) continue;
      try { await save({...r,details:r.details || []}); count++; }
      catch (error) {
        if (error.status===400 || error.status===413) { invalid=true; continue; }
        throw error;
      }
    }
    if (invalid) throw new Error("Some saved rounds could not be imported. They remain in this browser.");
    return count;
  }
  async function createDeviceCode() {
    await importLocal();
    const result=await api('/device-link',{method:'POST'});
    // Pin this device too, so both keep the same history if its IP later changes.
    await linkDevice(result.code);
    return result.code;
  }
  async function linkDevice(value) {
    const code=value.replace(/[\s-]/g,'').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) throw new Error('Enter the complete code from the other device.');
    if (importInFlight) { try { await importInFlight; } catch {} }
    await api('/rounds?division=primary',{},code);
    localStorage.setItem('oralRoundDeviceCode',code);
  }
  return {local,save,list,importLocal,createDeviceCode,linkDevice,enabled:()=>Boolean(base())};
})();

// Opening the site imports old rounds without requiring a button click.
ScoreSync.importLocal().catch(()=>{});
window.addEventListener('online',()=>{ ScoreSync.importLocal().catch(()=>{}); });
