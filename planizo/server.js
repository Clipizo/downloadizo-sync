process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning && warning.name === "ExperimentalWarning" && /SQLite/i.test(String(warning.message))) return;
  console.warn(warning && warning.stack ? warning.stack : warning);
});

import("./src/main.js")
  .then(({ main }) => main(process.argv.slice(2)))
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
