/**
 * @olbos/sdk — the 5-line agent integration.
 *
 *   const olbos = createOlbos({ baseUrl, payment: { mode: "x402", keypair } });
 *   const { strategyId } = await olbos.deployStrategy({ template: "balanced" });
 *   await olbos.fund(strategyId, usdc(5000));   // the payment IS the deposit
 *
 * Hides the whole 402 dance: in x402 mode every metered call is auto-paid
 * via x402-solana; in dev mode (localnet) calls pass a dev-payer header.
 * Everything above this module is a thin skin: agent-demo, MCP, CLI wizard.
 */
import type { Keypair, VersionedTransaction } from "@solana/web3.js";

// ---- types mirrored from the API ----

export interface Opportunity {
  venue: string;
  address: string;
  headlineApyBps: number;
  costBps: number;
  netApyBps: number;
  index: string;
}

export interface DeployResult {
  strategyId: string;
  policy: unknown;
  paymentRef: string;
  /**
   * Per-strategy Swig custody: the owner holds root (from birth, immutably),
   * the engine holds an on-chain-scoped, revocable role. "pending" means the
   * owner's activation signature hasn't landed yet — in x402 mode the SDK
   * signs and submits it automatically during deployStrategy.
   */
  custody?: {
    status: "active" | "pending";
    swigAddress: string;
    walletAddress: string;
    owner: string;
    dailyCapUsdc: number;
    /** base64 tx awaiting the owner's signature (pending only) */
    activationTx?: string | null;
  };
}

export interface Positions {
  strategyId: string;
  walletLiquid: string;
  positions: Record<string, string>;
  killSwitchActive: boolean;
}

export interface RiskStatus {
  strategyId: string;
  policy: unknown;
  totalManaged: string;
  exposures: Record<string, { value: string; shareBps: number; capBps: number }>;
  killSwitchActive: boolean;
}

export type PaymentMode =
  | { mode: "dev"; payer?: string }
  | {
      mode: "x402";
      keypair: Keypair;
      rpcUrl?: string;
      network?: "solana" | "solana-devnet";
      /** safety cap per request, atomic units (default 10 USDC) */
      maxPayment?: bigint;
    };

export interface OlbosClientOptions {
  baseUrl: string;
  payment?: PaymentMode;
  /** dev-rail break-glass token (localnet only; x402 requires a signature) */
  ownerToken?: string;
  /**
   * Custody-root keypair for break-glass signatures. Defaults to the x402
   * payment keypair (payer = owner in the common case). Hold this in an
   * OWNER session, never an agent session.
   */
  ownerKeypair?: Keypair;
}

/** Human USDC → atomic units. */
export function usdc(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6));
}

export class OlbosClient {
  private fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  private devPayer?: string;
  /** x402 mode only — also signs custody activations (owner = payer wallet). */
  private keypair?: Keypair;

  constructor(private opts: OlbosClientOptions) {
    const payment = opts.payment ?? { mode: "dev" as const };
    if (payment.mode === "x402") {
      this.keypair = payment.keypair;
      // lazily import so dev-mode consumers never load the payment stack
      let client: { fetch: typeof fetch } | undefined;
      const kp = payment.keypair;
      this.fetcher = async (url, init) => {
        if (!client) {
          const { createX402Client } = await import("x402-solana/client");
          client = createX402Client({
            wallet: {
              address: kp.publicKey.toBase58(),
              signTransaction: async (tx: VersionedTransaction) => {
                tx.sign([kp]);
                return tx;
              },
            },
            network: payment.network ?? "solana-devnet",
            rpcUrl: payment.rpcUrl,
            amount: payment.maxPayment ?? 10_000_000n,
          }) as { fetch: typeof fetch };
        }
        return client.fetch(url, init);
      };
    } else {
      this.devPayer = payment.payer ?? "sdk-agent";
      this.fetcher = (url, init) => fetch(url, init);
    }
  }

  private async call<T>(method: string, path: string, body?: unknown, owner = false): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.devPayer) headers["x-dev-payer"] = this.devPayer;
    if (owner) {
      if (!this.opts.ownerToken) throw new Error("ownerToken required for break-glass calls");
      headers["x-owner-token"] = this.opts.ownerToken;
    }
    const res = await this.fetcher(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      throw new Error(
        `${method} ${path} → ${res.status}: ${json?.error ?? JSON.stringify(json).slice(0, 200)}`,
      );
    }
    return json as T;
  }

  // ---- free reads ----
  opportunities(): Promise<{ opportunities: Opportunity[] }> {
    return this.call("GET", "/v1/opportunities");
  }
  positions(strategyId: string): Promise<Positions> {
    return this.call("GET", `/v1/strategies/${strategyId}/positions`);
  }
  riskStatus(strategyId: string): Promise<RiskStatus> {
    return this.call("GET", `/v1/strategies/${strategyId}/risk-status`);
  }
  auditLog(strategyId: string, after = 0): Promise<{ events: unknown[] }> {
    return this.call("GET", `/v1/strategies/${strategyId}/audit-log?after=${after}`);
  }

  // ---- metered (auto-paid in x402 mode) ----
  async deployStrategy(opts: {
    template?: "conservative" | "balanced" | "aggressive";
    name?: string;
    policy?: unknown;
    /** Custody root authority (base58). Defaults to the x402 payer wallet. */
    owner?: string;
  }): Promise<DeployResult> {
    const result = await this.call<DeployResult>("POST", "/v1/strategies", opts);
    // custody activation: the owner's one signature, signed right here with
    // the same keypair that paid — delegation without an extra UX step.
    // (Only when the payer wallet IS the owner; an explicit third-party
    // owner has to sign via GET/POST /custody themselves.)
    if (
      result.custody?.status === "pending" &&
      result.custody.activationTx &&
      this.keypair &&
      result.custody.owner === this.keypair.publicKey.toBase58()
    ) {
      const { VersionedTransaction } = await import("@solana/web3.js");
      const tx = VersionedTransaction.deserialize(
        Buffer.from(result.custody.activationTx, "base64"),
      );
      tx.sign([this.keypair]);
      const activated = await this.call<{
        status: "active";
        swigAddress: string;
        walletAddress: string;
        owner: string;
        dailyCapUsdc: number;
      }>("POST", `/v1/strategies/${result.strategyId}/custody`, {
        signedTx: Buffer.from(tx.serialize()).toString("base64"),
      });
      result.custody = { ...activated, activationTx: null };
    }
    return result;
  }
  fund(strategyId: string, amount: bigint): Promise<{ credited: string; paymentRef: string }> {
    return this.call("POST", `/v1/strategies/${strategyId}/fund`, { amount: amount.toString() });
  }
  rebalance(strategyId: string): Promise<{ executed: number }> {
    return this.call("POST", `/v1/strategies/${strategyId}/rebalance`, {});
  }
  async withdraw(
    strategyId: string,
    amount: bigint,
  ): Promise<{
    liquid: string;
    unwindTx: string | null;
    payout?: { status: "paid" | "pending"; to?: string; signature?: string; payoutTx?: string };
  }> {
    const result = await this.call<{
      liquid: string;
      unwindTx: string | null;
      payout?: { status: "paid" | "pending"; to?: string; signature?: string; payoutTx?: string };
    }>("POST", `/v1/strategies/${strategyId}/withdrawals`, {
      amount: amount.toString(),
    });
    // payout leg: the transfer out of the swig needs the OWNER's root
    // signature — the engine can't move funds, it only fee-pays. When the
    // paying wallet is the owner, sign and settle right here.
    if (result.payout?.status === "pending" && result.payout.payoutTx && this.keypair) {
      const { VersionedTransaction } = await import("@solana/web3.js");
      const tx = VersionedTransaction.deserialize(Buffer.from(result.payout.payoutTx, "base64"));
      tx.sign([this.keypair]);
      const paid = await this.call<{ status: "paid"; to: string; signature: string }>(
        "POST",
        `/v1/strategies/${strategyId}/payout`,
        {
          amount: amount.toString(),
          signedTx: Buffer.from(tx.serialize()).toString("base64"),
        },
      );
      result.payout = paid;
    }
    return result;
  }

  /** Full exit: unwind all, pay everything to the owner, close. Not metered. */
  closeStrategy(strategyId: string): Promise<{ status: string; paidOutUsdc?: number; payout?: unknown }> {
    return this.call("POST", `/v1/strategies/${strategyId}/close`, {});
  }

  // ---- break-glass (owner-only) ----

  /** `olbos:<action>:<strategyId>:<ts>` signed by the custody root. */
  private async ownerSig(action: "kill" | "unkill", strategyId: string) {
    const kp = this.opts.ownerKeypair ?? this.keypair;
    if (!kp) return null; // dev rail falls back to the shared token
    const [{ default: nacl }, { default: bs58 }] = await Promise.all([
      import("tweetnacl"),
      import("bs58"),
    ]);
    const ts = Math.floor(Date.now() / 1000);
    const msg = new TextEncoder().encode(`olbos:${action}:${strategyId}:${ts}`);
    return { ts, signature: bs58.encode(nacl.sign.detached(msg, kp.secretKey)) };
  }

  async kill(strategyId: string): Promise<{ killSwitchActive: boolean }> {
    const sig = await this.ownerSig("kill", strategyId);
    return this.call("POST", `/v1/strategies/${strategyId}/kill`, sig ?? {}, !sig);
  }
  async unkill(strategyId: string): Promise<{ killSwitchActive: boolean }> {
    const sig = await this.ownerSig("unkill", strategyId);
    return this.call("POST", `/v1/strategies/${strategyId}/unkill`, sig ?? {}, !sig);
  }

  /**
   * Terminal break-glass: revoke the engine's role ON-CHAIN. After this the
   * engine cannot touch the strategy's swig at all; only the owner's root
   * key can move funds. (Root never needs Olbos for this — we just make it
   * one call and pay the fee.)
   */
  async revokeCustody(strategyId: string): Promise<{ status: string; signature?: string }> {
    const kp = this.opts.ownerKeypair ?? this.keypair;
    if (!kp) throw new Error("revokeCustody requires the owner keypair");
    const r = await this.call<{ status: string; revokeTx?: string }>(
      "GET",
      `/v1/strategies/${strategyId}/custody/revoke`,
    );
    if (r.status === "already-revoked" || !r.revokeTx) return { status: r.status };
    const { VersionedTransaction } = await import("@solana/web3.js");
    const tx = VersionedTransaction.deserialize(Buffer.from(r.revokeTx, "base64"));
    tx.sign([kp]);
    return this.call("POST", `/v1/strategies/${strategyId}/custody/revoke`, {
      signedTx: Buffer.from(tx.serialize()).toString("base64"),
    });
  }
}

export function createOlbos(opts: OlbosClientOptions): OlbosClient {
  return new OlbosClient(opts);
}
