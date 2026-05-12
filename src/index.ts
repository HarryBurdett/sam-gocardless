/**
 * gocardless — SAM plugin entry point.
 *
 * Faithful TypeScript port of the Python `apps/gocardless/` app.
 *
 * SAM loads plugins via `import()` and calls the default export with
 * an AppContext. We return an Express Router that SAM mounts under
 * `/api/apps/gocardless/*`.
 */
import { createRouter } from './router.js';
import type { AppContext, AppBackendFactory } from './app-context.js';

const factory: AppBackendFactory = (ctx: AppContext) => {
  ctx.logger.info(`gocardless plugin loaded for tenant ${ctx.tenantId}`);
  return createRouter(ctx);
};

export default factory;
