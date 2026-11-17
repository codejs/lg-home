/**
 * Pretend the browser's preferred languages are `languages` (what the app
 * formats times with, see src/web/time.ts). Works with happy-dom and with
 * Node's own navigator. Returns a function that restores the real ones.
 */
export function setBrowserLanguages(...languages: string[]): () => void {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  const saved = ["languages", "language"].map((key) => [key, Object.getOwnPropertyDescriptor(nav, key)] as const);
  Object.defineProperty(nav, "languages", { value: Object.freeze([...languages]), configurable: true });
  Object.defineProperty(nav, "language", { value: languages[0], configurable: true });
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(nav, key, descriptor);
      else delete nav[key];
    }
  };
}
