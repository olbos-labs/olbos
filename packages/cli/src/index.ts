#!/usr/bin/env node
/**
 * `olbos init` — the setup ceremony. The ONE human moment: create the agent
 * identity, pick a risk posture, deploy, hand the keys to the agent.
 * Everything after this is autonomous.
 */
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import { createOlbos, usdc } from "@olbos/sdk";

const [cmd] = process.argv.slice(2);
if (cmd !== "init") {
  console.log("usage: olbos init");
  process.exit(1);
}

// interactive TTY → readline; piped stdin (CI/tests) → consume all answers upfront
const rl = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : null;
const piped: string[] = rl
  ? []
  : (await new Promise<string>((res) => {
      let buf = "";
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => res(buf));
    })).split("\n");
const ask = async (q: string, def: string): Promise<string> => {
  if (rl) return (await rl.question(`${q} [${def}]: `)).trim() || def;
  const answer = (piped.shift() ?? "").trim() || def;
  console.log(`${q} [${def}]: ${answer}`);
  return answer;
};

console.log(`
  ◈ OLBOS — autonomous treasury setup
    One ceremony, then your agent is on its own.
`);

// 1. agent identity
const keyDir = resolve(await ask("where should the agent keypair live?", "./olbos-keys"));
mkdirSync(keyDir, { recursive: true });
const keyPath = join(keyDir, "agent.keypair.json");
let agent: Keypair;
if (existsSync(keyPath)) {
  agent = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  console.log(`  ✓ existing agent identity: ${agent.publicKey.toBase58()}`);
} else {
  agent = Keypair.generate();
  writeFileSync(keyPath, JSON.stringify(Array.from(agent.secretKey)));
  console.log(`  ✓ new agent identity:      ${agent.publicKey.toBase58()}`);
  console.log(`    (keypair at ${keyPath} — keep it out of git)`);
}

// 2. environment
const mode = await ask("environment — localnet or devnet?", "localnet");
const api = await ask("Olbos API url?", "http://localhost:4020");

// 3. risk posture (owner-set; the agent cannot widen this later)
console.log(`
  risk posture (owner-set, engine-enforced — the agent can never widen it):
    conservative  50% max/venue · 20% liquid buffer · move on +1.00%
    balanced      70% max/venue · 10% liquid buffer · move on +0.50%
    aggressive   100% max/venue ·  5% liquid buffer · move on +0.25%
`);
const template = (await ask("template?", "balanced")) as
  | "conservative"
  | "balanced"
  | "aggressive";
const name = await ask("strategy name?", "my-treasury");

// 4. deploy
const olbos = createOlbos({
  baseUrl: api,
  payment:
    mode === "devnet"
      ? { mode: "x402", keypair: agent }
      : { mode: "dev", payer: agent.publicKey.toBase58() },
});
process.stdout.write(`\n  deploying '${name}' (${template})… `);
const dep = await olbos.deployStrategy({ template, name });
console.log(`✓ ${dep.strategyId}`);

// 5. config + handoff
const config = {
  api,
  mode,
  strategyId: dep.strategyId,
  agentKeypair: keyPath,
  agentAddress: agent.publicKey.toBase58(),
};
writeFileSync("olbos.config.json", JSON.stringify(config, null, 2));

console.log(`
  ── done. your agent takes it from here ──────────────────────

  config:        ./olbos.config.json
  strategy:      ${dep.strategyId}
  ${
    mode === "devnet"
      ? `fund agent:    devnet USDC → ${agent.publicKey.toBase58()}
                 (https://faucet.circle.com, network "Solana Devnet")`
      : `fund strategy: olbos.fund("${dep.strategyId}", usdc(5000))`
  }

  give your agent the SDK:
    const olbos = createOlbos({ baseUrl: "${api}", payment: { mode: "${mode === "devnet" ? "x402" : "dev"}", … } })

  or give Claude the MCP server:
    claude mcp add olbos ${mode === "devnet" ? `-e OLBOS_PAYMENT=x402 -e OLBOS_AGENT_KEYPAIR=${keyPath} ` : ""}-- npx tsx packages/mcp/src/index.ts

  break-glass stays with YOU (owner token / kill switch) — agents pay, owners sign.
`);
rl?.close();

// touch usdc so the snippet above is honest about the import surface
void usdc;
