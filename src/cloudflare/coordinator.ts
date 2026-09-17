import { DurableObject } from "cloudflare:workers";

import type {
  BeginWriteRequest,
  EndWriteRequest,
  ReadRequest,
  ReadResponse,
  ReleaseRequest,
  WriteRequest,
  WriteResult,
} from "../core/types";

import { type CoordinatorCore, createCoordinatorCore, migrate, type Transact } from "./coordinator-core";

export class CacheCoordinator<Env = unknown> extends DurableObject<Env> {
  private readonly core: CoordinatorCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transact: Transact = (run) => ctx.storage.transactionSync(run);
    migrate(ctx.storage.sql, transact);
    this.core = createCoordinatorCore(ctx.storage.sql, () => crypto.randomUUID(), transact);
  }

  read(request: ReadRequest): ReadResponse {
    return this.core.read(request, Date.now());
  }

  write(request: WriteRequest): WriteResult {
    return this.core.write(request, Date.now());
  }

  release(request: ReleaseRequest): void {
    this.core.release(request);
  }

  beginWrite(request: BeginWriteRequest): void {
    this.core.beginWrite(request, Date.now());
  }

  endWrite(request: EndWriteRequest): void {
    this.core.endWrite(request, Date.now());
  }

  invalidate(fences: string[]): void {
    this.core.invalidate(fences, Date.now());
  }
}
