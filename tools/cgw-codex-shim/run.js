import { runCodexTurn } from "./codexExec.js";
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

function formatAddress(address) {
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

async function main() {
  const config = loadConfig();
  const runtime = await startServer({
    config,
    executeTurn: (request) => runCodexTurn({ config, ...request }),
  });
  let shutdownPromise;

  const shutdown = () => {
    if (!shutdownPromise) shutdownPromise = runtime.close();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  console.log(`CGW Codex shim listening at ${formatAddress(runtime.address)}`);
}

main().catch((error) => {
  console.error(`cgw-codex-shim failed: ${error.message}`);
  process.exitCode = 1;
});
