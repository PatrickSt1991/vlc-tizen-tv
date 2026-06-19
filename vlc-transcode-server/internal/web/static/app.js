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

async function loadStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    $('st-enc').textContent = s.encoder || '—';
    $('st-hw').textContent = s.hwaccel === 'none' ? 'software' : (s.hwaccel || '—');
    $('st-share').textContent = s.configured ? s.share : 'not configured';
    $('hdot').style.background = s.configured ? 'var(--ok)' : 'var(--mut)';
  } catch (e) { /* server starting */ }
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

loadConfig();
loadStatus();
setInterval(loadStatus, 5000);
