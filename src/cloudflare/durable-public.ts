type DurableObjectBody = {
  size: number;
  etag: string;
  body: { cancel(): Promise<void> };
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T = unknown>(): Promise<T>;
};

export type DurableBucket = {
  get(key: string): Promise<DurableObjectBody | null>;
  head(key: string): Promise<object | null>;
  put(key: string, value: string | Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; httpMetadata?: { contentType?: string } }): Promise<object | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: false } | { objects: Array<{ key: string }>; truncated: true; cursor: string }>;
};

export type PublicGeneration = {
  revision: string;
  generationFence: number;
  capture: Record<string, { operation: string; sequence: number }>;
  tenantSource: string;
  policy: string;
  contract: string;
  state: 'active' | 'denied';
  origins: string[];
  responses: Array<{ target: string; digest: string | null; objectKey: string | null; reason?: 'ambiguous_slug' | 'locale_unavailable'; private?: boolean }>;
};

export type DurableAuthority = {
  format: 1;
  host: string;
  site: string;
  revision: string;
  generationFence: number;
  capture: Record<string, { operation: string; sequence: number }>;
  tenantSource: string;
  policy: string;
  contract: string;
  state: 'active' | 'pending' | 'denied';
  operation: string;
  markerSource: string;
  fence: number;
  markerFence: number;
  previousPublication: { operation: string; markerSource: string; markerFence: number; command?: { keyHash: string; claimHash: string } | null } | null;
  command?: { keyHash: string; claimHash: string } | null;
  intent: 'publish' | 'withdraw' | null;
  previousState: 'active' | 'denied' | null;
  origins: string[];
  responses: Array<{ target: string; digest: string | null; objectKey: string | null; reason?: 'ambiguous_slug' | 'locale_unavailable'; private?: boolean }>;
  candidate: PublicGeneration | null;
  preparation?: { generation: PublicGeneration; targets: string[] } | null;
  rollback: PublicGeneration[];
};

export type AuthorityRecord = { value: DurableAuthority; etag: string };

function validAuthority(value: object): value is DurableAuthority {
  const validCommand = (entry: unknown) => entry === null || entry === undefined || (!!entry && typeof entry === 'object' && /^[a-f0-9]{64}$/.test(String(Reflect.get(entry, 'keyHash'))) && /^[a-f0-9]{64}$/.test(String(Reflect.get(entry, 'claimHash'))));
  if ('command' in value && !validCommand(value.command)) return false;
  if (!('format' in value) || value.format !== 1 || !('state' in value) ||
      !['active', 'pending', 'denied'].includes(String(value.state))) return false;
  if (!('intent' in value) || (value.intent !== null && value.intent !== 'publish' && value.intent !== 'withdraw')) return false;
  if (!('fence' in value) || !Number.isSafeInteger(value.fence) || Number(value.fence) < 0) return false;
  if (!('markerFence' in value) || !Number.isSafeInteger(value.markerFence) || Number(value.markerFence) < 0 || Number(value.markerFence) > Number(value.fence)) return false;
  if (!('previousPublication' in value)) return false;
  if (value.previousPublication !== null) {
    const prior = value.previousPublication;
    if (!prior || typeof prior !== 'object' || value.intent !== 'withdraw' ||
        typeof Reflect.get(prior, 'operation') !== 'string' || !Reflect.get(prior, 'operation') ||
        typeof Reflect.get(prior, 'markerSource') !== 'string' || !Reflect.get(prior, 'markerSource') ||
        !Number.isSafeInteger(Reflect.get(prior, 'markerFence')) || Number(Reflect.get(prior, 'markerFence')) < 0 ||
        Number(Reflect.get(prior, 'markerFence')) >= Number(value.fence) || !validCommand(Reflect.get(prior, 'command'))) return false;
  }
  if ((value.state === 'pending') !== (value.intent === 'withdraw')) return false;
  if (!('previousState' in value) || (value.intent === null && value.previousState !== null) ||
      (value.intent !== null && value.previousState !== 'active' && value.previousState !== 'denied')) return false;
  if (!('rollback' in value) || !Array.isArray(value.rollback) || value.rollback.length > 2 ||
      !value.rollback.every((generation: unknown) => !!generation && typeof generation === 'object' && validGeneration(generation) && Reflect.get(generation, 'state') === 'active')) return false;
  if (!('candidate' in value) || (value.intent === null && value.candidate !== null)) return false;
  if ('preparation' in value && value.preparation !== null && value.preparation !== undefined) {
    const preparation = value.preparation;
    if (typeof preparation !== 'object' || !preparation || value.intent === null ||
        !('generation' in preparation) || !preparation.generation || typeof preparation.generation !== 'object' || !validGeneration(preparation.generation) ||
        !('targets' in preparation) || !Array.isArray(preparation.targets) || preparation.targets.length > 256 ||
        !preparation.targets.every((target: unknown) => typeof target === 'string' && target.length <= 4096)) return false;
  }
  if (value.candidate !== null && (!value.candidate || typeof value.candidate !== 'object' || !validGeneration(value.candidate))) return false;
  if (value.candidate !== null) {
    if (typeof value.candidate !== 'object' || !value.candidate) return false;
    if (value.intent === 'publish' && !['active', 'denied'].includes(String(Reflect.get(value.candidate, 'state')))) return false;
    if (value.intent === 'withdraw' && !['active', 'denied'].includes(String(Reflect.get(value.candidate, 'state')))) return false;
  }
  return validGeneration(value) && ['host', 'site', 'operation', 'markerSource'].every((key) => {
    if (!(key in value)) return false;
    const entry = Reflect.get(value, key);
    return typeof entry === 'string' && entry.length > 0 && entry.length <= (key === 'markerSource' ? 2048 : 1024);
  });
}

function validGeneration(value: object): boolean {
  if (!('generationFence' in value) || !Number.isSafeInteger(value.generationFence) || Number(value.generationFence) < 0) return false;
  if (!('capture' in value) || !value.capture || typeof value.capture !== 'object' || Array.isArray(value.capture)) return false;
  const captures = Object.entries(value.capture);
  if (captures.length > 64 || (Reflect.get(value, 'state') === 'active' && captures.length === 0) || captures.some(([id, item]) =>
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || !item || typeof item !== 'object' ||
    typeof Reflect.get(item, 'operation') !== 'string' || String(Reflect.get(item, 'operation')).length > 1024 ||
    !Number.isSafeInteger(Reflect.get(item, 'sequence')) || Number(Reflect.get(item, 'sequence')) < 0)) return false;
  if (!('origins' in value) || !Array.isArray(value.origins) || value.origins.length > 100 ||
      !value.origins.every((origin: unknown) => typeof origin === 'string' && origin.length <= 2048)) return false;
  if (!('responses' in value) || !Array.isArray(value.responses) || value.responses.length > 256) return false;
  const targets = new Set<string>();
  for (const response of value.responses) {
    if (!response || typeof response !== 'object') return false;
    const target: unknown = Reflect.get(response, 'target');
    const digest: unknown = Reflect.get(response, 'digest');
    const objectKey: unknown = Reflect.get(response, 'objectKey');
    const reason: unknown = Reflect.get(response, 'reason');
    const isPrivate: unknown = Reflect.get(response, 'private');
    if (typeof target !== 'string' || target.length > 4096 || !target.startsWith('/v1/') ||
        (digest !== null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) ||
        (digest === null ? objectKey !== null : typeof objectKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/\d+\/[a-f0-9]{64}$/.test(objectKey) || !objectKey.endsWith(`/${digest}`)) ||
        (reason !== undefined && (digest !== null || (reason !== 'ambiguous_slug' && reason !== 'locale_unavailable'))) ||
        (isPrivate !== undefined && (digest !== null || typeof isPrivate !== 'boolean')) || targets.has(target)) return false;
    targets.add(target);
  }
  return ['revision', 'tenantSource', 'policy', 'contract'].every((key) => {
    if (!(key in value)) return false;
    const entry = Reflect.get(value, key);
    return typeof entry === 'string' && entry.length > 0 && entry.length <= 1024;
  });
}

function validJsonResponse(bytes: Uint8Array): boolean {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

export async function bootstrapPublicNamespace(bucket: DurableBucket, prefix: string, operation: string): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,128}\/$/.test(prefix) || !/^[A-Za-z0-9_-]{1,128}$/.test(operation)) throw new Error('Invalid durable public namespace');
  const marker = `${prefix}bootstrap`;
  let current = await bucket.get(marker);
  if (!current) {
    await bucket.put(marker, JSON.stringify({ format: 1, operation, identity: crypto.randomUUID(), state: 'checking' }), { onlyIf: { etagDoesNotMatch: '*' } });
    current = await bucket.get(marker);
  }
  if (!current || current.size > 4096) return false;
  const value: object = await current.json();
  if (!value || typeof value !== 'object' || Reflect.get(value, 'format') !== 1 || Reflect.get(value, 'operation') !== operation ||
      typeof Reflect.get(value, 'identity') !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(String(Reflect.get(value, 'identity')))) return false;
  if (Reflect.get(value, 'state') === 'ready') return true;
  if (Reflect.get(value, 'state') !== 'checking') return false;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.some((entry) => entry.key !== marker)) return false;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (await bucket.put(marker, JSON.stringify({ format: 1, operation, identity: Reflect.get(value, 'identity'), state: 'ready' }), { onlyIf: { etagMatches: current.etag } })) return true;
  const latest = await bucket.get(marker);
  if (!latest || latest.size > 4096) return false;
  const completed: object = await latest.json();
  return !!completed && typeof completed === 'object' && Reflect.get(completed, 'format') === 1 &&
    Reflect.get(completed, 'operation') === operation && Reflect.get(completed, 'identity') === Reflect.get(value, 'identity') && Reflect.get(completed, 'state') === 'ready';
}

export async function readPublicNamespaceIdentity(bucket: DurableBucket, prefix: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]{1,128}\/$/.test(prefix)) throw new Error('Invalid durable public prefix');
  const marker = await bucket.get(`${prefix}bootstrap`);
  if (!marker || marker.size > 4096) return null;
  const value: object = await marker.json();
  if (!value || typeof value !== 'object' || Reflect.get(value, 'format') !== 1 || Reflect.get(value, 'state') !== 'ready') return null;
  const instance: unknown = Reflect.get(value, 'identity');
  return typeof instance === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance) ? instance : null;
}
async function namespaceReady(bucket: DurableBucket, prefix: string): Promise<boolean> { return (await readPublicNamespaceIdentity(bucket, prefix)) !== null; }

async function readOwnedObject(bucket: DurableBucket, prefix: string, key: string): Promise<DurableObjectBody | null> {
  const [ready, object] = await Promise.allSettled([namespaceReady(bucket, prefix), bucket.get(key)]);
  if (ready.status === 'rejected' || !ready.value) {
    if (object.status === 'fulfilled' && object.value) await object.value.body.cancel().catch(() => undefined);
    if (ready.status === 'rejected') throw ready.reason;
    throw new Error('Durable public namespace is not initialized');
  }
  if (object.status === 'rejected') throw object.reason;
  return object.value;
}

export function createPublicReadViews(read: (key: string, maxBytes: number) => Promise<{ bytes: Uint8Array; etag: string } | null>, prefix: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}\/$/.test(prefix)) throw new Error('Invalid durable public prefix');
  const json = (bytes: Uint8Array): object => JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  const namespaceIdentity = async (): Promise<string | null> => {
    const marker = await read(`${prefix}bootstrap`, 4096);
    if (!marker || marker.bytes.byteLength > 4096) return null;
    const value = json(marker.bytes);
    if (!value || typeof value !== 'object' || Reflect.get(value, 'format') !== 1 || Reflect.get(value, 'state') !== 'ready') return null;
    const identity: unknown = Reflect.get(value, 'identity');
    return typeof identity === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity) ? identity : null;
  };
  const ready = async () => (await namespaceIdentity()) !== null;
  return {
    namespaceIdentity,
    store: {
      async readAuthority(host: string): Promise<AuthorityRecord | null> {
        if (!await ready()) throw new Error('Durable public namespace is not initialized');
        const result = await read(`${prefix}authority/${encodeURIComponent(host)}`, 2 * 1024 * 1024);
        if (!result) return null;
        if (result.bytes.byteLength > 2 * 1024 * 1024) throw new Error('Invalid durable public authority size');
        const value = json(result.bytes);
        if (!value || typeof value !== 'object' || !validAuthority(value) || value.host !== host) throw new Error('Invalid durable public authority');
        return { value, etag: result.etag };
      },
      async readResponse(site: string, objectKey: string, digest: string, maxBytes: number): Promise<Uint8Array | null> {
        if (!await ready() || !/^[A-Za-z0-9_-]{1,128}$/.test(site) || !objectKey.startsWith(`${site}/`) ||
            !/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/\d+\/[a-f0-9]{64}$/.test(objectKey) ||
            !/^[a-f0-9]{64}$/.test(digest) || !objectKey.endsWith(`/${digest}`) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid durable public response');
        const result = await read(`${prefix}responses/${objectKey}`, maxBytes);
        if (!result) return null;
        if (result.bytes.byteLength > maxBytes) throw new Error('Invalid durable public response size');
        const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (actual !== digest) throw new Error('Invalid durable public response digest');
        return result.bytes;
      },
    },
    fences: {
      async read(site: string): Promise<PublicSiteFenceRecord | null> {
        if (!await ready()) throw new Error('Durable public namespace is not initialized');
        const result = await read(`${prefix}site-fence/${encodeURIComponent(site)}`, 2 * 1024 * 1024);
        if (!result) return null;
        if (result.bytes.byteLength > 2 * 1024 * 1024) throw new Error('Invalid public site fence');
        const value = json(result.bytes);
        if (!value || typeof value !== 'object' || !validSiteFence(value) || value.site !== site) throw new Error('Invalid public site fence');
        return { value, etag: result.etag };
      },
    },
  };
}

export function createDurablePublicStore(bucket: DurableBucket, prefix: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}\/$/.test(prefix)) throw new Error('Invalid durable public prefix');
  const key = (host: string) => `${prefix}authority/${encodeURIComponent(host)}`;
  return {
    async putResponse(site: string, operation: string, fence: number, digest: string, bytes: Uint8Array, maxBytes: number): Promise<string> {
      if (!await namespaceReady(bucket, prefix)) throw new Error('Durable public namespace is not initialized');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(site) || !/^[A-Za-z0-9_-]{1,128}$/.test(operation) || !Number.isSafeInteger(fence) || fence < 1) throw new Error('Invalid durable public response identity');
      const objectKey = `${site}/${operation}/${fence}/${digest}`;
      if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || bytes.byteLength > maxBytes)
        throw new Error('Invalid durable public response');
      if (!validJsonResponse(bytes)) throw new Error('Invalid durable public response JSON');
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== digest) throw new Error('Invalid durable public response digest');
      const result = await bucket.put(`${prefix}responses/${objectKey}`, bytes, { onlyIf: { etagDoesNotMatch: '*' } });
      if (result) return objectKey;
      const existing = await bucket.get(`${prefix}responses/${objectKey}`);
      if (!existing || existing.size !== bytes.byteLength) throw new Error('Invalid durable public response');
      const stored = new Uint8Array(await existing.arrayBuffer());
      const storedDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', stored))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (storedDigest !== digest) throw new Error('Invalid durable public response digest');
      return objectKey;
    },
    async readResponse(site: string, objectKey: string, digest: string, maxBytes: number): Promise<Uint8Array | null> {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(site) || !objectKey.startsWith(`${site}/`) || !/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/\d+\/[a-f0-9]{64}$/.test(objectKey) || !objectKey.endsWith(`/${digest}`) || !/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error('Invalid durable public response');
      const object = await readOwnedObject(bucket, prefix, `${prefix}responses/${objectKey}`);
      if (!object) return null;
      if (object.size > maxBytes) throw new Error('Invalid durable public response size');
      const bytes = new Uint8Array(await object.arrayBuffer());
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      if (actual !== digest) throw new Error('Invalid durable public response digest');
      return bytes;
    },
    async readAuthority(host: string): Promise<AuthorityRecord | null> {
      const object = await readOwnedObject(bucket, prefix, key(host));
      if (!object) return null;
      if (object.size > 2 * 1024 * 1024) throw new Error('Invalid durable public authority size');
      const parsed: object = await object.json();
      if (!parsed || typeof parsed !== 'object' || !validAuthority(parsed) || parsed.host !== host)
        throw new Error('Invalid durable public authority');
      return { value: parsed, etag: object.etag };
    },
    async compareAndSetAuthority(value: DurableAuthority, etag: string | null): Promise<boolean> {
      if (!await namespaceReady(bucket, prefix)) throw new Error('Durable public namespace is not initialized');
      if (!validAuthority(value)) throw new Error('Invalid durable public authority');
      const result = await bucket.put(key(value.host), JSON.stringify(value), {
        onlyIf: etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag },
        httpMetadata: { contentType: 'application/json' },
      });
      return result !== null;
    },
  };
}

export async function reservePublicMutation(
  store: ReturnType<typeof createDurablePublicStore>, current: AuthorityRecord, operation: string, kind: 'publish' | 'withdraw', markerSource: string, command: { keyHash: string; claimHash: string } | null = null,
): Promise<AuthorityRecord | null> {
  if ((current.value.intent !== null && !(current.value.intent === 'publish' && kind === 'withdraw')) ||
      current.value.operation === operation || !operation || !markerSource || !Number.isSafeInteger(current.value.fence + 1)) return null;
  const fence = current.value.fence + 1;
  const previousPublication = current.value.intent === 'publish'
    ? { operation: current.value.operation, markerSource: current.value.markerSource, markerFence: current.value.markerFence, command: current.value.command ?? null }
    : null;
  const value: DurableAuthority = { ...current.value, state: kind === 'withdraw' ? 'pending' : current.value.state, intent: kind, previousState: current.value.state === 'pending' ? current.value.previousState : current.value.state, operation, markerSource, command, fence, markerFence: fence, previousPublication, candidate: null, preparation: null };
  if (!await store.compareAndSetAuthority(value, current.etag)) return null;
  const installed = await store.readAuthority(value.host);
  if (!installed || installed.value.intent !== kind || installed.value.operation !== operation ||
      installed.value.fence !== value.fence) return null;
  return installed;
}

export async function takeoverPublicMutation(
  store: ReturnType<typeof createDurablePublicStore>, reservation: AuthorityRecord,
): Promise<AuthorityRecord | null> {
  if (reservation.value.intent === null || !Number.isSafeInteger(reservation.value.fence + 1)) return null;
  const value = { ...reservation.value, fence: reservation.value.fence + 1, candidate: null };
  if (!await store.compareAndSetAuthority(value, reservation.etag)) return null;
  const held = await store.readAuthority(value.host);
  return held?.value.operation === value.operation && held.value.markerSource === value.markerSource &&
    held.value.markerFence === value.markerFence && held.value.fence === value.fence ? held : null;
}

export async function attachPublicGeneration(
  store: ReturnType<typeof createDurablePublicStore>, reservation: AuthorityRecord, candidate: PublicGeneration,
): Promise<AuthorityRecord | null> {
  if (reservation.value.intent === null || reservation.value.candidate !== null || !validGeneration(candidate) || candidate.generationFence !== reservation.value.markerFence ||
      (reservation.value.intent === 'publish' && !['active', 'denied'].includes(candidate.state)) ||
      (reservation.value.intent === 'withdraw' && !['active', 'denied'].includes(candidate.state))) return null;
  const value = { ...reservation.value, candidate };
  if (!await store.compareAndSetAuthority(value, reservation.etag)) return null;
  const attached = await store.readAuthority(value.host);
  if (!attached || attached.value.operation !== value.operation || attached.value.fence !== value.fence ||
      attached.value.candidate === null) return null;
  return attached;
}

export async function savePublicPreparation(store: ReturnType<typeof createDurablePublicStore>, reservation: AuthorityRecord, generation: PublicGeneration, targets: string[]): Promise<AuthorityRecord | null> {
  if (reservation.value.intent === null || reservation.value.candidate !== null || !validGeneration(generation) || generation.generationFence !== reservation.value.markerFence ||
      targets.length > 256 || targets.some((target) => !target.startsWith('/v1/') || target.length > 4096) || new Set(targets).size !== targets.length || generation.responses.some((response, index) => response.target !== targets[index])) return null;
  const prior = reservation.value.preparation;
  if (generation.responses.length > (prior?.generation.responses.length ?? 0) + 1) return null;
  if (prior && (JSON.stringify(prior.targets) !== JSON.stringify(targets) || generation.revision !== prior.generation.revision || generation.generationFence !== prior.generation.generationFence || JSON.stringify(Object.entries(generation.capture).sort()) !== JSON.stringify(Object.entries(prior.generation.capture).sort()) ||
      generation.tenantSource !== prior.generation.tenantSource || generation.policy !== prior.generation.policy || generation.contract !== prior.generation.contract ||
      generation.state !== prior.generation.state || JSON.stringify(generation.origins) !== JSON.stringify(prior.generation.origins) || generation.responses.length < prior.generation.responses.length ||
      JSON.stringify(generation.responses.slice(0, prior.generation.responses.length)) !== JSON.stringify(prior.generation.responses))) return null;
  const value = { ...reservation.value, preparation: { generation, targets } };
  if (!await store.compareAndSetAuthority(value, reservation.etag)) return null;
  return store.readAuthority(value.host);
}

export async function finishPublicMutation(
  store: ReturnType<typeof createDurablePublicStore>, reservation: AuthorityRecord,
): Promise<boolean> {
  if (reservation.value.intent === null || reservation.value.candidate === null) return false;
  const old: PublicGeneration = { revision: reservation.value.revision, generationFence: reservation.value.generationFence, capture: reservation.value.capture, tenantSource: reservation.value.tenantSource,
    policy: reservation.value.policy, contract: reservation.value.contract, state: 'active',
    origins: reservation.value.origins, responses: reservation.value.responses };
  const rollback = reservation.value.previousState === 'active'
    ? [old, ...reservation.value.rollback.filter((entry) => entry.revision !== old.revision)].slice(0, 2)
    : reservation.value.rollback;
  const value: DurableAuthority = { ...reservation.value, ...reservation.value.candidate, intent: null, previousState: null, previousPublication: null, candidate: null, preparation: null, rollback };
  return store.compareAndSetAuthority(value, reservation.etag);
}

// The caller must first fence the D1 operation against any later commit.
export async function cancelPublicMutation(
  store: ReturnType<typeof createDurablePublicStore>, reservation: AuthorityRecord,
): Promise<boolean> {
  if (reservation.value.intent === null || reservation.value.previousState === null) return false;
  const prior = reservation.value.previousPublication;
  const value: DurableAuthority = prior
    ? { ...reservation.value, state: reservation.value.previousState, intent: 'publish', operation: prior.operation, markerSource: prior.markerSource, markerFence: prior.markerFence, command: prior.command ?? null, previousPublication: null, candidate: null, preparation: null }
    : { ...reservation.value, state: reservation.value.previousState, intent: null, previousState: null, previousPublication: null, candidate: null, preparation: null };
  return store.compareAndSetAuthority(value, reservation.etag);
}

export async function recoverPublicMutation(
  store: ReturnType<typeof createDurablePublicStore>,
  expected: Pick<DurableAuthority, 'host' | 'site' | 'operation' | 'fence' | 'markerSource'>,
): Promise<AuthorityRecord | null> {
  const current = await store.readAuthority(expected.host);
  if (!current || current.value.site !== expected.site ||
      current.value.operation !== expected.operation || current.value.markerSource !== expected.markerSource || current.value.fence !== expected.fence) return null;
  return current;
}

export async function publicHostReady(
  store: Pick<ReturnType<typeof createDurablePublicStore>, 'readAuthority' | 'readResponse'>,
  fences: Pick<ReturnType<typeof createPublicSiteFence>, 'read'>,
  host: string,
  targets: string[],
  verifyIdentity: (authority: DurableAuthority) => Promise<boolean>,
  maxBytes: number,
): Promise<boolean> {
  try {
    const authority = await store.readAuthority(host);
    if (!authority || authority.value.state !== 'active' || authority.value.intent !== null ||
        !await verifyIdentity(authority.value)) return false;
    const expected = new Set(targets);
    if (expected.size !== targets.length || authority.value.responses.length !== expected.size ||
        authority.value.responses.some((response) => !expected.has(response.target))) return false;
    const fence = await fences.read(authority.value.site);
    if (!fence || fence.value.state !== 'idle' || fence.value.retirement !== null || fence.value.intents.length !== 0 || !fence.value.hosts.includes(host)) return false;
    for (const response of authority.value.responses) {
      if (response.digest === null && response.objectKey === null) continue;
      if (!response.digest || !response.objectKey || !fence.value.pins.includes(response.objectKey) ||
          !await store.readResponse(authority.value.site, response.objectKey, response.digest, maxBytes)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function publicHostRetired(
  store: Pick<ReturnType<typeof createDurablePublicStore>, 'readAuthority'>,
  fences: Pick<ReturnType<typeof createPublicSiteFence>, 'read'>,
  host: string,
  verifyIdentity: (authority: DurableAuthority) => Promise<boolean>,
): Promise<boolean> {
  try {
    const authority = await store.readAuthority(host);
    if (!authority || authority.value.state !== 'denied' || authority.value.intent !== null ||
        !await verifyIdentity(authority.value)) return false;
    const fence = await fences.read(authority.value.site);
    return !!fence && fence.value.state === 'idle' && fence.value.intents.length === 0 && fence.value.pins.length === 0 &&
      fence.value.retirement !== null && fence.value.hosts.includes(host);
  } catch {
    return false;
  }
}

export type PublicSiteFence = {
  format: 1;
  site: string;
  fence: number;
  state: 'held' | 'idle';
  operation: string;
  owner: string;
  hosts: string[];
  pins: string[];
  hostPins: Record<string, string[]>;
  intents: PublicSiteIntent[];
  retirement: { operation: string; markerSource: string } | null;
  gcCursor: string | null;
  gcPlan: string[] | null;
  gcDone: boolean;
  kind: 'writer' | 'gc';
};
export type PublicSiteIntent = { host: string; operation: string; markerSource: string; markerFence: number; command?: { keyHash: string; claimHash: string } | null };
export type PublicSiteFenceRecord = { value: PublicSiteFence; etag: string };

function validSiteFence(value: object): value is PublicSiteFence {
  if (!('site' in value) || typeof value.site !== 'string') return false;
  const site = value.site;
  if (!('hosts' in value) || !Array.isArray(value.hosts) || !('pins' in value) || !Array.isArray(value.pins) ||
      !('hostPins' in value) || !value.hostPins || typeof value.hostPins !== 'object' || Array.isArray(value.hostPins)) return false;
  const knownHosts = value.hosts;
  const knownPins = value.pins;
  const hostPins = Object.entries(value.hostPins);
  if (hostPins.some(([host, pins]) => !knownHosts.includes(host) || !Array.isArray(pins))) return false;
  const allPins = new Set(hostPins.flatMap(([, pins]) => Array.isArray(pins) ? pins : []));
  if (allPins.size !== knownPins.length || knownPins.some((pin: unknown) => !allPins.has(pin))) return false;
  if (!('intents' in value) || !Array.isArray(value.intents) || value.intents.length > 1024) return false;
  if (!('retirement' in value) || (value.retirement !== null && (!value.retirement || typeof value.retirement !== 'object' ||
      typeof Reflect.get(value.retirement, 'operation') !== 'string' || !Reflect.get(value.retirement, 'operation') || String(Reflect.get(value.retirement, 'operation')).length > 1024 ||
      typeof Reflect.get(value.retirement, 'markerSource') !== 'string' || !Reflect.get(value.retirement, 'markerSource') || String(Reflect.get(value.retirement, 'markerSource')).length > 2048))) return false;
  const intentHosts = new Set<string>();
  for (const intent of value.intents) {
    if (!intent || typeof intent !== 'object') return false;
    const host: unknown = Reflect.get(intent, 'host');
    const operation: unknown = Reflect.get(intent, 'operation');
    const markerSource: unknown = Reflect.get(intent, 'markerSource');
    const markerFence: unknown = Reflect.get(intent, 'markerFence');
    const command: unknown = Reflect.get(intent, 'command');
    if (typeof host !== 'string' || !knownHosts.includes(host) || intentHosts.has(host) || typeof operation !== 'string' || !operation || operation.length > 1024 ||
        typeof markerSource !== 'string' || !markerSource || markerSource.length > 2048 || typeof markerFence !== 'number' || !Number.isSafeInteger(markerFence) || markerFence < 1 ||
        (command !== undefined && command !== null && (typeof command !== 'object' || !/^[a-f0-9]{64}$/.test(String(Reflect.get(command, 'keyHash'))) || !/^[a-f0-9]{64}$/.test(String(Reflect.get(command, 'claimHash')))))) return false;
    intentHosts.add(host);
  }
  return 'format' in value && value.format === 1 && 'site' in value && typeof value.site === 'string' && value.site.length > 0 && value.site.length <= 1024 &&
    'fence' in value && Number.isSafeInteger(value.fence) && Number(value.fence) > 0 &&
    'state' in value && (value.state === 'held' || value.state === 'idle') &&
    'operation' in value && typeof value.operation === 'string' && value.operation.length > 0 && value.operation.length <= 1024 &&
    'owner' in value && typeof value.owner === 'string' && value.owner.length > 0 && value.owner.length <= 1024 &&
    'hosts' in value && Array.isArray(value.hosts) && value.hosts.length <= 1024 && value.hosts.every((host: unknown) => typeof host === 'string' && host.length > 0 && host.length <= 253) &&
    'pins' in value && Array.isArray(value.pins) && value.pins.length <= 4096 && value.pins.every((pin: unknown) => typeof pin === 'string' && /^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/\d+\/[a-f0-9]{64}$/.test(pin) && pin.startsWith(`${site}/`)) &&
    'hostPins' in value && !!value.hostPins && typeof value.hostPins === 'object' && !Array.isArray(value.hostPins) && Object.entries(value.hostPins).length <= 1024 && Object.entries(value.hostPins).every(([host, pins]) => host.length > 0 && host.length <= 253 && Array.isArray(pins) && pins.every((pin: unknown) => typeof pin === 'string' && knownPins.includes(pin))) &&
    'gcCursor' in value && (value.gcCursor === null || (typeof value.gcCursor === 'string' && value.gcCursor.length <= 4096)) &&
    'gcPlan' in value && (value.gcPlan === null || (Array.isArray(value.gcPlan) && value.gcPlan.length <= 32 && value.gcPlan.every((key: unknown) => typeof key === 'string' && key.startsWith(`${site}/`) && /^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/\d+\/[a-f0-9]{64}$/.test(key)))) &&
    'gcDone' in value && typeof value.gcDone === 'boolean' &&
    'kind' in value && (value.kind === 'writer' || value.kind === 'gc');
}

export function createPublicSiteFence(bucket: DurableBucket, prefix: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}\/$/.test(prefix)) throw new Error('Invalid durable public prefix');
  const key = (site: string) => `${prefix}site-fence/${encodeURIComponent(site)}`;
  const read = async (site: string): Promise<PublicSiteFenceRecord | null> => {
    const object = await bucket.get(key(site));
    if (!object) return null;
    if (object.size > 2 * 1024 * 1024) throw new Error('Invalid public site fence');
    const value: object = await object.json();
    if (!value || typeof value !== 'object' || !validSiteFence(value) || value.site !== site) throw new Error('Invalid public site fence');
    return { value, etag: object.etag };
  };
  const put = async (value: PublicSiteFence, etag: string | null): Promise<boolean> => {
    if (!validSiteFence(value)) throw new Error('Invalid public site fence');
    return (await bucket.put(key(value.site), JSON.stringify(value), { onlyIf: etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag } })) !== null;
  };
  return {
    read,
    async acquire(site: string, operation: string, owner: string, kind: 'writer' | 'gc'): Promise<PublicSiteFenceRecord | null> {
      if (!await namespaceReady(bucket, prefix)) throw new Error('Durable public namespace is not initialized');
      const current = await read(site);
      if (current?.value.state === 'held') return null;
      const fence = (current?.value.fence ?? 0) + 1;
      if (!Number.isSafeInteger(fence)) return null;
      if (kind === 'gc' && current?.value.intents.length) return null;
      const value: PublicSiteFence = { format: 1, site, fence, state: 'held', operation, owner, kind, hosts: current?.value.hosts ?? [], pins: current?.value.pins ?? [], hostPins: current?.value.hostPins ?? {}, intents: current?.value.intents ?? [], retirement: current?.value.retirement ?? null, gcCursor: null, gcPlan: null, gcDone: false };
      if (!await put(value, current?.etag ?? null)) return null;
      const held = await read(site);
      return held?.value.state === 'held' && held.value.owner === owner && held.value.fence === fence && held.value.kind === kind ? held : null;
    },
    async registerHosts(record: PublicSiteFenceRecord, hosts: string[]): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer') return null;
      const combined = [...new Set([...record.value.hosts, ...hosts])].sort();
      if (combined.length > 1024) return null;
      const value = { ...record.value, hosts: combined };
      if (!await put(value, record.etag)) return null;
      const held = await read(value.site);
      return held?.value.owner === value.owner && held.value.operation === value.operation && held.value.fence === value.fence ? held : null;
    },
    async sealRetirement(record: PublicSiteFenceRecord, proof: { operation: string; markerSource: string }): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || record.value.operation !== proof.operation || !proof.markerSource ||
          record.value.intents.length || record.value.pins.length) return null;
      const value = { ...record.value, retirement: proof };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async clearRetirement(record: PublicSiteFenceRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || !record.value.retirement || record.value.operation === record.value.retirement.operation) return null;
      const value = { ...record.value, retirement: null };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async registerIntent(record: PublicSiteFenceRecord, intent: PublicSiteIntent, prior?: AuthorityRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || record.value.retirement !== null || !record.value.hosts.includes(intent.host) || intent.operation !== record.value.operation) return null;
      const current = record.value.intents.find((item) => item.host === intent.host);
      if (current && JSON.stringify(current) !== JSON.stringify(intent)) {
        if (!prior || prior.value.site !== record.value.site || prior.value.host !== intent.host || prior.value.intent !== 'publish' ||
            prior.value.operation !== current.operation || prior.value.markerSource !== current.markerSource || prior.value.markerFence !== current.markerFence ||
            intent.markerFence <= prior.value.fence) return null;
        const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(intent.host)}`);
        if (!actual || actual.etag !== prior.etag) return null;
      }
      const value = { ...record.value, intents: [...record.value.intents.filter((item) => item.host !== intent.host), intent] };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async settleIntent(record: PublicSiteFenceRecord, intent: PublicSiteIntent, authority: AuthorityRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || authority.value.site !== record.value.site || authority.value.host !== intent.host ||
          authority.value.operation !== intent.operation || authority.value.markerFence !== intent.markerFence || authority.value.markerSource !== intent.markerSource || authority.value.intent !== null ||
          !record.value.intents.some((item) => JSON.stringify(item) === JSON.stringify(intent))) return null;
      const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(intent.host)}`);
      if (!actual || actual.etag !== authority.etag) return null;
      const value = { ...record.value, intents: record.value.intents.filter((item) => item.host !== intent.host) };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    // The caller must first prove the unique D1 cancellation cannot later commit.
    async cancelIntent(record: PublicSiteFenceRecord, intent: PublicSiteIntent, authority: AuthorityRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || authority.value.host !== intent.host ||
          (authority.value.site !== record.value.site && !(authority.value.state === 'denied' && authority.value.intent === null)) ||
          authority.value.fence < intent.markerFence ||
          !(authority.value.intent === null || (authority.value.intent === 'publish' && authority.value.markerFence < intent.markerFence)) ||
          !record.value.intents.some((item) => JSON.stringify(item) === JSON.stringify(intent))) return null;
      const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(intent.host)}`);
      if (!actual || actual.etag !== authority.etag) return null;
      const restored = authority.value.intent === 'publish' ? [{ host: intent.host, operation: authority.value.operation, markerSource: authority.value.markerSource, markerFence: authority.value.markerFence, command: authority.value.command ?? null }] : [];
      const value = { ...record.value, intents: [...record.value.intents.filter((item) => item.host !== intent.host), ...restored] };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async registerGeneration(record: PublicSiteFenceRecord, generation: PublicGeneration, authority: AuthorityRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || record.value.retirement !== null || !validGeneration(generation)) return null;
      if (authority.value.site !== record.value.site || !record.value.hosts.includes(authority.value.host)) return null;
      const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(authority.value.host)}`);
      if (!actual || actual.etag !== authority.etag) return null;
      for (const response of generation.responses) {
        if (!response.objectKey) continue;
        const parts = response.objectKey.split('/');
        if (Number(parts[2]) !== record.value.fence && !record.value.pins.includes(response.objectKey)) return null;
        if (!record.value.pins.includes(response.objectKey) && !await bucket.head(`${prefix}responses/${response.objectKey}`)) return null;
      }
      const retained = [generation, ...authority.value.rollback, ...(authority.value.previousState === 'active' || authority.value.state === 'active' ? [authority.value] : [])];
      const references = retained.flatMap((entry) => entry.responses.flatMap((response) => response.objectKey === null ? [] : [response.objectKey]));
      if (references.some((reference) => !reference.startsWith(`${record.value.site}/`))) return null;
      const hostPins = { ...record.value.hostPins, [authority.value.host]: [...new Set(references)].sort() };
      const pins = [...new Set(Object.values(hostPins).flat())].sort();
      if (pins.length > 4096) return null;
      const value = { ...record.value, pins, hostPins };
      if (!await put(value, record.etag)) return null;
      const held = await read(value.site);
      return held?.value.owner === value.owner && held.value.operation === value.operation && held.value.fence === value.fence ? held : null;
    },
    async retireHost(record: PublicSiteFenceRecord, host: string, prior: { value: Pick<DurableAuthority, 'host' | 'site' | 'fence' | 'state' | 'intent'> }, next: AuthorityRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || prior.value.site !== record.value.site ||
          prior.value.host !== host || next.value.host !== host || next.value.site === record.value.site ||
          next.value.fence <= prior.value.fence || !record.value.hosts.includes(host) ||
          !(prior.value.state === 'denied' || (prior.value.state === 'pending' && prior.value.intent === 'withdraw'))) return null;
      const references = [next.value, ...next.value.rollback, ...(next.value.candidate ? [next.value.candidate] : []), ...(next.value.preparation ? [next.value.preparation.generation] : [])]
        .flatMap((generation) => generation.responses.flatMap((response) => response.objectKey ? [response.objectKey] : []));
      if (references.some((reference) => reference.startsWith(`${record.value.site}/`))) return null;
      const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(host)}`);
      if (!actual || actual.etag !== next.etag) return null;
      const hostPins = { ...record.value.hostPins };
      delete hostPins[host];
      const pins = [...new Set(Object.values(hostPins).flat())].sort();
      const value = { ...record.value, hostPins, pins };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async revalidateRollback(record: PublicSiteFenceRecord, authority: AuthorityRecord, revision: string, expected: Pick<PublicGeneration, 'tenantSource' | 'policy' | 'contract'>, guard: (generation: PublicGeneration) => Promise<boolean>): Promise<PublicGeneration | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || authority.value.site !== record.value.site ||
          !record.value.hosts.includes(authority.value.host) || authority.value.intent !== null || authority.value.state !== 'active') return null;
      const actual = await bucket.get(`${prefix}authority/${encodeURIComponent(authority.value.host)}`);
      if (!actual || actual.etag !== authority.etag) return null;
      const generation = authority.value.rollback.find((item) => item.revision === revision);
      if (!generation || generation.tenantSource !== expected.tenantSource || generation.policy !== expected.policy || generation.contract !== expected.contract || !await guard(generation)) return null;
      const current = new Map(authority.value.responses.map((response) => [response.target, response]));
      if (current.size !== generation.responses.length || generation.responses.some((response) => {
        const other = current.get(response.target);
        return !other || other.digest !== response.digest || other.reason !== response.reason || Boolean(other.private) !== Boolean(response.private);
      })) return null;
      for (const response of generation.responses) {
        if (!response.objectKey) continue;
        if (!record.value.pins.includes(response.objectKey) || !await bucket.head(`${prefix}responses/${response.objectKey}`)) return null;
      }
      return await guard(generation) ? { ...generation, revision: authority.value.revision, generationFence: authority.value.generationFence, capture: authority.value.capture } : null;
    },
    async takeover(record: PublicSiteFenceRecord, owner: string): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || !owner || owner === record.value.owner || !Number.isSafeInteger(record.value.fence + 1)) return null;
      const value = { ...record.value, owner, fence: record.value.fence + 1 };
      if (!await put(value, record.etag)) return null;
      const held = await read(value.site);
      return held?.value.state === 'held' && held.value.owner === owner && held.value.operation === value.operation && held.value.fence === value.fence ? held : null;
    },
    async replaceWriter(record: PublicSiteFenceRecord, operation: string, owner: string): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'writer' || !operation || !owner ||
          operation === record.value.operation || !Number.isSafeInteger(record.value.fence + 1)) return null;
      const value = { ...record.value, operation, owner, fence: record.value.fence + 1 };
      if (!await put(value, record.etag)) return null;
      const held = await read(value.site);
      return held?.value.state === 'held' && held.value.operation === operation && held.value.owner === owner && held.value.fence === value.fence ? held : null;
    },
    async planGcPage(record: PublicSiteFenceRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'gc' || record.value.gcPlan !== null || record.value.gcDone) return null;
      const root = `${prefix}responses/${record.value.site}/`;
      const page = await bucket.list({ prefix: root, cursor: record.value.gcCursor ?? undefined, limit: 32 });
      const pins = new Set(record.value.pins);
      const plan = page.objects.map((entry) => entry.key.slice(`${prefix}responses/`.length)).filter((objectKey) => {
        const parts = objectKey.split('/');
        const objectFence = Number(parts[2]);
        return parts.length === 4 && parts[0] === record.value.site && /^[A-Za-z0-9_-]{1,128}$/.test(parts[1] ?? '') &&
          /^[a-f0-9]{64}$/.test(parts[3] ?? '') && Number.isSafeInteger(objectFence) && objectFence > 0 &&
          objectFence < record.value.fence && !pins.has(objectKey);
      });
      const value = { ...record.value, gcPlan: plan, gcCursor: page.truncated ? page.cursor : null, gcDone: !page.truncated };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async applyGcPage(record: PublicSiteFenceRecord): Promise<PublicSiteFenceRecord | null> {
      if (record.value.state !== 'held' || record.value.kind !== 'gc' || record.value.gcPlan === null) return null;
      for (const objectKey of record.value.gcPlan) await bucket.delete(`${prefix}responses/${objectKey}`);
      const value = { ...record.value, gcPlan: null };
      if (!await put(value, record.etag)) return null;
      return read(value.site);
    },
    async release(record: PublicSiteFenceRecord): Promise<boolean> {
      if (record.value.state !== 'held' || (record.value.kind === 'gc' && (record.value.gcPlan !== null || !record.value.gcDone))) return false;
      return put({ ...record.value, state: 'idle' }, record.etag);
    },
  };
}
