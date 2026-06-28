'use strict';
// Setup-page logic. Plain fetch + DOM — no build step, served from the binary.

const $ = (id) => document.getElementById(id);
let anon = false;

function setMsg(text, kind) {
  const m = $('msg');
  m.textContent = text || '';
  m.className = 'msg' + (kind ? ' ' + kind : '');
}

function paintAnon() {
  $('anon').classList.toggle('on', anon);
  $('creds').style.opacity = anon ? .4 : 1;
}

// Format a UTC ISO timestamp as "just now / N min ago / today at HH:MM /
// YYYY-MM-DD HH:MM" depending on how recent it is.  Keeps the "last paired"
// line readable without bringing in a date library.
function formatAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const sec = Math.floor((Date.now() - t.getTime()) / 1000);
  if (sec < 60)             return 'just now';
  if (sec < 60 * 60)        return Math.floor(sec / 60) + ' min ago';
  // Today: same Y/M/D as now → show HH:MM
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth()    === now.getMonth() &&
    t.getDate()     === now.getDate();
  const hhmm = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
  if (sameDay) return 'today at ' + hhmm;
  return t.toISOString().slice(0,10) + ' ' + hhmm;
}

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('st-enc').textContent = s.encoder || '—';
    $('st-hw').textContent = s.hwaccel === 'none' ? 'software' : (s.hwaccel || '—');
    $('st-share').textContent = s.configured ? s.share : 'not configured';
    $('st-url').textContent = s.serverURL || '—';
    $('hdot').style.background = s.configured ? 'var(--ok)' : 'var(--mut)';
    if (s.configured && s.serverURL && s.token) {
      $('testcard').style.display = '';
      $('testlink').textContent = s.serverURL + '/play?path=/Movies/YourFile.mkv&token=' + s.token;
    }
    // "Last paired" indicator — survives server restarts so the user doesn't
    // think they have to re-pair after every binary upgrade.
    const lp = s.lastPair;
    const lpEl = $('lastpair');
    if (lp && lp.code && lp.at) {
      lpEl.textContent = 'Last paired with code ' + lp.code + ' · ' + formatAgo(lp.at) +
                         ' — the TV should still be paired; only re-pair if you reinstall the app on it.';
      lpEl.style.display = '';
    } else {
      lpEl.style.display = 'none';
    }
  } catch (e) { /* server starting */ }
}

async function pair() {
  const code = $('code').value.trim();
  if (!code) { $('pairmsg').textContent = 'Enter the code shown on the TV.'; $('pairmsg').className = 'msg err'; return; }
  $('pairmsg').textContent = 'Pairing…'; $('pairmsg').className = 'msg';
  const res = await (await fetch('/api/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })).json();
  if (res.ok) {
    $('pairmsg').textContent = 'Sent ' + res.url + ' to the TV. Press “Pair” on the TV to finish.';
    $('pairmsg').className = 'msg ok';
    // Pick up the freshly-saved lastPair without waiting for the 5 s poll.
    loadStatus();
  } else {
    $('pairmsg').textContent = 'Pairing failed: ' + (res.error || 'unknown');
    $('pairmsg').className = 'msg err';
  }
}

async function loadConfig() {
  const c = await (await fetch('/api/config')).json();
  const smb = c.smb || c.SMB || {};
  $('host').value = smb.host || '';
  $('port').value = smb.port || 445;
  $('share').value = smb.share || '';
  $('user').value = smb.user || '';
  $('domain').value = smb.domain || '';
  anon = !!smb.anonymous;
  paintAnon();
}

function readForm() {
  return {
    host: $('host').value.trim(),
    port: parseInt($('port').value, 10) || 445,
    share: $('share').value.trim(),
    user: $('user').value.trim(),
    pass: $('pass').value,        // blank = keep stored
    domain: $('domain').value.trim(),
    anonymous: anon,
  };
}

async function save() {
  const r = await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(readForm()),
  });
  if (r.ok) { setMsg('Saved.', 'ok'); $('pass').value = ''; loadStatus(); }
  else setMsg('Save failed.', 'err');
}

async function test() {
  setMsg('Testing…');
  await save();
  const res = await (await fetch('/api/test', { method: 'POST' })).json();
  if (res.ok) setMsg('Connected to the share ✓', 'ok');
  else setMsg('Could not connect: ' + (res.error || 'unknown'), 'err');
}

async function browse(path) {
  setMsg('Loading ' + (path || 'root') + '…');
  const res = await (await fetch('/api/browse?path=' + encodeURIComponent(path || ''))).json();
  const ul = $('list');
  ul.innerHTML = '';
  if (!res.ok) { setMsg('Browse failed: ' + (res.error || 'unknown'), 'err'); return; }
  setMsg('');
  if (path) {
    const up = document.createElement('li');
    up.textContent = '↩ ..';
    up.style.cursor = 'pointer'; up.style.padding = '4px 0';
    up.onclick = () => browse(path.split('/').slice(0, -1).join('/'));
    ul.appendChild(up);
  }
  (res.entries || []).forEach((e) => {
    const li = document.createElement('li');
    li.style.padding = '4px 0';
    li.textContent = (e.isDir ? '📁 ' : '🎬 ') + e.name;
    if (e.isDir) {
      li.style.cursor = 'pointer';
      li.onclick = () => browse((path ? path + '/' : '') + e.name);
    } else {
      li.style.color = 'var(--mut)';
    }
    ul.appendChild(li);
  });
}

$('anon').onclick = () => { anon = !anon; paintAnon(); };
$('save').onclick = save;
$('test').onclick = test;
$('browse').onclick = async () => { await save(); browse(''); };
$('pair').onclick = pair;

loadConfig();
loadStatus();
setInterval(loadStatus, 5000);
