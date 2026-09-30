// Per-request CSP nonce for the nonce e2e mode (SSR_NONCE=module wires it
// through `start.nonce` in vite.config.ts, next to SSR_MIDDLEWARE=1).
// Server-only: only the generated handler imports it. The recipe from the
// README: the middleware generates the nonce (here it takes the test's
// `x-csp-nonce` header instead, to stay deterministic) and stores it on
// `event.locals`; this module hands it to the handler, which runs it after
// the chain.
import type { RequestEvent } from '@solidjs/web';

export default function nonce(event: RequestEvent): string | undefined {
  const value = event.locals.nonce;
  return typeof value === 'string' ? value : undefined;
}
