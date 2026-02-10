import { AsyncLocalStorage } from "async_hooks";

interface RequestContext {
  arkeToken: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getArkeToken(): string | null {
  const ctx = requestContext.getStore();
  return ctx?.arkeToken ?? null;
}
