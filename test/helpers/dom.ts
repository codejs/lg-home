/**
 * Browser-like globals (happy-dom) for React component tests.
 * Import FIRST: @testing-library binds `screen` to document.body on import.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { after } from "node:test";
import { FakeEventSource } from "./event-source.js";

GlobalRegistrator.register({ url: "http://localhost:5173/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

after(() => GlobalRegistrator.unregister());

// Neither happy-dom nor Node has EventSource, which the signed-in app uses for
// live device events: install a controllable fake that never connects.
const globals = globalThis as { EventSource?: unknown };
globals.EventSource ??= FakeEventSource;

/*
 * DOM-safe assertions. Never hand DOM nodes to node:assert: when an assertion
 * fails, Node pretty-prints the values, and walking a happy-dom node's object
 * graph effectively never finishes — the test run hangs instead of failing.
 * These helpers report a short HTML snippet instead.
 */
function describeNode(node: Element | null): string {
  return node ? node.outerHTML.replace(/\s+/g, " ").slice(0, 300) : "nothing";
}

/** Fail unless the query matched nothing. */
export function assertAbsent(node: Element | null, what: string): void {
  if (node !== null) throw new Error(`expected no ${what}, but found: ${describeNode(node)}`);
}

/** Fail unless both refer to the same element (or both are null). */
export function assertSameNode(actual: Element | null, expected: Element | null, what: string): void {
  if (actual !== expected) throw new Error(`${what}: got ${describeNode(actual)}, expected ${describeNode(expected)}`);
}
