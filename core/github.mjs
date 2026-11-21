import { decodeJson, encodeJson } from './crypto.mjs';
import { applyOperations, validateState } from './state.mjs';

export class GitHubError extends Error {
  constructor(message, status, retryAt = 0) { super(message); this.status = status; this.retryAt = retryAt; }
}

export class GitHubStore {
  constructor(access, { fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), clock = () => Date.now() } = {}) {
    if (!/^[\w.-]+$/.test(access.owner) || !/^[\w.-]+$/.test(access.repo) || !access.path || !access.branch) throw new Error('GitHub depo ayarları eksik.');
    this.access = access;
    // Native browser fetch checks its receiver. Calling an unbound copy as
    // this.fetcher(...) throws before the network request (Node tolerates it).
    this.fetcher = fetcher.bind(globalThis); this.sleep = sleep; this.clock = clock;
    this.base = `https://api.github.com/repos/${encodeURIComponent(access.owner)}/${encodeURIComponent(access.repo)}`;
    this.url = `${this.base}/contents/${access.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(access.branch)}`;
    this.etag = null; this.snapshot = null; this.sha = null; this.retryAt = 0; this.tail = Promise.resolve(); this.lastWriteAt = 0;
  }

  exclusive(action) {
    const result = this.tail.then(action, action);
    this.tail = result.catch(() => {});
    return result;
  }

  async request(url, options = {}) {
    if (this.access.validUntil && Date.parse(this.access.validUntil) <= this.clock()) throw new GitHubError('Listenin erişim süresi doldu.', 401);
    if (this.retryAt > this.clock()) throw new GitHubError('GitHub bekleme süresi devam ediyor. Değişiklikler henüz kaydedilmedi.', 429, this.retryAt);
    let response;
    try {
      response = await this.fetcher(url, {
        ...options,
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.access.token}`,
          'X-GitHub-Api-Version': '2022-11-28', ...options.headers,
        },
        cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(18000),
      });
    } catch {
      throw new GitHubError('GitHub bağlantısı kurulamadı. Kaydedildi onayı gelmeden sayfayı kapatmayın.', 0);
    }
    if (response.ok || response.status === 304) return response;
    const body = await response.json().catch(() => ({}));
    if (response.status === 429 || (response.status === 403 && (response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining') === '0' || /rate limit|abuse/i.test(body.message || '')))) {
      const reset = response.headers.get('x-ratelimit-remaining') === '0' ? Number(response.headers.get('x-ratelimit-reset')) * 1000 : 0;
      this.retryAt = Math.max(this.clock() + 60000, this.clock() + Number(response.headers.get('retry-after') || 0) * 1000, reset);
      throw new GitHubError('GitHub işlem sınırı nedeniyle bekliyor. Bekleyen değişiklikler henüz kaydedilmedi.', response.status, this.retryAt);
    }
    const messages = {
      401: 'GitHub erişim anahtarı geçersiz veya süresi dolmuş. Kurulumdan anahtarı yenileyin.',
      403: 'Bu GitHub anahtarının kayıt yazma yetkisi yok.',
      404: 'Özel veri deposu veya kayıt dosyası bulunamadı. Depo ve anahtar yetkisini kontrol edin.',
      409: 'Başka bir cihaz kaydı değiştirdi.',
      422: 'GitHub değişikliği kabul etmedi. Dal korumasını ve dosya ayarlarını kontrol edin.',
    };
    throw new GitHubError(messages[response.status] || 'GitHub isteği tamamlanamadı. Kayıt onaylanmadı.', response.status);
  }

  verifyPrivate() {
    return this.exclusive(async () => {
      const response = await this.request(this.base);
      const repository = await response.json();
      if (repository.private !== true) throw new GitHubError('Firma ve kişi kayıtları için özel (Private) bir veri deposu kullanın.', 400);
      if (repository.archived) throw new GitHubError('Veri deposu arşivlenmiş; yazma yapılamaz.', 400);
      return repository;
    });
  }

  async read(force = false) {
    const response = await this.request(this.url, { headers: !force && this.etag ? { 'If-None-Match': this.etag } : {} });
    if (response.status === 304) {
      if (!this.snapshot) throw new GitHubError('GitHub önbellek yanıtı geçerli değil.', 0);
      return this.snapshot;
    }
    const file = await response.json();
    if (file.encoding !== 'base64' || !file.content || !file.sha) throw new GitHubError('Kayıt dosyası okunamadı veya dosya çok büyük.', 0);
    const snapshot = validateState(decodeJson(file.content));
    this.snapshot = snapshot; this.sha = file.sha; this.etag = response.headers.get('etag');
    return snapshot;
  }

  load(force = false) { return this.exclusive(() => this.read(force)); }

  verifyWritable() {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await this.read(true);
        try {
          const response = await this.request(this.url.split('?')[0], {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Kurulum: veri degistirmeden yazma yetkisi kontrolu', content: encodeJson(current), sha: this.sha, branch: this.access.branch }),
          });
          const saved = await response.json();
          this.sha = saved.content.sha; this.etag = null;
          return current;
        } catch (error) {
          if (error.status !== 409 || attempt === 3) throw error;
          await this.sleep(1100);
        }
      }
    });
  }

  initialize(initialState) {
    return this.exclusive(async () => {
      try { return { created: false, state: await this.read(true) }; }
      catch (error) { if (error.status !== 404) throw error; }
      const response = await this.request(this.url.split('?')[0], {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'STSO kontrol listesi ilk kayıt', content: encodeJson(validateState(initialState)), branch: this.access.branch }),
      });
      const result = await response.json();
      this.snapshot = initialState; this.sha = result.content.sha; this.etag = null;
      return { created: true, state: initialState };
    });
  }

  commit(operations, actor) {
    return this.exclusive(async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        // The blob SHA is an atomic compare-and-swap at GitHub. Use the
        // confirmed snapshot first; refetch after a conflict or uncertain PUT.
        const current = attempt === 0 && this.snapshot && this.sha
          ? this.snapshot
          : await this.read(true);
        const result = applyOperations(current, operations, actor);
        if (!result.changed) return result;
        // GitHub recommends at least one second between mutating requests.
        const delay = Math.max(0, 1100 - (this.clock() - this.lastWriteAt));
        if (delay) await this.sleep(delay);
        try {
          this.lastWriteAt = this.clock();
          const response = await this.request(this.url.split('?')[0], {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `Kontrol listesi: ${actor.username} (${operations.length} alan)`, content: encodeJson(result.state), sha: this.sha, branch: this.access.branch }),
          });
          const saved = await response.json();
          this.snapshot = result.state; this.sha = saved.content.sha; this.etag = null;
          return result;
        } catch (error) {
          // The same operation IDs make retrying a timed-out successful write safe.
          if (![0, 409].includes(error.status) || attempt === 5) throw error;
          await this.sleep(Math.min(350 * 2 ** attempt, 4000) + Math.floor(Math.random() * 250));
        }
      }
    });
  }
}
