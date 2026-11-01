import { isD1BindingName, type D1CacheProfile } from './profile';

export interface D1WorkerConfig {
  name?: string;
  main?: string;
  vars?: Record<string, unknown>;
  d1_databases?: Array<{ binding: string; database_id: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string; script_name?: string; environment?: string }> };
  migrations?: Array<{ tag: string; new_sqlite_classes?: string[] }>;
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hints = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
const bindingsOf = (config: D1WorkerConfig, profile: D1CacheProfile) => (config.d1_databases ?? []).filter(({ binding }) => isD1BindingName(binding, profile));

export function d1CacheProblem(config: D1WorkerConfig, profile: D1CacheProfile, coordinatorScript?: string): string | null {
  const lease = profile.readResponseLease;
  const maxSeconds = lease?.maxSeconds ?? 5;
  const refreshAhead = lease?.refreshAheadSeconds ?? 0;
  if (lease && (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300 || !Number.isInteger(refreshAhead) || refreshAhead < 0 || refreshAhead > maxSeconds)) return 'Invalid response lease duration or refresh-ahead window.';
  const vars = config.vars ?? {};
  const field = (name: string) => vars[`${profile.envPrefix}_${name}`];
  const enabled = field('ENABLED');
  if (enabled === undefined || enabled === 'false') return null;
  if (enabled !== 'true') return `${profile.envPrefix}_ENABLED must be true or false.`;
  const reads = field('READS_ENABLED');
  if (reads !== undefined && reads !== 'true' && reads !== 'false') return `${profile.envPrefix}_READS_ENABLED must be true or false.`;
  const bindings = bindingsOf(config, profile);
  if (profile.bindingNames.some((name) => !bindings.some(({ binding }) => binding === name)) || bindings.some(({ database_id }) => !idPattern.test(database_id))) return 'Cache requires physical D1 UUIDs for every configured binding.';
  let map: unknown;
  try { const raw = field('DATABASE_IDS'); if (typeof raw !== 'string') throw new Error(); map = JSON.parse(raw); } catch { return `${profile.envPrefix}_DATABASE_IDS must contain the current D1 binding map.`; }
  const expected = Object.fromEntries(bindings.map(({ binding, database_id }) => [binding, database_id]));
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== bindings.length || Object.entries(expected).some(([key, value]) => Reflect.get(map, key) !== value)) return `${profile.envPrefix}_DATABASE_IDS differs from d1_databases; run setup or update the map.`;
  const generation = field('GENERATION');
  if (typeof generation !== 'string' || !generation.trim() || generation.length > 256) return 'Cache requires a generation of at most 256 characters.';
  const location = field('LOCATION_HINT');
  if (location !== undefined && (typeof location !== 'string' || !hints.has(location))) return 'Invalid cache location hint.';
  const coordinators = config.durable_objects?.bindings?.filter(({ name }) => name === `${profile.envPrefix}_COORDINATOR`) ?? [];
  const coordinator = coordinators[0];
  if (coordinators.length !== 1 || !coordinator || coordinator.environment !== undefined || coordinator.class_name !== profile.coordinatorClass || (coordinatorScript ? coordinator.script_name !== coordinatorScript : coordinator.script_name !== undefined)) return 'Cache coordinator binding is missing or points to the wrong Worker.';
  if (!coordinatorScript && !config.migrations?.some(({ new_sqlite_classes }) => new_sqlite_classes?.includes(profile.coordinatorClass))) return 'Cache requires a SQLite Durable Object migration.';
  return null;
}

export function d1CachePairProblem(admin: D1WorkerConfig, writer: D1WorkerConfig, profile: D1CacheProfile, writerEntry: string): string | null {
  const field = (config: D1WorkerConfig, name: string) => config.vars?.[`${profile.envPrefix}_${name}`];
  const a = field(admin, 'ENABLED') === 'true';
  const b = field(writer, 'ENABLED') === 'true';
  if (a !== b) return 'Admin and writer must enable or disable the cache together.';
  if (!a) return null;
  const problem = d1CacheProblem(admin, profile) ?? d1CacheProblem(writer, profile, admin.name);
  if (problem) return problem;
  if (field(admin, 'GENERATION') !== field(writer, 'GENERATION') || (field(admin, 'LOCATION_HINT') ?? 'weur') !== (field(writer, 'LOCATION_HINT') ?? 'weur')) return 'Admin and writer must share cache generation and location hint.';
  const adminIds = Object.fromEntries(bindingsOf(admin, profile).map(({ binding, database_id }) => [binding, database_id]));
  if (bindingsOf(writer, profile).some(({ binding, database_id }) => adminIds[binding] !== database_id)) return 'Admin and writer D1 identities differ.';
  if (writer.main !== writerEntry) return 'Writer must use the cache-aware Worker entry.';
  return null;
}

export function refreshD1CacheDatabaseIds(config: D1WorkerConfig, profile: D1CacheProfile): void {
  if (config.vars?.[`${profile.envPrefix}_ENABLED`] !== 'true') return;
  config.vars[`${profile.envPrefix}_DATABASE_IDS`] = JSON.stringify(Object.fromEntries(bindingsOf(config, profile).map(({ binding, database_id }) => [binding, database_id])));
}

export type D1ConfigEdit = { path: string[]; value: unknown };
export type D1WriterEdits = { ok: true; edits: D1ConfigEdit[] } | { ok: false; problem: string };

export function d1WriterCacheEdits(admin: D1WorkerConfig, writer: D1WorkerConfig, profile: D1CacheProfile, writerEntry: string): D1WriterEdits {
  const prefix = profile.envPrefix;
  const enabled = admin.vars?.[`${prefix}_ENABLED`] === 'true';
  if (!enabled && writer.vars?.[`${prefix}_ENABLED`] !== 'true') return { ok: true, edits: [] };
  const adminIds = new Map(bindingsOf(admin, profile).map(({ binding, database_id }) => [binding, database_id]));
  const databases = bindingsOf(writer, profile);
  if (profile.bindingNames.some((name) => !databases.some(({ binding }) => binding === name)) || databases.some(({ binding, database_id }) => adminIds.get(binding) !== database_id)) return { ok: false, problem: 'Writer D1 bindings differ from admin.' };
  if (enabled && (!admin.name || !admin.vars?.[`${prefix}_GENERATION`])) return { ok: false, problem: 'Admin cache requires a Worker name and generation.' };
  const bindings = writer.durable_objects?.bindings ?? [];
  const coordinators = bindings.filter(({ name }) => name === `${prefix}_COORDINATOR`);
  const coordinator = coordinators[0];
  if (coordinators.length > 1 || (coordinator && (coordinator.environment !== undefined || coordinator.class_name !== profile.coordinatorClass || coordinator.script_name !== admin.name))) return { ok: false, problem: 'Writer cache coordinator conflicts with the admin Worker.' };
  const edits: D1ConfigEdit[] = [{ path: ['main'], value: writerEntry }, { path: ['vars', `${prefix}_ENABLED`], value: enabled ? 'true' : 'false' }];
  if (enabled) {
    edits.push({ path: ['vars', `${prefix}_GENERATION`], value: admin.vars?.[`${prefix}_GENERATION`] });
    edits.push({ path: ['vars', `${prefix}_READS_ENABLED`], value: admin.vars?.[`${prefix}_READS_ENABLED`] });
    edits.push({ path: ['vars', `${prefix}_DATABASE_IDS`], value: JSON.stringify(Object.fromEntries(databases.map(({ binding, database_id }) => [binding, database_id]))) });
    edits.push({ path: ['vars', `${prefix}_LOCATION_HINT`], value: admin.vars?.[`${prefix}_LOCATION_HINT`] });
    if (!coordinator) edits.push({ path: ['durable_objects', 'bindings'], value: [...bindings, { name: `${prefix}_COORDINATOR`, class_name: profile.coordinatorClass, script_name: admin.name }] });
  }
  return { ok: true, edits };
}

export function applyD1ConfigEdits(config: D1WorkerConfig, edits: readonly D1ConfigEdit[]): void {
  for (const { path, value } of edits) {
    let node: object = config;
    for (const key of path.slice(0, -1)) {
      let child: unknown = Reflect.get(node, key);
      if (!child || typeof child !== 'object') { child = {}; Reflect.set(node, key, child); }
      if (typeof child !== 'object' || child === null) throw new Error('Invalid configuration path');
      node = child;
    }
    const last = path.at(-1);
    if (!last) throw new Error('Invalid configuration path');
    if (value === undefined) Reflect.deleteProperty(node, last); else Reflect.set(node, last, value);
  }
}
