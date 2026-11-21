import { unlockUser, normalizeUsername } from './core/crypto.mjs';
import { GitHubStore } from './core/github.mjs';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const fieldNames = { arrived: 'Geldi', document: 'Belge', voted: 'Oy', note: 'Not' };
const defaultUsers = ['besir', 'ensar', 'yavuz', 'fahri', 'kerim'];
const fold = value => value.toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
const clock = date => new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(date));
const pending = new Map();
let config, session, store, data, filter = 'all', healthy = false, saving = false;
let pollTimer, saveTimer, toastTimer, lastSync = 0, generation = 0, noteContext = null;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').dataset.error = String(error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 3500);
}

function cookieName() { return `stso_${config.id.replace(/[^\w-]/g, '')}`; }
function cookiePath() { return new URL('.', location.href).pathname; }
function rememberSession(result, persistent) {
  const value = encodeURIComponent(JSON.stringify({ username: result.user.username, key: result.rememberedKey, persistent }));
  const seconds = Math.max(0, Math.floor(Math.min(36 * 3600000, Date.parse(config.validUntil) - Date.now()) / 1000));
  document.cookie = `${cookieName()}=${value}; Path=${cookiePath()}; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}${persistent ? `; Max-Age=${seconds}` : ''}`;
}
function forgetSession() {
  if (config?.id) document.cookie = `${cookieName()}=; Path=${cookiePath()}; Max-Age=0; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`;
}
function storedSession() {
  const value = document.cookie.split('; ').find(part => part.startsWith(`${cookieName()}=`));
  if (!value) return null;
  try { return JSON.parse(decodeURIComponent(value.slice(value.indexOf('=') + 1))); } catch { return null; }
}

function setConnection(ok, message = '') {
  healthy = ok;
  $('#connection').dataset.state = ok ? 'live' : 'error';
  $('#connection span').textContent = ok ? 'Güncel' : 'Bağlantı bekleniyor';
  $('#connection-banner').hidden = ok;
  $('#connection-banner').textContent = message || 'Ortak liste şu anda yenilenemiyor. Bağlantı gelince otomatik güncellenecek.';
  if (ok) {
    lastSync = Date.now();
    $('#sync-time').textContent = `Son kontrol ${clock(lastSync)} · ${Math.round(pollInterval() / 1000)} sn`;
  }
}

function pollInterval() { return Math.max(3000, Math.min(30000, config.pollIntervalMs || 3000)); }
function queuePoll(delay = pollInterval()) {
  clearTimeout(pollTimer);
  if (session && !document.hidden) pollTimer = setTimeout(refresh, delay + Math.floor(Math.random() * 200));
}

async function refresh() {
  if (!session || document.hidden) return;
  if (saving) { queuePoll(); return; }
  const active = generation;
  try {
    const next = await store.load();
    if (active !== generation) return;
    const changed = next.revision !== data?.revision;
    data = next;
    setConnection(true);
    if (changed) render();
    else updateButtonAvailability();
  } catch (error) {
    if (active !== generation) return;
    setConnection(false, error.message);
    updateButtonAvailability();
  }
  if (active === generation) queuePoll(Math.max(pollInterval(), (store.retryAt || 0) - Date.now()));
}

function updateButtonAvailability() {
  for (const button of document.querySelectorAll('[data-check]')) {
    const key = `${button.dataset.id}:${button.dataset.check}`;
    button.disabled = !healthy || pending.has(key);
  }
  $('#note-save').disabled = !healthy || Boolean(noteContext && pending.has(`${noteContext.id}:note`));
}

function checkButton(record, field) {
  const waiting = pending.has(`${record.id}:${field}`);
  return `<td class="check-cell"><button class="check-button${waiting ? ' pending' : ''}" role="switch" aria-checked="${record[field]}" data-check="${field}" data-id="${escapeHtml(record.id)}" aria-label="${escapeHtml(record.company)}: ${fieldNames[field]}${waiting ? ', kayıt bekleniyor' : ''}" ${!healthy || waiting ? 'disabled' : ''}><span aria-hidden="true">${waiting ? '·' : '✓'}</span><span class="mobile-check-label">${fieldNames[field]}</span></button></td>`;
}

function render() {
  if (!data) return;
  const activeElement = document.activeElement;
  const focused = activeElement?.matches('[data-check], [data-note]') ? { id: activeElement.dataset.id, field: activeElement.dataset.check, note: activeElement.dataset.note } : null;
  const query = fold($('#search').value.trim());
  const visible = data.records.filter(record => {
    if (query && !fold([record.registry, record.company, record.voter, record.phone, record.phone.replace(/\s/g, ''), record.note].join(' ')).includes(query)) return false;
    return filter === 'all' || (filter === 'waiting' && !record.arrived) || (filter === 'arrived' && record.arrived) || (filter === 'voted' && record.voted) || (filter === 'notes' && Boolean(record.note.trim()));
  });
  const total = data.records.length;
  const arrived = data.records.filter(record => record.arrived).length;
  const documents = data.records.filter(record => record.document).length;
  const voted = data.records.filter(record => record.voted).length;
  const percent = total ? Math.round(voted / total * 100) : 0;
  $('#stat-total').textContent = total;
  $('#stat-arrived').textContent = arrived;
  $('#stat-waiting').textContent = `${total - arrived} firma bekleniyor`;
  $('#stat-document').textContent = documents;
  $('#stat-voted').textContent = voted;
  $('#stat-percent').textContent = `%${percent} katılım`;
  $('#progress-value').style.width = `${percent}%`;
  $('#result-count').textContent = visible.length;
  $('#list-count').textContent = `${total} kayıttan ${visible.length} kayıt gösteriliyor`;
  $('#empty-state').hidden = Boolean(visible.length);
  $('#records-body').innerHTML = visible.map(record => `<tr class="${record.arrived ? 'arrived-row' : ''}"><td><span class="record-number">${record.number}</span><span class="record-registry">${escapeHtml(record.registry)}</span></td><td class="company-cell"><span class="company-name">${escapeHtml(record.company)}</span>${record.sourceTruncated ? '<small class="source-truncated">Unvan kaynak belgede kısaltılmıştır.</small>' : ''}</td><td class="person-cell"><span class="person-name${record.voter ? '' : ' missing'}">${record.voter ? escapeHtml(record.voter) : '—'}</span>${record.phone ? `<a class="phone" href="tel:${record.phone.replace(/[^+\d]/g, '')}">${escapeHtml(record.phone)}</a>` : ''}</td>${['arrived', 'document', 'voted'].map(field => checkButton(record, field)).join('')}<td class="check-cell note-cell"><button type="button" class="note-button${record.note.trim() ? ' has-note' : ''}" data-note="${escapeHtml(record.id)}" data-id="${escapeHtml(record.id)}" aria-label="${escapeHtml(record.company)}: ${record.note ? 'notu düzenle' : 'not ekle'}" title="${escapeHtml(record.note || 'Not ekle')}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5" stroke-linejoin="round" stroke-linecap="round"/></svg></button></td></tr>`).join('');
  renderSaveStatus();
  renderActivity();
  checkOpenNote();
  if (focused && !document.querySelector('dialog[open]')) {
    const selector = focused.note ? `[data-note="${CSS.escape(focused.note)}"]` : `[data-id="${CSS.escape(focused.id)}"][data-check="${focused.field}"]`;
    $(selector)?.focus({ preventScroll: true });
  }
}

function renderSaveStatus() {
  const failed = [...pending.values()].some(entry => entry.status === 'failed');
  $('#save-banner').hidden = !pending.size;
  $('#save-message').textContent = failed ? `${pending.size} değişiklik henüz kaydedilmedi. ${[...pending.values()].find(entry => entry.error)?.error || 'Bağlantıyı kontrol edip tekrar deneyin.'}` : `${pending.size} değişiklik kaydediliyor… GitHub onayı bekleniyor.`;
  $('#retry-save').hidden = !failed;
  $('#retry-save').disabled = saving || (store?.retryAt || 0) > Date.now();
}

function stage(record, field, value, expectedVersion = record.versions[field]) {
  const key = `${record.id}:${field}`;
  if (pending.has(key)) return null;
  const operation = { opId: crypto.randomUUID(), recordId: record.id, field, value, expectedVersion };
  pending.set(key, { operation, status: 'queued' });
  if (!saveTimer) saveTimer = setTimeout(flush, 850);
  render();
  return operation.opId;
}

async function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (saving || !session) return;
  const batch = [...pending.entries()].filter(([, entry]) => entry.status === 'queued');
  if (!batch.length) return;
  const active = generation;
  saving = true;
  batch.forEach(([, entry]) => { entry.status = 'saving'; });
  renderSaveStatus();
  try {
    const result = await store.commit(batch.map(([, entry]) => entry.operation), session.user);
    if (generation !== active) return;
    data = result.state;
    for (const [key, entry] of batch) {
      if (result.accepted.includes(entry.operation.opId)) {
        pending.delete(key);
        if (noteContext?.opId === entry.operation.opId) { $('#note-dialog').close(); noteContext = null; }
      }
    }
    for (const conflict of result.conflicts) {
      pending.delete(`${conflict.recordId}:${conflict.field}`);
      if (noteContext?.id === conflict.recordId && conflict.field === 'note') {
        $('#note-error').hidden = false;
        $('#note-error').textContent = 'Not kaydedilmedi: bu alan başka bir kullanıcı tarafından değiştirildi.';
      }
    }
    setConnection(true);
    if (result.conflicts.length) toast(`${result.conflicts.length} alan başka bir cihazda değişmiş. Güncel kayıt gösteriliyor; kendi değişikliğiniz kaydedilmedi.`, true);
    else toast(batch.length > 1 ? `${batch.length} değişiklik kaydedildi.` : 'Kaydedildi.');
  } catch (error) {
    if (generation !== active) return;
    batch.forEach(([, entry]) => { entry.status = 'failed'; entry.error = error.message; });
    setConnection(false, error.message);
    toast('Kayıt onaylanmadı. Değişiklikler bekliyor; tekrar kaydedebilirsiniz.', true);
  } finally {
    if (generation === active) {
      saving = false;
      render();
      updateButtonAvailability();
      if ([...pending.values()].some(entry => entry.status === 'queued')) saveTimer = setTimeout(flush, 1100);
      queuePoll(Math.max(pollInterval(), (store.retryAt || 0) - Date.now()));
    }
  }
}

function openNote(id) {
  const record = data.records.find(item => item.id === id);
  if (!record) return;
  noteContext = { id, version: record.versions.note, opId: pending.get(`${id}:note`)?.operation.opId };
  $('#note-company').textContent = `${record.registry} · ${record.company}`;
  $('#note-text').value = pending.get(`${id}:note`)?.operation.value ?? record.note;
  $('#note-author').textContent = record.updatedAt ? `Son işlem: ${record.updatedBy} · ${clock(record.updatedAt)}` : '';
  $('#note-counter').textContent = `${$('#note-text').value.length} / 2000`;
  $('#note-error').hidden = true;
  $('#note-conflict').hidden = true;
  $('#note-dialog').showModal();
  updateButtonAvailability();
  $('#note-text').focus();
}

function checkOpenNote() {
  if (!noteContext || !$('#note-dialog').open) return;
  const record = data.records.find(item => item.id === noteContext.id);
  if (record && record.versions.note !== noteContext.version) {
    $('#note-conflict').hidden = false;
    $('#note-remote').textContent = record.note || '(Boş not)';
  }
}

function renderActivity() {
  const items = data.history.slice(-30).reverse();
  $('#activity-list').innerHTML = items.length ? items.map(item => {
    const record = data.records.find(record => record.id === item.recordId);
    const action = item.field === 'note' ? 'Not güncellendi' : `${fieldNames[item.field] || item.field}: ${item.to ? 'işaretlendi' : 'işaret kaldırıldı'}`;
    return `<article class="activity-item"><strong>${escapeHtml(item.name)}</strong> · ${escapeHtml(action)}<p>${escapeHtml(record?.company || item.recordId)}</p><small>${clock(item.at)}</small></article>`;
  }).join('') : '<p class="empty-state">Henüz bir işaretleme yapılmadı.</p>';
}

async function startSession(result, remember) {
  const nextStore = new GitHubStore(result.access);
  await nextStore.verifyPrivate();
  const initial = await nextStore.load(true);
  generation++;
  store = nextStore; session = result; data = initial;
  rememberSession(result, remember);
  $('#password').value = '';
  $('#login-screen').hidden = true;
  $('#loading').hidden = true;
  $('#app-screen').hidden = false;
  $('#current-user').textContent = result.user.name;
  setConnection(true);
  render();
  queuePoll();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').hidden = true;
  $('#login-submit').disabled = true;
  $('#login-submit').textContent = 'Giriş yapılıyor…';
  try {
    if (!config?.id || !config.users.length) throw new Error('GitHub bağlantısı henüz kurulmadı. Paketteki KURULUM yönergesini tamamlayın.');
    const result = await unlockUser(config, normalizeUsername($('#username').value), $('#password').value);
    await startSession(result, $('#remember').checked);
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  } finally {
    $('#login-submit').disabled = false;
    $('#login-submit').textContent = 'Listeye giriş yap';
  }
});

$('#show-password').addEventListener('click', () => {
  const visible = $('#password').type === 'password';
  $('#password').type = visible ? 'text' : 'password';
  $('#show-password').textContent = visible ? 'Gizle' : 'Göster';
  $('#show-password').setAttribute('aria-label', visible ? 'Parolayı gizle' : 'Parolayı göster');
});

$('#logout').addEventListener('click', () => {
  if (pending.size) { toast('Önce bekleyen değişiklikleri kaydedin. Kaydedilmemiş işlemler varken çıkış yapılmadı.', true); return; }
  generation++; clearTimeout(pollTimer); clearTimeout(saveTimer);
  forgetSession(); session = null; store = null; data = null; healthy = false;
  $('#records-body').replaceChildren(); $('#activity-list').replaceChildren();
  $('#search').value = ''; filter = 'all';
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === 'all'));
  $('#app-screen').hidden = true; $('#login-screen').hidden = false;
});

$('#records-body').addEventListener('click', event => {
  const check = event.target.closest('[data-check]');
  const note = event.target.closest('[data-note]');
  if (check && healthy && !check.disabled) {
    const record = data.records.find(item => item.id === check.dataset.id);
    if (record) stage(record, check.dataset.check, !record[check.dataset.check]);
  } else if (note) openNote(note.dataset.note);
});

$('#search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === button));
  render();
});

$('#retry-save').addEventListener('click', () => {
  for (const entry of pending.values()) if (entry.status === 'failed') { entry.status = 'queued'; entry.error = ''; }
  flush();
});

$('#note-text').addEventListener('input', () => { $('#note-counter').textContent = `${$('#note-text').value.length} / 2000`; });
$('#note-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!noteContext || !healthy) return;
  const record = data.records.find(item => item.id === noteContext.id);
  if (record.versions.note !== noteContext.version) { checkOpenNote(); return; }
  if (record.note === $('#note-text').value) { $('#note-dialog').close(); noteContext = null; return; }
  noteContext.opId = stage(record, 'note', $('#note-text').value, noteContext.version);
  updateButtonAvailability();
});
$('#note-load-current').addEventListener('click', () => {
  if (!noteContext) return;
  if ($('#note-text').value && !confirm('Yazdığınız not yerine ortak listedeki güncel not açılsın mı?')) return;
  const record = data.records.find(item => item.id === noteContext.id);
  noteContext.version = record.versions.note;
  $('#note-text').value = record.note;
  $('#note-counter').textContent = `${record.note.length} / 2000`;
  $('#note-conflict').hidden = true;
  $('#note-error').hidden = true;
});
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
$('#note-dialog').addEventListener('close', () => { noteContext = null; });
$('#activity-open').addEventListener('click', () => $('#activity-dialog').showModal());
$('#export').addEventListener('click', () => {
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `stso-kontrol-yedek-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  if (pending.size) toast('Yedek yalnızca onaylanmış kayıtları içeriyor. Bekleyen işlemleri ayrıca kaydedin.', true);
});
$('#print').addEventListener('click', () => window.print());
document.addEventListener('visibilitychange', () => {
  clearTimeout(pollTimer);
  if (!document.hidden && session) refresh();
});
window.addEventListener('online', () => { if (session) refresh(); });
window.addEventListener('offline', () => { if (session) { setConnection(false, 'İnternet bağlantısı kesildi. Kaydedilmemiş işlemler bekliyor.'); updateButtonAvailability(); } });
window.addEventListener('beforeunload', event => { if (pending.size) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if (event.key === '/' && session && !event.target.closest('input, textarea, select, dialog')) { event.preventDefault(); $('#search').focus(); }
});

async function boot() {
  try {
    if (!crypto.subtle) throw new Error('Giriş için siteyi HTTPS üzerinden açın. Yerelde localhost kullanılabilir.');
    const response = await fetch('./config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Yapılandırma dosyası yüklenemedi.');
    config = await response.json();
    const users = config.users?.length ? config.users : defaultUsers.map(username => ({ username, name: username }));
    for (const user of users) $('#username').add(new Option(user.name, user.username));
    if (config.id) {
      const saved = storedSession();
      if (saved) {
        $('#username').value = saved.username;
        try {
          const result = await unlockUser(config, saved.username, '', saved.key);
          await startSession(result, saved.persistent === true);
          return;
        } catch (error) {
          if (/parola|süresi doldu/.test(error.message)) forgetSession();
          $('#login-error').textContent = error.message;
          $('#login-error').hidden = false;
        }
      }
    }
  } catch (error) {
    $('#login-error').textContent = error.message;
    $('#login-error').hidden = false;
  }
  $('#loading').hidden = true;
  $('#login-screen').hidden = false;
}
boot();
