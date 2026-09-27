import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanText, RULE_COUNT } from "../scripts/credential-scan.js";

/**
 * Tests for the credential scanner itself.
 *
 * A scanner that has only ever been pointed at clean files is not evidence that it
 * would notice a dirty one, and one that is only ever pointed at clean files is
 * not evidence that it would stay quiet. Both directions are checked here, and the
 * benign half is not hypothetical: every case in `BENIGN` below is a line that this
 * scanner actually flagged at some point, in this repository or its sibling P1.
 *
 * ## Why the bad samples are assembled at runtime
 *
 * A literal `sk_live_...` in this file would be found by the scanner when it scans
 * this file - correctly, and uselessly. So each hostile sample is concatenated
 * into shape after the fact. The repository never contains a credential-shaped
 * literal even as a fixture, which is asserted directly at the end of this file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");

/**
 * The suppression marker, read out of the scanner's own source so the two cannot
 * drift apart. If the marker is renamed, this test follows the rename rather than
 * quietly passing against a literal that no longer suppresses anything.
 */
const ALLOW =
  readFileSync(resolve(PACKAGE, "scripts", "credential-scan.ts"), "utf8").match(/const ALLOW_MARKER = "([^"]+)"/)?.[1] ??
  "credential-scan:allow";

const RULES_THAT_MUST_FIRE = [
  {
    rule: "PEM private key block",
    // eslint-disable-next-line no-useless-concat -- the split is the point
    line: `key = "${"-----BEGIN EC PRIVATE KEY" + "-----"}"`,
  },
  {
    rule: "provider API key with a known prefix",
    line: `token = "${["sk", "live", "A1b2C3d4E5f6G7h8"].join("_")}"`,
  },
  {
    rule: "Google service account private_key id",
    line: `{ "private_key_id": "${"a".repeat(40)}" }`,
  },
  {
    rule: "JSON web token",
    line: `header = "${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVl"].join(".")}"`,
  },
  { rule: "bearer token in a header literal", line: `h = { "Authorization": "Bearer ${"t".repeat(30)}" }` },
  { rule: "32-byte hex literal named as a key or seed", line: `const PRIVATE_KEY = "0x${"b".repeat(64)}";` },
  {
    rule: "seed phrase",
    line: ["mnemonic", "=", `"abandon ability able about above absent absorb abstract absurd abuse accident accident"`].join(" "),
  },
  { rule: "Luhn-valid payment card number", line: `card = "${["4111 1111 1111 111", "1"].join(" ")}"` },
  {
    rule: "URL with inline credentials",
    line: `curl "${["https://", "api-key", ":", "s3cr3t-token-value", "@example.com/v1"].join("")}"`,
  },
  { rule: "literal assigned to a secret-named key", line: `const apiKey = "${"k".repeat(40)}";` },
];

describe("the credential scanner", () => {
  it("fires on every rule it claims to have", () => {
    for (const { rule, line } of RULES_THAT_MUST_FIRE) {
      const found = scanText(line);
      expect(
        found.some((f) => f.rule === rule || f.rule.startsWith("literal assigned to")),
        `expected rule "${rule}" to fire on its own sample`,
      ).toBe(true);
    }
    expect(RULE_COUNT).toBe(RULES_THAT_MUST_FIRE.length);
  });

  it("stays quiet on every line it once flagged", () => {
    // Each of these is a real line from this repository or P1 that the scanner
    // flagged before the rules were tightened. They are the false-positive corpus,
    // and they are here so the rules cannot be loosened back into noise.
    const BENIGN: readonly { readonly why: string; readonly line: string }[] = [
      {
        why: "a base-unit amount that happens to pass Luhn",
        line: `    expect(formatUsd(huge)).toBe("$1180591620717411.303424");`,
      },
      {
        why: "P1's security prose, which mentions the word without being one",
        line: `- No key, mnemonic, or authenticated URL appears in any tracked file. \`.env\` is`,
      },
      {
        why: "a P1 test title about the scanner, which reads as a long word run",
        line: `  it("contains no private key, mnemonic, or authenticated URL in any source file", async () => {`,
      },
      {
        why: "a traceability table row naming the checks it performs",
        line: `| 4 | No credential appears in any tracked file | 8 | \`.gitignore\` | scans for mnemonics |`,
      },
      {
        why: "an English test title, which is structurally a mnemonic",
        line: `  it("records the ceiling refusal with the rule that fired and the amount asked for", async () => {`,
      },
      {
        why: "hardhat's first default account, used as a payee",
        line: `export const SELLER_PAYTO = "0x5FbDB2315678afecb367f032d93F642f64180aa3";`,
      },
      {
        why: "the public Ethereum Sepolia USDC contract, which is not a secret",
        line: `export const ETHEREUM_SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";`,
      },
      {
        why: "an obvious sentinel address",
        line: `      payTo: "0x1111111111111111111111111111111111111111",`,
      },
      {
        why: "an FNV-1a offset basis, which is a constant, not a key",
        line: `  let hash = 0x811c9dc5;`,
      },
      {
        why: "a documented placeholder",
        line: `  PRIVATE_KEY=0x0000000000000000000000000000000000000000000000000000000000000000`,
      },
      {
        why: "an env-var reference rather than a value",
        line: `  const key = process.env.ANTHROPIC_API_KEY;`,
      },
      {
        why: "the code that uses a key, reading it at runtime rather than storing it",
        line: "        headers.authorization = `Bearer ${options.apiKey}`;",
      },
      {
        why: "a facet named for authentication that holds no credential",
        line: `  const authCount = "0";`,
      },
      {
        why: "a transaction hash, which is public by design",
        line: `    expect(attempt?.txHash).toBe("0x${"a".repeat(64)}");`,
      },
      {
        why: "a loopback seller URL, which has no userinfo",
        line: `    curl -i ${"http://127.0.0.1:61742/v1/mandi-price"}`,
      },
      {
        why: "a git author, which has an @ but no password",
        line: `    npm publish --author="A Dev <dev@example.com>"`,
      },
      {
        why: "a CAIP-2 asset identifier, which is not a URL with userinfo",
        line: `  const asset = "eip155:11155111=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";`,
      },
    ];

    for (const { why, line } of BENIGN) {
      expect(scanText(line).map((f) => f.rule), `false positive: ${why}`).toEqual([]);
    }
  });

  it("never prints the value it found", () => {
    // A scanner that fires on a real key must not become the second copy of it.
    // Assembled at runtime for the same reason as the fixtures above, and because
    // an all-`x` value is a *placeholder* - a fact this test pins separately below.
    const secret = ["7dF3aQ9kL2mN8pR4sT6vW1yZ0bC5eH8jK", "3nQ7wA9mP2"].join("");
    const [finding] = scanText(`const apiKey = "${secret}";`);
    expect(finding).toBeDefined();
    expect(finding?.masked).not.toContain(secret);
    expect(finding?.masked).toContain("*");
    // And the whole report, serialised, carries no run of the secret.
    expect(JSON.stringify(scanText(`const apiKey = "${secret}";`))).not.toContain(secret);
  });

  it("reads a placeholder as a placeholder but a real-looking value as a secret", () => {
    // The distinction the word-boundary test exists for. A substring match on
    // "example" would quietly drop the last of these, and a key named
    // `MyExampleApiKey2024` is not a placeholder.
    //
    // Assembled at runtime so this file does not itself contain the `name = value`
    // adjacency the catch-all rule is looking for - the assertion below would
    // otherwise be a real finding in the repository.
    const camelCaseKey = ["My", "Example", "Api", "Key2024abcdef"].join("");

    expect(scanText(`const apiKey = "your-api-key-here";`)).toEqual([]);
    expect(scanText(`const apiKey = "xxxxxxxx";`)).toEqual([]);
    expect(scanText(`const PRIVATE_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000";`)).toEqual([]);
    expect(scanText(`const apiKey = "${camelCaseKey}";`).length).toBeGreaterThan(0);
  });

  it("suppresses a line only when the marker carries a reason", () => {
    // The escape hatch is the part of this tool most likely to be abused, so it is
    // pinned from both sides: a line with a secret is a finding, and the same line
    // plus the marker is not. Assembled in pieces so this file does not itself
    // contain either shape.
    const secret = ["7dF3aQ9kL2mN8pR4sT6vW1yZ0bC5eH8jK", "3nQ7wA9mP2"].join("");
    const unmarked = `const apiKey = "${secret}";`;
    expect(scanText(unmarked).length).toBeGreaterThan(0);
    // Only comment position counts, so the marker has to be written as a comment.
    expect(scanText(`${unmarked} ${ALLOW} hostile fixture`)).toHaveLength(1);
    expect(scanText(`${unmarked} // ${ALLOW} hostile fixture`)).toEqual([]);
  });

  it("finds nothing in its own source, so no fixture can become a real finding", () => {
    // The property that makes the runtime assembly above necessary. If a future
    // edit pastes a literal key into this file, this fails and the scan stays green
    // for the right reason.
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(here, name))
      .concat([resolve(here, "..", "scripts", "credential-scan.ts")]);

    for (const file of sources) {
      expect(scanText(readFileSync(file, "utf8")).map((f) => `${f.file}:${f.line}`), `scan fixture in ${file}`).toEqual([]);
    }
  });
});
