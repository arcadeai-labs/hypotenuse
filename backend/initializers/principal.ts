import { api, Initializer } from "keryx";
import { resolvePrincipal } from "../middleware/session";

const namespace = "principal";

/**
 * Register the `beforeAct` hook that resolves who each request is — a session,
 * a CLI token, or nobody — before any action middleware runs. See
 * `resolvePrincipal` in `middleware/session.ts`.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`.
 */
export class Principal extends Initializer {
  constructor() {
    super(namespace);
    this.declaresAPIProperty = false;
  }

  /** Register the hook. */
  async initialize(): Promise<void> {
    api.hooks.actions.beforeAct(resolvePrincipal);
  }
}
