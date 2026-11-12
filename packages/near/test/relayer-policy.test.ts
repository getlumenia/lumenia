import { describe, expect, it } from "vitest";
import { KeyPair, actions, encodeSignedDelegate, teraToGas } from "near-api-js";
import {
  BLOCK_WINDOW,
  MAX_EXPIRY_S,
  MIN_EXPIRY_S,
  checkLinkMsg,
  decodeSignedDelegate,
  describePolicy,
  evaluate,
  isEd25519PublicKey,
  isValidAccountId,
  verifyDelegateSignature,
  type DecodedSignedDelegate,
} from "../src/relayer/policy.js";
import { CTX, ESCROW, HEIGHT, SENDER, USDC, b64, ftTransferCall, linkKey, linkMsg, reclaimCall, signDelegate } from "./relayer-helpers.js";

async function refusedWith(code: string, o: Parameters<typeof b64>[0], reasonPart?: RegExp) {
  const v = evaluate(await b64(o), CTX);
  expect(v.allow, `expected refusal ${code}, got allow`).toBe(false);
  if (v.allow) return;
  expect(v.code).toBe(code);
  if (reasonPart) expect(v.reason).toMatch(reasonPart);
  return v;
}

describe("policy: allowed shapes", () => {
  it("allows ft_transfer_call of USDC into the escrow with a link message", async () => {
    const key = linkKey();
    const { base64, keyPair } = await signDelegate({ actions: [ftTransferCall({ msg: linkMsg({ public_key: key }) })] });
    const v = evaluate(base64, CTX);
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.kind).toBe("create_link");
    expect(v.senderId).toBe(SENDER);
    expect(v.receiverId).toBe(USDC);
    expect(v.method).toBe("ft_transfer_call");
    expect(v.amountUnits).toBe("100000");
    expect(v.expiresInS).toBe(86_400);
    expect(v.linkPublicKeys).toEqual([key]);
    expect(v.publicKey).toBe(keyPair.getPublicKey().toString());
    expect(v.deposit).toBe(1n);
    expect(v.gas).toBe(teraToGas(100));
    expect(v.maxBlockHeight).toBe(BigInt(HEIGHT + 300));
  });

  it("allows the batch message shape with string and object drops", async () => {
    const k1 = linkKey();
    const k2 = linkKey();
    const k3 = linkKey();
    const msg = JSON.stringify({ drops: [k1, { public_key: k2, amount: "50000", memo: "b" }, { public_key: k3 }], expires_in_s: 3600 });
    const v = evaluate(await b64({ actions: [ftTransferCall({ msg })] }), CTX);
    expect(v.allow).toBe(true);
    if (v.allow) expect(v.linkPublicKeys).toEqual([k1, k2, k3]);
  });

  it("allows reclaim on the escrow with no deposit", async () => {
    const key = linkKey();
    const v = evaluate(await b64({ receiverId: ESCROW, actions: [reclaimCall({ publicKey: key })] }), CTX);
    expect(v.allow).toBe(true);
    if (!v.allow) return;
    expect(v.kind).toBe("reclaim");
    expect(v.method).toBe("reclaim");
    expect(v.deposit).toBe(0n);
    expect(v.linkPublicKeys).toEqual([key]);
    expect(v.amountUnits).toBeUndefined();
  });

  it("accepts an optional memo (string or null) in the ft_transfer_call args", async () => {
    expect(evaluate(await b64({ actions: [ftTransferCall({ extra: { memo: "thanks" } })] }), CTX).allow).toBe(true);
    expect(evaluate(await b64({ actions: [ftTransferCall({ extra: { memo: null } })] }), CTX).allow).toBe(true);
  });

  it("accepts the expiry and gas boundaries", async () => {
    expect(evaluate(await b64({ actions: [ftTransferCall({ msg: linkMsg({ expires_in_s: MIN_EXPIRY_S }) })] }), CTX).allow).toBe(true);
    expect(evaluate(await b64({ actions: [ftTransferCall({ msg: linkMsg({ expires_in_s: MAX_EXPIRY_S }) })] }), CTX).allow).toBe(true);
    expect(evaluate(await b64({ actions: [ftTransferCall({ gasTgas: 100 })] }), CTX).allow).toBe(true);
    expect(evaluate(await b64({ actions: [ftTransferCall({ gasTgas: 1 })] }), CTX).allow).toBe(true);
  });

  it("accepts max_block_height anywhere in (now, now + 600]", async () => {
    expect(evaluate(await b64({ maxBlockHeight: BigInt(HEIGHT + 1) }), CTX).allow).toBe(true);
    expect(evaluate(await b64({ maxBlockHeight: BigInt(HEIGHT + BLOCK_WINDOW) }), CTX).allow).toBe(true);
  });

  it("accepts a decoded object or raw bytes as input, not only base64", async () => {
    const { bytes } = await signDelegate();
    expect(evaluate(bytes, CTX).allow).toBe(true);
    expect(evaluate(decodeSignedDelegate(bytes), CTX).allow).toBe(true);
  });
});

describe("policy: refusals", () => {
  it("wrong receiver", async () => {
    await refusedWith("receiver", { receiverId: "other-token.testnet" }, /neither the USDC contract nor the escrow|neither/);
  });

  it("wrong method on the USDC contract (ft_transfer)", async () => {
    const action = actions.functionCall("ft_transfer", { receiver_id: "bob.testnet", amount: "1" }, teraToGas(10), 1n);
    await refusedWith("method", { actions: [action] }, /ft_transfer_call/);
  });

  it("deposit 2 yocto, and deposit 0, on ft_transfer_call", async () => {
    await refusedWith("deposit", { actions: [ftTransferCall({ deposit: 2n })] }, /exactly 1 yoctoNEAR/);
    await refusedWith("deposit", { actions: [ftTransferCall({ deposit: 0n })] });
  });

  it("gas 150 Tgas, and gas 0", async () => {
    await refusedWith("gas", { actions: [ftTransferCall({ gasTgas: 150 })] }, /150 Tgas/);
    await refusedWith("gas", { actions: [ftTransferCall({ gasTgas: 0 })] });
  });

  it("two actions, and zero actions", async () => {
    await refusedWith("actions", { actions: [ftTransferCall(), ftTransferCall()] }, /exactly one action.*got 2/);
    await refusedWith("actions", { actions: [] }, /got 0/);
  });

  it("ft_transfer_call whose args.receiver_id is another account", async () => {
    await refusedWith("receiver", { actions: [ftTransferCall({ receiverId: "mallory.testnet" })] }, /receiver_id must be the escrow/);
  });

  it("an unparseable msg, a non-string msg, and a msg with the wrong shape", async () => {
    await refusedWith("msg", { actions: [ftTransferCall({ msg: "{not json" })] }, /not JSON/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: 42 })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ hello: "world" }) })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ public_key: "secp256k1:" + "1".repeat(80) }) })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ public_key: "ed25519:notbase58!!" }) })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ extra_field: 1 }) })] }, /unknown fields/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ memo: "x".repeat(257) }) })] }, /256 bytes/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ expires_in_s: MIN_EXPIRY_S - 1 }) })] }, /1 hour to 7 days/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ expires_in_s: MAX_EXPIRY_S + 1 }) })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: linkMsg({ expires_in_s: "3600" }) })] });
  });

  it("batch messages: empty, duplicate keys, too many, unknown fields", async () => {
    const k = linkKey();
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ drops: [], expires_in_s: 3600 }) })] }, /non-empty/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ drops: [k, k], expires_in_s: 3600 }) })] }, /repeats/);
    const many = Array.from({ length: 31 }, () => linkKey());
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ drops: many, expires_in_s: 3600 }) })] }, /limit is 30/);
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ drops: [{ public_key: k, to: "x" }], expires_in_s: 3600 }) })] });
    await refusedWith("msg", { actions: [ftTransferCall({ msg: JSON.stringify({ drops: [{ public_key: k, amount: "0" }], expires_in_s: 3600 }) })] });
  });

  it("bad amounts and unknown args", async () => {
    await refusedWith("args", { actions: [ftTransferCall({ amount: "0" })] }, /positive integer/);
    await refusedWith("args", { actions: [ftTransferCall({ amount: "abc" })] });
    await refusedWith("args", { actions: [ftTransferCall({ amount: 100000 })] });
    await refusedWith("args", { actions: [ftTransferCall({ amount: "1" + "0".repeat(39) })] });
    await refusedWith("args", { actions: [ftTransferCall({ extra: { approval_id: 1 } })] }, /unknown fields: approval_id/);
    await refusedWith("args", { actions: [ftTransferCall({ rawArgs: new TextEncoder().encode("[1,2]") })] }, /JSON object/);
    await refusedWith("args", { actions: [ftTransferCall({ rawArgs: new Uint8Array([0xff, 0xfe]) })] });
  });

  it("reclaim with a deposit, another escrow method, extra args", async () => {
    await refusedWith("deposit", { receiverId: ESCROW, actions: [reclaimCall({ deposit: 1n })] }, /no deposit/);
    await refusedWith("method", { receiverId: ESCROW, actions: [reclaimCall({ method: "claim" })] }, /only reclaim/);
    await refusedWith("args", { receiverId: ESCROW, actions: [reclaimCall({ extra: { to: "x" } })] }, /exactly \{public_key\}/);
    await refusedWith("args", { receiverId: ESCROW, actions: [reclaimCall({ publicKey: "nope" })] });
    await refusedWith("gas", { receiverId: ESCROW, actions: [reclaimCall({ gasTgas: 101 })] });
  });

  it("an escrow method with a deposit never passes even when it is called reclaim with 1 yocto", async () => {
    await refusedWith("deposit", { receiverId: ESCROW, actions: [reclaimCall({ deposit: 1n })] });
  });

  it("expired or too-distant max_block_height", async () => {
    await refusedWith("expiry", { maxBlockHeight: BigInt(HEIGHT) }, /expired/);
    await refusedWith("expiry", { maxBlockHeight: BigInt(HEIGHT - 1) }, /expired/);
    await refusedWith("expiry", { maxBlockHeight: BigInt(HEIGHT + BLOCK_WINDOW + 1) }, /more than 600 blocks/);
  });

  it("nonce out of the protocol bound", async () => {
    await refusedWith("nonce", { nonce: 0n });
    await refusedWith("nonce", { nonce: BigInt(HEIGHT + 300) * 1_000_000n + 1n }, /1e6/);
  });

  it("a non-FunctionCall action (transfer)", async () => {
    await refusedWith("action_type", { actions: [actions.transfer(1n)] }, /only FunctionCall/);
  });

  it("an invalid sender account id", async () => {
    await refusedWith("sender", { senderId: "Alice..testnet" }, /not a valid NEAR account id/);
    await refusedWith("sender", { senderId: "a" });
  });

  it("a nested delegate action (object input, since the wire format cannot carry one)", async () => {
    const inner = await signDelegate();
    const outer = await signDelegate();
    const decoded = decodeSignedDelegate(outer.bytes) as DecodedSignedDelegate;
    decoded.delegateAction.actions = [{ signedDelegate: inner.signed } as never];
    const v = evaluate(decoded, CTX);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("nesting");
  });

  it("a tampered delegate (sender changed after signing) fails the signature check", async () => {
    const { signed } = await signDelegate();
    expect(verifyDelegateSignature(signed as never)).toBe(true);
    signed.delegateAction.senderId = "mallory.testnet";
    expect(verifyDelegateSignature(signed as never)).toBe(false);
    const v = evaluate(encodeSignedDelegate(signed), CTX);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("signature");
  });

  it("a signature made by another key", async () => {
    const a = await signDelegate();
    const b = await signDelegate({ keyPair: KeyPair.fromRandom("ed25519") });
    a.signed.signature = b.signed.signature;
    const v = evaluate(encodeSignedDelegate(a.signed), CTX);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("signature");
  });

  it("undecodable input: bad base64, garbage bytes, trailing bytes, empty", async () => {
    for (const input of ["%%%", "AAAA", "", Buffer.from("hello").toString("base64")]) {
      const v = evaluate(input, CTX);
      expect(v.allow).toBe(false);
      if (!v.allow) expect(v.code).toBe("undecodable");
    }
    const { bytes } = await signDelegate();
    const longer = new Uint8Array(bytes.length + 1);
    longer.set(bytes);
    const v = evaluate(longer, CTX);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.code).toBe("undecodable");
  });

  it("carries sender, receiver and method in the refusal so the log line can name them", async () => {
    const v = await refusedWith("deposit", { actions: [ftTransferCall({ deposit: 5n })] });
    expect(v?.senderId).toBe(SENDER);
    expect(v?.receiverId).toBe(USDC);
    expect(v?.method).toBe("ft_transfer_call");
  });
});

describe("policy: helpers", () => {
  it("validates NEAR account ids", () => {
    expect(isValidAccountId("alice.testnet")).toBe(true);
    expect(isValidAccountId("a1-b_c.d2.testnet")).toBe(true);
    expect(isValidAccountId("3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af")).toBe(true);
    expect(isValidAccountId("Alice.testnet")).toBe(false);
    expect(isValidAccountId("a")).toBe(false);
    expect(isValidAccountId("a..b")).toBe(false);
    expect(isValidAccountId("-a.testnet")).toBe(false);
    expect(isValidAccountId("x".repeat(65))).toBe(false);
    expect(isValidAccountId(5)).toBe(false);
  });

  it("recognises ed25519 public keys only", () => {
    expect(isEd25519PublicKey(linkKey())).toBe(true);
    expect(isEd25519PublicKey(KeyPair.fromRandom("ed25519").toString())).toBe(false); // 64-byte secret
    expect(isEd25519PublicKey("secp256k1:" + "1".repeat(88))).toBe(false);
    expect(isEd25519PublicKey(linkKey().slice("ed25519:".length))).toBe(false); // no prefix
  });

  it("checkLinkMsg reports the first problem in words", () => {
    const r = checkLinkMsg(JSON.stringify({ public_key: linkKey(), expires_in_s: 10 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expires_in_s 10 is outside/);
  });

  it("describePolicy names both allowed calls and the limits", () => {
    const d = describePolicy({ escrowId: ESCROW, usdcId: USDC });
    expect(d.rules.allowed.map((a) => a.method)).toEqual(["ft_transfer_call", "reclaim"]);
    expect(d.rules.allowed[0]?.receiver_id).toBe(USDC);
    expect(d.rules.allowed[0]?.args.receiver_id).toBe(ESCROW);
    expect(d.rules.delegate.max_block_height_window_blocks).toBe(600);
    expect(d.words.join(" ")).toContain("1 yoctoNEAR");
    expect(d.words.join(" ")).toContain("reclaim");
  });
});
