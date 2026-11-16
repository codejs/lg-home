import { assertAbsent, assertSameNode } from "../../helpers/dom.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginPage } from "../../../src/web/LoginPage.js";
import { deferred, installFetch, json, type FetchHandler } from "../../helpers/fetch.js";

function renderLogin(loginHandler: FetchHandler) {
  const fetchStub = installFetch({ "POST /api/auth/login": loginHandler });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={queryClient}>
      <LoginPage />
    </QueryClientProvider>,
  );
  return {
    fetchStub,
    queryClient,
    user: userEvent.setup(),
    username: screen.getByLabelText("Username") as HTMLInputElement,
    password: screen.getByLabelText("Password") as HTMLInputElement,
    submit: screen.getByRole("button", { name: /sign in/i }) as HTMLButtonElement,
  };
}

describe("LoginPage", () => {
  let restore: (() => void) | undefined;
  beforeEach(() => (restore = undefined));
  afterEach(() => {
    cleanup();
    restore?.();
  });

  it("renders a proper credentials form", () => {
    const { username, password, fetchStub } = renderLogin(() => json(200, {}));
    restore = fetchStub.restore;
    assert.equal(password.type, "password", "password is masked");
    assert.equal(password.autocomplete, "current-password");
    assert.equal(username.autocomplete, "username");
    assertSameNode(document.activeElement, username, "focused element");
    assertAbsent(screen.queryByRole("alert"), "no error initially");
  });

  it("keeps the button disabled until both fields are filled", async () => {
    const { user, username, password, submit, fetchStub } = renderLogin(() => json(200, {}));
    restore = fetchStub.restore;
    assert.equal(submit.disabled, true);
    await user.type(username, "alice");
    assert.equal(submit.disabled, true);
    await user.type(password, "x");
    assert.equal(submit.disabled, false);
    await user.clear(username);
    assert.equal(submit.disabled, true);
  });

  it("does not submit with Enter while a field is empty", async () => {
    const { user, username, fetchStub } = renderLogin(() => json(200, {}));
    restore = fetchStub.restore;
    await user.type(username, "alice{Enter}");
    assert.equal(fetchStub.calls.length, 0);
  });

  it("submits the credentials exactly as typed", async () => {
    const { user, username, password, submit, fetchStub } = renderLogin(() =>
      json(200, { user: { id: 1, username: "alice" } }),
    );
    restore = fetchStub.restore;
    await user.type(username, "Alice");
    await user.type(password, " pass word ");
    await user.click(submit);
    await waitFor(() => assert.equal(fetchStub.calls.length, 1));
    assert.deepEqual(fetchStub.calls[0].body, { username: "Alice", password: " pass word " });
  });

  it("submits with the Enter key", async () => {
    const { user, username, password, fetchStub } = renderLogin(() => json(200, { user: { id: 1, username: "a" } }));
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "secret123{Enter}");
    await waitFor(() => assert.equal(fetchStub.calls.length, 1));
  });

  it("shows the server's error message when authentication fails", async () => {
    const { user, username, password, submit, fetchStub, queryClient } = renderLogin(() =>
      json(401, { error: "Invalid username or password" }),
    );
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "wrong-password");
    await user.click(submit);
    const alert = await screen.findByRole("alert");
    assert.equal(alert.textContent, "Invalid username or password");
    assert.equal(queryClient.getQueryData(["me"]), undefined, "not signed in");
    assert.equal(username.disabled, false, "form usable again");
    assert.equal(submit.disabled, false);
  });

  it("shows the rate-limit message", async () => {
    const { user, username, password, submit, fetchStub } = renderLogin(() =>
      json(429, { error: "Too many failed attempts. Try again later." }),
    );
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "whatever1");
    await user.click(submit);
    assert.match((await screen.findByRole("alert")).textContent ?? "", /Too many failed attempts/);
  });

  it("shows network failures", async () => {
    const { user, username, password, submit, fetchStub } = renderLogin(() => {
      throw new TypeError("Failed to fetch");
    });
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "secret123");
    await user.click(submit);
    assert.match((await screen.findByRole("alert")).textContent ?? "", /Failed to fetch/);
  });

  it("renders error messages as text, never as HTML (XSS)", async () => {
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    const { user, username, password, submit, fetchStub } = renderLogin(() => json(401, { error: payload }));
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "secret123");
    await user.click(submit);
    const alert = await screen.findByRole("alert");
    assert.equal(alert.textContent, payload);
    assertAbsent(alert.querySelector("img, script"), "HTML elements inside the alert");
    assert.equal((window as { __xss?: number }).__xss, undefined);
  });

  it("disables the form while signing in and ignores repeated submits", async () => {
    const pending = deferred<Response>();
    const { user, username, password, submit, fetchStub } = renderLogin(() => pending.promise);
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "secret123");
    await user.click(submit);
    await waitFor(() => assert.equal(submit.textContent, "Signing in…"));
    assert.equal(submit.disabled, true);
    assert.equal(username.disabled, true);
    assert.equal(password.disabled, true);
    await user.click(submit);
    await user.keyboard("{Enter}");
    assert.equal(fetchStub.calls.length, 1, "only one request in flight");
    pending.resolve(json(200, { user: { id: 1, username: "alice" } }));
    await waitFor(() => assert.equal(submit.textContent, "Sign in"));
  });

  it("on success hands the user to the app and forgets the password", async () => {
    const { user, username, password, submit, fetchStub, queryClient } = renderLogin(() =>
      json(200, { user: { id: 7, username: "alice" } }),
    );
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "secret123");
    await user.click(submit);
    await waitFor(() => assert.deepEqual(queryClient.getQueryData(["me"]), { id: 7, username: "alice" }));
    assert.equal(password.value, "", "password cleared from component state");
  });

  it("clears a previous error when retrying", async () => {
    let attempt = 0;
    const { user, username, password, submit, fetchStub } = renderLogin(() =>
      ++attempt === 1 ? json(401, { error: "Invalid username or password" }) : json(200, { user: { id: 1, username: "alice" } }),
    );
    restore = fetchStub.restore;
    await user.type(username, "alice");
    await user.type(password, "wrong-one");
    await user.click(submit);
    await screen.findByRole("alert");
    await user.clear(password);
    await user.type(password, "secret123");
    await user.click(submit);
    await waitFor(() => assertAbsent(screen.queryByRole("alert"), "error alert"));
  });
});
