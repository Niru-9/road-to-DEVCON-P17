# Architecture

How Khata (खाता — a ledger or account book) is put together, and why each load-bearing
decision is a property of the control flow rather than a promise in a README.

Read `docs/p2-coin-purse-design.md` for the reasoning *before* the code, and
`docs/rubric-traceability.md` for check → file → test. This document is the
structure as it shipped. Every claim here is asserted by a test; where a test is
named, read it rather than trusting this file.

---

## 1. One tool, two fetches, and exactly one place a signature can exist

`paid_fetch` is an SSRF primitive by construction: a model gets to name a URL. The
entire design is about making that safe, and the shape is a two-step request
rather than a payment-wrapping helper.

```
paid_fetch(url)
   │
   ├─ SellerAllowlist.permits(url) ── may it *go* there?          tools.ts
   │      no  → refusal, no socket opened
   │
   ├─ fetch(url)                                    ← 1. ask, unpaid
   │      200 → free, or an error. No signature was possible.
   │      ≠402 → return as-is
   │
   ├─ decodeAndSelect(Payment-Required)  ← 2. hand-validated, then allowlist-filtered
   ├─ checkPerCall / checkCumulative               ← 3. policy, still no signature
   ├─ ledger.reserve(...)                           ← 4. durable, inside BEGIN IMMEDIATE
   │
   ├─ refuse → ledger row (refused) → back to the model as text
   │
   └─ approve → signer.createPaymentPayload()   ← THE FIRST MOMENT A SIGNATURE EXISTS
                 → encodePaymentSignatureHeader()
                 → fetch(url) with X-PAYMENT
                 → settle from Payment-Response, never from the quote
```

`src/x402/gate.ts` documents this order in its own header (step 6 is
`createPaymentPayload`). Two properties fall out of the *shape*:

- **Check 5 is structural.** The signer is reachable only from the `approve`
  branch, so "per-call ceiling compared before signing" is a property of the
  control flow. `tests/signing-gate.test.ts` asserts `signer.callCount === 0` on
  every refusal path rather than asserting a comment.
- **Refusal is free.** Everything before step 6 costs no money and cannot cost
  money, which is why the six abuses in §7 are demonstrable with no credentials
  at all.

**Why not `wrapFetchWithPayment`?** Because it requests, parses, signs and
retries with no seam to intervene, and "the tool did not call the limiter" becomes
a matter of configuration rather than something a reader can see. The two extra
lines are the price of an auditable order.

---

## 2. Money is `bigint` atomic units, and the ledger is the authority

Two separate decisions that are easy to conflate.

**Units.** `src/money/amount.ts` converts a canonical decimal `string` to `bigint`
and every comparison is integer. SQLite money columns are `TEXT`, not `REAL`, and
`setReadBigInts` appears nowhere — so 2^53 + 1 round-trips as 9007199254740993 and not 9007199254740992.
`tests/money.test.ts` includes that case deliberately.
`tests/rubric-traceability.test.ts` source-scans the money, policy and ledger
paths for `parseFloat`, so the property is checked rather than remembered.

**Authority.** The in-process `spentSoFar` is an optimisation, not the truth. The
cumulative check runs twice: once in `checkCumulative`
(`src/policy/policy.ts`) for a fast, specific refusal, and again inside
`Ledger.reserve` (`src/ledger/ledger.ts`) which re-reads the `runs.run_budget`
row within `BEGIN IMMEDIATE` before inserting the reservation. Two processes
racing the same budget cannot both win the second check. `committed()` is
re-derived on open rather than cached, so a reopened ledger does not inherit an
in-memory total.

The refusal names the rule and the number, not just "denied" — an over-ceiling
quote records `reason: "per-call-ceiling-exceeded"` and the amount asked for,
because a blanket "malformed" sends an operator to a different file.

---

## 3. Committed and held are different numbers, and the record keeps them apart

This was the one real defect in the shipped artefact, and it is worth stating
because the fix is a data-model decision, not a display fix.

- **`committedAtomic`** — money actually gone. Sums `settled` rows only.
- **`reservedAtomic`** — history. What an attempt asked for, whether or not it
  ever settled. An *interrupted* call still shows its original reservation here,
  because that is what the ledger recorded at the time.
- **`heldAtomic`** — *now*. What is still unresolved. Only `reserved` and
  `interrupted` rows hold anything; `settled`, `released` and `refused` hold
  `"0"`.

The first record's audit table summed `reservedAtomic` into a column headed
"Held", so a run with one unresolved 500-unit call displayed 15500 — the sum of
every reservation ever made, including six that had settled. The number was not
wrong arithmetically; it was answering a different question than the column asked.

So `heldNow()` lives in `src/app/record.ts` as the single definition, and both
consumers use it: the saved record and the SSE frame in `src/ui/server.ts`. That
is the actual fix — not two correct implementations, but one definition with two
callers. `assertHoldsAgree()` then rejects a record whose call rows, ledger rows
and totals disagree, so the two cannot drift apart silently.

`reserve` refuses on `committed + reserved` (not `committed` alone), so a hold
cannot be spent a second time either.

---

## 4. The tool schema is the boundary, not the prompt

There is no prompt telling the model to respect the budget, because a prompt is
advisory. Instead the tool it is shown has two properties and no limit-bearing
field at all:

```ts
PAID_FETCH_TOOL_PARAMETERS = {
  type: "object",
  properties: { url: …, label: … },
  required: ["url"],
  additionalProperties: false,
}
```

There is no `budget`, `perCallCeiling` or `skipPolicy` to read a limit *from*.
`additionalProperties: false` plus `.strict()` parsing turns an invented argument
into a **recorded refusal** rather than a silent default, so an attacker who
persuades the model to try `{"url": …, "budget": "99999999"}` produces an audit
row rather than a wider limit.

Two tests guard this from both sides: `tests/agent-loop.test.ts` sends 16
adversarial argument cases and asserts `signer.callCount === 0` *and* zero ledger
rows for each, and `tests/check9-tool-surface.test.ts` checks the surface the
model is actually shown — that the advertised JSON Schema and the zod schema
agree, and that no limit is reachable through the definition. The gate's own
`SigningGate.call()` takes no limit parameter either, so there is no third door.

---

## 5. Two allowlists, because there are two questions

- **What may we spend on?** `src/policy/allowlist.ts` — CAIP-2 network shape
  (`eip155:*` rejected), assets scoped per network as `network=0xaddress`.
- **Where may we go?** `SellerAllowlist` in `src/agent/tools.ts`, fed by
  `AGENT_ALLOWED_SELLER_HOSTS`.

They are independent on purpose. A policy that correctly allows Ethereum Sepolia
USDC still says nothing about whether the model may fetch
`http://169.254.169.254/`. The first answers "is this purchase sane", the second
answers "is this destination allowed", and collapsing them would mean fixing a
spend limit to also fix an SSRF hole.

`SellerAllowlist` accepts both `host` and `host:port` entries. A bare host
matches on hostname alone, which is a real limitation of the configured form and
is documented in `.env.example` — the demo does not rely on it (§6).

---

## 6. The transport guard stands down by design — and the port pin is what makes it stand up

`src/x402/guarded-transport.ts` is a deliberately redundant second check on the
destination, applied to the transport rather than the tool, so it is the last
thing before a socket exists. Redundancy is the point: a bug in URL parsing, a
mistyped allowlist entry, or a future code path that calls the gate directly
would all still be caught.

It engages only when

```ts
guardRequiredFor(allowlist) === allowlist.pinsPorts && allowlist.hosts.every(isLoopbackHost)
```

Both halves, or it stands down — because a deployment fetching a real seller over
HTTPS is the intended production shape and must not be broken by a guard written
for a laptop.

**The consequence is the interesting part.** The sellers bind an ephemeral port
per run, so a host-only allowlist is never port-pinned, so the last-line guard
would *never engage in the demo*. `startPurseRuntime` therefore builds its
allowlist from the two `host:port` pairs it has just bound, which pins the ports
and makes `requireLoopback` true. Deleting the ephemeral-port design would have
silently deleted the guard; deleting `HONEST_STALL_PORT` / `ROGUE_STALL_PORT` was
safe precisely *because* nothing read them. `transportGuardEngaged` is reported
in the runtime state, so the record says whether the guard was actually up rather
than the reader assuming it.

What the guard is not: not a production boundary. A local attacker who can start
a process can still be reached on loopback, and DNS rebinding is out of scope. It
converts a misconfiguration from "the model can read your local network" into "the
model can only read loopback" — the honest amount of safety available without a
network namespace.

---

## 7. The rogue stall is an instrument, not a fixture

`src/seller/rogue.ts` registers seven routes on a real `node:http` server, each
putting an abuse on the wire as bytes, headers and status codes, because that is
what a seller actually controls. A stubbed transport cannot catch a header-name
mistake, which is exactly the bug this project shipped and fixed.

| route | abuse | attacks |
|---|---|---|
| `/rogue/overpriced` | quotes 100× the honest price | the per-call ceiling |
| `/rogue/unknown-asset` | a token nobody has heard of | the asset allowlist |
| `/rogue/wrong-network` | pay me on Base mainnet | the network allowlist |
| `/rogue/unknown-scheme` | a scheme with no implementation | "an entry I do not understand is not one I sign" |
| `/rogue/bait-and-switch` | takes the money, reports 10× | settlement evidence |
| `/rogue/hostile-notes` | a 402 wrapped in prompt injection | the model's instructions |
| `/rogue/burner` | free twice, then demands money | the "is it free?" decision |
| `GET /rogue/state` | *not an abuse* — a counter endpoint tests read | — |

`BURNER_FREE_ITERATIONS = 2` is capped, and the cap is asserted: a long paid
burner would need a real signature per iteration, and with no key every one of
those rows would read `interrupted`. Two free calls make the free→paid transition
visible in one run instead.

`tests/rubric-traceability.test.ts` asserts all seven routes exist in the seller
*and* in `tests/sellers.test.ts`, and that no eighth is registered. That last
assertion exists because `/rogue/unknown-scheme` had been left out of the list
while both the route and its test existed — so deleting it would have passed a
test named after the claim. The `/rogue/state` slice is checked separately to
confirm it never asks for money.

---

## 8. Quarantine labels, and why the budget was never at risk

`toModelContent()` in `src/agent/dispatch.ts` renders any seller prose through
`Quarantined.render()`, which wraps it in `UNTRUSTED_SELLER_DATA` markers with a
`source` naming the tool and host, inside a `tool` message — never in the system
or user turn, where it could become an instruction.

Forwarding the injection is deliberate. Suppressing it would demonstrate nothing,
and a record that quietly dropped the attack would be indistinguishable from a run
where nothing was attempted. The text is preserved verbatim and asserted absent
from every trusted field.

The honest limit: `render()` *labels* rather than strips, so the real guarantee is
not the label. It is that the ceiling was read from the 402 requirements by the
gate before any model text existed (§1). The model cannot talk the budget up
because it never held the budget. `tests/agent-llm.test.ts` asserts both the
markers and the unchanged spend.

---

## 9. One dispatcher, two planners, identical policy

`ScriptedPlanner` (the default, so the demo needs no key) and `LlmPlanner` both
produce a tool call, and both go through the single `ToolDispatcher` in
`src/agent/dispatch.ts` to reach the single `SigningGate`. "Same policy either
way" is therefore structural: there is no second path to the gate for a live
model to drift onto.

`src/agent/llm.ts` is a real `POST {baseUrl}/chat/completions` client, and
`buildRequestBody` attaches the tool definition on **every** request with no code
path that omits it. `tests/agent-llm.test.ts` asserts `request.body.tools`
deep-equals the exported schema on every request, that a returned `tool_calls`
becomes a real paid fetch through the real gate, and that the result comes back as
a `tool` message — against a real in-process HTTP server, with only the model's
*output* scripted.

What is not claimed: no hosted model has been driven with a real key. There is no
model key in this environment. The tests prove the purse is unaffected by a
misbehaving model; they do not prove any particular model is well-behaved.

---

## 10. The UI and the record are the same truth, and the UI is read-only

`src/ui/server.ts` serves `public/` with no build step and no framework, over the
same runtime the demo uses. `GET /api/run` streams progress over SSE, and the
result frame carries `quotedAtomic`, `ledgerState` and `heldAtomic` from the same
ledger row the saved record uses (§3) — a live row that disagreed with the saved
one would be a lie told twice.

Read-only is enforced, not styled:

- The page has no input that can change a budget, ceiling, network, asset, scheme,
  payee, host or port.
- `POST /api/run` starts a run with whatever the environment already holds, so it
  cannot become a policy editor.
- Every other write-shaped request answers `405` with `allow: GET, POST`
  (`src/ui/server.ts:110`).

`npm run demo` deliberately does not exit: it serves the page and waits for
Ctrl-C. `npm run demo:headless` runs the identical path and exits, and is what
regenerates `record/decision-log.json`.

---

## 11. The vocabulary is the claim, and it is checked

The settlement vocabulary is exactly `not-reached | not-paid | settled-stub |
budget-held | free`, asserted by `tests/record.test.ts`. There is no bare `paid`
in it; the gate's own internal word (`gateOutcome`) is kept in a separate field so
the two vocabularies stay comparable without being conflated. `settled-stub` is a
deliberate admission, not a hedge: without a funded key, a "settled" amount is
what the local stub facilitator was *asked* to settle, and calling it anything
else would overclaim.

The record carries `chainTouched: false` and `realFundsMoved: false` in its own
`settlement` block, so the honest claim cannot be lifted out of context. **Nothing
in this repository has moved money.** A real settlement needs a wallet key and a
facilitator, neither of which is wired, and no command claims to do it.

`docs/rubric-traceability.md` is itself under test: every path in its table must
exist, no row may be marked Done without citing a real test, every test file must
be cited somewhere, the code claims are spot-checked against the source, and the
gaps it admits must still be listed. A table that drifts is worse than no table.

---

## Module map

| path | lines | role |
|---|---|---|
| `src/ledger/ledger.ts` | 805 | SQLite authority: reserve inside `BEGIN IMMEDIATE`, committed, holds |
| `src/x402/gate.ts` | 589 | `SigningGate` — the ordering in §1, and the only signer call site |
| `src/app/record.ts` | 509 | the decision record, `heldNow()`, `assertHoldsAgree()` |
| `src/policy/policy.ts` | 432 | frozen limits, `checkPerCall`, `checkCumulative` |
| `src/agent/tools.ts` | 395 | the tool schema, `SellerAllowlist` |
| `src/x402/decode.ts` | 353 | `Payment-Required` decode + `chooseQuote`; header name constants |
| `src/seller/rogue.ts` | 333 | the seven routes of §7 |
| `src/ui/server.ts` | 311 | the read-only server and the SSE stream |
| `src/app/runtime.ts` | 287 | wiring: pinned hosts, guard, ledger, planner |
| `src/agent/loop.ts` | 262 | `runAgent`, `ScriptedPlanner`, `LlmPlanner` |
| `src/agent/dispatch.ts` | 238 | the one dispatcher; quarantine rendering |
| `src/agent/llm.ts` | 233 | real `POST /chat/completions`, tools on every request |
| `src/seller/honest.ts` | 232 | the honest stall |
| `src/seller/facilitator.ts` | 202 | **stub** — structure check, no chain, no facilitator |
| `src/config/env.ts` | 195 | `loadConfig`, validated once at startup |
| `src/policy/allowlist.ts` | 162 | network + asset allowlist |
| `src/money/amount.ts` | 162 | `string` ⇄ `bigint` atomic units |
| `src/untrusted/quarantine.ts` | 161 | the fenced marker rendering |
| `src/seller/http.ts` | 156 | the `node:http` stall base |
| `src/seller/wire.ts` | 138 | `Payment-Response` encoding |
| `src/x402/http-transport.ts` | 113 | the real `fetch` boundary |
| `src/x402/guarded-transport.ts` | 109 | the last-line destination check of §6 |
| `src/seller/stub-signer.ts` | 104 | **stub** — real payload + real codec, constant signature |
| `src/ledger/sqlite.ts` | 55 | the `node:sqlite` handle |

The two files marked **stub** are where a real deployment would diverge, and both
are named as such in the record rather than hidden.
