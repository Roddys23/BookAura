const fs = require("fs");
const path = require("path");

const swPath = path.resolve(__dirname, "..", "public", "sw.js");
const sw = fs.readFileSync(swPath, "utf8");

const buildVersion = String(Date.now());
const updated = sw.replace(/const APP_VERSION = "[^"]+";/, `const APP_VERSION = "${buildVersion}";`);

if (updated === sw) {
  throw new Error("Could not find APP_VERSION marker in public/sw.js");
}

fs.writeFileSync(swPath, updated, "utf8");
console.log(`Updated Service Worker APP_VERSION=${buildVersion}`);
