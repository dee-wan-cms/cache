import { handle, type Env } from "./app";

export default { fetch: handle } satisfies ExportedHandler<Env>;
