import { loadConfig } from "./config.js";
import { runCodexTurn } from "./codexExec.js";
import { startServer } from "./server.js";

function printHelp() {
  console.log(`Usage: node tools/cgw-codex-shim/smoke.js [options]

Options:
  --model <alias>   Configured shim alias (defaults to the first alias)
  --prompt <text>   Single prompt (defaults to CGW_SHIM_SMOKE_PROMPT)
  --help            Show this help

Required environment is documented in tools/cgw-codex-shim/README.md.
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--model") options.model = argv[++index];
    else if (arg === "--prompt") options.prompt = argv[++index];
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const model = options.model || Object.keys(config.modelAliases)[0];
  if (!config.modelAliases[model]) throw new Error(`model alias is not configured: ${model}`);
  const prompt = options.prompt || process.env.CGW_SHIM_SMOKE_PROMPT || "Reply with CGW_SHIM_NATIVE_OK only.";
  const runtime = await startServer({
    config,
    executeTurn: (request) => runCodexTurn({ config, ...request }),
  });

  try {
    const baseUrl = `http://${runtime.address.address}:${runtime.address.port}`;
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || `shim returned HTTP ${response.status}`);
    console.log(JSON.stringify({ ok: true, model, text: body.choices?.[0]?.message?.content || "" }));
  } finally {
    await runtime.close();
  }
}

main().catch((error) => {
  console.error(`smoke failed: ${error.message}`);
  process.exitCode = 1;
});
