# @olbos/mcp

Olbos as MCP tools — any LLM agent gets a yield treasury on Solana.

```bash
claude mcp add olbos \
  --env OLBOS_API=https://api.olbos.tech \
  --env OLBOS_PAYMENT=x402 \
  --env OLBOS_AGENT_KEYPAIR=/path/to/agent-keypair.json \
  --env OLBOS_RPC=https://api.mainnet-beta.solana.com \
  -- npx @olbos/mcp
```

Then just talk: *"you've got idle USDC — park it somewhere safe"* becomes
`deploy_strategy` → `fund_strategy` (the x402 payment **is** the deposit) →
capital working on Kamino/Marginfi within policy, fully audited.

## Tools

| tool | cost | what it does |
|---|---|---|
| `get_opportunities` | free | venues ranked by net risk-adjusted APY |
| `deploy_strategy` | 0.10 USDC | strategy + per-strategy Swig custody (owner = your wallet, root) |
| `fund_strategy` | the amount | **the settled x402 transfer is the deposit** |
| `get_positions` / `get_risk_status` | free | allocation, exposure vs caps, kill state |
| `trigger_rebalance` | 0.01 USDC | one cycle; no-op if nothing clears the gates |
| `withdraw` | 0.01 USDC | unwind lowest-yield first + owner-signed payout |
| `get_audit_log` | free | every decision, payment, simulation, on-chain action |

## Owner sessions — agents pay, owners sign

Break-glass tools are **not registered** in agent sessions; an agent cannot
even see them. Start a separate session with the custody-root keypair:

```bash
claude mcp add olbos-owner \
  --env OLBOS_API=https://api.olbos.tech \
  --env OLBOS_OWNER_KEYPAIR=/path/to/owner-keypair.json \
  -- npx @olbos/mcp
```

unlocks `kill_strategy`, `clear_kill_switch`, and `revoke_engine_custody` —
the last one removes the engine's role **on-chain**, a break-glass that works
even if the Olbos API is down.

## Env

| var | default | |
|---|---|---|
| `OLBOS_API` | `http://localhost:4020` | Olbos API base URL |
| `OLBOS_PAYMENT` | `dev` | `x402` for real payments |
| `OLBOS_AGENT_KEYPAIR` | — | path to keypair JSON (x402 mode) |
| `OLBOS_RPC` | — | Solana RPC (x402 mode) |
| `OLBOS_OWNER_KEYPAIR` | — | custody-root key → owner tools (kill + on-chain revoke) |
| `OLBOS_OWNER_TOKEN` | — | dev-rail break-glass (localnet only) |

## Development

```bash
pnpm install && pnpm build
claude mcp add olbos -- node /path/to/olbos/packages/mcp/dist/index.js
```

`OLBOS_API` defaults to `http://localhost:4020` with the dev payment rail, so
you can point it at any local Olbos API instance.

## License

MIT
