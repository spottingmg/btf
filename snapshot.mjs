// Sammler für die Betriebshofliste.
// Liest die Livebus-Datenbank alle paar Sekunden und merkt sich für jeden Wagen den letzten Stand.
// Das Ergebnis liegt als fahrzeuge.json auf dem Branch "data" und wird von der Betriebshofliste geladen.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';

const DB = (process.env.DB_URL || 'https://fahrgastzahlen-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/$/, '');
const PATH = (process.env.DB_PATH || 'livegeomatching/busses').replace(/^\/|\/$/g, '');
const MINUTES = Number(process.env.MINUTES || 28);       // Laufzeit dieses Durchgangs
const EVERY = Number(process.env.EVERY_SECONDS || 15);   // Abfrage-Takt
const PUSH_EVERY = Number(process.env.PUSH_MINUTES || 5);// zwischendurch speichern
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 400);  // so lange bleibt ein Wagen gespeichert
const DIR = process.env.DATA_DIR || 'data';
const FILE = `${DIR}/fahrzeuge.json`;
const REPO = process.env.GITHUB_REPOSITORY, TOKEN = process.env.GITHUB_TOKEN;

mkdirSync(DIR, { recursive: true });
let store = { format: 'betriebshofliste-verlauf/1', updated: 0, vehicles: {} };
try {
  const j = JSON.parse(readFileSync(FILE, 'utf8'));
  if (j && j.vehicles) store = j;
} catch { /* erster Lauf */ }

let dirty = false, fails = 0, lastPush = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function poll() {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(`${DB}/${PATH}.json`, { signal: ctl.signal });
    const j = await r.json();
    if (!r.ok) throw new Error((j && j.error) || `HTTP ${r.status}`);
    if (!j || typeof j !== 'object') return 0;
    const now = Date.now();
    let n = 0;
    for (const id of Object.keys(j)) {
      const v = j[id];
      if (!v || typeof v !== 'object') continue;
      const g = v.geomatching || {}, rw = v.raw || {};
      const wagen = String(rw.vehicle ?? g.vehicle ?? id);
      store.vehicles[wagen] = { seen: now, v };
      n++;
    }
    for (const w of Object.keys(store.vehicles)) {
      if (now - (store.vehicles[w].seen || 0) > KEEP_DAYS * 864e5) delete store.vehicles[w];
    }
    if (n) dirty = true;
    return n;
  } finally { clearTimeout(to); }
}

function push() {
  if (!dirty) return;
  store.updated = Date.now();
  writeFileSync(FILE, JSON.stringify(store));
  const REMOTE = process.env.PUSH_URL || (REPO && TOKEN ? `https://x-access-token:${TOKEN}@github.com/${REPO}.git` : '');
  if (!REMOTE) { console.log('Kein GITHUB_TOKEN – nur lokal gespeichert.'); dirty = false; return; }
  const run = c => execSync(c, { cwd: DIR, stdio: 'pipe' });
  try {
    if (existsSync(`${DIR}/.git`)) rmSync(`${DIR}/.git`, { recursive: true, force: true });
    run('git init -q');
    run('git checkout -q -b data');
    run('git add fahrzeuge.json');
    run('git -c user.name=sammler -c user.email=sammler@users.noreply.github.com commit -q -m "Stand ' + new Date().toISOString() + '"');
    run(`git push -q -f ${REMOTE} data:data`);
    console.log(new Date().toISOString(), 'gespeichert:', Object.keys(store.vehicles).length, 'Wagen');
    dirty = false; lastPush = Date.now();
  } catch (e) {
    console.error('Speichern fehlgeschlagen:', String(e.stderr || e.message).split(TOKEN || '\u0000').join('***'));
  }
}

const end = Date.now() + MINUTES * 60000;
while (Date.now() < end) {
  try { const n = await poll(); fails = 0; if (n === 0) console.log('keine Wagen in der Datenbank'); }
  catch (e) {
    fails++; console.error('Abruf fehlgeschlagen:', e.message);
    if (fails >= 8) { push(); process.exit(1); }
  }
  if (Date.now() - lastPush >= PUSH_EVERY * 60000) push();
  await sleep(EVERY * 1000);
}
push();
