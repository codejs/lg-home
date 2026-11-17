import { assertAbsent } from "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { App } from "../../../src/web/App.js";
import { createQueryClient } from "../../../src/web/queryClient.js";
import { queryKeys } from "../../../src/web/queries.js";
import { NO_SUBSCRIPTIONS } from "../../helpers/fake-backend.js";
import { deferred, installFetch, json, type FetchHandler } from "../../helpers/fetch.js";

const ALICE = { id: 1, username: "alice" };
const DEVICES = [{ id: "d1", type: "DEVICE_REFRIGERATOR", alias: "Kitchen Fridge", modelName: null, reportable: true, updatedAt: "" }];

let restore: (() => void) | undefined;
let queryClient: QueryClient;

function renderApp(routes: Record<string, FetchHandler>) {
  // Device cards load their own status, and the devices page which devices are
  // watched; answer both unless a test overrides them.
  const fetchStub = installFetch({
    "GET /api/devices/d1/status": () => json(200, {}),
    "GET /api/subscriptions": () => json(200, NO_SUBSCRIPTIONS),
    ...routes,
  });
  restore = fetchStub.restore;
  queryClient = createQueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
  return { fetchStub, user: userEvent.setup() };
}

async function signIn(user: ReturnType<typeof userEvent.setup>, password = "secret123") {
  await user.type(await screen.findByLabelText("Username"), "alice");
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("App (auth gate)", () => {
  afterEach(() => {
    cleanup();
    restore?.();
    queryClient?.clear();
  });

  it("shows a loading state while checking the session", async () => {
    const pending = deferred<Response>();
    renderApp({ "GET /api/auth/me": () => pending.promise });
    assert.ok(screen.getByText("Loading…"));
    assertAbsent(screen.queryByLabelText("Password"), "password field (login page)");
    pending.resolve(json(401, { error: "Authentication required" }));
    await screen.findByLabelText("Password");
  });

  it("shows only the login page when signed out, without touching device APIs", async () => {
    const { fetchStub } = renderApp({ "GET /api/auth/me": () => json(401, { error: "Authentication required" }) });
    await screen.findByLabelText("Password");
    assertAbsent(screen.queryByText("Sync from ThinQ"), "devices page");
    assert.deepEqual(fetchStub.calls.map((c) => c.url), ["/api/auth/me"]);
  });

  it("goes straight to the devices page with a valid session", async () => {
    renderApp({
      "GET /api/auth/me": () => json(200, { user: ALICE }),
      "GET /api/devices": () => json(200, DEVICES),
    });
    await screen.findByText("Kitchen Fridge");
    assert.ok(screen.getByText("alice"));
    assertAbsent(screen.queryByLabelText("Password"), "password field (login page)");
  });

  it("shows an error (not the login form) when the session check itself fails", async () => {
    renderApp({ "GET /api/auth/me": () => json(500, { error: "Internal Server Error" }) });
    assert.ok(await screen.findByText("Internal Server Error"));
    assertAbsent(screen.queryByLabelText("Password"), "password field (login page)");
    assertAbsent(screen.queryByText("Sync from ThinQ"), "devices page");
  });

  it("stays on the login page with an error after a failed login", async () => {
    const { user } = renderApp({
      "GET /api/auth/me": () => json(401, { error: "Authentication required" }),
      "POST /api/auth/login": () => json(401, { error: "Invalid username or password" }),
    });
    await signIn(user, "wrong-password");
    assert.equal((await screen.findByRole("alert")).textContent, "Invalid username or password");
    assertAbsent(screen.queryByText("Sync from ThinQ"), "devices page");
  });

  it("shows the devices page after a successful login", async () => {
    const { user, fetchStub } = renderApp({
      "GET /api/auth/me": () => json(401, { error: "Authentication required" }),
      "POST /api/auth/login": () => json(200, { user: ALICE }),
      "GET /api/devices": () => json(200, DEVICES),
    });
    await signIn(user);
    await screen.findByText("Kitchen Fridge");
    assertAbsent(screen.queryByLabelText("Password"), "password field (login page)");
    assert.ok(!document.body.innerHTML.includes("secret123"), "password not left in the DOM");
    assert.equal(fetchStub.calls.filter((c) => c.url === "/api/auth/me").length, 1, "no redundant session re-check");
  });

  it("signs out: back to the login page with cached data dropped", async () => {
    const { user } = renderApp({
      "GET /api/auth/me": () => json(200, { user: ALICE }),
      "GET /api/devices": () => json(200, DEVICES),
      "POST /api/auth/logout": () => json(200, { ok: true }),
    });
    await screen.findByText("Kitchen Fridge");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Password");
    assert.equal(queryClient.getQueryData(queryKeys.devices), undefined, "device data not kept for the next user");
    assertAbsent(screen.queryByText("Kitchen Fridge"), "stale device card");
  });

  it("signs out locally even if the logout request fails", async () => {
    const { user } = renderApp({
      "GET /api/auth/me": () => json(200, { user: ALICE }),
      "GET /api/devices": () => json(200, DEVICES),
      "POST /api/auth/logout": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await screen.findByText("Kitchen Fridge");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByLabelText("Password");
  });

  it("returns to the login page when the session expires mid-use", async () => {
    let expired = false;
    const { user } = renderApp({
      "GET /api/auth/me": () => json(200, { user: ALICE }),
      "GET /api/devices": () => json(200, DEVICES),
      "POST /api/devices/sync": () => {
        expired = true;
        return json(401, { error: "Authentication required" });
      },
    });
    await screen.findByText("Kitchen Fridge");
    await user.click(screen.getByRole("button", { name: "Sync from ThinQ" }));
    await screen.findByLabelText("Password");
    assert.ok(expired);
    assert.equal(queryClient.getQueryData(queryKeys.devices), undefined);
  });

  it("a different user signing in afterwards sees only their own name", async () => {
    let who = ALICE;
    const { user } = renderApp({
      "GET /api/auth/me": () => json(200, { user: who }),
      "GET /api/devices": () => json(200, DEVICES),
      "POST /api/auth/logout": () => json(200, { ok: true }),
      "POST /api/auth/login": () => json(200, { user: (who = { id: 2, username: "bob" }) }),
    });
    await screen.findByText("alice");
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.type(await screen.findByLabelText("Username"), "bob");
    await user.type(screen.getByLabelText("Password"), "secret456");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await screen.findByText("bob");
    await waitFor(() => assertAbsent(screen.queryByText("alice"), "previous user's name"));
  });
});
