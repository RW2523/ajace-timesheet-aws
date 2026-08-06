#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VISUAL HARNESS — render the REAL components to HTML so a human can look at
// them.
//
// WHY THIS EXISTS: every existing test asserts on strings. A string assertion
// cannot see that `.alert { display: flex }` shatters a flowing sentence into
// side-by-side columns, because the sentence is still *present* in the markup —
// it is the CASCADE that breaks it, and nothing in this repo has ever executed
// the cascade. TimesheetTargetPicker.js and the admin add-person UI shipped
// without anyone ever looking at a pixel of them.
//
// NOTHING HERE RE-TYPES COMPONENT MARKUP. Every scene imports the actual file
// from components/ and renders it with react-dom/server, using the same
// babel + "@/…"-alias loader as test/target-picker-render.test.cjs. The only
// thing the harness writes by hand is the page shell and the grey caption
// strips (all `hx-` prefixed), so anything you see inside a white card is the
// component's own output under the app's own globals.css.
//
// Sub-components like PeriodSwitch / TargetSwitch / ReviewStep are module-
// private (`function PeriodSwitch(...)`, not exported). Rather than copy them,
// the loader appends a single `export { … }` line to the END of the source text
// before handing it to babel — the component bodies are still byte-for-byte the
// shipped ones.
//
// Run:  node tools/visual/render-gallery.cjs          (writes tools/visual/out/*.html)
// Then: node tools/visual/shoot.mjs                   (writes tools/visual/out/*.png)
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const Module = require("module");
const babel = require("next/dist/compiled/babel/core");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

// ---- module loader --------------------------------------------------------
// "@/x"          -> <repo>/x                (jsconfig.json paths; bare Node has no idea)
// "next/xyz"     -> "next/xyz.js"           (Next's exports map is resolved by the bundler)
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req.startsWith("@/")) req = path.join(ROOT, req.slice(2));
  else if (/^next\/(navigation|server|headers|router)$/.test(req)) req = req + ".js";
  return origResolve.call(this, req, ...rest);
};

// The render test only ever loaded ONE component whose own imports were all
// JSX-free, so a one-shot transform was enough there. DashboardClient pulls in
// Topbar, Calendar, DayModal, Questionnaire and PreviewPane, so the transform
// has to be installed as a require HOOK — otherwise the first nested `require`
// hands raw JSX to Node and dies on `<div`.
const EXTRA_EXPORTS = new Map();   // absolute filename -> "A, B, C"
const origJs = Module._extensions[".js"];
Module._extensions[".js"] = function (mod, filename) {
  if (!filename.startsWith(ROOT) || filename.includes("node_modules")) {
    return origJs(mod, filename);
  }
  let src = fs.readFileSync(filename, "utf8");
  // Reach module-private components (PeriodSwitch, ReviewStep, …) without
  // copying them. Appended AFTER the whole file, so every name it lists is
  // already declared; the component bodies are untouched.
  const extra = EXTRA_EXPORTS.get(filename);
  if (extra) src += `\nexport { ${extra} };\n`;
  const { code } = babel.transformSync(src, {
    filename, babelrc: false, configFile: false,
    presets: [[require("next/dist/compiled/babel/preset-react"), { runtime: "automatic" }]],
    plugins: [require("next/dist/compiled/babel/plugin-transform-modules-commonjs")],
  });
  mod._compile(code, filename);
};

function load(rel, extraExports) {
  const file = path.join(ROOT, rel);
  if (extraExports) EXTRA_EXPORTS.set(file, extraExports);
  return require(file);
}

const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);

// ---- real modules ---------------------------------------------------------
const Dash = load("components/DashboardClient.js", "PeriodSwitch, TargetSwitch, ReviewStep, SubmitSuccess");
const DayModal = load("components/DayModal.js").default;
const Picker = load("components/TimesheetTargetPicker.js").default;
const { buildCalendar, rollup } = load("lib/engine.js");
const { validateTimesheet } = load("lib/validate.js");
const { holidaysInMonth } = load("lib/holidays.js");
const { EMPTY_PICK } = load("lib/roster.js");

// ---- fixtures -------------------------------------------------------------
const MONTH = 7, YEAR = 2026;
const HOLIDAYS = holidaysInMonth(YEAR, MONTH);

const ADMIN_SELF = { id: "u-admin", full_name: "Dana Ops", email: "dana@ajace.com", role: "admin" };
const PRIYA = { id: "u-1", full_name: "Priya Raman", email: "priya@ajace.com", employee_code: "EC-0117" };
const JOHN = { id: "u-2", full_name: "John Smith", email: "john.smith@ajace.com", employee_code: "EC-0042" };
const JOHN2 = { id: "u-3", full_name: "John Smith", email: "jsmith@contractor.example", active: false };
const ROSTER = [PRIYA, JOHN, JOHN2];
const PEOPLE = [ADMIN_SELF, ...ROSTER];

// A worked month: weekdays at 8h, one 10h day, one day with PTO on it.
function workedDays() {
  const out = [];
  for (let d = 1; d <= 31; d++) {
    const date = `${YEAR}-07-${String(d).padStart(2, "0")}`;
    const wd = new Date(date + "T00:00:00").getDay();
    if (wd === 0 || wd === 6) continue;
    if (d === 9) { out.push({ date, regular_hours: 8, overtime_hours: 2 }); continue; }
    if (d === 15) { out.push({ date, vacation_hours: 8 }); continue; }
    if (d === 21) { out.push({ date, regular_hours: 5 }); continue; }   // a "short" day
    out.push({ date, regular_hours: 8 });
  }
  return out;
}
const FULL_CAL = buildCalendar({ days: workedDays() }, MONTH, YEAR);
const EMPTY_CAL = buildCalendar({ days: [] }, MONTH, YEAR);

const noop = () => {};
const noopField = () => () => {};

function reviewProps(over) {
  const fields = Object.assign(
    { employee_name: "Priya Raman", employee_id: "EC-0117", client: "Northwind Logistics", project: "Depot rollout" },
    over.fields || {}
  );
  const calendar = over.calendar || FULL_CAL;
  const q = over.q || {};
  const validation = validateTimesheet({
    fields, calendar, questionnaire: q, holidayWork: {}, holidays: HOLIDAYS,
    onBehalf: over.forSelf === false,
  });
  return Object.assign({
    fields, setField: noopField, calendar, month: MONTH, year: YEAR,
    onDayClick: noop, validation, totals: rollup(calendar),
    q, setQ: noop, holidays: HOLIDAYS, holidayWork: {}, setHolidayWork: noop,
    aiMeta: null, approval: null, emptyExtraction: false, onSwitchPeriod: noop,
    saving: false, submit: noop, showErrors: false, alreadySubmitted: false,
    onClearDayHours: noop, onRestoreAiHours: noop, onSetDayHours: noop, onEditDay: noop,
    hoursOnDate: () => 0, workedHoursOnDate: () => 0, aiHoursOnDate: () => null,
    bulkHours: 8, setBulkHours: noop, emptyWeekdayCount: 0,
    onFillWeekdays: noop, onUndoFill: noop, canUndoFill: false, bulkMsg: "",
    showPreview: false, previewPages: [], previewDoc: null, previewLoading: false,
    fileName: "file.xlsx", togglePreview: noop, resetForNew: noop,
    submitError: "", resumedAt: null, draftSavedAt: null, draftSaving: false, draftError: "",
    // The merged filing flow. `blockers` is validate.js's errors PLUS the two
    // things it cannot know — whether a subject is chosen and whether the
    // mandatory on-behalf note is there — so it is composed the same way the
    // component's caller composes it, not hand-written.
    forSelf: true, targetName: null, willBeApproved: false, isNewPerson: false,
    note: "", setNote: noop, noteRequired: false, nameMismatch: null,
  }, over, (() => {
    const noteRequired = over.noteRequired === true;
    const noteOk = !noteRequired || String(over.note || "").trim().length >= 3;
    const blockers = validation.errors.concat(
      noteOk ? [] : ["Say why you are filing this on their behalf — a note is required, " +
                     "and it is the only record of why these hours exist."]);
    return { fields, calendar, q, validation, totals: rollup(calendar),
             blockers, canSubmit: blockers.length === 0 };
  })());
}

// The EXACT banner a user photographed as broken. confidence .98 + llm_used
// produce "AI populated this from <b>file.xlsx</b> · confidence 98% · LLM used.
// Review and correct anything below." — a flowing sentence with inline <b>,
// which is the shape .alert{display:flex} shatters.
const AI_META_REPORTED = {
  fileName: "file.xlsx", confidence: 0.98, llm_used: true,
};
const AI_META_UNSURE = {
  fileName: "July timesheet - Priya.xlsx", confidence: 0.72, llm_used: true,
  reviewStatus: "needs_review",
  issues: [
    { message: "Verification DISAGREED: primary read 168h, re-read 140h." },
    { message: "The document's printed total (152h) does not match the sum of its day rows." },
  ],
  notes: ["Parsed 3 sheets", "Re-read with the vision model", "Cross-checked printed totals"],
  offMonth: [{ period: "2026-06", count: 21 }],
};

// ---- scenes ---------------------------------------------------------------
const scenes = [];
const scene = (name, caption, body, opts) =>
  scenes.push(Object.assign({ name, caption, body }, opts || {}));

// 1 & 2 — the review page, which is where every .alert variant actually lives.
const reviewBusy = render(h(Dash.ReviewStep, reviewProps({
  resumedAt: "2026-08-04T09:14:00.000Z",
  aiMeta: Object.assign({}, AI_META_UNSURE, { fileName: "file.xlsx", confidence: 0.98 }),
  emptyExtraction: true,
  calendar: EMPTY_CAL,
  fields: { employee_name: "", employee_id: "", client: "", project: "" },
  showErrors: true,
})));
// A questionnaire that actually SATISFIES validate.js, so the `.alert ok`
// branch renders — it is the one alert variant no failing state can produce.
const FULL_ROLL = rollup(FULL_CAL);
const Q_VALID = {
  regularHours: FULL_ROLL.regular, overtimeHours: FULL_ROLL.overtime,
  workedWeekends: "no", holidaysTaken: 0,
  managerApproval: "detected",
  approvalDetection: { detected: true, confidence: 0.94, approver: "M. Okafor", quote: "Approved – M. Okafor, 31 Jul 2026" },
};
const reviewClean = render(h(Dash.ReviewStep, reviewProps({
  aiMeta: AI_META_REPORTED,
  q: Q_VALID,
  fields: { employee_name: "Priya Raman", employee_id: "EC-0117", client: "", project: "" },
})));

scene("review-busy", "ReviewStep — draft resumed, AI-filled, nothing found for the month, AI unsure, validation errors. Five stacked .alert variants in situ.", reviewBusy, { page: true });
scene("review-clean", "ReviewStep — the exact user-reported banner: “AI populated this from file.xlsx · confidence 98% · LLM used. Review and correct anything below.”", reviewClean, { page: true });

// 3 — picker states. Rendered inside the app's own .card.card-pad chrome, which
//     is where the picker is now mounted: the FIRST CARD ON THE TIMESHEET TAB,
//     above the dropzone. It used to sit in the admin console's add-timesheet
//     modal; that modal is gone, and the card is where its width comes from.
const pickerProps = (value, extra) => Object.assign({
  value, onChange: noop, roster: ROSTER, people: PEOPLE, self: ADMIN_SELF, serverEmailError: "",
}, extra || {});
const pickerSelf = render(h(Picker, pickerProps({ mode: "self", pick: "", newName: "", newEmail: "" })));
const pickerNoMatch = render(h(Picker, pickerProps({ mode: "other", pick: "Nora New", newName: "", newEmail: "" })));
const pickerEmpty = render(h(Picker, pickerProps(EMPTY_PICK)));
const pickerNew = render(h(Picker, pickerProps({
  mode: "new", pick: "John Smith", newName: "John Smith", newEmail: "john.smith@ajace.com", newCode: "EC-0042",
})));
const pickerNewClean = render(h(Picker, pickerProps({
  mode: "new", pick: "Nora New", newName: "Nora New", newEmail: "nora.new@example.com", newCode: "",
})));

// 4 — modals, rendered whole (each owns its own .modal-bg overlay)
const periodSwitch = render(h(Dash.PeriodSwitch, {
  from: "July 2026", to: "June 2026", willReread: true, hours: 168,
  onCancel: noop, onConfirm: noop,
}));
const periodSwitchNoDoc = render(h(Dash.PeriodSwitch, {
  from: "July 2026", to: "August 2026", willReread: false, hours: 0,
  onCancel: noop, onConfirm: noop,
}));
const dayModal = render(h(DayModal, {
  day: FULL_CAL.find((c) => c.date === `${YEAR}-07-15`), onSave: noop, onClose: noop,
}));
const dayModalHoliday = render(h(DayModal, {
  day: Object.assign({}, FULL_CAL[3], { isHoliday: true, holidayName: "Independence Day", isWeekend: false, other: 8 }),
  onSave: noop, onClose: noop,
}));
const successCard = render(h(Dash.SubmitSuccess, {
  period: "July 2026", totals: rollup(FULL_CAL), onClose: noop, onNew: noop,
}));
const targetSwitch = render(h(Dash.TargetSwitch, {
  who: "Priya Raman", hours: 168, onCancel: noop, onConfirm: noop,
}));

// ---- the merged filing flow, filing for SOMEBODY ELSE ---------------------
// Same component, same review grid, same document preview — the only screen in
// the product that files a timesheet now. What changes with the target is the
// self-attestation block (gone), the mandatory note (present), the draft promise
// (inverted) and the outcome sentence (three-way).
const Q_ONBEHALF = { managerApproval: "acknowledged_absent", managerApprovalAck: true };
const reviewOnBehalfAdmin = render(h(Dash.ReviewStep, reviewProps({
  forSelf: false, targetName: "Priya Raman", willBeApproved: true,
  noteRequired: true, note: "Paper timesheet handed in on 3 Aug — no laptop access.",
  q: Q_ONBEHALF, aiMeta: AI_META_REPORTED,
})));
const reviewOnBehalfHr = render(h(Dash.ReviewStep, reviewProps({
  forSelf: false, targetName: "John Smith", willBeApproved: false,
  noteRequired: true, note: "Typed from the paper sheet handed to HR.",
  q: Q_ONBEHALF, aiMeta: AI_META_REPORTED,
})));
const reviewOnBehalfBlocked = render(h(Dash.ReviewStep, reviewProps({
  forSelf: false, targetName: "Priya Raman", willBeApproved: true,
  noteRequired: true, note: "", showErrors: true,
  nameMismatch: "J. Smith",
  q: Q_ONBEHALF, aiMeta: AI_META_REPORTED,
})));

scene("modal-period-switch", "PeriodSwitch (post-fix) — content wrapped in .modal-head + .modal-body. Watch the padding and the bottom rounded corner.", periodSwitch, { overlay: true });
scene("modal-period-switch-empty", "PeriodSwitch — the no-document / no-hours wording.", periodSwitchNoDoc, { overlay: true });
scene("modal-day", "DayModal — a day carrying paid-not-worked hours (the Remove control).", dayModal, { overlay: true });
scene("modal-day-holiday", "DayModal — holiday badge + PTO row, the widest head this dialog gets.", dayModalHoliday, { overlay: true });
scene("modal-success", "SubmitSuccess — .modal.success-card (has its own padding, so it is unaffected by the .modal padding hazard).", successCard, { overlay: true });
scene("modal-target-switch", "TargetSwitch — changing WHO a timesheet is for from the review step. Same shape as PeriodSwitch, because it clears the same work.", targetSwitch, { overlay: true });

scene("review-onbehalf-admin", "ReviewStep filing for SOMEONE ELSE as admin — no self-attestation inputs, the mandatory note card, the inverted draft promise (“not saved automatically”), and the “approved and payable” outcome.", reviewOnBehalfAdmin, { page: true });
scene("review-onbehalf-hr", "ReviewStep filing for someone else as HR — identical screen, but the outcome sentence says the filing is queued for an admin. HR must never be shown the payable copy.", reviewOnBehalfHr, { page: true });
scene("review-onbehalf-blocked", "ReviewStep on-behalf, refused: the missing mandatory note in the blockers list, the field marked invalid, and the “this document names somebody else” warning.", reviewOnBehalfBlocked, { page: true });

scene("picker-self", "TimesheetTargetPicker — MYSELF, the state the timesheet tab opens in for an admin.", modalChrome(pickerSelf), { page: true });
scene("picker-empty", "TimesheetTargetPicker — Someone else, nothing typed (what /dashboard?for=other lands on).", modalChrome(pickerEmpty), { page: true });
scene("picker-nomatch", "TimesheetTargetPicker — a typed name matching nobody: the .alert info that offers to add them. THE sentence+button+trailing-text shape bug (A) attacks.", modalChrome(pickerNoMatch), { page: true });
scene("picker-new-clash", "TimesheetTargetPicker — new person, name clashes with two existing John Smiths and the email is already taken. Two .alert warn blocks.", modalChrome(pickerNew), { page: true });
scene("picker-new-clean", "TimesheetTargetPicker — new person, no clashes: the “does not create a working login” .alert warn on its own.", modalChrome(pickerNewClean), { page: true });

// The picker is only ever mounted inside this wrapper (AdminClient.js:818-833).
// Reproduced here so the picker gets its real width and its real card; the
// picker's OWN markup above is untouched component output.
function modalChrome(inner) {
  return `<div class="container" style="padding:22px 24px">` +
    `<div class="card card-pad" id="ts-target-card">${inner}` +
    `<div class="muted" style="font-size:12px">harness chrome — reproduces the card ` +
    `DashboardClient mounts the picker in</div></div></div>`;
}

// 5 — the alert gallery. Every block below is LIFTED VERBATIM out of the
//     component output rendered above, not retyped.
function topLevelAlerts(html) {
  const out = [];
  const re = /<div class="alert[^"]*"/g;
  let m;
  while ((m = re.exec(html))) {
    // walk forward counting <div>/</div> to find this element's own close tag
    let depth = 0, i = m.index;
    while (i < html.length) {
      if (html.startsWith("<div", i)) { depth++; i += 4; continue; }
      if (html.startsWith("</div>", i)) { depth--; i += 6; if (depth === 0) break; continue; }
      i++;
    }
    out.push(html.slice(m.index, i));
    re.lastIndex = i;
  }
  return out;
}

const alertSources = [
  ["DashboardClient.js:1018 — .alert info (draft resumed)", 0],
  ["DashboardClient.js:1023 — .alert info — THE REPORTED ONE", 1],
];
const busyAlerts = topLevelAlerts(reviewBusy);
const cleanAlerts = topLevelAlerts(reviewClean);
const pickerAlerts = [].concat(
  topLevelAlerts(pickerNoMatch), topLevelAlerts(pickerNew), topLevelAlerts(pickerNewClean)
);

const galleryItems = [];
const push = (label, html) => { if (html) galleryItems.push({ label, html }); };
busyAlerts.forEach((a, i) => push(`ReviewStep (busy) alert ${i + 1} — class="${(a.match(/class="([^"]*)"/) || [])[1]}"`, a));
cleanAlerts.forEach((a, i) => push(`ReviewStep (clean) alert ${i + 1} — class="${(a.match(/class="([^"]*)"/) || [])[1]}"`, a));
pickerAlerts.forEach((a, i) => push(`TimesheetTargetPicker alert ${i + 1} — class="${(a.match(/class="([^"]*)"/) || [])[1]}"`, a));
topLevelAlerts(reviewOnBehalfBlocked).forEach((a, i) =>
  push(`ReviewStep (on-behalf, refused) alert ${i + 1} — class="${(a.match(/class="([^"]*)"/) || [])[1]}"`, a));

const galleryBody = galleryItems.map((it) =>
  `<div class="hx-item"><div class="hx-lbl">${esc(it.label)}</div>` +
  `<div class="hx-stage">${it.html}</div></div>`
).join("\n");

scene("alerts-gallery", `Every .alert this app can render, lifted verbatim from the component output above (${galleryItems.length} of them). If a sentence breaks into side-by-side columns with a 10px gutter, that is globals.css:136 display:flex.`, galleryBody, { page: true, gallery: true });

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- page shell -----------------------------------------------------------
// The REAL stylesheet, inlined so the cascade is byte-identical to production
// and no file:// path can silently 404 into an unstyled page.
const GLOBALS = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
const HARNESS_CSS = `
.hx-cap { font: 600 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0f172a; color: #e2e8f0; padding: 8px 12px; position: sticky; top: 0; z-index: 999; }
.hx-cap b { color: #fbbf24; }
.hx-wrap { padding: 16px; }
.hx-item { margin: 0 0 18px; }
.hx-lbl { font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #475569; margin: 0 0 5px; }
/* the stage is a plain white card at the width an alert really gets inside a
   .modal-body / a .card — no other styling, so nothing here can mask a bug */
.hx-stage { background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 14px; max-width: 880px; }
`;

function docFor(s) {
  const body = s.overlay
    ? s.body
    : `<div class="hx-wrap"><div class="${s.gallery ? "" : "container"}">${s.body}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(s.name)}</title>
<style>${GLOBALS}</style>
<style>${HARNESS_CSS}</style>
</head><body>
<div class="hx-cap"><b>${esc(s.name)}</b> — ${esc(s.caption)}</div>
${body}
</body></html>`;
}

const manifest = [];
for (const s of scenes) {
  const f = path.join(OUT, s.name + ".html");
  fs.writeFileSync(f, docFor(s));
  manifest.push({ name: s.name, caption: s.caption, file: f, overlay: !!s.overlay });
  console.log("wrote " + path.relative(ROOT, f));
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${scenes.length} scenes, ${galleryItems.length} alerts in the gallery.`);
