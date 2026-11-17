/**
 * How the app shows times: always in the user's locale (the browser's
 * preferred languages), so cards, events and subscriptions agree, e.g.
 * "2:05 PM" for en-US and "14:05" for en-GB or de-DE. Two lengths:
 *   - formatClock: hours and minutes, on the device cards ("Updated 2:05 PM",
 *     "ends ~3:30 PM");
 *   - formatTimestamp: with seconds for today and the date otherwise, for
 *     events and subscriptions.
 * Every function takes optional `locales` (mainly for tests); the default is
 * the browser's.
 */

export type Locales = readonly string[] | undefined;

/** The browser's preferred languages, most preferred first (undefined: the runtime's default). */
export function userLocales(): Locales {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.languages?.length) return nav.languages;
  return nav?.language ? [nav.language] : undefined;
}

const mutable = (locales: Locales) => (locales ? [...locales] : undefined);

/** "2:05 PM" / "14:05" */
export function formatClock(time: Date | number, locales: Locales = userLocales()): string {
  return new Date(time).toLocaleTimeString(mutable(locales), { hour: "numeric", minute: "2-digit" });
}

/** A compact local date/time, with the date left out for today: "2:05:07 PM" / "Dec 30, 2025, 9:05 AM". */
export function formatTimestamp(iso: string, now = new Date(), locales: Locales = userLocales()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(mutable(locales), { hour: "numeric", minute: "2-digit", second: "2-digit" })
    : date.toLocaleString(mutable(locales), { dateStyle: "medium", timeStyle: "short" });
}

/** The full local date and time, e.g. for a tooltip. */
export function formatFullTimestamp(iso: string, locales: Locales = userLocales()): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(mutable(locales));
}
