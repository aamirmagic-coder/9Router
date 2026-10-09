import { isModelAllowed } from "../open-sse/config/modelPolicy.js";
const cases = [
  ["routerai","deepseek/deepseek-v4-flash-0731",true],
  ["routerai","deepseek/deepseek-v4-flash",true],
  ["routerai","rai-img-2","false"],["routerai","black-forest-labs/flux.2-klein-4b","false"],
  ["routerai","gpt-4o","false"],["openai-compatible-chat-fa3cc1b2-47e9-47b3-ad53-973b5862ef90","deepseek/deepseek-v4-flash-0731",true],
  ["openai-compatible-chat-fa3cc1b2-47e9-47b3-ad53-973b5862ef90","rai-img-2",false],
  ["opencode","space-bunny-free",true],
  ["opencode","mimo-v2.6-flash-free",true],
  ["opencode","north-mini-code-free",true],
  ["z-ai","glm-5.2-free",true],
  ["openrouter","deepseek/deepseek-v3.2:free",true],
  ["openrouter","gpt-4o",false],
  ["ollama","qwen2.5-coder:14b",true],
  ["ollama-cloud","gemma4:31b-cloud",true],
  ["claude","claude-opus-4-6",true],
  ["codex","gpt-5",true],
  ["gemini-cli","gemini-2.5-pro",true],
];
let fail=0;
for (const [p,m,want] of cases) {
  const got = isModelAllowed(p,m);
  const w = want === "false" ? false : want;
  const ok = got === w;
  if(!ok) fail++;
  console.log(`${ok?"ok ":"FAIL"} ${p}/${m} -> ${got} (want ${w})`);
}
console.log(fail===0 ? "\nALL PASS" : `\n${fail} FAILED`);
if (fail) process.exit(1);

