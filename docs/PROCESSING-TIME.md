# How long does it take to process a timesheet?

**Item 9.** Answer, stage by stage, for the AJACE timesheet app ("Direct++") as
deployed: one EC2 `t4g.small`, `next start -p 3009` under pm2, behind Caddy.

Every figure below is tagged:

- **[CODE]** — read straight out of the source. Exact, with file and line.
- **[MEASURED]** — I ran it on this machine (Apple silicon laptop, `node v22`).
  Not the t4g.small. Where that matters it says so.
- **[ESTIMATE]** — a judgement call. **Nobody has timed the OpenRouter calls in
  production**; there was no telemetry in the repo until the instrumentation
  described in §7 was added. Do not quote these to anyone as measurements.

---

## 1. The short answer [ESTIMATE]

| Document | Typical wall clock, upload → filled calendar |
|---|---|
| 1-page PDF, clean, first model accepts | **12–40 s** |
| 1-page PDF, first model rejected by the accept gate, second accepts | **25–70 s** |
| Photo or scan of a 1-page timesheet | **30–90 s** |
| 10-page text PDF, clean, first model accepts | **40–120 s** |
| 10-page scanned PDF that walks the whole ladder and repairs | **2–6 min** |
| Pathological (every call times out and retries) | **~30 min, uncapped** |

The spread is almost entirely model latency. Everything the app itself does —
parsing, summing, validating, writing to the database — is a rounding error, and
that part **is** measured (§4).

The 30-minute figure is not hyperbole; it falls out of the timeouts in §5. It has
probably never happened, but nothing in this deployment prevents it.

---

## 2. What actually happens, in order

All stages are sequential. Nothing overlaps.

| # | Stage | Where | Cost |
|---|---|---|---|
| 1 | Preview render | `app/api/preview/route.js` | ~free [MEASURED] |
| 2 | Upload #1 → S3 | `/api/storage/upload` | bandwidth |
| 3 | Upload #2 → `/api/process` (**the same bytes again**) | `DashboardClient.js:162` | bandwidth, again |
| 4 | `buildModelInput` | `lib/directpp/input.js` | 1 ms–350 ms [MEASURED] |
| 5 | **OpenRouter model calls** | `lib/directpp/extractor.js` | ~100 % of the time |
| 6 | Calendar build + rollup + validation | `lib/engine.js`, `lib/validate.js` | sub-ms |
| 7 | Save baseline (2 RDS round trips) | `DashboardClient.js:242` | single-digit ms |

**Stage 3 is not a typo** [CODE]. `ensureStored()` POSTs the file to
`/api/storage/upload` (`DashboardClient.js:129,152`), then the same `File`
object is appended to the `/api/process` FormData (`DashboardClient.js:162`). On
a home upstream link that doubles the user-visible upload time. Upload cap is
`MAX_UPLOAD_MB = 15` (`lib/aws/filetypes.js:8`), so worst case is 2 × 15 MB out
of the browser.

**There is no progress reporting and no polling** [CODE]. `processAI()` awaits a
single blocking `fetch("/api/process")` (`DashboardClient.js:164`) with no
client-side timeout. The only feedback is the spinner at line 477,
"Processing with AI…". So "how long does it take" is also "how long the user
stares at a spinner with no information".

---

## 3. Stage 5 — the model calls, in detail [CODE]

From `lib/directpp/extractor.js` and `lib/directpp/openrouter.js`:

| Setting | Value | Source |
|---|---|---|
| Model ladder | `openai/gpt-5.4-nano` → `openai/gpt-5.4-mini` → `openai/gpt-5` | `CFG.ladder`, extractor.js:12 |
| Stop condition | first model that passes `acceptGate()` | extractor.js:75–77 |
| Verify model | `openai/gpt-5.4-mini` (or the next ladder model if that was the winner) | `CFG.verifyModel`, extractor.js:17, 246 |
| Extraction `max_tokens` | 8000 | openrouter.js:28 |
| Verify `max_tokens` | 2000 | extractor.js:257 |
| `temperature` | 0, `response_format: json_object` | openrouter.js:29–33 |
| Per-call timeout | **180 000 ms (180 s)** | openrouter.js:28 |
| Retries | `for (attempt = 0; attempt < 2)` → **one retry on any throw** | openrouter.js:37–53 |
| Repair round | at most **one per file** (`CFG.repair` + `!repaired`) | extractor.js:66 |
| System prompt | **11 650 chars ≈ 2 900 tokens**, sent on *every* extraction call | [MEASURED] |
| Verify prompt | 582 chars ≈ 150 tokens | [MEASURED] |
| Poll interval | **none — there is no polling anywhere** | DashboardClient.js:164 |

Call count per document:

- **Minimum: 1 call.** Clean document, nano accepts, no verify.
- **Maximum: 5 calls** = 3 ladder + 1 repair + 1 verify.

When the extra calls fire:

- **Repair** — when the code-summed daily hours disagree with the model's own
  `self_check`, or with a printed total the model claimed to match
  (`needsRepair()`, extractor.js:191). The repair call re-sends the whole system
  prompt **plus up to 30 000 chars of the previous answer** (extractor.js:208,
  ≈ 7 500 extra input tokens).
- **Verify** — `shouldVerify()` (extractor.js:237) fires when confidence < 0.9,
  **or `images.length > 0`**, or a repair happened, or the read is small and
  sparse. **Any photo/scan upload therefore always pays for the verify call.**
  It is skipped when two ladder models already disagreed by more than 2 h, since
  the second model already served as the independent opinion.

### Cost of the manager-approval prompt block (item 5)

The `manager_approval` contract block plus its rules paragraph add **1 989
characters ≈ 500 tokens** to the system prompt (9 661 → 11 650 chars)
[MEASURED]. That is input tokens only, on every extraction call, and it adds no
call. At current nano/mini input pricing this is noise; latency impact is
likewise within run-to-run variance. It does **not** touch the verify prompt —
`directVerifySystem()` still tells the verifier to ignore approver signatures
(prompts.js:41), and its job stays "re-count the hours".

---

## 4. The stages that are NOT the model [MEASURED]

Measured on this laptop, not the box. Expect roughly **2–4× the CPU time on a
2-vCPU Graviton2 `t4g.small`** [ESTIMATE].

| Input | Time | Result |
|---|---|---|
| 3 MB PDF → `buildModelInput` | **1 ms** | base64 only, 4.00 MB data URL |
| Clean 1200×1600 scan (44 KB JPEG) → `prepImage` | **71 ms** | 0.08 MB data URL |
| Noisy 1200×1600 phone photo (1.2 MB JPEG) → `prepImage` | **348 ms** | **27.88 MB data URL** |
| XLSX month sheet → `renderOfficePreview` | ~1 ms | — |

That third row is the one to care about. `prepImage()` (`input.js:122–136`)
upsamples 2× with lanczos3 whenever the short edge is under 1400 px, then
re-encodes as **PNG with no size cap**. A noisy photo balloons from a 1.2 MB
JPEG to a ~28 MB base64 data URL — **and that data URL is re-uploaded to
OpenRouter on every ladder call, the repair call and the verify call.** For a
`.docx` this runs on up to 10 embedded images (`input.js:88–93`).

So the real cost of a phone photo is not the 348 ms of CPU; it is that every one
of up to 5 model calls now carries ~28 MB of body.

Stage 1 (preview) is effectively free: `.xlsx/.xls/.csv/.docx` render in-process
via SheetJS/mammoth; PDFs and images never reach the server at all — the browser
renders them with `URL.createObjectURL` (`DashboardClient.js:100–104`).

---

## 5. The ceiling, and why it isn't 300 seconds

`app/api/process/route.js:5` declares `export const maxDuration = 300`. **That
line does nothing here** [CODE]. It is a Vercel/serverless directive; this
deployment runs `next start -p 3009` under pm2 (README, package.json). There is
no server-side wall clock on an extraction on this box.

What does bound it:

- 180 s per OpenRouter call, **× 2 for the automatic retry** = 360 s per logical
  call (`AbortSignal.timeout` throws, and the retry loop catches any throw).
- Up to 5 logical calls per document.
- **⇒ code-derived worst case ≈ 30 minutes**, with the browser's `fetch` sitting
  open the whole time (no client timeout) and Caddy's own proxy timeouts as the
  only other backstop.

Two smaller things worth knowing: `/api/process` is **not** rate-limited (only
`/api/preview` is, 60 per 5 min per user — preview/route.js:36), and the Python
engine path (`lib/engine.js processUpload`, 240 s timeout) is **dead code in
production** — `deploy/env.production.example:72` sets `DIRECT_SERVERLESS=true`,
so route.js:45–48 always takes `processServerless()`.

---

## 6. Measured vs estimated — the honest table

| Claim | Status |
|---|---|
| Model ids, token limits, timeouts, retry count, call counts | **[CODE]** exact |
| "No polling", "file uploaded twice", "`maxDuration` is inert" | **[CODE]** exact |
| Prompt sizes in characters; +1 989 chars for the approval block | **[MEASURED]** |
| `buildModelInput` / `prepImage` / preview timings | **[MEASURED]** on a laptop |
| t4g.small being 2–4× slower on that CPU work | **[ESTIMATE]** |
| **Every wall-clock range in §1** | **[ESTIMATE]** |

The estimates in §1 assume a nano extraction over a 1-page document lands in
6–20 s and a verify in 4–12 s, scaling with page count. The code sends no
`reasoning` parameter, so reasoning-token volume is whatever the provider
defaults to — that is the dominant term and it is entirely outside our control
and unobserved.

---

## 7. Getting real numbers (already wired up)

`chatJson()` has always returned `usage` (prompt/completion tokens) and the
caller threw it away. It no longer does. `directExtract()` now times every
OpenRouter call and records:

```
{ stage: "extract" | "repair" | "verify", model, ms, prompt_tokens, completion_tokens, ok }
```

Where it lands:

- `directExtract()` returns `timings = { total_ms, model_ms, calls[] }`.
- `/api/process` adds `timings.input_ms` (the `buildModelInput` stage) and
  returns `timings` at the top level of the response.
- The same object is embedded in `agent_trace.timings`, and a
  `DirectTiming / measured` row is appended to `agent_trace.actions`.
- `agent_trace` is already persisted to `ts_employee_edits.fields.agent_trace`
  on submit (`DashboardClient.js:300`) and already rendered by the admin
  console's AgentTrace panel.

So after a day of live use the admin console holds real per-document numbers —
per model, per stage, with token counts — and §1 can be replaced with
measurements. The instrumentation reads no hours and changes no result: it is
`Date.now()` deltas plus an object the HTTP client already returned.

### If it needs to be faster

In rough order of payoff, none of which is done here:

1. **Cap `prepImage` output** (max dimension + JPEG instead of PNG). A 28 MB
   body sent up to 5 times is the single largest avoidable cost.
2. **Stop uploading the file twice** — `/api/process` could read it back from S3
   using the path `ensureStored()` already returns.
3. **Report progress.** The work is already staged and now timed; the UI just
   has no channel for it. A spinner that says "reading page 3 of 10" changes the
   perceived time far more than any of the above.
4. Lower the 180 s per-call timeout and/or drop the blind retry — a call that
   has burned 180 s is rarely worth a second 180 s.
