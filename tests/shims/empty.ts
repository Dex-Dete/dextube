/**
 * Shim for the `server-only` / `client-only` build guard packages.
 *
 * In a Next.js build these packages make importing server code from a client
 * bundle a hard error. Under Vitest there is no bundler boundary, so the guard
 * resolves to this empty module instead.
 */
export {};
