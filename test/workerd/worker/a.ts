import { handle, type Env } from "./app";

export { CacheCoordinator } from "../../../dist/cloudflare/index.js";

export default { fetch: handle } satisfies ExportedHandler<Env>;
