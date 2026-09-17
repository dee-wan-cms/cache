export const WRITE_PATH_ATTEMPTS = 3;
export const MAX_COORDINATOR_NAME_LENGTH = 256;

export const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const;

export type CoordinatorLocationHint = (typeof LOCATION_HINTS)[number];

export interface DurableObjectStoreOptions {
  attempts?: number;
  locationHint?: CoordinatorLocationHint;
  name: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedStoreOptions {
  attempts: number;
  locationHint?: CoordinatorLocationHint;
  name: string;
  sleep: (ms: number) => Promise<void>;
}

const isLocationHint = (value: unknown): value is CoordinatorLocationHint =>
  LOCATION_HINTS.some((hint) => hint === value);

export function resolveStoreOptions(options: DurableObjectStoreOptions): ResolvedStoreOptions {
  const { attempts = WRITE_PATH_ATTEMPTS, locationHint, name } = options;
  const problems = [
    !(typeof name === "string" && name.length > 0 && name.length <= MAX_COORDINATOR_NAME_LENGTH) &&
      `name must be 1..${MAX_COORDINATOR_NAME_LENGTH} characters and identify one D1 database`,
    !(Number.isInteger(attempts) && attempts >= 1 && attempts <= 10) && "attempts must be an integer in 1..10",
    locationHint !== undefined && !isLocationHint(locationHint) && `locationHint must be one of ${LOCATION_HINTS.join(", ")}`,
  ].filter((problem): problem is string => typeof problem === "string");
  if (problems.length > 0) throw new TypeError(`cache store: ${problems.join("; ")}`);
  return {
    attempts,
    name,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    ...(locationHint ? { locationHint } : {}),
  };
}
