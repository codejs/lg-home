import { useEffect, useState } from "react";

/**
 * The current tab, kept in the URL hash so reloading and Back work. `fallback`
 * is the tab without a hash; every other tab is `#<tab>`. Switching tabs adds
 * a history entry. Pass a constant `tabs` array.
 */
export function useHashTab<T extends string>(tabs: readonly T[], fallback: T): [T, (next: T) => void] {
  const fromLocation = (): T => {
    const hash = window.location.hash.slice(1);
    return tabs.find((t) => t === hash) ?? fallback;
  };
  const [tab, setTab] = useState<T>(fromLocation);

  useEffect(() => {
    const onPop = () => setTab(fromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // `tabs` and `fallback` are constants: subscribe once.
  }, []);

  const showTab = (next: T) => {
    if (next === tab) return;
    setTab(next);
    const url = next === fallback ? window.location.pathname + window.location.search : `#${next}`;
    window.history.pushState(null, "", url);
  };

  return [tab, showTab];
}
