import { Transaction } from "@mysten/sui/transactions";
import { describe, expect, it } from "vitest";
import {
  bucketLabel,
  computeBucketOdds,
  computeOdds,
  createSelloutMarketTx,
} from "../predict";

// Smoke tests for the chain-free, deterministic parts of the predict module:
// the parimutuel odds math, bucket labelling, and that a PTB constructor returns
// a real `Transaction`. No wallet, network, or signing is involved.

describe("computeOdds", () => {
  it("returns a 50/50 sentinel for an empty pool (no information)", () => {
    expect(computeOdds(0n, 0n)).toEqual({ yesPct: 50, noPct: 50 });
  });

  it("splits the pool proportionally", () => {
    expect(computeOdds(75n, 25n)).toEqual({ yesPct: 75, noPct: 25 });
  });

  it("yesPct and noPct always sum to 100", () => {
    const { yesPct, noPct } = computeOdds(1n, 2n);
    expect(yesPct + noPct).toBeCloseTo(100, 10);
  });
});

describe("computeBucketOdds", () => {
  it("returns an equal split for an empty pool", () => {
    expect(computeBucketOdds([0n, 0n, 0n])).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });

  it("weights buckets by their stake", () => {
    expect(computeBucketOdds([10n, 30n])).toEqual([25, 75]);
  });
});

describe("bucketLabel", () => {
  it("labels the first, middle, and last (open-ended) buckets", () => {
    const cutoffs = [250n, 500n];
    expect(bucketLabel(cutoffs, 0)).toBe("0–249");
    expect(bucketLabel(cutoffs, 1)).toBe("250–499");
    expect(bucketLabel(cutoffs, 2)).toBe("500+");
  });

  it("falls back to 'Bucket i' for an out-of-range index", () => {
    expect(bucketLabel([250n], 5)).toBe("Bucket 5");
  });
});

describe("createSelloutMarketTx", () => {
  it("builds a Transaction (the PTB constructor wires a move call without a wallet)", () => {
    const tx = createSelloutMarketTx(
      "0x0000000000000000000000000000000000000000000000000000000000000abc",
      "0x2::sui::SUI",
    );
    expect(tx).toBeInstanceOf(Transaction);
    // The built command list contains exactly the create move call.
    const data = tx.getData();
    expect(data.commands).toHaveLength(1);
    expect(data.commands[0].$kind).toBe("MoveCall");
  });
});
