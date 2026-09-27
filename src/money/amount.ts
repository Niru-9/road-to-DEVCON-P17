/**
 * Money, in base units, as `bigint`.
 *
 * A token's smallest unit is an integer. There is no other representation in
 * this codebase — not in the policy, not in the ledger, not in the purse. If a
 * number can leave this module as a `number`, something has gone wrong.
 *
 * The rule this module exists to enforce: **a quoted amount is either a
 * canonical decimal string or it is a rejection.** Never a float, never a
 * rounded value, never a best guess.
 */

/**
 * Nominal type for a token amount in base units. Structurally just `bigint`;
 * the alias exists so that a signature reading `Atomic` says what it means.
 */
export type Atomic = bigint;

/** Thrown when a value is not a canonical base-unit integer string. */
export class AtomicFormatError extends Error {
  readonly value: string;
  readonly context: string;

  constructor(value: string, context: string, detail: string) {
    super(`${context}: ${detail} (received ${JSON.stringify(value)})`);
    this.name = "AtomicFormatError";
    this.value = value;
    this.context = context;
  }
}

/**
 * Canonical form: no sign, no leading zeros, no decimal point, no exponent, no
 * separators, no whitespace.
 *
 * Rejecting `"1.5"` matters more than it looks. A seller that quotes a
 * fractional base-unit amount is either broken or probing, and rounding it to
 * `1` or `2` is a decision this agent is not entitled to make on the seller's
 * behalf. Rejecting `"007"` matters because two different strings for the same
 * amount would defeat the exact-match reconciliation in the ledger.
 */
const CANONICAL_ATOMIC = /^(?:0|[1-9][0-9]*)$/;

/** Decimals of the assets this agent accepts. USDC and friends: 6. */
export const USDC_DECIMALS = 6;

/**
 * Parse a canonical decimal string into base units.
 *
 * @param value    the quoted amount, exactly as the seller wrote it
 * @param context  where the value came from, used in the error message
 */
export function parseAtomic(value: string, context = "amount"): Atomic {
  if (typeof value !== "string") {
    throw new AtomicFormatError(String(value), context, "amount is not a string");
  }
  if (!CANONICAL_ATOMIC.test(value)) {
    if (/^-?[0-9]*\.[0-9]+$/.test(value)) {
      throw new AtomicFormatError(
        value,
        context,
        "amount has a decimal point; base units are whole numbers",
      );
    }
    if (/[eE]/.test(value)) {
      throw new AtomicFormatError(value, context, "amount uses exponent notation");
    }
    if (/^0[0-9]/.test(value)) {
      throw new AtomicFormatError(value, context, "amount has a leading zero");
    }
    if (/^-/.test(value)) {
      throw new AtomicFormatError(value, context, "amount is negative");
    }
    if (value !== value.trim()) {
      throw new AtomicFormatError(value, context, "amount has surrounding whitespace");
    }
    throw new AtomicFormatError(value, context, "amount is not a base-10 integer string");
  }
  return BigInt(value);
}

/** Render base units as the canonical decimal string used in storage. */
export function formatAtomic(value: Atomic): string {
  if (typeof value !== "bigint") {
    throw new TypeError(`formatAtomic expects a bigint, received ${typeof value}`);
  }
  return value.toString(10);
}

/** Addition. Both operands are already base units, so the sum is exact. */
export function addAtomic(a: Atomic, b: Atomic): Atomic {
  return a + b;
}

/** Subtraction. Callers that could underflow must check `available` first. */
export function subtractAtomic(a: Atomic, b: Atomic): Atomic {
  if (a < b) {
    throw new RangeError(
      `refusing to underflow: ${formatAtomic(a)} - ${formatAtomic(b)} is negative`,
    );
  }
  return a - b;
}

/** Total a collection of amounts. Starts at zero, so it is exact. */
export function sumAtomic(values: Iterable<Atomic>): Atomic {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

/** -1, 0 or 1. */
export function compareAtomic(a: Atomic, b: Atomic): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when `amount` is strictly greater than `ceiling`. */
export function exceedsAtomic(amount: Atomic, ceiling: Atomic): boolean {
  return amount > ceiling;
}

/** True when `amount` fits within `ceiling`, inclusive. */
export function fitsWithinAtomic(amount: Atomic, ceiling: Atomic): boolean {
  return amount <= ceiling;
}

/**
 * Render base units as dollars, for humans and logs only.
 *
 * The return value is the single place a decimal point is produced in this
 * codebase, and nothing ever reads it back. Comparisons never touch it.
 *
 * Trailing zeros are trimmed to at least two decimals, so a budget reads as
 * `$5.00` and a ceiling as `$0.025` rather than `$0.025000`. That is
 * presentation only — `formatAtomic` remains the canonical form for storage.
 */
export function formatUsd(amount: Atomic, decimals = USDC_DECIMALS): string {
  if (decimals < 0) {
    throw new RangeError(`decimals must be >= 0, received ${decimals}`);
  }
  const negative = amount < 0n;
  const digits = formatAtomic(negative ? -amount : amount);
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);

  if (decimals === 0) {
    return negative ? `-$${whole}` : `$${whole}`;
  }

  let fraction = padded.slice(padded.length - decimals);
  // Trim trailing zeros, but never below two decimals — "$5.00" reads as money,
  // "$5." does not.
  const trimmed = fraction.replace(/0+$/, "");
  fraction = trimmed.length >= 2 ? trimmed : fraction.slice(0, 2);

  const shown = `${whole}.${fraction}`;
  return negative ? `-$${shown}` : `$${shown}`;
}
