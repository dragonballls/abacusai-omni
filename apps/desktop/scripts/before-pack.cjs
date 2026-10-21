const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = () => {
  execFileSync(
    process.execPath,
    [path.join(__dirname, "check-release-build.mjs")],
    { stdio: "inherit" }
  );
  execFileSync(
    process.execPath,
    [path.join(__dirname, "../../../scripts/prepare-gods-eye-runtime.mjs")],
    {
      stdio: "inherit",
      env: { ...process.env, ABACUS_GODS_EYE_PACKAGE: "1" },
    }
  );
  execFileSync(
    process.execPath,
    [path.join(__dirname, "generate-notices.js")],
    {
      stdio: "inherit",
    }
  );
};
