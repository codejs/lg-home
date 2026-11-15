import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { setUnauthorizedHandler } from "./api";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// A 401 from any API call means the session ended: clear cached data so the
// app falls back to the login page.
setUnauthorizedHandler(() => {
  queryClient.setQueryData(["me"], null);
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "me" });
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
