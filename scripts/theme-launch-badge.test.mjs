import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/app/page.tsx", "utf8");
const layout = readFileSync("src/app/layout.tsx", "utf8");
const providers = readFileSync("src/components/providers.tsx", "utf8");
const globals = readFileSync("src/app/globals.css", "utf8");
const removedLaunchBadgePattern = new RegExp(["product", "hunt"].join(""), "i");

assert.equal(
  removedLaunchBadgePattern.test(page),
  false,
  "home page should not include the removed external launch badge or copy",
);

assert.match(
  layout,
  /data-color-mode="auto"/,
  "root layout should let Primer resolve color mode automatically",
);
assert.match(
  layout,
  /data-light-theme="light"/,
  "root layout should declare the Primer light theme",
);
assert.match(
  layout,
  /data-dark-theme="dark"/,
  "root layout should declare the Primer dark theme",
);

assert.match(
  providers,
  /<ThemeProvider\s+colorMode="auto"\s+dayScheme="light"\s+nightScheme="dark">/,
  "Primer ThemeProvider should track the client's system color preference",
);

assert.match(
  globals,
  /themes\/light\.css/,
  "global styles should include Primer light tokens",
);
assert.match(
  globals,
  /themes\/dark\.css/,
  "global styles should include Primer dark tokens for prefers-color-scheme: dark",
);
