export const FIELDS = ['arrived', 'document', 'voted', 'note'];

export function createState(source) {
  return {
    schema: 1, revision: 0, title: source.title, eventDate: source.date,
    records: source.records.map(record => ({
      ...record, arrived: false, document: false, voted: false, note: '',
      versions: { arrived: 0, document: 0, voted: 0, note: 0 }, updatedAt: null, updatedBy: null,
    })),
    history: [],
  };
}

export function validateState(state) {
  if (state?.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.records) || !Array.isArray(state.history)) throw new Error('Kayıt dosyasının biçimi tanınmıyor. Mevcut dosya değiştirilmedi.');
  if (!state.records.length || state.records.length > 5000 || state.history.length > 1000) throw new Error('Kayıt dosyasının boyutu uygun değil.');
  const ids = new Set();
  for (const record of state.records) {
    if (typeof record.id !== 'string' || ids.has(record.id)) throw new Error('Kayıt kimlikleri geçerli değil.');
    ids.add(record.id);
    for (const key of ['registry', 'company', 'voter', 'phone', 'note']) if (typeof record[key] !== 'string') throw new Error('Kayıt alanları geçerli değil.');
    if (record.note.length > 2000) throw new Error('Bir not izin verilenden uzun.');
    for (const key of FIELDS) {
      if (!Number.isSafeInteger(record.versions?.[key]) || record.versions[key] < 0 || (key !== 'note' && typeof record[key] !== 'boolean')) throw new Error('Kayıt sürümü geçerli değil.');
    }
  }
  return state;
}

export function applyOperations(current, operations, actor, now = new Date().toISOString()) {
  validateState(current);
  const state = structuredClone(current);
  const accepted = [], conflicts = [];
  for (const operation of operations) {
    const { opId, recordId, field, value, expectedVersion } = operation;
    if (typeof opId !== 'string' || !/^[a-zA-Z0-9-]{12,80}$/.test(opId) || !FIELDS.includes(field) || !Number.isSafeInteger(expectedVersion)) throw new Error('Geçersiz değişiklik.');
    if ((field === 'note' && (typeof value !== 'string' || value.length > 2000)) || (field !== 'note' && typeof value !== 'boolean')) throw new Error('Geçersiz alan değeri.');
    const previous = state.history.find(entry => entry.opId === opId);
    if (previous) {
      if (previous.recordId !== recordId || previous.field !== field || previous.to !== value || previous.username !== actor.username) throw new Error('İşlem kimliği başka bir değişiklikte kullanılmış.');
      accepted.push(opId);
      continue;
    }
    const record = state.records.find(item => item.id === recordId);
    if (!record || record.versions[field] !== expectedVersion) {
      conflicts.push({ ...operation, currentValue: record?.[field], currentVersion: record?.versions[field] });
      continue;
    }
    const from = record[field];
    record[field] = value;
    record.versions[field]++;
    record.updatedAt = now;
    record.updatedBy = actor.name;
    state.revision++;
    state.history.push({ opId, recordId, field, from, to: value, at: now, username: actor.username, name: actor.name });
    accepted.push(opId);
  }
  state.history = state.history.slice(-1000);
  if (new TextEncoder().encode(JSON.stringify(state)).length > 740000) throw new Error('Kayıt dosyası sınırına ulaşıldı. Önce JSON yedeğini indirin.');
  return { state, accepted, conflicts, changed: state.revision !== current.revision };
}
