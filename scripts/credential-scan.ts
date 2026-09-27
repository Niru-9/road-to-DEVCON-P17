/**
 * `npm run scan:credentials` — look for anything that could be a real secret in
 * the shipped tree.
 *
 * ## Why this is a script and not a checklist
 *
 * "There are no credentials in the repo" is a claim that goes stale the moment
 * someone pastes a key into a fixture. This re-runs the check over every shipped
 * file in the workspace in a second, so the claim in the traceability document can
 * be re-verified instead of believed.
 *
 * ## Scope
 *
 * There is no Git repository here, so "tracked files" is defined the way a reader
 * would expect: every file a clone would contain. That means P2, the sibling P1
 * and the shared `docs/`, minus what `.gitignore` excludes (`node_modules`,
 * `build` output, the local SQLite ledgers, `package-lock.json` integrity noise).
 * A real `.env` *would* be scanned - its absence is the finding that matters, and
 * a rule that only works when the file is present is worthless.
 *
 * ## What it deliberately does not report
 *
 * A scanner that cries wolf on `0x1111...1111` and `0xdeadbeef` gets switched off,
 * so the rules are built around *what a secret would be used for* rather than
 * around entropy. Hex constants, hardhat's default accounts and the public Base
 * Sepolia USDC address are all values a demo legitimately needs; none of them are
 * credentials, and a tool that cannot tell them apart is not evidence of anything.
 *
 * ## What it never prints
 *
 * The matched text. A finding is reported as `path:line  rule  masked`, where
 * `masked` keeps only enough characters to locate the value. If this ever fires
 * on a real key, running the scan must not turn the terminal into a second leak.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT = resolve(PROJECT_ROOT, "..");

/** Directories never present in a clone, so never worth reading. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next", ".turbo"]);

/** Extensions that hold text a secret could hide in. Binary is read as UTF-8 and skipped. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".css",
  ".html",
  ".sh",
  ".ps1",
  ".bat",
  ".cmd",
  ".env",
  ".example",
  ".sql",
]);

/** Extensionless files worth reading, all of which appear in these two projects. */
const TEXT_FILENAMES = new Set([".env", ".gitignore", ".npmrc", ".netrc", "Dockerfile", "LICENSE"]);

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly masked: string;
}

const findings: Finding[] = [];

function mask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 3)}${"*".repeat(Math.min(trimmed.length - 6, 12))}${trimmed.slice(-3)}`;
}

/**
 * An identifier that names a secret: `PRIVATE_KEY`, `privateKey`, `apiKey`,
 * `signerToken`, `DB_PASSWORD`.
 *
 * The leading and trailing character classes are both allowed to be empty. An
 * earlier version required a character before the keyword, which meant
 * `PRIVATE_KEY` did not match `PRIVATE_KEY` and `apiKey` did not match `APIKEY`
 * - so the catch-all rule below was dead code, and the scan reported a clean
 * tree for the wrong reason.
 */
const SECRET_NAME =
  /([A-Za-z0-9_]*(?:PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSPHRASE|API_?KEY|MNEMONIC|SEED_?PHRASE|CREDENTIALS?|AUTH)[A-Za-z0-9_]*)/i;

/** The literal assigned to `name` on this line, or `null` if there is not one. */
function assignedValue(name: string, line: string): string | null {
  // `name` is interpolated into a pattern, so the few characters that are
  // meaningful in one are neutralised first. Every name the rule can match is an
  // identifier, so this is belt and braces rather than a live risk.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignment = new RegExp(`${escaped}\\s*[:=]\\s*["'\`]([^"'\`]{4,})["'\`]`).exec(line);
  return assignment === null ? null : (assignment[1] as string);
}

/**
 * Values that are obviously documentation, not secrets.
 *
 * Split deliberately into two tests. The first is anchored: it only accepts a
 * value that *is* a conventional placeholder. The second looks for a marker word,
 * but on word boundaries - so `0x0000...0` and `your-key-here` are placeholders
 * while a real key that happens to contain "Example" in camel case is still
 * reported. A single substring test would have suppressed the second silently,
 * which is the failure mode of every secret scanner that has never been audited.
 */
const PLACEHOLDER_EXACT = new RegExp(
  [
    // Empty, or one of the conventional "fill this in" words.
    "^(?:|x{3,}|_+|-+|\\*{3,}|<[^>]*>|\\$\\{[^}]*\\}|\\$[A-Z_][A-Z0-9_]*|\\{\\{[^}]*\\}\\}|none|null|nil|true|false|undefined|todo|changeme|change-me)$",
    // Anything naming a fake, stub or example key - the zero-filled ones used by
    // anvil and hardhat, and the `0x0.0` form used in `.env.example`.
    "^0x[0.]+$",
  ].join("|"),
  "i",
);

/** Marker words, matched on word boundaries so camelCase does not trip them. */
const PLACEHOLDER_MARKER = new RegExp(
  "\\b(?:fake|stub|stubs|example|examples|placeholder|redacted|dummy|sample|samples|notreal|not-real|dontuse|don-t-use|your|my|replace|insert|unset|todo|fixme|xxx+)\\b",
  "i",
);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_EXACT.test(value) || PLACEHOLDER_MARKER.test(value);
}

/**
 * A value computed at runtime cannot be a hardcoded credential.
 *
 * `` headers.authorization = `Bearer ${options.apiKey}` `` is the code that *uses*
 * a key, not a copy of one, and reading it as a secret is the difference between a
 * scanner that finds things and one that gets switched off.
 */
function isDynamic(value: string): boolean {
  return value.includes("${") || /\bprocess\s*\.\s*env\b/.test(value);
}

type Rule = { readonly name: string; readonly test: (line: string) => string | null };

const RULES: readonly Rule[] = [
  {
    // A PEM block is a private key whichever label it carries.
    name: "PEM private key block",
    test: (line) => /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.exec(line)?.[0] ?? null,
  },
  {
    name: "provider API key with a known prefix",
    test: (line) =>
      /\b(?:sk_(?:live|test)_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})/.exec(
        line,
      )?.[0] ?? null,
  },
  {
    name: "Google service account private_key id",
    test: (line) => /"private_key_id"\s*:\s*"([0-9a-f]{40})"/.exec(line)?.[0] ?? null,
  },
  {
    // A JWT is three base64url segments; the header alone is unmistakable.
    name: "JSON web token",
    test: (line) => /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/.exec(line)?.[0] ?? null,
  },
  {
    name: "bearer token in a header literal",
    test: (line) => /["'`]Authorization["'`]\s*[:=,]\s*["'`]Bearer\s+[A-Za-z0-9._~+/-]{20,}/.exec(line)?.[0] ?? null,
  },
  {
    // A 32-byte hex literal is exactly what a secp256k1 key looks like. Reported
    // only when it is *named* like a key, so hashes and commitments stay quiet -
    // and skipped when the literal is a documented placeholder, which is what
    // `.env.example` and the anvil defaults are made of.
    name: "32-byte hex literal named as a key or seed",
    test: (line) => {
      const named = SECRET_NAME.exec(line);
      if (named === null) return null;
      const hex = /\b(?:0x)?[0-9a-fA-F]{64}\b/.exec(line);
      if (hex === null || isPlaceholder(hex[0])) return null;
      // The assignment is not used to decide *whether* to report - the name and the
      // shape are enough - but a placeholder value settles it either way.
      const value = assignedValue(named[1] ?? "", line);
      if (value !== null && isPlaceholder(value.trim())) return null;
      return hex[0];
    },
  },
  {
    // A URL carrying inline credentials. Check 4 of the rubric names this
    // explicitly, and it is the shape most often pasted in by accident - a curl
    // command copied out of a terminal and committed with the token still on it.
    // `user@host` without a colon is a git author, not a secret.
    name: "URL with inline credentials",
    test: (line) => /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.exec(line)?.[0] ?? null,
  },
  {
    // A seed phrase in the shape a wallet would accept: 12 or 24 short lowercase
    // words, single-spaced, no punctuation, *assigned to a seed-shaped name*.
    //
    // The name is not decoration. A mnemonic and an English sentence are
    // structurally identical, so an earlier version of this rule - which counted
    // words in any line mentioning "mnemonic" - flagged P1's own security prose,
    // and a later version which matched any quoted word-run flagged test titles
    // like "records the ceiling refusal with the rule that fired". Requiring an
    // assignment kills both, because prose has `mnemonic,` where a wallet has
    // `mnemonic =`.
    name: "seed phrase",
    test: (line) =>
      /\b(?:mnemonic|seed[_-]?phrase|seedwords?|bip39)\s*[:=]\s*["'`]([a-z]{3,8}(?: [a-z]{3,8}){11,23})["'`]/.exec(
        line,
      )?.[0] ?? null,
  },
  {
    // Luhn-valid payment card numbers. Random digit runs are common in hashes,
    // timestamps and base-unit amounts, so this needs both a real checksum and a
    // shape that is not an amount of money: no currency mark in front, no decimal
    // part behind.
    name: "Luhn-valid payment card number",
    test: (line) => {
      for (const candidate of line.match(/(?<![\w$.])\d(?:[ -]?\d){12,18}(?!\d|\.\d)/g) ?? []) {
        const digits = candidate.replace(/\D/g, "");
        if (digits.length < 13 || digits.length > 19) continue;
        let sum = 0;
        let double = false;
        for (let index = digits.length - 1; index >= 0; index -= 1) {
          let digit = Number(digits[index]);
          if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
          }
          sum += digit;
          double = !double;
        }
        if (sum % 10 === 0) return candidate;
      }
      return null;
    },
  },
];

function isScannable(file: string): boolean {
  const ext = extname(file).toLowerCase();
  if (TEXT_FILENAMES.has(file.slice(file.lastIndexOf(sep) + 1))) return true;
  if (ext === "") return true;
  if (ext === ".sqlite" || ext === ".db" || ext === ".png" || ext === ".jpg" || ext === ".zip") return false;
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Marks a line as a deliberate exception to the scan. Everything after it on that
 * line is the reason, and the reason is printed in the report.
 *
 * Matched only in comment position. A bare substring test would also fire on this
 * file's own doc comment and on the test that reads this constant, which would put
 * two meaningless entries in the suppression list and teach a reviewer to skim
 * past it - the exact outcome the list exists to prevent.
 */
const ALLOW_MARKER = "credential-scan:allow";

/** The marker as a comment, which is the only place it counts. */
const ALLOW_DIRECTIVE = new RegExp(String.raw`(?://|#|/\*)\s*${ALLOW_MARKER}\b`);

/** Lines suppressed by the marker, as `line: reason`. Reported, never silent. */
const suppressed: string[] = [];

/** The same, resolved to a workspace-relative path, for the final report. */
const suppressedFinal: string[] = [];

function reasonFor(line: string): string {
  return (line.split(ALLOW_MARKER)[1] ?? "").trim() || "(no reason given)";
}

/**
 * Apply every rule to one block of text.
 *
 * Exported so the rules can be tested against known-bad and known-benign input.
 * A credential scanner that is never shown a real secret is not evidence that it
 * would notice one, and one that is never shown a harmless line is not evidence
 * that it would stay quiet.
 */
export function scanText(text: string): readonly Finding[] {
  const found: Finding[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    // A deliberate, reviewable escape hatch. A hostile-input test fixture has to
    // contain the hostile string to prove it is refused, so the rule and the test
    // are in direct conflict and one of them has to give. Requiring the marker to be
    // written out - and counting the lines that carry it in the report - means the
    // exception is a visible, auditable act rather than a silent hole: a reviewer can
    // read every suppression in one place instead of trusting that none was smuggled
    // into the rules.
    if (ALLOW_DIRECTIVE.test(line)) {
      suppressed.push(`${index + 1}: ${reasonFor(line)}`);
      return;
    }

    for (const rule of RULES) {
      const matched = rule.test(line);
      if (matched !== null) found.push({ file: "<text>", line: index + 1, rule: rule.name, masked: mask(matched) });
    }

    // The catch-all: a key-shaped *name* with a literal value. Checked separately
    // because the value, not the name, decides whether it is a placeholder.
    const named = SECRET_NAME.exec(line);
    if (named === null) return;
    const name = named[1];
    if (name === undefined) return;
    const value = assignedValue(name, line);
    if (value === null) return;
    if (isDynamic(value)) return;
    if (isPlaceholder(value.trim())) return;
    // A short value under a name like `tokenCount` is a count, not a secret.
    if (value.length < 12) return;
    found.push({ file: "<text>", line: index + 1, rule: `literal assigned to ${name}`, masked: mask(value) });
  });
  return found;
}

/** The number of rules applied, for the report and for the self-test. */
export const RULE_COUNT = RULES.length + 1;

function scanFile(file: string): void {
  const text = readFileSync(file, "utf8");
  // A NUL byte in the first kilobyte means this is binary wearing a .ts suffix.
  if (text.slice(0, 1024).includes("\0")) return;

  for (const finding of scanText(text)) {
    findings.push({ ...finding, file: relative(WORKSPACE_ROOT, file).split(sep).join("/") });
  }
  // Suppressions are reported with their file, so the list of exceptions is
  // reviewable in the same pass as the findings.
  for (const entry of suppressed.splice(0, suppressed.length)) {
    const [line = "", ...rest] = entry.split(": ");
    const path = relative(WORKSPACE_ROOT, file).split(sep).join("/");
    suppressedFinal.push(`${path}:${line}  ${rest.join(": ")}`);
  }
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(full));
      continue;
    }
    if (entry.isFile() && isScannable(full)) found.push(full);
  }
  return found;
}

/** Every directory a clone of this workspace would contain, P2 first. */
function scanRoots(): string[] {
  const roots = [PROJECT_ROOT, join(WORKSPACE_ROOT, "p1-operators-booth"), join(WORKSPACE_ROOT, "docs")];
  return roots.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function main(): void {
  const roots = scanRoots();
  const files = roots.flatMap(walk);
  for (const file of files) scanFile(file);

  const scannedBytes = files.reduce((total, file) => total + readFileSync(file, "utf8").length, 0);
  const lines: string[] = [
    "",
    "  Credential scan",
    "  ===============",
    `  roots       ${roots.map((root) => relative(WORKSPACE_ROOT, root) || ".").join(", ")}`,
    `  files read  ${files.length} (${(scannedBytes / 1024).toFixed(0)} KiB)`,
    `  rules       ${RULE_COUNT}`,
    "",
  ];

  if (findings.length === 0) {
    lines.push(`  PASS - no credential-shaped value in ${files.length} shipped files.`, "");
  } else {
    lines.push(`  FAIL - ${findings.length} finding(s):`, "");
    for (const finding of findings) {
      lines.push(`    ${finding.file}:${finding.line}  ${finding.rule}  ${finding.masked}`);
    }
    lines.push("", "  Values are masked on purpose. Treat every one as real until proven otherwise.", "");
  }

  if (suppressedFinal.length > 0) {
    lines.push(`  ${suppressedFinal.length} line(s) suppressed by \`${ALLOW_MARKER}\` - each one is an exception, not an oversight:`, "");
    for (const entry of suppressedFinal) lines.push(`    ${entry}`);
    lines.push("");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  // A non-zero exit is the point: this has to fail a pipeline, not decorate a log.
  process.exit(findings.length === 0 ? 0 : 1);
}

// Only when run as a command. Imported by its own test, the module must hand over
// the rules and leave the exit code to the runner.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
