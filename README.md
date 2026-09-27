# Khata — the Coin Purse

An LLM agent that answers a research question by buying data from paid x402
endpoints, and **cannot be drained** by a seller that misbehaves.

You hand it a purse: a per-call ceiling and a total budget. It reads each seller's
payment requirements, decides whether to sign, and writes every decision to a
ledger so you can audit the run afterwards. Refusals are recorded with the rule
that fired and the amount that was asked for.

- **Network:** Ethereum Sepolia (`eip155:11155111`, chain id 11155111)
- **Token:** Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, 6 decimals
- **Scheme:** x402 `exact`, EIP-712 domain `name: "USDC"`, `version: "2"`
- **Facilitator:** `https://facilitator.x402.rs`

## Install and run the demo

Requires Node 20.12+ (22 LTS recommended).

```powershell
npm install
npm run demo
```

No `.env` and no credentials are needed. The demo starts two local seller
processes — an honest stall and a rogue stall that overprices, quotes an
unknown asset, quotes the wrong network, free-loads then starts charging,
injects text at the model, and reports ten times what it was paid — runs the agent
against both, writes `record/decision-log.json`, and serves a read-only page.

The UI URL is printed near the end of the terminal output on an ephemeral port.
Stop with `Ctrl-C`.

Other entry points:

```powershell
npm run demo:headless   # same run, no UI, exits on its own
npm run agent           # the same run printed as CLI text
npm run ui              # serve the read-only page over an existing record
```

## What the demo should show

Ten tool calls, one per turn:

| Calls | Result |
|---|---|
| 1–4 honest routes | `settled-stub` |
| 5–6 rogue burner, first two visits | `free` — no payment requested |
| 7 rogue burner, now charging | `settled-stub` |
| 8 rogue over-price ($5.00 against a $0.025 ceiling) | `not-paid` |
| 9 rogue injection attempt | `settled-stub`, the text quarantined |
| 10 rogue claims 10× what it was paid | `budget-held`, $0.0005 still held |

Committed spend is exactly **$0.015** of a **$5.00** run budget. The page is
read-only: there is no input anywhere that can change a limit.

## Tests

```powershell
npm run typecheck
npm test
npm run scan:credentials
```

`npm run verify` runs all three. Results on the code in this repository:

| Command | Result |
|---|---|
| `npm run verify` | exit 0 — **458 / 458 passing**, 15 files |
| `npm run scan:credentials` | **PASS**, 87 files, 0 findings |

The suite is hermetic: real HTTP to real local sellers, real SQLite, no network
and no credentials. For reference, the UI is 212 lines of markup, 449 of CSS,
384 of plain JavaScript.

## No real money is involved

**Every settlement in this demo is a stub.** The signer is a deterministic local
stub and the facilitator settles in memory, so:

- **no chain is contacted and no funds move**;
- every settlement is labelled `settled-stub`, never `paid`;
- `record/decision-log.json` states `chainTouched: false` and
  `realFundsMoved: false` in its own settlement block.

The shipped record is a **real local run** — real HTTP, real SQLite, real
refusals — not a testnet run. It is included as the sample record the brief asks
for, and it is not evidence of a live payment. **No live payment has been made
and there is no transaction hash.**

## Limitations

1. **MetaMask payment is not integrated, and cannot be with this architecture.**
   The signing gate runs inside the Node agent process and calls
   `createPaymentPayload()` synchronously. A browser wallet lives in the browser,
   so a MetaMask signature cannot be obtained from inside that loop. Supporting it
   would mean moving the signing step out of the server — a redesign, not
   configuration.
2. **Real payment is switched off by design.** `EVM_PRIVATE_KEY` and `X402_PAY_TO`
   must be set together or not at all, so a recipient address alone cannot enable
   a payment path. No payer key or seed phrase belongs in this project, and none
   is included.
3. The committed decision record is a local run, not a testnet run (above).
4. The LLM planner is optional. `PURSE_PLANNER=scripted` is the default and needs
   no model key; `PURSE_PLANNER=llm` needs `LLM_BASE_URL` and `LLM_API_KEY`.
   The LLM choice is independent of any payment method.
5. No browser testing was performed.

## License

MIT.
