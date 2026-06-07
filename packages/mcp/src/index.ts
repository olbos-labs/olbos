#!/usr/bin/env node
/**
 * @olbos/mcp — Olbos as MCP tools. Any LLM agent gets a treasury:
 * "park my idle USDC somewhere safe" → deploy_strategy → 402 paid under
 * the hood → capital working on Solana.
 *
 * Env:
 *   OLBOS_API            (default http://localhost:4020)
 *   OLBOS_PAYMENT        dev | x402            (default dev)
 *   OLBOS_AGENT_KEYPAIR  path to keypair json  (x402 mode)
 *   OLBOS_RPC            Solana RPC            (x402 mode)
 *   OLBOS_OWNER_KEYPAIR  custody-root keypair — enables break-glass tools
 *                        (kill/unkill by wallet signature + on-chain revoke)
 *   OLBOS_OWNER_TOKEN    dev-rail break-glass (localnet only)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createOlbos, usdc, type PaymentMode } from "@olbos/sdk";

async function buildPayment(): Promise<PaymentMode> {
  if (process.env.OLBOS_PAYMENT === "x402") {
    const path = process.env.OLBOS_AGENT_KEYPAIR;
    if (!path) throw new Error("OLBOS_AGENT_KEYPAIR required in x402 mode");
    const { Keypair } = await import("@solana/web3.js");
    const keypair = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))),
    );
    return { mode: "x402", keypair, rpcUrl: process.env.OLBOS_RPC };
  }
  return { mode: "dev", payer: "mcp-agent" };
}

async function loadOwnerKeypair() {
  const path = process.env.OLBOS_OWNER_KEYPAIR;
  if (!path) return undefined;
  const { Keypair } = await import("@solana/web3.js");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

const ownerKeypair = await loadOwnerKeypair();
const olbos = createOlbos({
  baseUrl: process.env.OLBOS_API ?? "http://localhost:4020",
  payment: await buildPayment(),
  ownerToken: process.env.OLBOS_OWNER_TOKEN,
  ownerKeypair,
});

const { version } = createRequire(import.meta.url)("../package.json");
const server = new McpServer({ name: "olbos", version });

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
  isError: true,
});

server.registerTool(
  "get_opportunities",
  {
    title: "List yield opportunities",
    description:
      "Ranked Solana yield venues by net risk-adjusted APY (headline minus costs). Free read.",
  },
  async () => {
    try {
      const r = await olbos.opportunities();
      return json(
        r.opportunities.map((o) => ({
          venue: o.venue,
          netApyPct: o.netApyBps / 100,
          headlineApyPct: o.headlineApyBps / 100,
        })),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "deploy_strategy",
  {
    title: "Deploy a treasury strategy",
    description:
      "Deploy an autonomous yield strategy (paid via x402: 0.10 USDC). Pick a risk template: " +
      "conservative (50% cap/venue, 20% liquid buffer), balanced (70%/10%), aggressive (100%/5%). " +
      "Funds live in a per-strategy Swig smart account: the owner wallet holds root authority, " +
      "the engine holds an on-chain-scoped, revocable role. Returns the strategyId used by all other tools.",
    inputSchema: {
      template: z.enum(["conservative", "balanced", "aggressive"]).default("balanced"),
      name: z.string().max(64).optional().describe("label for this strategy"),
      owner: z
        .string()
        .optional()
        .describe("custody root wallet (base58); defaults to the paying wallet"),
    },
  },
  async ({ template, name, owner }) => {
    try {
      return json(await olbos.deployStrategy({ template, name, owner }));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "fund_strategy",
  {
    title: "Fund a strategy",
    description:
      "Route capital into a strategy. The x402 payment IS the deposit — the engine credits " +
      "the settled amount and the autonomy loop puts it to work within policy.",
    inputSchema: {
      strategyId: z.string(),
      amountUsdc: z.number().positive().describe("amount in USDC, e.g. 5000"),
    },
  },
  async ({ strategyId, amountUsdc }) => {
    try {
      return json(await olbos.fund(strategyId, usdc(amountUsdc)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_positions",
  {
    title: "Get positions",
    description: "Current allocation: liquid wallet balance + per-venue positions. Free read.",
    inputSchema: { strategyId: z.string() },
  },
  async ({ strategyId }) => {
    try {
      const p = await olbos.positions(strategyId);
      return json({
        strategyId: p.strategyId,
        walletLiquidUsdc: Number(p.walletLiquid) / 1e6,
        positionsUsdc: Object.fromEntries(
          Object.entries(p.positions).map(([k, v]) => [k, Number(v) / 1e6]),
        ),
        killSwitchActive: p.killSwitchActive,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_risk_status",
  {
    title: "Get risk status",
    description:
      "Exposure per venue vs policy caps, total managed, kill-switch state. Free read.",
    inputSchema: { strategyId: z.string() },
  },
  async ({ strategyId }) => {
    try {
      return json(await olbos.riskStatus(strategyId));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "trigger_rebalance",
  {
    title: "Trigger a rebalance",
    description:
      "Manually trigger one rebalance cycle (paid: 0.01 USDC). The engine only moves capital " +
      "when net improvement clears the policy threshold — triggering when nothing qualifies is a no-op.",
    inputSchema: { strategyId: z.string() },
  },
  async ({ strategyId }) => {
    try {
      return json(await olbos.rebalance(strategyId));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "withdraw",
  {
    title: "Withdraw liquidity",
    description:
      "Make USDC liquid for the agent to spend (paid: 0.01 USDC). Unwinds lowest-yield " +
      "positions first; honors the strategy's risk policy.",
    inputSchema: {
      strategyId: z.string(),
      amountUsdc: z.number().positive(),
    },
  },
  async ({ strategyId, amountUsdc }) => {
    try {
      return json(await olbos.withdraw(strategyId, usdc(amountUsdc)));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_audit_log",
  {
    title: "Read the audit trail",
    description:
      "Every decision, payment, simulation and on-chain action, replayable. Free read.",
    inputSchema: {
      strategyId: z.string(),
      tail: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ strategyId, tail }) => {
    try {
      const r = await olbos.auditLog(strategyId);
      return json(r.events.slice(-tail));
    } catch (e) {
      return fail(e);
    }
  },
);

// break-glass tools only exist in owner sessions (agents pay, owners sign)
if (ownerKeypair || process.env.OLBOS_OWNER_TOKEN) {
  server.registerTool(
    "kill_strategy",
    {
      title: "KILL SWITCH",
      description:
        "Owner-only break-glass: halt all strategy activity immediately. The engine will " +
        "refuse every action until cleared.",
      inputSchema: { strategyId: z.string() },
    },
    async ({ strategyId }) => {
      try {
        return json(await olbos.kill(strategyId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  server.registerTool(
    "clear_kill_switch",
    {
      title: "Clear kill switch",
      description: "Owner-only: resume strategy activity after a kill.",
      inputSchema: { strategyId: z.string() },
    },
    async ({ strategyId }) => {
      try {
        return json(await olbos.unkill(strategyId));
      } catch (e) {
        return fail(e);
      }
    },
  );
  // on-chain revoke needs the root key itself, not just a session token
  if (ownerKeypair) {
    server.registerTool(
      "revoke_engine_custody",
      {
        title: "REVOKE ENGINE (on-chain, terminal)",
        description:
          "Owner-only, irreversible without re-activation: remove the engine's role from the " +
          "strategy's Swig ON-CHAIN. The engine loses all access; only the owner's root key " +
          "can move funds afterward. Stronger than the kill switch — survives even a " +
          "compromised or unreachable Olbos API.",
        inputSchema: { strategyId: z.string() },
      },
      async ({ strategyId }) => {
        try {
          return json(await olbos.revokeCustody(strategyId));
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

await server.connect(new StdioServerTransport());
console.error(`olbos MCP server up (api=${process.env.OLBOS_API ?? "http://localhost:4020"}, payment=${process.env.OLBOS_PAYMENT ?? "dev"})`);
