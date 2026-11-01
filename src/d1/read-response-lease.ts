import { d1CacheRuntime } from './env';
import { isD1BindingName, type D1CacheProfile } from './profile';
import { createReadResponseLease } from '../response-lease';

export { limitReadResponseLeaseUntil as limitD1ReadLeaseUntil, wrapReadResponseLeaseOrigin as wrapD1ReadLeaseOrigin, forwardReadLease as forwardD1ReadLease } from '../response-lease';

export function wrapD1ReadResponseLease<Env extends object, Context>(handler: (request: Request, env: Env, context: Context) => Promise<Response>, profile: D1CacheProfile): (request: Request, env: Env, context: Context) => Promise<Response> {
  return createReadResponseLease(handler, (env) => {
    const config = profile.readResponseLease;
    if (!config) return null;
    const rawSeconds: unknown = Reflect.get(env, `${profile.envPrefix}_READ_ACCESS_SECONDS`);
    const seconds = typeof rawSeconds === 'string' && /^(?:0|[1-9]\d{0,2})$/.test(rawSeconds) ? Number(rawSeconds) : 0;
    const release: unknown = Reflect.get(env, config.deploymentEnv);
    const database: unknown = Reflect.get(env, config.databaseBinding);
    const runtime = database && typeof database === 'object' ? d1CacheRuntime(database) : undefined;
    if (!isD1BindingName(config.databaseBinding, profile) || typeof release !== 'string' || !release.trim() || !runtime?.readsEnabled || !runtime.regionalIdentity) return null;
    return { config, seconds, identity: () => {
      const identities: unknown[] = [];
      for (const [name, value] of Object.entries(env)) {
        if (!isD1BindingName(name, profile)) continue;
        const dependency = value && typeof value === 'object' ? d1CacheRuntime(value) : undefined;
        if (!dependency?.readsEnabled || !dependency.regionalIdentity) return null;
        identities.push([name, dependency.databaseId, dependency.generation, dependency.coordinatorName, dependency.regionalIdentity]);
      }
      identities.sort((a, b) => String(a).localeCompare(String(b)));
      return ['d1-response-lease-v2', profile, release, identities];
    } };
  });
}
