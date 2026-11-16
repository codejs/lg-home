import type { ReactElement } from "react";

/** Minimal line icons per appliance family (24×24, drawn with currentColor). */

type Family = "fridge" | "dishwasher" | "laundry" | "air" | "cooking" | "robot" | "generic";

export function deviceFamily(type: string): Family {
  if (/REFRIGERATOR|WINE_CELLAR/.test(type)) return "fridge";
  if (/DISH_WASHER/.test(type)) return "dishwasher";
  if (/WASH|DRYER|STYLER/.test(type)) return "laundry";
  if (/AIR|FAN|HUMIDIFIER|BOILER|WATER_HEATER/.test(type)) return "air";
  if (/OVEN|COOKTOP|HOOD|MICROWAVE/.test(type)) return "cooking";
  if (/CLEANER/.test(type)) return "robot";
  return "generic";
}

const PATHS: Record<Family, ReactElement> = {
  fridge: (
    <>
      <rect x="5" y="2.5" width="14" height="19" rx="2" />
      <path d="M5 9.5h14M8 5.5v2M8 12.5v4" />
    </>
  ),
  dishwasher: (
    <>
      <rect x="4" y="2.5" width="16" height="19" rx="2" />
      <path d="M4 7h16M8 12h8" />
      <circle cx="7.5" cy="4.8" r=".6" />
      <circle cx="10" cy="4.8" r=".6" />
    </>
  ),
  laundry: (
    <>
      <rect x="4" y="2.5" width="16" height="19" rx="2" />
      <path d="M4 6.5h16" />
      <circle cx="12" cy="14" r="4.5" />
      <circle cx="7" cy="4.5" r=".6" />
    </>
  ),
  air: (
    <>
      <rect x="2.5" y="4" width="19" height="8" rx="2" />
      <path d="M5.5 9h13M7 15.5c0 1.5 1 2 1 3.5M12 15.5v4M17 15.5c0 1.5-1 2-1 3.5" />
    </>
  ),
  cooking: (
    <>
      <rect x="3.5" y="3" width="17" height="18" rx="2" />
      <path d="M3.5 7.5h17" />
      <rect x="7" y="10.5" width="10" height="7" rx="1" />
      <circle cx="7" cy="5.3" r=".6" />
      <circle cx="10" cy="5.3" r=".6" />
    </>
  ),
  robot: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
      <path d="M6.5 7.5h11" />
    </>
  ),
  generic: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M12 8v4" />
      <path d="M9 9.5a4 4 0 1 0 6 0" />
    </>
  ),
};

export function DeviceIcon({ type }: { type: string }) {
  const family = deviceFamily(type);
  return (
    <svg
      className="device-icon"
      data-family={family}
      viewBox="0 0 24 24"
      width="28"
      height="28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[family]}
    </svg>
  );
}
