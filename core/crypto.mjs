const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const ITERATIONS = 250000;

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function fromBase64(value) {
  return Uint8Array.from(atob(value.replace(/\s/g, '')), ch => ch.charCodeAt(0));
}

export const encodeJson = data => toBase64(encoder.encode(JSON.stringify(data)));
export const decodeJson = value => JSON.parse(decoder.decode(fromBase64(value)));

export function normalizeUsername(value) {
  return value.trim().toLocaleLowerCase('tr-TR');
}

async function passwordKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromBase64(salt), iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
  );
}

export async function sealUser({ id, username, name, password, payload }) {
  username = normalizeUsername(username);
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, ITERATIONS);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(`${id}:${username}`) },
    key, encoder.encode(JSON.stringify(payload)),
  );
  return { username, name: name.trim(), salt, iterations: ITERATIONS, iv: toBase64(iv), vault: toBase64(new Uint8Array(encrypted)) };
}

export async function unlockUser(config, username, password, rememberedKey) {
  const user = config.users.find(item => item.username === normalizeUsername(username));
  if (!user) throw new Error('Kullanıcı adı veya parola hatalı.');
  if (!config.validUntil || Date.parse(config.validUntil) <= Date.now()) throw new Error('Bu listenin erişim süresi doldu.');
  try {
    const key = rememberedKey
      ? await crypto.subtle.importKey('raw', fromBase64(rememberedKey), { name: 'AES-GCM' }, true, ['decrypt'])
      : await passwordKey(password, user.salt, user.iterations);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(user.iv), additionalData: encoder.encode(`${config.id}:${user.username}`) },
      key, fromBase64(user.vault),
    );
    const access = JSON.parse(decoder.decode(decrypted));
    if (access.validUntil !== config.validUntil || access.configId !== config.id) throw new Error('Invalid access');
    const exportedKey = toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
    return { user: { username: user.username, name: user.name }, access, rememberedKey: exportedKey };
  } catch {
    throw new Error('Kullanıcı adı veya parola hatalı.');
  }
}
