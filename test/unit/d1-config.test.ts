import { describe, expect, it } from 'vitest';
import { applyD1ConfigEdits, d1CachePairProblem, d1CacheProblem, d1WriterCacheEdits, refreshD1CacheDatabaseIds } from '../../src/d1/config';
import type { D1CacheProfile } from '../../src/d1/profile';

const profile: D1CacheProfile = { envPrefix: 'APP_CACHE', bindingNames: ['DB'], bindingPrefixes: ['TENANT_'], coordinatorNamePrefix: 'app:', coordinatorClass: 'CacheCoordinator', readModels: ['catalogue'], unfencedWriteTables: ['heartbeat'] };
const id = '00000000-0000-0000-0000-000000000000';
const admin = { name: 'admin', vars: { APP_CACHE_ENABLED: 'true', APP_CACHE_GENERATION: '1', APP_CACHE_DATABASE_IDS: JSON.stringify({ DB: id }) }, d1_databases: [{ binding: 'DB', database_id: id }], durable_objects: { bindings: [{ name: 'APP_CACHE_COORDINATOR', class_name: 'CacheCoordinator' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['CacheCoordinator'] }] };
const writer = { main: 'writer.ts', vars: { ...admin.vars }, d1_databases: admin.d1_databases, durable_objects: { bindings: [{ name: 'APP_CACHE_COORDINATOR', class_name: 'CacheCoordinator', script_name: 'admin' }] } };
describe('generic D1 writer configuration', () => {
  it('derives the binding map from current physical D1 ids', () => {
    const config = { ...admin, vars: { ...admin.vars }, d1_databases: [...admin.d1_databases, { binding: 'TENANT_a', database_id: id }] };
    refreshD1CacheDatabaseIds(config, profile);
    expect(JSON.parse(config.vars.APP_CACHE_DATABASE_IDS)).toEqual({ DB: id, TENANT_a: id });
    config.d1_databases.pop(); refreshD1CacheDatabaseIds(config, profile);
    expect(JSON.parse(config.vars.APP_CACHE_DATABASE_IDS)).toEqual({ DB: id });
  });
  it('validates both writers and permits a staged read rollout', () => {
    expect(d1CacheProblem(admin, profile)).toBeNull();
    expect(d1CachePairProblem(admin, writer, profile, 'writer.ts')).toBeNull();
    expect(d1CachePairProblem(admin, { ...writer, vars: { ...writer.vars, APP_CACHE_READS_ENABLED: 'false' } }, profile, 'writer.ts')).toBeNull();
    expect(d1CacheProblem({ ...admin, vars: { ...admin.vars, APP_CACHE_DATABASE_IDS: '{}' } }, profile)).toMatch(/differs/);
    expect(d1CacheProblem({ ...admin, vars: { ...admin.vars, APP_CACHE_READS_ENABLED: 'invalid' } }, profile)).toMatch(/READS_ENABLED/);
    expect(d1CacheProblem({ ...admin, vars: { ...admin.vars, APP_CACHE_GENERATION: 'x'.repeat(257) } }, profile)).toMatch(/generation/);
    expect(d1CacheProblem({ ...admin, vars: { ...admin.vars, APP_CACHE_LOCATION_HINT: 'mars' } }, profile)).toMatch(/location/);
    expect(d1CacheProblem({ ...admin, durable_objects: { bindings: [{ ...admin.durable_objects.bindings[0]!, environment: 'preview' }] } }, profile)).toMatch(/coordinator/);
    expect(d1CacheProblem({ ...admin, durable_objects: { bindings: [admin.durable_objects.bindings[0]!, admin.durable_objects.bindings[0]!] } }, profile)).toMatch(/coordinator/);
    expect(d1CachePairProblem(admin, { ...writer, vars: { ...writer.vars, APP_CACHE_ENABLED: 'false' } }, profile, 'writer.ts')).toMatch(/together/);
    expect(d1CachePairProblem({ ...admin, vars: { ...admin.vars, APP_CACHE_ENABLED: 'false' } }, writer, profile, 'writer.ts')).toMatch(/together/);
    expect(d1CachePairProblem(admin, { ...writer, vars: { ...writer.vars, APP_CACHE_GENERATION: '2' } }, profile, 'writer.ts')).toMatch(/generation/);
  });
  it('reconciles only cache writer settings and rejects incompatible bindings', () => {
    const existing = { name: 'my-writer', main: 'old.ts', vars: { CUSTOM: 'retained' }, d1_databases: admin.d1_databases, durable_objects: { bindings: [{ name: 'OTHER', class_name: 'Other' }] } };
    const result = d1WriterCacheEdits({ ...admin, vars: { ...admin.vars, APP_CACHE_READS_ENABLED: 'false' } }, existing, profile, 'writer.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.problem);
    applyD1ConfigEdits(existing, result.edits);
    expect(existing).toMatchObject({ name: 'my-writer', main: 'writer.ts', vars: { CUSTOM: 'retained', APP_CACHE_READS_ENABLED: 'false', APP_CACHE_DATABASE_IDS: JSON.stringify({ DB: id }) }, durable_objects: { bindings: [{ name: 'OTHER', class_name: 'Other' }, { name: 'APP_CACHE_COORDINATOR', class_name: 'CacheCoordinator', script_name: 'admin' }] } });
    expect(d1WriterCacheEdits(admin, { ...existing, d1_databases: [{ binding: 'DB', database_id: 'other' }] }, profile, 'writer.ts').ok).toBe(false);
  });

});
