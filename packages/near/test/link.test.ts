import { describe, expect, it } from "vitest";
import { base58Decode, ed25519KeyBytes } from "../src/base58.js";
import { buildLink, LinkError, newLinkKey, parseLinkOrKey } from "../src/link.js";

describe("link encode/decode", () => {
  const key = newLinkKey();

  it("builds <origin>/c#<secret> and strips trailing slashes from the origin", () => {
    expect(buildLink("https://near.lumenia.test/", key.secretKey)).toBe(`https://near.lumenia.test/c#${key.secretKey}`);
    expect(buildLink("http://localhost:5173", key.secretKey)).toBe(`http://localhost:5173/c#${key.secretKey}`);
  });

  it("refuses to build a link from a public key or a non-http origin", () => {
    expect(() => buildLink("https://x.test", key.publicKey)).toThrow(LinkError);
    expect(() => buildLink("ftp://x.test", key.secretKey)).toThrow(LinkError);
  });

  it("decodes the public key from a link, a secret key or a public key", () => {
    const link = buildLink("https://near.lumenia.test", key.secretKey);
    expect(parseLinkOrKey(link)).toEqual({ publicKey: key.publicKey, secretKey: key.secretKey });
    expect(parseLinkOrKey(key.secretKey)).toEqual({ publicKey: key.publicKey, secretKey: key.secretKey });
    expect(parseLinkOrKey(key.publicKey)).toEqual({ publicKey: key.publicKey });
    expect(parseLinkOrKey(`  ${key.publicKey}\n`)).toEqual({ publicKey: key.publicKey });
  });

  it("tolerates extra fragment parameters and URL encoding", () => {
    expect(parseLinkOrKey(`https://x.test/c#${key.secretKey}&name=Ali`).publicKey).toBe(key.publicKey);
    expect(parseLinkOrKey(`https://x.test/c?utm=1#${encodeURIComponent(key.secretKey)}`).publicKey).toBe(key.publicKey);
  });

  it("never mistakes a public key for a secret (near-api-js would derive a wrong key)", () => {
    const parsed = parseLinkOrKey(key.publicKey);
    expect(parsed.secretKey).toBeUndefined();
    expect(parsed.publicKey).toBe(key.publicKey);
  });

  it("rejects truncated, altered or foreign keys", () => {
    expect(() => parseLinkOrKey(key.secretKey.slice(0, -5))).toThrow(LinkError);
    expect(() => parseLinkOrKey("secp256k1:abc")).toThrow(LinkError);
    expect(() => parseLinkOrKey("https://x.test/c")).toThrow(LinkError);
    expect(() => parseLinkOrKey("ed25519:0OIl")).toThrow(LinkError);
    expect(() => parseLinkOrKey("")).toThrow(LinkError);
  });

  it("generates distinct keys", () => {
    const other = newLinkKey();
    expect(other.publicKey).not.toBe(key.publicKey);
    expect(ed25519KeyBytes(other.secretKey)).toBe(64);
    expect(ed25519KeyBytes(other.publicKey)).toBe(32);
  });
});

describe("base58", () => {
  it("decodes known vectors", () => {
    expect(Buffer.from(base58Decode("11")).toString("hex")).toBe("0000");
    expect(Buffer.from(base58Decode("2NEpo7TZRRrLZSi2U")).toString("utf8")).toBe("Hello World!");
    expect(() => base58Decode("0")).toThrow();
    expect(ed25519KeyBytes("nope")).toBe(-1);
  });
});
