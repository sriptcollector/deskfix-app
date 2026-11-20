// The floating assistant: first-run steps (account or guest, what it can do, permissions), the small
// floating icon, the assistant panel (Chat / Fix for me / Teach me / History), the approval card,
// the pill while it works, and the "Problem solved" card.
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Session, type CommandAsk, type Mode, type Proposal, type Result } from "./agent";
import { apLog, api, ApiError, autopilot, commandLog, getEnv, getToken, hush, loadToken, openDashboard, overlayMode, placePanel, screenPaused, server, setScreenPaused, setToken, setUser, speak, track, type CommandLog, type HistoryRow, type Me } from "./api";
import { Bars, Bot } from "./bot";
import { Mic, saidStop } from "./voice";
import { Perms } from "./perms";

type View = "loading" | "welcome" | "signin" | "explain" | "perms" | "ready" | "mini" | "home" | "pill";
type Tab = Mode | "history";
type Line = { who: "bot" | "me"; text: string };
type Card =
  | { kind: "propose"; p: Proposal; teach: boolean }
  | { kind: "command"; c: CommandAsk; details: boolean }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "done"; r: Result; why?: boolean }
  | { kind: "stopped" }
  | { kind: "problem"; title: string; body?: string; action?: { label: string; run: () => void } }
  | null;

const win = getCurrentWindow();
const SIZES: Partial<Record<View, [number, number]>> = { mini: [56, 56], pill: [440, 64] };
const PANEL: [number, number] = [380, 560];
export const SHORTCUT = "CommandOrControl+Shift+Space";
const TABS: [Tab, string][] = [["chat", "Chat"], ["fix", "Fix for me"], ["teach", "Teach me"], ["history", "History"]];
const HELLO: Record<Mode, string> = { chat: "Ask me anything about your computer, or what is on your screen.", fix: "What is not working? Tell me in your own words.", teach: "What do you want to learn? I will show you where to click." };
const SUGGEST: Record<Mode, string[]> = { chat: ["What is this window for?", "Is this website safe?"], fix: ["Make my text bigger", "My printer is offline", "My computer is slow"], teach: ["Show me how to make a spreadsheet", "Show me how to take a screenshot"] };
const PLACE: Record<Mode, string> = { chat: "Type a question", fix: "Type the problem", teach: "Type what to learn" };

export function Panel() {
  const [view, setView] = useState<View>("loading");
  const [tab, setTab] = useState<Tab>("fix");
  const [me, setMe] = useState<Me | null>(null);
  const [os, setOs] = useState<"mac" | "windows">("windows");
  const [lines, setLines] = useState<Line[]>([]);
  const [card, setCard] = useState<Card>(null);
  const [level, setLevel] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState({ n: 0, total: 0, task: "" });
  const [needs, setNeeds] = useState<string | null>(null);
  const [paused, setPaused] = useState(screenPaused());
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const viewRef = useRef(view);
  viewRef.current = view;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const session = useRef<Session | null>(null);
  const live = useRef(false); // a session is running (thinking, working or waiting on a card)
  const waiter = useRef<((s: string) => void) | null>(null);
  const approve = useRef<((ok: boolean) => void) | null>(null);
  const mic = useRef<Mic | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);

  const say = (who: Line["who"], text: string) => setLines((l) => [...l, { who, text }]);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "end" });
  }, [lines, card, thinking]);

  // ---------- window size and placement ----------
  async function show(v: View) {
    setView(v);
    document.body.dataset.busy = live.current ? "1" : "0";
    const [w, h] = SIZES[v] ?? PANEL;
    // Big system text makes everything larger than a fixed window: grow to match, never past the screen.
    const k = v === "mini" ? 1 : Math.min(1.5, Math.max(1, w / innerWidth));
    await placePanel(Math.min(Math.ceil(w * k), screen.availWidth * 0.95), Math.min(Math.ceil(h * k), screen.availHeight * 0.92));
    if (v !== "pill") await invoke("walk_focus", { walking: false });
    await invoke("panel_front", { focus: v !== "pill" && v !== "mini" }).catch(() => win.show());
  }
  // Keep the pill off the spot the assistant is about to press.
  const pillLow = useRef(false);
  async function avoid(x: number, y: number) {
    if (viewRef.current !== "pill") return;
    const k = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(k);
    const sz = (await win.outerSize()).toLogical(k);
    if (x > pos.x - 40 && x < pos.x + sz.width + 40 && y > pos.y - 40 && y < pos.y + sz.height + 40) {
      pillLow.current = !pillLow.current;
      const { availWidth, availHeight } = window.screen;
      await win.setPosition(new LogicalPosition(pillLow.current ? 16 : availWidth - sz.width - 16, pillLow.current ? availHeight - sz.height - 16 : 40));
    }
  }

  // ---------- start-up: who is this, is setup done, are permissions on ----------
  async function loadMe() {
    const m = await api<Me>("/api/me");
    setMe(m);
    setUser(m.email);
    emitTo("overlay", "ov:settings", { textSize: m.settings.textSize });
    document.documentElement.dataset.theme = m.settings.theme === "system" ? "" : m.settings.theme;
    return m;
  }
  async function route(openAfter = true) {
    const env = await getEnv();
    setOs(env.os);
    if (!(await loadToken())) return show("welcome");
    try {
      await loadMe();
    } catch (e) {
      if ((e as ApiError).status === 401) {
        await setToken(null);
        return show("welcome");
      }
      setCard({ kind: "problem", title: "You are offline", body: "Check that Wi-Fi is on, then try again." });
      return show("home");
    }
    if (!localStorage.getItem("df_explained")) return show("explain");
    const p = await invoke<{ screen: boolean; control: boolean }>("perms_status");
    if (!localStorage.getItem("df_perms_ok") || (env.os === "mac" && (!p.screen || !p.control))) return show("perms");
    return show(openAfter ? "home" : "mini");
  }

  useEffect(() => {
    route(false);
    const un = [
      listen<boolean>("panel-toggle", async (e) => {
        // false = close (the native side saw it in front); true = the native side already put it in front.
        if (live.current) return;
        if (!e.payload) return viewRef.current === "home" ? show("mini") : undefined;
        if (viewRef.current === "mini" || viewRef.current === "loading") route(true);
        else show(viewRef.current);
      }),
      listen<{ view?: string }>("panel-open", (e) => (e.payload?.view === "signin" ? show("signin") : route(true))),
      listen("me-changed", () => loadMe().catch(() => {})),
    ];
    register(SHORTCUT, (e) => e.state === "Pressed" && (viewRef.current === "mini" ? route(true) : invoke("panel_toggle"))).catch(() => {});
    return () => {
      un.forEach((p) => p.then((f) => f()));
      unregister(SHORTCUT).catch(() => {});
    };
  }, []);

  // ---------- the mic ----------
  function micStart() {
    mic.current?.stop();
    mic.current = new Mic({ onLevel: setLevel, onWords: (h) => heard(h.text), silenceMs: 1200 });
    mic.current.start().then((ok) => {
      setMicOn(ok);
      if (!ok) say("bot", os === "mac" ? "I can't hear you yet. Your Mac asks once: press Allow on its microphone box. Or type instead." : "I can't hear you yet. Check that a microphone is plugged in, or type instead.");
    });
  }
  function micOff(flush = false) {
    mic.current?.stop(flush);
    setMicOn(false);
  }

  // ---------- Chat / Fix for me / Teach me ----------
  function heard(text: string) {
    const t = text.trim();
    if (!t) return;
    const s = session.current;
    if (s && viewRef.current === "pill") {
      if (saidStop(t)) s.stop("voice");
      else if (/do it for me/i.test(t)) s.doItForMe();
      return;
    }
    say("me", t);
    if (waiter.current) {
      const w = waiter.current;
      waiter.current = null;
      return w(t);
    }
    if (s && live.current) {
      setCard(null);
      setThinking(true);
      return void s.more(t).finally(() => setThinking(false));
    }
    begin(tabRef.current === "history" ? "chat" : (tabRef.current as Mode), t);
  }
  async function begin(mode: Mode, text: string) {
    const m = meRef.current;
    if (m && !m.canUse) return ui.problem(m.why ?? "busy");
    if (screenPaused()) return ui.problem("paused");
    track("help_asked", { mode });
    const s = new Session(mode, ui);
    session.current = s;
    live.current = true;
    setCard(null);
    setThinking(true);
    try {
      await s.start(`They said: "${text}"`);
    } catch (e) {
      live.current = false;
      s.end();
      overlayMode(false);
      setCard({ kind: "problem", title: "I can't see your screen yet", body: os === "mac" ? "Turn on screen viewing for DeskFix in System Settings, then try again." : "Try again in a moment.", action: os === "mac" ? { label: "Show me the switch", run: () => (localStorage.removeItem("df_perms_ok"), show("perms")) } : undefined });
      show("home");
      apLog(`PROBLEM capture ${String(e).slice(0, 120)}`);
    } finally {
      setThinking(false);
      loadMe().catch(() => {});
    }
  }

  // The session asks the panel to show things through this.
  const ui = {
    settings: () => meRef.current!.settings,
    propose: (p: Proposal) =>
      new Promise<boolean>((resolve) => {
        const teach = session.current?.mode === "teach";
        say("bot", p.cause || p.understood);
        setCard({ kind: "propose", p, teach });
        speak(p.cause || p.understood, meRef.current?.settings);
        overlayMode(false);
        show("home");
        approve.current = (ok) => {
          approve.current = null;
          setCard(null);
          if (ok) say("me", teach ? "Start" : "Allow fix");
          resolve(ok);
        };
      }),
    // One command that changes something: plain words up top, the command itself under Details.
    command: (c: CommandAsk) =>
      new Promise<boolean>((resolve) => {
        say("bot", c.why);
        setCard({ kind: "command", c, details: false });
        speak(c.why, meRef.current?.settings);
        overlayMode(false);
        show("home");
        approve.current = (ok) => {
          approve.current = null;
          setCard(null);
          say("me", ok ? "Allow fix" : "Cancel");
          if (!ok) say("bot", "Cancelled. That command did not run.");
          resolve(ok);
        };
      }),
    checked: (_what: string, report: string) => say("bot", report),
    ask: (question: string, options: string[]) =>
      new Promise<string>((resolve) => {
        say("bot", question);
        setCard({ kind: "ask", question, options });
        show("home");
        waiter.current = (t) => {
          setCard(null);
          resolve(t);
        };
      }),
    bot: (text: string) => say("bot", text),
    avoid: (x: number, y: number) => avoid(x, y),
    progress: (n: number, total: number, task: string) => setProgress({ n, total, task }),
    walking: async (on: boolean) => {
      if (on) {
        micOff();
        await overlayMode(true, false);
        register("Escape", () => session.current?.stop("esc")).catch(() => {});
        await show("pill");
        invoke("walk_focus", { walking: true });
      } else {
        unregister("Escape").catch(() => {});
        invoke("walk_focus", { walking: false });
      }
    },
    needsYou: (text: string | null) => setNeeds(text),
    done: (r: Result) => {
      micOff();
      live.current = false;
      setNeeds(null);
      say("bot", r.outcome);
      setCard({ kind: "done", r });
      speak(r.worked ? `Problem solved. ${r.outcome}` : r.outcome, meRef.current?.settings);
      setTimeout(() => overlayMode(false), 2000);
      setHistory(null);
      show("home");
    },
    problem: (kind: string) => {
      micOff();
      setNeeds(null);
      overlayMode(false);
      if (kind === "cancelled") {
        live.current = false;
        say("bot", "Okay. Nothing was changed.");
        setCard(null);
        return show("home");
      }
      if (kind === "stopped") {
        setCard({ kind: "stopped" });
        return show("home");
      }
      live.current = false;
      const left = meRef.current?.fixes.limit ?? 5;
      const canBuy = meRef.current?.checkout !== false;
      const P: Record<string, Card> = {
        offline: { kind: "problem", title: "The internet dropped for a moment", body: "Check your Wi-Fi, then try again." },
        busy: { kind: "problem", title: "I can't think right now", body: "Try again in a minute." },
        cap: { kind: "problem", title: "This one is taking too long", body: "Ask again in a simpler way, or copy a summary for a person to help." },
        paused: { kind: "problem", title: "Screen viewing is paused", body: "I can't look at your screen while it is paused.", action: { label: "Turn it back on", run: () => togglePause(false) } },
        month_used: { kind: "problem", title: "You have used this month's help", body: "It refills on the 1st." },
        free_used: { kind: "problem", title: `You have used your ${left} free fixes this month`, body: canBuy ? "They refill on the 1st. Pro gives you more, for $20 a month." : "They refill on the 1st.", action: canBuy ? { label: "See plans", run: () => openDashboard().then(() => emitTo("dashboard", "dashboard-go", "account")) } : undefined },
      };
      setCard(P[kind] ?? P.busy);
      show("home");
    },
  };

  function togglePause(on: boolean) {
    setScreenPaused(on);
    setPaused(on);
    track("screen_pause", { on });
    if (on && live.current) session.current?.stop("paused");
    if (!on) setCard(null);
  }
  function stopAll() {
    if (live.current && session.current) session.current.stop("button");
    else hush();
  }
  function endSession() {
    live.current = false;
    session.current?.end();
    overlayMode(false);
    setCard(null);
  }
  function minimize() {
    if (live.current) return;
    micOff();
    show("mini");
  }
  const [commands, setCommands] = useState<CommandLog[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  async function loadHistory() {
    setCommands(commandLog());
    setHistory(await api<HistoryRow[]>("/api/history").catch(() => []));
  }
  function summary(r: Result) {
    const s = session.current;
    return [`DeskFix summary (${new Date().toLocaleString()})`, `Computer: ${os === "mac" ? "Mac" : "Windows"}${s?.app ? `, app in front: ${s.app}` : ""}`, `Problem: ${s?.task ?? ""}`, `Result: ${r.outcome}`, r.cause && `Likely cause: ${r.cause}`, r.support && `What was tried:\n${r.support}`, s?.journal.length ? `Steps taken:\n${s.journalText()}` : ""].filter(Boolean).join("\n");
  }

  // ---------- typing beats talking ----------
  function send() {
    const t = draft.trim();
    if (!t) return;
    if (micOn) micOff();
    setDraft("");
    heard(t);
  }

  // ---------- CI test: a scripted person presses what a person would press ----------
  const apDone = useRef<Set<string>>(new Set());
  useEffect(() => {
    autopilot().then((ap) => {
      if (!ap) return;
      const once = (key: string, ms: number, f: () => void) => {
        if (apDone.current.has(key)) return;
        apDone.current.add(key);
        setTimeout(f, ms);
      };
      apLog(`view ${view} ${card?.kind ?? ""}`);
      const [kind, ...rest] = ap.split(":");
      const words = rest.join(":");
      if (view === "welcome") once("welcome", 3000, guest);
      if (view === "explain") once("explain", 3000, () => (localStorage.setItem("df_explained", "1"), route(true)));
      if (view === "perms" && os === "windows") once("perms", 3000, () => (localStorage.setItem("df_perms_ok", "1"), show("ready")));
      if (view === "ready") once("ready", 2500, () => show("home"));
      if (view === "home" && !card && !live.current) once("start", 3500, () => (setTab(kind === "teachdo" ? "teach" : (kind as Tab)), tabRef.current = kind === "teachdo" ? "teach" : (kind as Tab), heard(words)));
      if (card?.kind === "propose" || card?.kind === "command") once(`propose${lines.length}`, 2500, () => approve.current?.(true));
      if (card?.kind === "ask") once(`ask${lines.length}`, 2500, () => heard(card.options[0]));
      if (view === "pill" && needs && kind === "teachdo") once("doit", 1500, () => session.current?.doItForMe());
      if (card?.kind === "done") {
        apLog(`DONE worked=${card.r.worked} verified=${card.r.verified} outcome=${card.r.outcome}`);
        if (!card.r.worked) apLog(`SUMMARY ${summary(card.r).replace(/\n/g, " | ")}`);
      }
      if (card?.kind === "problem") apLog(`PROBLEM ${card.title}`);
      if (card?.kind === "stopped") apLog("STOPPED");
    });
  }, [view, card, needs]);

  // ---------- first run ----------
  const steps = (n: number) => (
    <div className="steps" aria-label={`Step ${n} of 4`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= n ? "on" : ""} />)}
    </div>
  );
  const [guestBusy, setGuestBusy] = useState(false);
  async function guest() {
    setGuestBusy(true);
    try {
      const r = await api<{ token: string }>("/auth/guest", {});
      await setToken(r.token);
      track("guest_start");
      await route(true);
    } catch {
      setCard({ kind: "problem", title: "You are offline", body: "Check that Wi-Fi is on, then try again." });
    }
    setGuestBusy(false);
  }

  if (view === "loading") return <div />;
  if (view === "mini")
    return (
      <button className="mini" onClick={() => route(true)} aria-label="Open DeskFix" title="Open DeskFix">
        D
      </button>
    );
  if (view === "welcome")
    return (
      <div className="panel">
        <div className="drag" data-tauri-drag-region />
        {steps(1)}
        <div className="body center">
          <Bot expr="idle" size={64} />
          <h1>Computer problems? Let AI fix them</h1>
          <p className="small">Free to start: 5 fixes a month. No card.</p>
          <div className="grow" />
          <button className="btn primary full" autoFocus onClick={() => show("signin")}>Create account</button>
          <button className="btn full" style={{ marginTop: 8 }} disabled={guestBusy} onClick={guest}>{guestBusy ? "…" : "Continue as guest"}</button>
          {card?.kind === "problem" && <p className="err">{card.title}. {card.body}</p>}
          <p className="small" style={{ margin: "12px 0 0" }}>An account keeps your history if you change computers.</p>
        </div>
      </div>
    );
  if (view === "signin") return <SignIn progress={steps(1)} onBack={() => (me ? show("home") : show("welcome"))} onDone={() => (track("sign_up"), emitTo("dashboard", "me-changed", {}), route(true))} />;
  if (view === "explain")
    return (
      <div className="panel">
        <div className="drag" data-tauri-drag-region />
        {steps(2)}
        <div className="body" style={{ gap: 10 }}>
          <h1 style={{ fontSize: 24 }}>Here is what I can do</h1>
          {[
            [<WrenchIcon />, "Fix problems", "Tell me what is wrong. I find the cause and ask before I change anything."],
            [<CursorIcon />, "Control the computer", "After you press Allow fix, I click and type for you while you watch."],
            [<LearnIcon />, "Teach software", "Ask how to do something. I highlight where to click and you do each step."],
          ].map(([icon, t, d], i) => (
            <div key={i} className="row" style={{ alignItems: "flex-start", gap: 14, padding: "8px 0" }}>
              {icon}
              <span><b style={{ fontWeight: 500 }}>{t}</b><span className="small" style={{ display: "block" }}>{d}</span></span>
            </div>
          ))}
          <div className="grow" />
          <p className="small" style={{ margin: 0 }}>You can pause screen viewing or press Stop at any time.</p>
          <button className="btn primary full" autoFocus onClick={() => (localStorage.setItem("df_explained", "1"), route(true))}>Continue</button>
        </div>
      </div>
    );
  if (view === "perms")
    return os === "mac" ? (
      <Perms progress={steps(3)} Back={Back} onBack={() => (localStorage.removeItem("df_explained"), show("explain"))} onDone={() => (localStorage.setItem("df_perms_ok", "1"), show("ready"))} />
    ) : (
      <div className="panel">
        <div className="drag" data-tauri-drag-region />
        {steps(3)}
        <div className="body" style={{ gap: 10 }}>
          <Back onClick={() => (localStorage.removeItem("df_explained"), show("explain"))} />
          <h1 style={{ fontSize: 24, marginTop: 0 }}>Let me see and help</h1>
          {[["Screen viewing", "I look at your screen only while I help you."], ["Computer control", "I click and type only after you press Allow fix."]].map(([t, d]) => (
            <div key={t} className="card row" style={{ justifyContent: "space-between" }}>
              <span><b style={{ fontWeight: 500 }}>{t}</b><span className="small" style={{ display: "block" }}>{d}</span></span>
              <span className="status ok">On</span>
            </div>
          ))}
          <p className="small" style={{ margin: "4px 0 0" }}>Windows needs no switch for these. For some fixes Windows asks "Do you want to allow this app to make changes?" You press Yes yourself. I never press it.</p>
          <div className="grow" />
          <button className="btn primary full" autoFocus onClick={() => (localStorage.setItem("df_perms_ok", "1"), track("permission_step", { stage: "windows_ok" }), show("ready"))}>Allow</button>
        </div>
      </div>
    );
  if (view === "ready")
    return (
      <div className="panel">
        <div className="drag" data-tauri-drag-region />
        {steps(4)}
        <div className="body center">
          <Bot expr="happy" size={64} />
          <h1>I am ready to help</h1>
          <p className="small">I stay as a small round button on your screen. Press it any time, or press {os === "mac" ? "Command" : "Ctrl"} + Shift + Space.</p>
          <div className="grow" />
          <button className="btn primary full" autoFocus onClick={() => show("home")}>Open the assistant</button>
        </div>
      </div>
    );

  if (view === "pill")
    return (
      <div className="pill" role="status">
        <Bot expr={needs ? "waiting" : "focused"} size={28} />
        <div className="what">
          <span className="mono">{needs ? "Your turn" : progress.total ? `Step ${progress.n} of ${progress.total}` : "Working"}</span>
          <span>{needs ?? progress.task}</span>
        </div>
        {session.current?.pick === "show" && <button className="btn sm" onClick={() => session.current?.doItForMe()}>Do it for me</button>}
        <button className="btn sm" onClick={() => togglePause(true)} aria-label="Pause screen viewing" title="Pause screen viewing"><EyeIcon off={false} /></button>
        <button className="btn stop" onClick={stopAll}>Stop</button>
      </div>
    );

  // ---------- the assistant panel ----------
  const mode: Mode = tab === "history" ? "chat" : tab;
  const empty = lines.length === 0 && !card && !thinking;
  return (
    <div className="panel">
      <div className="head" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region><Bot expr={thinking ? "thinking" : "idle"} size={28} /> DeskFix</span>
        <button className="btn sm" role="switch" aria-checked={!paused} onClick={() => togglePause(!paused)} title={paused ? "Screen viewing is paused. Press to turn it on." : "Pause screen viewing"} aria-label="Screen viewing">
          <EyeIcon off={paused} />
        </button>
        <button className="btn stop" disabled={!live.current && !thinking} onClick={stopAll}>Stop</button>
        <button className="btn sm" onClick={minimize} aria-label="Minimize to the floating button" title="Minimize">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
        </button>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => (setTab(t), t === "history" && loadHistory())}>{label}</button>
        ))}
      </div>
      {tab === "history" ? (
        <div className="body" style={{ padding: "12px 16px 16px", overflowY: "auto" }}>
          {history === null ? <p className="small">Loading…</p> : history.length === 0 ? (
            <div className="center" style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <p>Nothing here yet. I keep each note for 30 days.</p>
              <p className="small">Problems I fix and things I teach you show up here.</p>
              <button className="btn" onClick={() => setTab("fix")}>Fix something</button>
            </div>
          ) : (
            <div className="rows">
              {history.map((h) => (
                <div key={h.at}>
                  <button className="r" onClick={() => setOpen(open === h.at ? null : h.at)} aria-expanded={open === h.at}>
                    <span className="d">{new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                    <span className="t">{h.task}</span>
                    <span className={`status ${h.worked ? "ok" : "bad"}`}>{h.worked ? "Solved" : "Not fixed"}</span>
                  </button>
                  {open === h.at && (
                    <div className="small" style={{ padding: "0 16px 14px 102px", userSelect: "text" }}>
                      <p style={{ margin: "0 0 6px" }}>{h.outcome}</p>
                      {h.cause && <p style={{ margin: "0 0 6px" }}>Cause: {h.cause}</p>}
                      {h.steps?.length > 0 && <ol style={{ margin: 0, paddingLeft: 18 }}>{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                      {h.commands && h.commands.length > 0 && <CommandList rows={h.commands} />}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {commands.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <button className="r cmdhead" onClick={() => setShowCommands(!showCommands)} aria-expanded={showCommands}>
                <span className="mono">Commands run on this computer</span>
                <span className="small">{commands.length}</span>
              </button>
              {showCommands && <CommandList rows={commands} dates />}
            </div>
          )}
          <div className="grow" />
          <button className="link" onClick={() => openDashboard()}>Open the dashboard</button>
        </div>
      ) : (
        <div className="body" style={{ padding: "12px 16px 16px" }}>
          <div className="chat" aria-live="polite">
            {empty && (
              <>
                <div className="msg helper">{HELLO[mode]}</div>
                <div className="chips" aria-label="Try one of these">
                  {SUGGEST[mode].map((s) => <button key={s} className="chip" onClick={() => heard(s)}>{s}</button>)}
                </div>
              </>
            )}
            {lines.map((l, i) => <div key={i} className={`msg ${l.who === "bot" ? "helper" : "me"}`}>{l.text}</div>)}
            {thinking && !card && <div className="msg helper small">Looking at your screen…</div>}
            {card?.kind === "propose" && (
              <div className="card">
                <span className="mono">{card.teach ? "What I will show you" : "What I will change"}</span>
                <ol>{card.p.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                {card.p.risk !== "low" && !card.teach && <p className="small warn" style={{ margin: "10px 0 0" }}>{card.p.risk === "high" ? "This changes something important. I will ask once more before that step." : "This changes more than a simple setting."}</p>}
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="btn primary" style={{ flex: 1 }} autoFocus onClick={() => approve.current?.(true)}>{card.teach ? "Start" : "Allow fix"}</button>
                  <button className="btn" style={{ flex: 1 }} onClick={() => approve.current?.(false)}>Cancel</button>
                </div>
                <p className="small" style={{ margin: "10px 0 0" }}>Nothing changes until you allow it. Press Stop at any time.</p>
              </div>
            )}
            {card?.kind === "command" && (
              <div className="card" data-card="command">
                <span className="mono">What I will change</span>
                <p style={{ margin: "8px 0 0", fontSize: 17, lineHeight: "24px" }}>{card.c.why}</p>
                {card.c.undo && <p className="small" style={{ margin: "8px 0 0" }}>{card.c.undo}</p>}
                <button className="link" style={{ padding: "8px 0 0" }} onClick={() => setCard({ ...card, details: !card.details })} aria-expanded={card.details}>{card.details ? "Hide details" : "Details"}</button>
                {card.details && <pre className="cmd" aria-label="The exact command">{card.c.command}</pre>}
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="btn primary" style={{ flex: 1 }} autoFocus onClick={() => approve.current?.(true)}>Allow fix</button>
                  <button className="btn" style={{ flex: 1 }} onClick={() => approve.current?.(false)}>Cancel</button>
                </div>
                <p className="small" style={{ margin: "10px 0 0" }}>Nothing changes until you allow it. Press Stop at any time.</p>
              </div>
            )}
            {card?.kind === "ask" && (
              <div className="chips">
                {card.options.map((o, i) => <button key={o} className={`chip${i === 0 ? " rec" : ""}`} autoFocus={i === 0} onClick={() => heard(o)}>{o}{i === 0 && <span className="tag">Best</span>}</button>)}
              </div>
            )}
            {card?.kind === "done" && card.r.worked && (
              <div className="card">
                <span className="status ok">{session.current?.mode === "fix" || card.r.cause ? "Problem solved" : "Done"}</span>
                {card.why && card.r.cause && <p className="small" style={{ margin: "10px 0 0", userSelect: "text" }}>{card.r.cause}</p>}
                {card.why && card.r.steps.length > 0 && <><p className="small" style={{ margin: "10px 0 0" }}>Next time, you can:</p><ol>{card.r.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></>}
                <p style={{ margin: "12px 0 8px", fontWeight: 500 }}>Is everything working?</p>
                <div className="chips">
                  <button className="chip rec" autoFocus onClick={() => (track("fix_confirmed", { yes: true }), endSession(), say("bot", "Good. I saved this in History."), setTimeout(() => !live.current && viewRef.current === "home" && show("mini"), 1800))}>Yes, all good</button>
                  <button className="chip" onClick={() => (track("fix_confirmed", { yes: false }), setCard(null), live.current = true, say("bot", "What is still wrong?"))}>No, still wrong</button>
                  {!card.why && (card.r.cause || card.r.steps.length > 0) && <button className="chip" onClick={() => setCard({ ...card, why: true })}>{card.r.cause ? "Why did this happen?" : "Show me the steps"}</button>}
                  {session.current?.journal.some((j) => j.did) && <button className="chip" onClick={() => (setCard(null), say("me", "Undo that"), live.current = true, setThinking(true), session.current!.more(session.current!.undoPrompt()).finally(() => setThinking(false)))}>Undo that</button>}
                </div>
              </div>
            )}
            {card?.kind === "done" && !card.r.worked && (
              <div className="card">
                <span className="status bad">Could not fix</span>
                {card.r.cause && <p className="small" style={{ margin: "10px 0 0", userSelect: "text" }}>{card.r.cause}</p>}
                <div className="chips" style={{ marginTop: 12 }}>
                  <button className="chip rec" autoFocus onClick={() => (setCard(null), live.current = true, setThinking(true), session.current!.more("Try a different, safe way. Take a screenshot first. If it needs a riskier action, call confirm first.").finally(() => setThinking(false)))}>Try another safe way</button>
                  <button className="chip" onClick={() => navigator.clipboard.writeText(summary(card.r)).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2500)))}>{copied ? "Copied" : "Copy summary for support"}</button>
                  <button className="chip" onClick={endSession}>I am done</button>
                </div>
                <p className="small" style={{ margin: "10px 0 0" }}>The summary says what was wrong and what I tried. Paste it to a person who helps you.</p>
              </div>
            )}
            {card?.kind === "stopped" && (
              <div className="card">
                <h2>Stopped. Nothing else will happen</h2>
                <div className="chips" style={{ marginTop: 12 }}>
                  <button className="chip rec" autoFocus onClick={() => (setCard(null), setThinking(true), session.current!.more("Keep going from where things are now. Take a screenshot first.").finally(() => setThinking(false)))}>Keep going</button>
                  {session.current?.journal.some((j) => j.did) && <button className="chip" onClick={() => (setCard(null), setThinking(true), session.current!.more(session.current!.undoPrompt()).finally(() => setThinking(false)))}>Undo what you did</button>}
                  <button className="chip" onClick={endSession}>I am done</button>
                </div>
              </div>
            )}
            {card?.kind === "problem" && (
              <div className="card">
                <h2>{card.title}</h2>
                {card.body && <p className="small" style={{ margin: "6px 0 0" }}>{card.body}</p>}
                <div className="chips" style={{ marginTop: 12 }}>
                  {card.action && <button className="chip rec" onClick={() => (setCard(null), card.action!.run())}>{card.action.label}</button>}
                  <button className="chip" onClick={() => (setCard(null), route(true))}>Try again</button>
                </div>
              </div>
            )}
            <div ref={chatEnd} />
          </div>
          {micOn && <div className="listening" aria-live="polite"><Bars level={level} />Listening…</div>}
          <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
            <input value={draft} onChange={(e) => (micOn && micOff(true), setDraft(e.target.value))} placeholder={PLACE[mode]} aria-label={PLACE[mode]} />
            <button type="button" className={`mic${micOn ? " on" : ""}`} aria-pressed={micOn} aria-label={micOn ? "Turn the mic off" : "Speak instead of typing"} title={micOn ? "Turn the mic off" : "Speak"} onClick={() => (micOn ? micOff(true) : micStart())}>
              <MicIcon />
            </button>
          </form>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
            <span className="small">{me?.fixes.limit != null ? `${me.fixes.left} of ${me.fixes.limit} free fixes left this month` : paused ? "Screen viewing is paused" : ""}</span>
            <button className="link" style={{ padding: 0 }} onClick={() => openDashboard()}>Dashboard</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Every setup step has a visible Back that keeps what was entered.
/** Commands shown in History: plain words first, the command itself in small print. */
function CommandList({ rows, dates = false }: { rows: CommandLog[]; dates?: boolean }) {
  return (
    <ul className="cmds" aria-label="Commands">
      {rows.map((c, i) => (
        <li key={c.at + i}>
          <span>
            {dates && <span className="d">{new Date(c.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} </span>}
            {c.why}
            <span className={`tag ${c.approved ? "" : "quiet"}`} style={{ marginLeft: 8 }}>{!c.approved ? "Read only" : c.ok ? "Allowed" : "Did not finish"}</span>
          </span>
          <code>{c.command}</code>
        </li>
      ))}
    </ul>
  );
}

const Back = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="link back" onClick={onClick} aria-label="Back">
    ← Back
  </button>
);

// ---------- create account / sign in (Google first, or an emailed code; no password) ----------
function SignIn({ progress, onDone, onBack }: { progress: React.ReactNode; onDone: () => void; onBack: () => void }) {
  const [step, setStep] = useState<"choose" | "email" | "code" | "waiting">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState("");
  const [wait, setWait] = useState(0);
  // A guest who makes an account keeps their history: the server gets the guest session.
  const guest = useRef(getToken());
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const [googleOn, setGoogleOn] = useState(false);
  useEffect(() => {
    getEnv().then((env) => {
      if (env.signin === "email") return setStep((s) => (s === "choose" ? "email" : s));
      api<{ google: boolean }>("/api/config").then((c) => (setGoogleOn(c.google), !c.google && setStep((s) => (s === "choose" ? "email" : s)))).catch(() => setStep((s) => (s === "choose" ? "email" : s)));
    });
  }, []);
  async function google() {
    setStep("waiting");
    try {
      const me = guest.current ? await api<Me>("/api/me").catch(() => null) : null;
      const t = await invoke<string>("google_signin", { server: await server(), guest: me?.guest ? me.email : null });
      await setToken(t);
      onDone();
    } catch {
      setErr("That did not work. Try again.");
      setStep("choose");
    }
  }
  async function sendCode() {
    setBusy(true);
    setErr("");
    const again = step === "code";
    setSent("");
    try {
      await api("/auth/email/start", { email });
      setStep("code");
      setCode("");
      setWait(30);
      if (again) setSent(`New code sent at ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Use the newest email. Check your spam folder too.`);
    } catch (e) {
      setErr((e as ApiError).code === "offline" ? "You are offline. Check your Wi-Fi and try again." : "That email does not look right. Check it and try again.");
    }
    setBusy(false);
  }
  async function verify(c = code) {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ token: string }>("/auth/email/verify", { email, code: c }, { headers: guest.current ? { "x-guest": guest.current } : {} });
      await setToken(r.token);
      onDone();
    } catch {
      setErr("That code did not work. Check it, or send a new one.");
    }
    setBusy(false);
  }
  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body center">
        <Back onClick={() => (step === "code" ? setStep("email") : (step === "email" && googleOn) || step === "waiting" ? setStep("choose") : onBack())} />
        <Bot expr={step === "waiting" ? "waiting" : "idle"} size={56} />
        {step === "waiting" ? (
          <>
            <h1>Finish in your browser</h1>
            <p>Then come back here.</p>
            <button className="link" onClick={google}>Open the browser again</button>
          </>
        ) : step === "choose" ? (
          <>
            <h1>Create your account</h1>
            <p className="small">No password. Free: 5 fixes a month.</p>
            <div className="grow" />
            <button className="btn primary full" autoFocus onClick={google}><GoogleG /> Continue with Google</button>
            <button className="link" onClick={() => setStep("email")}>Use my email instead</button>
            {err && <p className="err">{err}</p>}
            <p className="small" style={{ margin: "8px 0 0" }}>We only see your name and email. Never your passwords or mail.</p>
          </>
        ) : step === "email" ? (
          <form className="stack" style={{ width: "100%", textAlign: "left" }} onSubmit={(e) => (e.preventDefault(), sendCode())}>
            <h1 style={{ textAlign: "center" }}>What is your email?</h1>
            <p className="small" style={{ textAlign: "center", margin: "0 auto 8px" }}>We email you a 6-digit code. No password.</p>
            <label className="small" htmlFor="em">Your email</label>
            <input id="em" className="field" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <p className="err">{err}</p>}
            <div style={{ height: 8 }} />
            <button className="btn primary full" disabled={busy || !email.includes("@")}>{busy ? "…" : "Send me a code"}</button>
          </form>
        ) : (
          <form className="stack" style={{ width: "100%", textAlign: "left" }} onSubmit={(e) => (e.preventDefault(), verify())}>
            <h1 style={{ textAlign: "center" }}>Check your email</h1>
            <p className="small" style={{ textAlign: "center", margin: "0 auto 8px" }}>We sent a 6-digit code to {email}.</p>
            <label className="small" htmlFor="cd">The code</label>
            <input id="cd" className="field code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "");
              setCode(v);
              if (v.length === 6) verify(v);
            }} />
            {err && <p className="err">{err}</p>}
            {sent && !err && <p className="small" role="status" style={{ textAlign: "center" }}>{sent}</p>}
            <div style={{ height: 8 }} />
            <button className="btn primary full" disabled={busy || code.length !== 6}>{busy ? "…" : "Sign in"}</button>
            <div className="row" style={{ justifyContent: "center" }}>
              {/@gmail\.com$/i.test(email) && <button type="button" className="link" onClick={() => openUrl("https://mail.google.com")}>Open Gmail</button>}
              <button type="button" className="link" onClick={sendCode} disabled={busy || wait > 0}>{wait > 0 ? `Send a new code (${wait}s)` : "Send a new code"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------- icons (our own line icons, 1.75 px stroke) ----------
const I = (p: { children: React.ReactNode; size?: number }) => (
  <svg width={p.size ?? 24} height={p.size ?? 24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: "none" }}>{p.children}</svg>
);
const WrenchIcon = () => <I><path d="M14.5 4.5a4 4 0 0 0-4.9 5.2L4 15.3 6.7 18l5.6-5.6a4 4 0 0 0 5.2-4.9l-2.4 2.4-2.3-.5-.5-2.3z" /></I>;
const CursorIcon = () => <I><path d="M6 4l11 6.5-4.8 1.4L15 18l-2.2 1-2.8-6-3.4 3.2z" /></I>;
const LearnIcon = () => <I><path d="M3 8.5 12 4l9 4.5-9 4.5z" /><path d="M7 10.5v4.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-4.5M21 8.5V14" /></I>;
const MicIcon = () => <I size={18}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></I>;
const EyeIcon = ({ off }: { off: boolean }) => <I size={18}><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" />{off && <path d="M4 4l16 16" />}</I>;
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
);
