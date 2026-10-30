export interface D1WritePolicy {
  unfencedWriteTables: readonly string[];
}

export interface D1CacheProfile extends D1WritePolicy {
  readModels: readonly string[];
  envPrefix: string;
  bindingNames: readonly string[];
  bindingPrefixes: readonly string[];
  coordinatorNamePrefix: string;
  coordinatorClass: string;
  readResponseLease?: {
    databaseBinding: string;
    deploymentEnv: string;
    paths: readonly string[];
    credentialHeaders: readonly string[];
    varyHeaders: readonly string[];
    bypassQueryParams?: readonly string[];
    freshnessCookie: string;
  };
}

export const isD1BindingName = (key: string, profile: D1CacheProfile): boolean =>
  profile.bindingNames.includes(key) || profile.bindingPrefixes.some((prefix) => key.startsWith(prefix) && /^[A-Za-z0-9_]{1,48}$/.test(key.slice(prefix.length)));
