/**
 * Loader setup for the web (React) tests, passed to node with --import:
 * compile TS/TSX with test/web/tsconfig.json (automatic JSX runtime) and give
 * the tests a browser-like DOM (jsdom) as globals.
 */
import { register } from "tsx/esm/api";
import globalJsdom from "global-jsdom";

register({ tsconfig: "./test/web/tsconfig.json" });
globalJsdom(undefined, { url: "http://localhost/" });

// Tell React that tests drive updates through act() (Testing Library does).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
