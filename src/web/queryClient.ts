import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "./api";
import { signOutLocally } from "./queries";

/**
 * The app's query client. A 401 from any API call means the session ended:
 * clear cached data so the app falls back to the login page.
 */
export function createQueryClient(config: QueryClientConfig = {}): QueryClient {
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: { ...config.defaultOptions, queries: { retry: false, ...config.defaultOptions?.queries } },
  });
  setUnauthorizedHandler(() => signOutLocally(queryClient));
  return queryClient;
}
