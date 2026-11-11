// client.ts builds for a random key, policy.ts decodes: the two must agree byte for byte.
import { describe, expect, it } from "vitest";
import { KeyPair, encodeSignedDelegate, teraToGas, type Provider } from "near-api-js";
import { RelayRequestError, buildSignedDelegateForPayForward, buildSignedDelegateForReclaim, relay } from "../src/relayer/client.js";
import { decodeSignedDelegate, evaluate } from "../src/relayer/policy.js";
import { ESCROW, USDC, linkKey } from "./relayer-helpers.js";

const HEIGHT = 1000;

function fakeProvider(o: { nonce?: bigint; height?: number } = {}): Provider {
  return {
    viewAccessKey: async () => ({ nonce: o.nonce ?? 41n, permission: "FullAccess", block_hash: "", block_height: o.height ?? HEIGHT }),
    viewBlock: async () => ({ header: { height: o.height ?? HEIGHT, hash: "11111111111111111111111111111111" } }),
  } as unknown as Provider;
}

describe("client.ts to policy.ts round trip", () => {
  it("builds a pay-forward delegate that the policy decodes, allows and re-encodes identically", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const key = linkKey();
    const built = await buildSignedDelegateForPayForward({
      senderId: "fresh-claimer.testnet",
      senderKeyPair: keyPair,
      usdcId: USDC,
      escrowId: ESCROW,
      amountUnits: 100_000n,
      msg: { public_key: key, expires_in_s: 86_400, memo: "pay it forward" },
      provider: fakeProvider(),
    });
    expect(built.nonce).toBe(42n);
    expect(built.maxBlockHeight).toBe(BigInt(HEIGHT + 300));
    expect(built.receiverId).toBe(USDC);
    expect(built.method).toBe("ft_transfer_call");
    expect(built.publicKey).toBe(keyPair.getPublicKey().toString());
    expect(built.base64).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const decoded = decodeSignedDelegate(built.base64);
    const da = decoded.delegateAction;
    expect(da.senderId).toBe("fresh-claimer.testnet");
    expect(da.receiverId).toBe(USDC);
    expect(da.nonce).toBe(42n);
    expect(da.maxBlockHeight).toBe(BigInt(HEIGHT + 300));
    expect(da.actions).toHaveLength(1);
    const fc = da.actions[0]?.functionCall;
    expect(fc?.methodName).toBe("ft_transfer_call");
    expect(fc?.gas).toBe(teraToGas(100));
    expect(fc?.deposit).toBe(1n);
    const args = JSON.parse(new TextDecoder().decode(Uint8Array.from(fc?.args ?? [])));
    expect(args.receiver_id).toBe(ESCROW);
    expect(args.amount).toBe("100000");
    expect(JSON.parse(args.msg)).toEqual({ public_key: key, expires_in_s: 86_400, memo: "pay it forward" });

    const verdict = evaluate(built.base64, { escrowId: ESCROW, usdcId: USDC, currentBlockHeight: HEIGHT });
    expect(verdict.allow).toBe(true);
    if (verdict.allow) {
      expect(verdict.kind).toBe("create_link");
      expect(verdict.amountUnits).toBe("100000");
      expect(verdict.linkPublicKeys).toEqual([key]);
      expect(verdict.publicKey).toBe(built.publicKey);
    }

    // What the relayer re-serialises into its own transaction is exactly what the sender signed.
    const again = encodeSignedDelegate(decoded as never);
    expect(Buffer.from(again).equals(Buffer.from(built.bytes))).toBe(true);
  });

  it("accepts the secret key as a string, a string msg, and refuses a TTL above 600", async () => {
    const keyPair = KeyPair.fromRandom("ed25519");
    const built = await buildSignedDelegateForPayForward({
      senderId: "bob.testnet",
      senderKeyPair: keyPair.toString(),
      usdcId: USDC,
      escrowId: ESCROW,
      amountUnits: "250000",
      msg: JSON.stringify({ public_key: linkKey(), expires_in_s: 3600 }),
      provider: fakeProvider({ nonce: 7n, height: 5000 }),
      blockHeightTtl: 600,
    });
    expect(built.nonce).toBe(8n);
    expect(built.maxBlockHeight).toBe(5600n);
    expect(evaluate(built.bytes, { escrowId: ESCROW, usdcId: USDC, currentBlockHeight: 5000 }).allow).toBe(true);
    await expect(
      buildSignedDelegateForPayForward({
        senderId: "bob.testnet",
        senderKeyPair: keyPair,
        usdcId: USDC,
        escrowId: ESCROW,
        amountUnits: 1n,
        msg: { public_key: linkKey(), expires_in_s: 3600 },
        provider: fakeProvider(),
        blockHeightTtl: 700,
      }),
    ).rejects.toThrow(/1\.\.600/);
    await expect(
      buildSignedDelegateForPayForward({
        senderId: "bob.testnet",
        senderKeyPair: keyPair,
        usdcId: USDC,
        escrowId: ESCROW,
        amountUnits: 0n,
        msg: { public_key: linkKey(), expires_in_s: 3600 },
        provider: fakeProvider(),
      }),
    ).rejects.toThrow(/positive/);
  });

  it("builds a reclaim delegate the policy allows", async () => {
    const key = linkKey();
    const built = await buildSignedDelegateForReclaim({
      senderId: "funder.testnet",
      senderKeyPair: KeyPair.fromRandom("ed25519"),
      escrowId: ESCROW,
      linkPublicKey: key,
      provider: fakeProvider(),
    });
    expect(built.receiverId).toBe(ESCROW);
    const v = evaluate(built.base64, { escrowId: ESCROW, usdcId: USDC, currentBlockHeight: HEIGHT });
    expect(v.allow).toBe(true);
    if (v.allow) {
      expect(v.kind).toBe("reclaim");
      expect(v.deposit).toBe(0n);
      expect(v.linkPublicKeys).toEqual([key]);
    }
  });

  it("relay() posts {signedDelegate} to /relay and surfaces refusals as RelayRequestError", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const ok = { txHash: "abc", explorerUrl: "https://testnet.nearblocks.io/txns/abc", outcome: { status: "success" } };
    const fetchOk: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify(ok), { status: 200 });
    };
    const r = await relay("https://relayer.example/", "QUJD", fetchOk);
    expect(r.txHash).toBe("abc");
    expect(seen[0]?.url).toBe("https://relayer.example/relay");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ signedDelegate: "QUJD" });

    const fetch403: typeof fetch = async () =>
      new Response(JSON.stringify({ reason: "deposit must be 1", code: "deposit" }), { status: 403 });
    await expect(relay("https://relayer.example/relay", "QUJD", fetch403)).rejects.toMatchObject({
      name: "RelayRequestError",
      status: 403,
      code: "deposit",
      reason: "deposit must be 1",
    });

    const fetch429: typeof fetch = async () =>
      new Response(JSON.stringify({ reason: "wait", code: "cooldown", retryAfterS: 7 }), { status: 429 });
    try {
      await relay("https://relayer.example", "QUJD", fetch429);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RelayRequestError);
      expect((e as RelayRequestError).retryAfterS).toBe(7);
    }
  });
});
