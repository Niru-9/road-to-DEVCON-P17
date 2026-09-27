import { describe, expect, it } from "vitest";
import {
  AtomicFormatError,
  addAtomic,
  compareAtomic,
  exceedsAtomic,
  fitsWithinAtomic,
  formatAtomic,
  formatUsd,
  parseAtomic,
  subtractAtomic,
  sumAtomic,
} from "../src/money/amount.js";

describe("Check 10 (6 pts) — amounts are compared in integer base units", () => {
  describe("parseAtomic accepts only canonical decimal strings", () => {
    it("accepts canonical integers", () => {
      expect(parseAtomic("0")).toBe(0n);
      expect(parseAtomic("1")).toBe(1n);
      expect(parseAtomic("500")).toBe(500n);
      expect(parseAtomic("4990000")).toBe(4_990_000n);
    });

    it.each([
      ["1.5", "decimal point"],
      ["0.1", "decimal point"],
      ["1e6", "exponent"],
      ["1E3", "exponent"],
      ["007", "leading zero"],
      ["0000", "leading zero"],
      ["-1", "negative"],
      ["+1", "not canonical"],
      [" 1", "whitespace"],
      ["1 ", "whitespace"],
      ["1,000", "separator"],
      ["0x10", "hex"],
      ["", "empty"],
      ["abc", "not a number"],
      ["NaN", "not a number"],
      ["Infinity", "not a number"],
      ["1.0", "decimal point"],
    ])("rejects %j (%s) rather than coercing it", (value) => {
      expect(() => parseAtomic(value)).toThrow(AtomicFormatError);
    });

    it("names the offending value in the error, so a rogue quote is legible", () => {
      expect(() => parseAtomic("1.5", "rogue quote")).toThrow(/rogue quote.*1\.5/);
    });

    it("does not accept a number where a string is required", () => {
      // A seller sending `amount: 5000` as a JSON number is not sending a
      // canonical string, and a float would have already lost the type that
      // proves it is an integer.
      expect(() => parseAtomic(5000 as unknown as string)).toThrow(AtomicFormatError);
    });
  });

  describe("arbitrary precision — the reason this is bigint and not number", () => {
    it("round-trips 2^53 + 1, which a JS number cannot represent", () => {
      const beyondDouble = 9_007_199_254_740_993n; // 2^53 + 1
      expect(beyondDouble).toBe(9_007_199_254_740_993n);
      // The same value as a double silently loses the last digit.
      expect(String(Number(beyondDouble))).toBe("9007199254740992");
      // Canonical string round-trips exactly.
      expect(formatAtomic(beyondDouble)).toBe("9007199254740993");
      expect(parseAtomic("9007199254740993")).toBe(beyondDouble);
    });

    it("round-trips a value far beyond signed 64-bit, which SQLite INTEGER cannot hold", () => {
      // 2^70 base units — a token with 18 decimals and a large supply.
      const huge = 1_180_591_620_717_411_303_424n; // 2^70
      expect(huge > 9_223_372_036_854_775_807n).toBe(true);
      expect(parseAtomic(formatAtomic(huge))).toBe(huge);
    });

    it("adds 1 + 2 to exactly 3, with no float anywhere near", () => {
      expect(addAtomic(1n, 2n)).toBe(3n);
      // The float this replaces would be 0.30000000000000004.
      expect(0.1 + 0.2 === 0.3).toBe(false);
      expect(addAtomic(100_000n, 200_000n)).toBe(300_000n);
    });

    it("sums a long list of small amounts exactly", () => {
      const amounts = Array.from({ length: 1_000 }, () => 1n);
      expect(sumAtomic(amounts)).toBe(1_000n);
    });
  });

  describe("arithmetic is total and refuses to underflow", () => {
    it("subtracts exactly", () => {
      expect(subtractAtomic(5_000_000n, 1_500_000n)).toBe(3_500_000n);
    });

    it("throws rather than returning a negative budget", () => {
      expect(() => subtractAtomic(100n, 101n)).toThrow(RangeError);
      expect(() => subtractAtomic(100n, 100n)).not.toThrow();
    });

    it("sums an empty collection to zero", () => {
      expect(sumAtomic([])).toBe(0n);
    });
  });

  describe("comparisons", () => {
    it("orders exactly at and around a boundary", () => {
      const ceiling = 25_000n;
      expect(exceedsAtomic(24_999n, ceiling)).toBe(false);
      expect(exceedsAtomic(25_000n, ceiling)).toBe(false); // inclusive
      expect(exceedsAtomic(25_001n, ceiling)).toBe(true);
      expect(fitsWithinAtomic(25_000n, ceiling)).toBe(true);
      expect(fitsWithinAtomic(25_001n, ceiling)).toBe(false);
    });

    it("compares to -1, 0 or 1", () => {
      expect(compareAtomic(1n, 2n)).toBe(-1);
      expect(compareAtomic(2n, 2n)).toBe(0);
      expect(compareAtomic(3n, 2n)).toBe(1);
    });
  });

  describe("formatting is display-only and never round-trips through a float", () => {
    it("renders base units as dollars", () => {
      expect(formatUsd(25_000n)).toBe("$0.025");
      expect(formatUsd(5_000_000n)).toBe("$5.00");
      expect(formatUsd(1n)).toBe("$0.000001");
      expect(formatUsd(0n)).toBe("$0.00");
      expect(formatUsd(4_990_000n)).toBe("$4.99");
    });

    it("formats a value larger than a double can hold without drift", () => {
      // 2^70 base units is $1,180,591,620,717,411.303424 — a value a double
      // cannot hold in the first place, and one that must not be rounded.
      const huge = 1_180_591_620_717_411_303_424n;
      expect(formatUsd(huge)).toBe("$1180591620717411.303424");
      // And the formatting agrees with bigint arithmetic, not with a float.
      expect(formatUsd(huge)).toBe(
        `$${(huge / 1_000_000n).toString()}.${(huge % 1_000_000n).toString().padStart(6, "0")}`,
      );
    });

    it("refuses a negative precision", () => {
      expect(() => formatUsd(1n, -1)).toThrow(RangeError);
    });
  });

  describe("type discipline", () => {
    it("rejects a non-bigint in formatAtomic", () => {
      expect(() => formatAtomic(500 as unknown as bigint)).toThrow(TypeError);
      expect(() => formatAtomic("500" as unknown as bigint)).toThrow(TypeError);
    });
  });
});
