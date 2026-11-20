// The help session loop (Chat, Fix for me, Teach me). The server decides the next step; this file shows it (the character
// flies there and says it), does it, looks again, and repeats. It stops the instant the person moves
// the mouse, presses Esc, says "stop", or presses Stop.
import { emitTo } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { act, apLog, api, autopilot, ApiError, capture, cmdClassify, cmdRun, cmdStop, cursor, frontApp, getEnv, hush, logCommand, speak, syscheck, track, type CommandLog, type Settings, type Shot } from "./api";
import type { Expr } from "./bot";

export type Mode = "chat" | "fix" | "teach";
export type Proposal = { understood: string; cause: string; task: string; steps: string[]; risk: "low" | "medium" | "high" };
/** A command that changes something: the person sees `why` in plain words, the command itself under Details. */
export type CommandAsk = { why: string; command: string; undo: string };
export type Result = { outcome: string; worked: boolean; verified: boolean; cause: string; steps: string[]; support: string };
export type UI = {
  settings: () => Settings;
  propose: (p: Proposal) => Promise<boolean>; // the approval card: Allow fix (true) or Cancel (false)
  command: (c: CommandAsk) => Promise<boolean>; // the same card for one command that changes something
  checked: (what: string, report: string) => void; // a system check's plain-words result, shown in the chat
  ask: (question: string, options: string[]) => Promise<string>;
  bot: (text: string) => void; // a line in the chat panel
  avoid: (x: number, y: number) => Promise<void>; // move the Step pill off the spot about to be pressed
  progress: (n: number, total: number, task: string) => void;
  walking: (on: boolean) => void;
  needsYou: (text: string | null) => void;
  done: (r: Result) => void;
  problem: (kind: "offline" | "busy" | "cap" | "month_used" | "free_used" | "stopped" | "cancelled" | "paused") => void;
};

const RISKY = /\b(delet|trash|empty the|erase all|erase (your|the)|factory reset|reset (your|the) (mac|pc|computer|phone|password)|pay\b|paying|payment|purchas|buy|checkout|send|post\b|posting|reply|share|password|passcode|install|uninstall|update now|software update|sign(ing)? out|log(ging)? out|accept|agree to|subscribe)/i;
const ov = (name: string, payload: unknown = {}) => emitTo("overlay", name, payload);
const CHECK_LABEL: Record<string, string> = { cpu: "Checking the processor", gpu: "Checking the graphics card", memory: "Checking memory", disk: "Checking disk space", battery: "Checking the battery", temperature: "Checking temperatures", network: "Checking the internet", startup: "Checking what starts up", system: "Checking the computer", all: "Checking the whole computer" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

export class Session {
  id = crypto.randomUUID();
  messages: any[] = [];
  aborted = false;
  task = "";
  total = 0;
  n = 0;
  shot: Shot | null = null;
  /** "do": the assistant clicks. "show": Teach me, the person clicks where the highlight is. */
  pick: "do" | "show" = "do";
  app: string | null = null;
  /** Undo journal: every change in order, so "Undo that" can reverse exactly what happened, even later. */
  journal: { at: number; step: number; said?: string; did?: string }[] = [];
  /** Every command run in this help, sent to the server so it lands in History with the job. */
  commands: CommandLog[] = [];
  /** The short label on the DeskFix cursor ("Opening Settings"): the last say line, shortened. */
  private label: string | null = null;
  private note(entry: { said?: string; did?: string }) {
    this.journal.push({ at: Date.now(), step: this.n, ...entry });
    try {
      localStorage.setItem("df_last_journal", JSON.stringify({ task: this.task, os: navigator.platform, entries: this.journal.slice(-80) }));
    } catch {}
  }
  journalText() {
    return this.journal.map((j, i) => `${i + 1}. ${j.said ? `Said: "${j.said}"` : `Did: ${j.did}`}`).join(String.fromCharCode(10));
  }
  undoPrompt() {
    return `Undo everything you changed in this help, in reverse order, saying each step. Here is exactly what happened:
${this.journalText()}
Only reverse real changes (settings, text, files). Then call done.`;
  }
  private expected: [number, number] | null = null;
  private watching = 0;
  private busy = false;
  /** True while a Yes card, a question or a "your turn" step is up: the person is meant to use the mouse. */
  private waitingOnPerson = false;
  private needConfirm = false;
  private confirmed = false;
  private failures = 0;
  /** Nothing changes on the computer before the person presses Allow fix on the approval card. */
  private allowed = false;
  private escalate = false;
  private stopWaiters: (() => void)[] = [];

  constructor(public mode: Mode, private ui: UI) {
    if (mode === "teach") this.pick = "show";
  }

  stop(why = "stopped") {
    if (this.aborted) return;
    this.aborted = true;
    hush();
    cmdStop(); // a running command dies with the Stop press
    act({ do: "up" }).catch(() => {});
    clearInterval(this.watching);
    ov("ov:expr", { expr: "stopped" });
    ov("ov:label", { text: null });
    ov("ov:say", { text: null });
    ov("ov:confirm", null);
    ov("ov:point", null);
    this.stopWaiters.forEach((f) => f());
    track("help_stopped", { why, session: this.id, step: this.n });
    this.ui.problem(why === "paused" ? "paused" : why === "cancel" ? "cancelled" : "stopped");
  }

  /** Maps a point in the AI's picture to a point on the screen. */
  private toScreen(c: [number, number]): [number, number] {
    const s = this.shot!;
    return [(c[0] * s.sw) / s.w, (c[1] * s.sh) / s.h];
  }

  private watch() {
    // A real mouse move by the person (more than 6 points from where we left it) stops everything.
    clearInterval(this.watching);
    this.watching = window.setInterval(async () => {
      if (this.busy || !this.expected || this.aborted) return;
      const c = await cursor().catch(() => null);
      if (c && !this.waitingOnPerson && Math.hypot(c[0] - this.expected[0], c[1] - this.expected[1]) > 40) this.stop("mouse");
    }, 120);
  }

  private t0 = 0;
  private firstAction = false;
  private mark(what: string) {
    apLog(`timing ${what} ${Date.now() - this.t0}ms`);
    track("help_timing", { session: this.id, what, ms: Date.now() - this.t0 });
  }

  async start(firstText: string, extra: any[] = []) {
    this.t0 = Date.now();
    const env = await getEnv();
    // Something visible right away (well under a second): the helper appears and says it's on it.
    this.ui.walking(true);
    ov("ov:mode", { mode: "walk" });
    ov("ov:expr", { expr: "thinking" });
    cursor().then((c) => c && ov("ov:fly", { x: c[0], y: c[1], ms: 1 }));
    ov("ov:say", { text: "On it. Looking at your screen.", spoken: 99 });
    this.mark("first_visible");
    // Which app they were using when they asked.
    this.app = (await frontApp()) ?? this.app;
    this.shot = await capture();
    ov("ov:screen", { sw: this.shot.sw, sh: this.shot.sh });
    this.messages.push({ role: "user", content: [{ type: "text", text: firstText }, ...extra, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: this.shot.data } }] });
    this.task = firstText.slice(0, 60);
    track("help_started", { mode: this.mode, os: env.os });
    await this.loop();
  }

  /** "Do it for me" (Teach me, at any point): from the next step on the assistant clicks and types. */
  private note2: string | null = null;
  private skipWait: (() => void) | null = null;
  doItForMe() {
    this.pick = "do";
    this.note2 = 'They said "Do it for me". From now on click and type yourself (no more needs_you for ordinary clicks), finish the job, verify it, then call done.';
    this.skipWait?.();
  }

  /** The person said or typed something more (an answer, or "No, still wrong"). */
  async more(text: string) {
    this.aborted = false;
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    await this.loop();
  }

  private async call() {
    const env = await getEnv();
    for (let tries = 0; tries < 3; tries++) {
      try {
        return await api<{ content: any[]; stop_reason: string }>("/api/agent", { session: this.id, mode: this.mode, messages: this.messages, escalate: this.escalate, os: env.os, app: this.app ?? undefined, screen: this.shot ? { w: this.shot.w, h: this.shot.h } : undefined, commands: this.commands.slice(-40) });
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 402) return this.end(), this.ui.problem(err.code as any), null;
        if (err.status === 429 && err.code === "session_cap") return this.ui.problem("cap"), null;
        if (tries === 2) return this.ui.problem(err.status === 0 ? "offline" : "busy"), null;
        await sleep(1500 * (tries + 1));
      }
    }
    return null;
  }

  private async loop() {
    for (let turn = 0; turn < 120 && !this.aborted; turn++) {
      ov("ov:expr", { expr: "thinking" });
      const r = await this.call();
      if (!r || this.aborted) return;
      this.messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b) => b.type === "tool_use");
      for (const b of r.content) if (b.type === "text" && b.text.trim()) this.ui.bot(b.text.trim());
      if (!uses.length) {
        ov("ov:expr", { expr: "idle" });
        return; // the AI is waiting for the person to say something
      }
      const results: any[] = [];
      let finished = false;
      for (const u of uses) {
        const isComputer = u.toolset_name === "computer";
        const base = { type: "tool_result", tool_use_id: u.id, ...(isComputer ? { toolset_name: "computer" } : {}) };
        if (this.aborted) {
          results.push({ ...base, is_error: true, content: "Not executed: the person pressed Stop." });
          continue;
        }
        apLog(`tool ${u.name} ${JSON.stringify(u.input ?? {}).slice(0, 160)}`);
        const tStep = Date.now();
        try {
          const out = isComputer ? await this.computer(u.name, u.input ?? {}) : await this.tool(u.name, u.input ?? {});
          track("help_step", { session: this.id, tool: u.name, ok: true, ms: Date.now() - tStep });
          if (out === "__done__") {
            finished = true;
            results.push({ ...base, content: "OK" });
          } else results.push({ ...base, content: out });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          this.failures++;
          if (this.failures >= 2) this.escalate = true; // two misses: a stronger model takes the next steps
          apLog(`tool error ${u.name}: ${msg.slice(0, 160)}`);
          track("help_step", { session: this.id, tool: u.name, ok: false, ms: Date.now() - tStep, error: msg.slice(0, 120) });
          results.push({ ...base, is_error: true, content: isComputer ? `Error: ${msg}` : msg });
          if (isComputer) {
            // Later actions in the same batch don't run once one fails.
            for (const rest of uses.slice(uses.indexOf(u) + 1)) results.push({ type: "tool_result", tool_use_id: rest.id, ...(rest.toolset_name === "computer" ? { toolset_name: "computer" } : {}), is_error: true, content: "Not executed: an earlier computer action in this turn failed." });
            break;
          }
        }
      }
      if (this.note2) {
        results.push({ type: "text", text: this.note2 });
        this.note2 = null;
      }
      this.messages.push({ role: "user", content: results });
      if (finished || this.aborted) return;
    }
  }

  // ---------- the AI's own tools ----------
  private async tool(name: string, i: any): Promise<any> {
    const s = this.ui.settings();
    switch (name) {
      case "propose": {
        this.total = i.steps?.length ?? 0;
        this.task = i.task || i.understood || this.task;
        ov("ov:expr", { expr: "idle" });
        ov("ov:say", { text: null });
        this.waitingOnPerson = true;
        const allowed = await this.ui.propose({ understood: i.understood, cause: i.cause ?? "", task: this.task, steps: i.steps ?? [], risk: i.risk ?? "low" });
        this.waitingOnPerson = false;
        track("fix_proposal", { allowed, mode: this.mode, risk: i.risk });
        if (!allowed) {
          this.stop("cancel");
          return "They pressed Cancel. Change nothing.";
        }
        this.allowed = true;
        this.beginWalk();
        return this.pick === "show" ? "They pressed Start. Show each step with mouse_move and needs_you; don't click yourself." : "They pressed Allow fix. Do the steps now, then verify the result before you call done.";
      }
      case "say": {
        if (RISKY.test(i.text) && !this.confirmed) this.needConfirm = true;
        this.n = Math.max(this.n, Math.min(this.total || 99, Number(i.step) || this.n || 1));
        this.ui.progress(this.n, Math.max(this.total, this.n), this.task);
        ov("ov:expr", { expr: (i.expression as Expr) ?? "focused" });
        ov("ov:say", { text: i.text, spoken: 999 });
        this.setLabel(i.text);
        this.note({ said: i.text });
        // Spoken only if they turned "Talk out loud" on; either way the next action starts right away.
        if (s.voice) speak(i.text, s);
        await sleep(250);
        return "OK";
      }
      case "ask": {
        ov("ov:expr", { expr: "waiting" });
        this.waitingOnPerson = true;
        const a = await this.ui.ask(i.question, i.options ?? []);
        this.expected = await cursor().catch(() => this.expected);
        this.waitingOnPerson = false;
        return `They answered: "${a}"`;
      }
      case "confirm": {
        const [x, y] = this.expected ?? [innerWidth / 2, innerHeight / 2];
        ov("ov:expr", { expr: "careful" });
        hush();
        speak(i.title, s);
        this.waitingOnPerson = true;
        const yes = await new Promise<boolean>((resolve) => {
          import("@tauri-apps/api/event").then(({ once }) => once<{ yes: boolean }>("ov:answer", (e) => resolve(e.payload.yes)));
          this.stopWaiters.push(() => resolve(false));
          ov("ov:confirm", { x, y, title: i.title, detail: i.detail ?? "", undoable: !!i.undoable });
          this.ui.walking(false);
        });
        ov("ov:confirm", null);
        this.ui.walking(true);
        this.expected = await cursor().catch(() => this.expected);
        this.waitingOnPerson = false;
        this.needConfirm = false;
        this.confirmed = yes;
        track("risky_answer", { yes });
        return yes ? "They pressed Yes. Do it now." : "They said no. Don't do it. Skip it and finish what's left, or call done.";
      }
      case "needs_you": {
        ov("ov:expr", { expr: "waiting" });
        const [x, y] = this.expected ?? [innerWidth / 2, innerHeight / 2];
        ov("ov:point", { x, y });
        ov("ov:say", { text: i.text, spoken: 999 });
        speak(i.text, s);
        this.ui.needsYou(i.text);
        clearInterval(this.watching); // the person is meant to use the mouse now
        const before = hash((await capture(undefined, 320)).data);
        // CI only: the scripted person does what the helper points at.
        if (this.pick === "show" && (await autopilot()) && this.expected) {
          const [px, py] = this.expected;
          setTimeout(() => act({ do: "click", x: px, y: py }).catch(() => {}), 2500);
        }
        await new Promise<void>((resolve) => {
          const iv = setInterval(async () => {
            if (this.aborted) return clearInterval(iv), resolve();
            const now = hash((await capture(undefined, 320)).data);
            if (now !== before) {
              clearInterval(iv);
              setTimeout(resolve, 900); // let the screen settle
            }
          }, 700);
          this.stopWaiters.push(() => (clearInterval(iv), resolve()));
          this.skipWait = () => (clearInterval(iv), resolve());
        });
        this.skipWait = null;
        ov("ov:point", null);
        this.ui.needsYou(null);
        if (this.aborted) return "They stopped.";
        if (this.note2) {
          this.expected = await cursor().catch(() => null); // their hand moved the mouse: start from where it is now
          this.watch();
          return "They did not do this step: they asked you to do it for them.";
        }
        ov("ov:say", { text: this.pick === "show" ? "Good." : "Thanks. Back to me.", spoken: 999 });
        this.expected = await cursor().catch(() => null);
        this.watch();
        return "They did it. Take a screenshot to see what changed.";
      }
      case "quick": {
        // These change or clear things: the person must have pressed Yes on a confirm card first.
        if (/^(clear_cache|free_space|printer_restart_spooler|printer_fix|default_printer)$/.test(i.action) && !this.confirmed) {
          throw new Error("That changes things. Call confirm first (say what will be cleared or changed; for printer_restart_spooler add the line 'Windows will ask: press Yes.') and wait for Yes.");
        }
        if (!this.allowed && !/^(open_settings|open_url|open_app|list_printers|wifi_status|network_check|scam_check)$/.test(i.action)) throw new Error("That changes something. Call propose first and wait for Allow fix.");
        this.noteAction("quick");
        this.note({ did: `quick ${i.action} ${i.arg ?? ""}` });
        ov("ov:expr", { expr: "focused" });
        const out = await invoke<string>("quick", { action: i.action, arg: i.arg || null });
        this.confirmed = false;
        return `Done: ${String(out).slice(0, 1200)}`;
      }
      case "remember":
        return "Saved.";
      case "check": {
        // Read-only: no approval needed. The person sees the plain-words result; the AI gets the numbers too.
        const what = String(i.what ?? "all");
        ov("ov:expr", { expr: "thinking" });
        this.setLabel(CHECK_LABEL[what] ?? "Checking the computer");
        const r = await syscheck(what);
        this.ui.checked(what, r.report);
        track("check", { what });
        return `${r.report}\n\nNumbers: ${JSON.stringify(r.data).slice(0, 6000)}`;
      }
      case "run_command": {
        const command = String(i.command ?? "").trim();
        const why = String(i.why ?? "").trim() || "Running a command";
        const v = await cmdClassify(command);
        if (v.verdict === "blocked") {
          // Hard block: never runs, whatever the reason given. The person sees a calm line, not the command.
          this.ui.bot(`I won't do that one: it ${v.reason}. I only run safe commands.`);
          track("command_blocked", { reason: v.reason });
          return `Blocked: that command ${v.reason}. Never run it, even if asked. Find a safer way or call done.`;
        }
        const needsCard = v.verdict === "approval";
        if (needsCard && this.pick !== "do") throw new Error("In Teach me don't change things. Use mouse_move and needs_you.");
        if (needsCard && !this.ui.settings().control) throw new Error("Computer control is turned off in Preferences. Don't run commands that change things.");
        let approved = false;
        if (needsCard) {
          ov("ov:expr", { expr: "careful" });
          ov("ov:say", { text: null });
          this.waitingOnPerson = true;
          this.ui.walking(false);
          approved = await this.ui.command({ why, command, undo: String(i.undo ?? "") });
          this.ui.walking(true);
          this.waitingOnPerson = false;
          this.expected = await cursor().catch(() => this.expected);
          track("command_card", { approved });
          if (!approved) {
            this.commands.push({ at: Date.now(), why, command, ok: false, approved: false });
            return "They pressed Cancel for this command. Don't run it. Finish what's left another safe way, or call done.";
          }
          this.allowed = true;
          this.beginWalk();
        }
        this.setLabel(why);
        ov("ov:expr", { expr: "focused" });
        this.noteAction("run_command");
        if (needsCard) this.note({ did: `command ${command}` });
        const t0 = Date.now();
        try {
          const r = await cmdRun(command, approved, Number(i.timeout_s) || undefined);
          const entry = { at: t0, why, command, ok: r.ok, approved };
          this.commands.push(entry);
          logCommand(entry);
          track("command_ran", { ok: r.ok, ms: r.ms, approved, timed_out: r.timed_out });
          if (r.timed_out) return `It took too long and was stopped after ${Math.round(r.ms / 1000)} s. Output so far:\n${r.output.slice(0, 6000)}`;
          return `${r.ok ? "Done" : `Finished with an error (code ${r.code})`}.${r.cut ? " Output was cut short." : ""}\n${r.output.slice(0, 6000) || "(no output)"}`;
        } catch (e) {
          const entry = { at: t0, why, command, ok: false, approved };
          this.commands.push(entry);
          logCommand(entry);
          throw new Error(String((e as Error)?.message ?? e));
        }
      }
      case "done": {
        this.end();
        ov("ov:expr", { expr: i.worked ? "happy" : "sorry" });
        ov("ov:label", { text: null });
        ov("ov:say", { text: null });
        // "Problem solved" is shown only when the assistant checked the result itself.
        this.ui.done({ outcome: i.outcome ?? "", worked: !!i.worked && !!i.verified, verified: !!i.verified, cause: i.cause ?? "", steps: i.how_next_time ?? [], support: i.support_summary ?? "" });
        track(i.worked && i.verified ? "fix_verified" : "help_unfinished", { mode: this.mode, pick: this.pick });
        return "__done__";
      }
    }
    throw new Error(`unknown tool ${name}`);
  }

  /** The DeskFix cursor's tag: a few words, present tense ("Opening Settings"). Empty when there's nothing to say. */
  private setLabel(text: string | null) {
    const short = text ? text.replace(/[.!]+$/, "").split(/[,.;:]/)[0].trim().slice(0, 36) : null;
    if (short === this.label) return;
    this.label = short;
    ov("ov:label", { text: short });
  }

  private beginWalk() {
    this.ui.walking(true);
    ov("ov:mode", { mode: "walk" });
    this.expected = null;
    cursor().then((c) => {
      this.expected = c;
      if (c) ov("ov:fly", { x: c[0], y: c[1], ms: 1 });
      this.watch();
    });
  }
  end() {
    clearInterval(this.watching);
    this.ui.walking(false);
  }

  // ---------- computer actions ----------
  private flightMs(to: [number, number]) {
    const from = this.expected ?? to;
    const ms = Math.min(700, Math.max(250, Math.hypot(to[0] - from[0], to[1] - from[1]) / 1.2));
    return this.ui.settings().moveSpeed === "slow" ? ms * 1.6 : ms;
  }
  /** The DeskFix cursor glides to the spot on the overlay. The person's own pointer never moves. */
  private async moveTo(c: [number, number]) {
    const p = this.toScreen(c);
    const ms = this.flightMs(p);
    ov("ov:expr", { expr: "focused" });
    await this.ui.avoid(p[0], p[1]);
    ov("ov:fly", { x: p[0], y: p[1], ms });
    await sleep(ms);
    this.at = p;
    return p;
  }
  /** Where the DeskFix cursor is (clicks without a coordinate go here). */
  private at: [number, number] | null = null;
  private async doing<T>(f: () => Promise<T>, p: [number, number] | null) {
    this.busy = true;
    try {
      return await f();
    } finally {
      if (p) this.expected = p;
      else this.expected = await cursor().catch(() => this.expected);
      setTimeout(() => (this.busy = false), 60);
    }
  }

  /** Our own windows must never receive the helper's typing. */
  private async releaseKeyboard() {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    for (const w of await getAllWebviewWindows()) {
      if (await w.isFocused().catch(() => false)) {
        apLog(`released keyboard from ${w.label}`);
        track("help_step", { tool: "release_keyboard", from: w.label });
        await invoke("walk_focus", { walking: true });
        await sleep(200);
        break;
      }
    }
  }

  private noteAction(name: string) {
    if (!this.firstAction && !/screenshot|zoom|wait|cursor_position/.test(name)) {
      this.firstAction = true;
      this.mark(`first_action ${name}`);
    }
  }

  private async computer(name: string, i: any): Promise<any> {
    this.noteAction(name);
    if (!/screenshot|zoom|wait|cursor_position|mouse_move/.test(name)) this.note({ did: `${name} ${JSON.stringify(i)}` });
    const changes = /click|drag|type|key|mouse_down|mouse_up/.test(name);
    if (changes && !this.allowed) throw new Error("Nothing may change before the person allows it. Call propose first and wait for Allow fix. You may look (screenshot, zoom, scroll) and run read-only quick checks.");
    if (changes && !this.ui.settings().control) throw new Error("Computer control is turned off in Preferences. Use mouse_move and needs_you so the person does each step.");
    if (this.pick !== "do" && changes) throw new Error("In Teach me don't click or type. Use mouse_move and needs_you.");
    if (this.needConfirm && /click|key|type/.test(name)) {
      this.needConfirm = false;
      throw new Error("That looks risky. Call confirm first and wait for Yes.");
    }
    if (/click|key|type/.test(name)) this.confirmed = false;
    switch (name) {
      case "screenshot": {
        this.shot = await capture();
        return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: this.shot.data } }];
      }
      case "zoom": {
        const [x0, y0, x1, y1] = i.region as number[];
        const a = this.toScreen([x0, y0]);
        const b = this.toScreen([x1, y1]);
        const z = await capture([a[0], a[1], b[0] - a[0], b[1] - a[1]], 1024);
        return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: z.data } }];
      }
      case "mouse_move": {
        // Only the DeskFix cursor moves. (Hover menus: the AI clicks them instead.)
        await this.moveTo(i.coordinate);
        return "OK";
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        let p = this.at ?? this.expected ?? [0, 0];
        if (i.coordinate) p = await this.moveTo(i.coordinate);
        await sleep(150); // the eye catches up before the press
        ov("ov:expr", { expr: "pressing" });
        ov("ov:press", { x: p[0], y: p[1] });
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        // Soft first (the OS presses the control, the pointer stays with the person); a real click puts the pointer back after.
        const how = await this.doing(() => act({ do: "click", x: p[0], y: p[1], button: name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left", count, modifiers: i.text ?? null, soft: name === "left_click", restore: true }), null);
        if (typeof how === "string" && how.startsWith("soft")) track("help_step", { tool: "soft_click", what: how.slice(5, 60) });
        ov("ov:expr", { expr: "focused" });
        await sleep(350); // let the screen settle
        return "OK";
      }
      case "left_click_drag": {
        const a = this.toScreen(i.start_coordinate);
        await this.moveTo(i.start_coordinate);
        const b = this.toScreen(i.coordinate);
        ov("ov:fly", { x: b[0], y: b[1], ms: 500 });
        this.at = b;
        await this.doing(() => act({ do: "drag", from: a, to: b, restore: true }), null);
        await sleep(400);
        return "OK";
      }
      case "left_mouse_down":
        await this.doing(() => act({ do: "down" }), null);
        return "OK";
      case "left_mouse_up":
        await this.doing(() => act({ do: "up" }), null);
        return "OK";
      case "scroll": {
        const p = i.coordinate ? await this.moveTo(i.coordinate) : null;
        await this.doing(() => act({ do: "scroll", x: p?.[0] ?? null, y: p?.[1] ?? null, direction: i.scroll_direction, amount: i.scroll_amount ?? 3, restore: true }), null);
        await sleep(400);
        return "OK";
      }
      case "type": {
        await this.releaseKeyboard();
        ov("ov:expr", { expr: "focused" });
        try {
          await this.doing(() => act({ do: "type", text: String(i.text ?? "") }), null);
        } catch (e) {
          throw new Error(/card|ssn|code/.test(String(e)) ? "I won't type that. The person types passwords, codes and card numbers themselves: use needs_you." : String(e));
        }
        await sleep(300);
        return "OK";
      }
      case "key": {
        await this.releaseKeyboard();
        // Our own Esc must not trip the "Esc stops everything" shortcut.
        const esc = /esc/i.test(String(i.text ?? ""));
        if (esc) await unregister("Escape").catch(() => {});
        await this.doing(() => act({ do: "key", combo: String(i.text ?? ""), repeat: i.repeat ?? 1 }), null);
        if (esc && !this.aborted) await register("Escape", () => this.stop("esc")).catch(() => {});
        await sleep(300);
        return "OK";
      }
      case "wait":
        await sleep(Math.min(10, Number(i.duration ?? 1)) * 1000);
        return "OK";
      case "cursor_position": {
        const c = await cursor();
        const s = this.shot!;
        return c ? `X=${Math.round((c[0] * s.w) / s.sw)}, Y=${Math.round((c[1] * s.h) / s.sh)}` : "unknown";
      }
      case "hold_key":
        throw new Error("hold_key isn't available here. Use key instead.");
    }
    throw new Error(`unknown action ${name}`);
  }
}
