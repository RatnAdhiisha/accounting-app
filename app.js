// Version 0.1: connects to the Apps Script link and shows the lists from the data sheet.
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

// Calls the Apps Script link. GET for reads; POST with text/plain (no CORS preflight) for writes.
async function api(action, body) {
  const url = store.get('scriptUrl'), key = store.get('scriptKey');
  if (!url) throw new Error('No Apps Script link saved yet.');
  let res;
  if (body) {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, key, data: body }) });
  } else {
    res = await fetch(`${url}?action=${encodeURIComponent(action)}&key=${encodeURIComponent(key)}`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Unknown error');
  return json.data;
}

function showLists(lists) {
  const box = $('lists');
  box.innerHTML = '<h2>Lists in the sheet</h2>';
  for (const [name, rows] of Object.entries(lists)) {
    const h = document.createElement('div');
    h.innerHTML = `<strong>${name}</strong> <span class="muted">(${rows.length})</span>`;
    const ul = document.createElement('ul');
    rows.forEach(r => {
      const li = document.createElement('li');
      li.textContent = Object.values(r).filter(v => v !== '' && v !== true && v !== false).join(' · ');
      ul.appendChild(li);
    });
    box.append(h, ul);
  }
  box.classList.remove('hidden');
}

async function test() {
  const s = $('status');
  s.className = 'muted'; s.textContent = 'Connecting…';
  try {
    const lists = await api('lists');
    s.className = 'ok'; s.textContent = 'Connected to the data sheet.';
    showLists(lists);
  } catch (e) {
    s.className = 'err'; s.textContent = 'Could not connect: ' + e.message;
  }
}

$('url').value = store.get('scriptUrl');
$('key').value = store.get('scriptKey');
$('save').onclick = () => {
  store.set('scriptUrl', $('url').value.trim());
  store.set('scriptKey', $('key').value.trim());
  test();
};
if (store.get('scriptUrl')) test();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
