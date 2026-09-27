/*
 * Khata demo UI.
 *
 * Read-only by construction: this file fetches `/api/policy` and `POST /api/run`
 * and nothing else. There is no input, no slider and no setter for a limit
 * anywhere in this script, so there is nothing here to tighten later — the page
 * cannot grow a policy control without someone writing one from scratch.
 *
 * Two things it does take seriously:
 *
 * 1. **Untrusted text stays fenced.** Seller bytes are rendered only inside
 *    `#untrusted`, as text nodes, never as HTML. `textContent` is used
 *    deliberately: a seller that returned `<img onerror=...>` gets a visible
 *    string, not script execution.
 *
 * 2. **Status is never colour alone.** Every settlement badge carries a word
 *    ("settled-stub", "not-paid", "budget-held", "free", "not-reached"), so the
 *    meaning survives greyscale, colour blindness and a screen reader.
 */

const $ = (id) => document.getElementById(id);

const els = {
  question: $("question"),
  ceiling: $("p-ceiling"),
  budget: $("p-budget"),
  networks: $("p-networks"),
  schemes: $("p-schemes"),
  hosts: $("p-hosts"),
  ledger: $("p-ledger"),
  planner: $("r-planner"),
  run: $("run"),
  status: $("status"),
  bar: $("b-bar"),
  fill: $("b-fill"),
  barText: $("b-text"),
  holds: $("b-holds"),
  calls: $("calls-body"),
  audit: $("audit-body"),
  untrusted: $("untrusted"),
};

/* ------------------------------------------------------------------ */
/* Policy: read once, display only                                      */
/* ------------------------------------------------------------------ */

async function loadPolicy() {
  let policy;
  try {
    policy = await (await fetch("/api/policy")).json();
  } catch {
    els.question.textContent = "The policy could not be read from the server.";
    return null;
  }

  els.question.textContent = policy.question;
  els.ceiling.textContent = `${policy.limits.perCallCeilingUsd} (${policy.limits.perCallCeilingAtomic} base units)`;
  els.budget.textContent = `${policy.limits.runBudgetUsd} (${policy.limits.runBudgetAtomic} base units)`;
  els.networks.textContent = policy.allowlist.networks.join(", ") || "none";
  els.schemes.textContent = policy.allowlist.schemes.join(", ") || "none";
  els.hosts.textContent = policy.allowlist.sellerHosts.join(", ") || "none";
  els.ledger.textContent = policy.ledgerPath;

  els.bar.setAttribute("aria-valuemax", policy.limits.runBudgetAtomic);
  els.barText.textContent = `$0.00 of ${policy.limits.runBudgetUsd}`;
  return policy;
}

/* ------------------------------------------------------------------ */
/* Small DOM helpers. Text only.                                        */
/* ------------------------------------------------------------------ */

function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function mono(value) {
  const span = document.createElement("span");
  span.className = "mono";
  span.textContent = value;
  return span;
}

function badge(status, gate) {
  const span = document.createElement("span");
  // The class is derived from a closed set on our side, never from seller text.
  span.className = `badge badge-${status.replace(/[^a-z-]/g, "")}`;
  span.textContent = status;
  if (gate && gate !== status) {
    const small = document.createElement("span");
    small.className = "badge-gate";
    small.textContent = `gate: ${gate}`;
    span.append(small);
  }
  return span;
}

/* ------------------------------------------------------------------ */
/* Budget bar                                                           */
/* ------------------------------------------------------------------ */

function setBudget(spentAtomic, budgetAtomic) {
  const spent = BigInt(spentAtomic);
  const budget = BigInt(budgetAtomic);
  // Integer maths in base units, then a percentage for the CSS width. Doing this
  // in floating point dollars would lose precision on small amounts.
  const pct = budget === 0n ? 0 : Number((spent * 10_000n) / budget) / 100;
  const clamped = Math.max(0, Math.min(100, pct));

  els.fill.style.width = `${clamped}%`;
  els.bar.setAttribute("aria-valuenow", String(Number((spent * 100n) / budget)));
  els.bar.setAttribute("aria-valuetext", `${usd(spent)} committed of ${usd(budget)}`);
  els.barText.textContent = `${usd(spent)} of ${usd(budget)}`;
}

function usd(atomic) {
  const text = String(atomic);
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).padStart(7, "0");
  const whole = digits.slice(0, digits.length - 6);
  const frac = digits.slice(digits.length - 6).replace(/0+$/, "").padEnd(2, "0");
  return `${negative ? "-" : ""}$${whole}.${frac}`;
}

/* ------------------------------------------------------------------ */
/* Untrusted text: fenced, collapsed, and never interpreted              */
/* ------------------------------------------------------------------ */

function addUntrusted(source, content) {
  const empty = els.untrusted.querySelector(".empty-note");
  if (empty) empty.remove();

  const details = document.createElement("details");
  details.className = "untrusted-block";

  const summary = document.createElement("summary");
  summary.textContent = `Untrusted data from ${source}`;

  const pre = document.createElement("pre");
  // textContent, never innerHTML. The content is a stranger's bytes.
  pre.textContent = content;

  details.append(summary, pre);
  els.untrusted.append(details);
}

/* ------------------------------------------------------------------ */
/* Streaming run                                                        */
/* ------------------------------------------------------------------ */

function setStatus(text) {
  els.status.textContent = text;
}

async function run() {
  els.run.disabled = true;
  els.calls.replaceChildren();
  els.audit.replaceChildren();
  els.untrusted.replaceChildren();
  els.holds.replaceChildren();
  // A previous failure must not sit above a run that is now working.
  document.getElementById("failure")?.remove();
  setBudget("0", els.bar.getAttribute("aria-valuemax"));
  setStatus("Starting sellers and the agent…");

  let response;
  try {
    // No body. There is nothing to send, because there is nothing a caller is
    // allowed to influence.
    response = await fetch("/api/run", { method: "POST" });
  } catch {
    setStatus("Could not reach the server.");
    els.run.disabled = false;
    return;
  }

  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({}));
    setStatus(detail.error ?? `The server refused to start a run (${response.status}).`);
    els.run.disabled = false;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line. Keep the remainder for the next
    // chunk rather than assuming one frame per read.
    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      handleFrame(frame);
    }
  }
  els.run.disabled = false;
}

function handleFrame(frame) {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (data === "") return;

  const payload = JSON.parse(data);
  if (event === "start") {
    els.planner.textContent = payload.plannerDescription;
    setStatus("Running…");
  } else if (event === "result") {
    onResult(payload);
  } else if (event === "end") {
    setStatus(`Run ${payload.runId} finished in ${payload.turns} turns. Record written.`);
    void loadRecord();
  } else if (event === "error") {
    // The run died. The tables were cleared when it started and nothing new was
    // written, so say so plainly - an empty table next to a bare SQLite message
    // reads like the run is still going.
    setStatus(`The run failed: ${payload.message}`);
    showFailure(payload);
  }
}

/**
 * Report a failed run in full.
 *
 * `detail` explains what the message means here and `ledgerPath` names the file,
 * because "UNIQUE constraint failed: attempts.id" on its own tells a reader
 * nothing they can act on. Built with textContent, like everything else here.
 */
function showFailure(payload) {
  let box = document.getElementById("failure");
  if (box === null) {
    box = document.createElement("div");
    box.id = "failure";
    box.className = "failure";
    box.setAttribute("role", "alert");
    els.status.insertAdjacentElement("afterend", box);
  }
  box.replaceChildren();
  const head = document.createElement("strong");
  head.textContent = `Run ${payload.runId ?? "(unknown)"} did not finish.`;
  box.append(head);
  if (payload.detail) {
    const why = document.createElement("p");
    why.textContent = payload.detail;
    box.append(why);
  }
  if (payload.ledgerPath && payload.ledgerPath !== "unknown") {
    const where = document.createElement("p");
    where.className = "mono";
    where.textContent = `Ledger: ${payload.ledgerPath}`;
    box.append(where);
  }
}

function onResult(payload) {
  const r = payload.result;
  const settlement = settlementOf(r);
  setBudget(payload.spentAfter, els.bar.getAttribute("aria-valuemax"));
  setStatus(`Call ${payload.index + 1}: ${settlement}`);

  const row = els.calls.insertRow();
  cell(row, String(payload.index + 1));
  cell(row, r.label ?? "—");
  const statusCell = row.insertCell();
  statusCell.append(badge(settlement, r.gateOutcome));
  cell(row, r.quotedAtomic ? usd(r.quotedAtomic) : "—", "mono");
  cell(row, r.settledAtomic ? usd(r.settledAtomic) : "—", "mono");
  cell(row, r.reason ?? r.code ?? "—", "reason");

  if (r.untrusted) addUntrusted(r.untrusted.source, r.untrusted.content);
  if (r.heldAtomic && r.heldAtomic !== "0") {
    setStatus(`Call ${payload.index + 1}: ${settlement} — ${usd(r.heldAtomic)} still held.`);
  }
}

/**
 * Map a gate outcome to the record's vocabulary.
 *
 * The `paid` case becomes `settled-stub`, never `paid`. That mapping is the
 * whole point: the gate's word describes the protocol, and the UI must not let a
 * reader take it as a payment.
 */
function settlementOf(r) {
  switch (r.gateOutcome) {
    case "paid":
      return "settled-stub";
    case "refused":
      return "not-paid";
    case "interrupted":
      return "budget-held";
    case "free":
      return "free";
    default:
      return "not-reached";
  }
}

/* ------------------------------------------------------------------ */
/* Record rendering, after a run or on reload                           */
/* ------------------------------------------------------------------ */

async function loadRecord() {
  const response = await fetch("/api/record");
  if (!response.ok) return;
  const record = await response.json();

  if (record.policy) {
    els.bar.setAttribute("aria-valuemax", record.policy.runBudgetAtomic);
    setBudget(record.totals.committedAtomic, record.policy.runBudgetAtomic);
  }

  renderCalls(record.calls ?? []);
  renderAudit(record.ledger ?? []);
  renderHolds(record.totals ?? {});
  if (record.run) els.planner.textContent = record.run.plannerDescription;
}

function renderCalls(calls) {
  if (calls.length === 0) return;
  els.calls.replaceChildren();
  for (const call of calls) {
    const row = els.calls.insertRow();
    cell(row, String(call.index + 1));
    cell(row, call.label ?? "—");
    const statusCell = row.insertCell();
    statusCell.append(badge(call.settlement, call.gateOutcome));
    cell(row, call.quotedAtomic === "0" ? "—" : usd(call.quotedAtomic), "mono");
    cell(row, call.committedAtomic === "0" ? "—" : usd(call.committedAtomic), "mono");
    cell(row, call.refusal ? `${call.refusal.code}: ${call.refusal.message}` : "—", "reason");

    if (call.untrusted) addUntrusted(call.untrusted.source, call.untrusted.content);
  }
}

function renderAudit(rows) {
  if (rows.length === 0) return;
  els.audit.replaceChildren();
  for (const row of rows) {
    const tr = els.audit.insertRow();
    cell(tr, row.id, "mono");
    cell(tr, row.state);
    cell(tr, row.decision);
    cell(tr, usd(row.quoteAtomic), "mono");
    cell(tr, row.settledAtomic ? usd(row.settledAtomic) : "—", "mono");
    // `heldAtomic` is the *current* hold, which the server derives from the
    // attempt's state. `reservedAtomic` is deliberately not used here: a settled
    // row still carries the amount that was authorised, so rendering that column
    // would show a hold on every call the purse ever paid for and contradict the
    // one-hold callout under the budget bar.
    cell(tr, row.heldAtomic === "0" ? "—" : `${usd(row.heldAtomic)} held`, "mono");
  }
}

function renderHolds(totals) {
  els.holds.replaceChildren();
  if (!totals.heldAttemptCount) return;
  const li = document.createElement("li");
  // The hold is the point of a fail-closed design, so it is called out in words.
  li.textContent = `${usd(totals.heldAtomic)} still held by ${totals.heldAttemptCount} unresolved call — settlement was not confirmed, so the budget was not returned.`;
  els.holds.append(li);
}

/* ------------------------------------------------------------------ */

els.run.addEventListener("click", () => {
  void run();
});

const policy = await loadPolicy();
await loadRecord();
if (policy) setStatus(policy.settlement.note);
