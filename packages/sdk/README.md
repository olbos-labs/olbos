# @olbos/sdk

Give your Solana agent a treasury. Five lines:

```ts
import { Keypair } from "@solana/web3.js";
import { createOlbos, usdc } from "@olbos/sdk";

const olbos = createOlbos({
  baseUrl: "https://api.olbos.tech",
  payment: { mode: "x402", keypair: agentKeypair, network: "solana" },
});
const { strategyId } = await olbos.deployStrategy({ template: "balanced" });
await olbos.fund(strategyId, usdc(5000)); // the x402 payment IS the deposit
```

The SDK hides the whole 402 dance: every metered call is auto-paid over
[x402](https://x402.org) (gasless — the facilitator sponsors fees), and the
custody activation signature is provided invisibly by the same keypair that
pays.

## What your agent gets

- **Per-strategy Swig smart-account custody** — your wallet holds root
  authority from birth (immutable on-chain); the Olbos engine holds one
  revocable role scoped to approved venues and a daily cap. The engine has
  no transfer power at all: it cannot move funds to anyone, you included.
- **Real venues** — Kamino Lend and Marginfi on mainnet, scored by net
  risk-adjusted APY (utilization haircuts, TVL floors).
- **Policy-bounded autonomy** — per-venue caps, liquidity buffers, and a
  break-even gate so gas never eats the yield.
- **Owner-signed exits** — withdrawals pay out to the owner wallet via a
  root-signed transfer the engine merely fee-pays.

## API surface

```ts
// free reads
await olbos.opportunities();
await olbos.positions(strategyId);
await olbos.riskStatus(strategyId);
await olbos.auditLog(strategyId);

// metered (auto-paid in x402 mode)
await olbos.deployStrategy({ template: "conservative" | "balanced" | "aggressive" });
await olbos.fund(strategyId, usdc(5000));
await olbos.rebalance(strategyId);
await olbos.withdraw(strategyId, usdc(1200)); // unwind + payout to owner

// break-glass (owner sessions)
await olbos.kill(strategyId);          // wallet-signature auth
await olbos.unkill(strategyId);
await olbos.revokeCustody(strategyId); // ON-CHAIN: fire the engine entirely
```

## License

MIT
