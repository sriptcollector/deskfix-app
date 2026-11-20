// The dashboard: four sections only (Orion's spec). Assistant, Activity, Preferences, Account.
import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { api, ApiError, getEnv, loadToken, server, setToken, track, type HistoryRow, type Me, type Settings } from "./api";

type Section = "assistant" | "activity" | "preferences" | "account";
const NAMES: [Section, string][] = [["assistant", "Assistant"], ["activity", "Activity"], ["preferences", "Preferences"], ["account", "Account"]];
const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "long", day: "numeric" });

export function Dashboard() {
  const [sec, setSec] = useState<Section>("assistant");
  const [me, setMe] = useState<Me | null>(null);
  const [os, setOs] = useState<"mac" | "windows">("windows");
  const [version, setVersion] = useState("");
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [offline, setOffline] = useState(false);

  async function load() {
    const env = await getEnv();
    setOs(env.os);
    setVersion(env.version);
    if (!(await loadToken())) return setMe(null);
    try {
      const m = await api<Me>("/api/me");
      setMe(m);
      setOffline(false);
      document.documentElement.dataset.theme = m.settings.theme === "system" ? "" : m.settings.theme;
    } catch (e) {
      if ((e as ApiError).status === 401) setMe(null);
      else setOffline(true);
    }
    setRows(await api<HistoryRow[]>("/api/history").catch(() => []));
  }
  useEffect(() => {
    load();
    const un = [listen("dashboard-open", load), listen<Section>("dashboard-go", (e) => setSec(e.payload)), listen("me-changed", load)];
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => (un.forEach((p) => p.then((f) => f())), window.removeEventListener("focus", onFocus));
  }, []);

  const set = async (patch: Partial<Settings> & { memories?: string[] }) => {
    const m = await api<Me>("/api/settings", patch).catch(() => null);
    if (m) {
      setMe(m);
      document.documentElement.dataset.theme = m.settings.theme === "system" ? "" : m.settings.theme;
      emitTo("panel", "me-changed", {});
      emitTo("overlay", "ov:settings", { textSize: m.settings.textSize });
    }
  };
  const openAssistant = (view?: string) => emitTo("panel", "panel-open", { view });
  const flash = (t: string) => (setNote(t), setTimeout(() => setNote(""), 4000));

  const Toggle = ({ k, label, hint }: { k: keyof Settings; label: string; hint: string }) => (
    <div className="pref">
      <span className="l">{label}<span className="small">{hint}</span></span>
      <button className="toggle" role="switch" aria-checked={!!me!.settings[k]} aria-label={label} onClick={() => set({ [k]: !me!.settings[k] } as any)} />
    </div>
  );
  const Seg = ({ k, label, opts }: { k: keyof Settings; label: string; opts: [any, string][] }) => (
    <div className="pref">
      <span className="l">{label}</span>
      <span className="seg" role="radiogroup" aria-label={label}>
        {opts.map(([v, l]) => <button key={String(v)} role="radio" aria-checked={me!.settings[k] === v} onClick={() => set({ [k]: v } as any)}>{l}</button>)}
      </span>
    </div>
  );

  async function checkout(plan: "pro" | "business", seats = 1) {
    try {
      const r = await api<{ url: string }>("/api/checkout", { plan, seats });
      await openUrl(r.url.startsWith("/") ? (await server()) + r.url : r.url);
      track("begin_checkout", { plan });
      flash("A page opened in your web browser. Come back here when it is done.");
    } catch {
      flash("Checkout did not open. Try again in a minute.");
    }
  }
  async function portal() {
    try {
      const r = await api<{ url: string }>("/api/portal", {});
      await openUrl(r.url.startsWith("/") ? (await server()) + r.url : r.url);
    } catch {
      flash("Billing did not open. Try again in a minute.");
    }
  }
  const [seats, setSeats] = useState(3);
  const [joinCode, setJoinCode] = useState("");
  const [invite, setInvite] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="dash">
      <nav className="rail" aria-label="Sections">
        <div className="brand">DeskFix</div>
        {NAMES.map(([s, n]) => <button key={s} aria-current={sec === s ? "page" : undefined} onClick={() => setSec(s)}>{n}</button>)}
        <div className="grow" />
        <span className="small" style={{ padding: "0 12px" }}>Version {version}</span>
      </nav>
      <main className="main">
        {offline && <p className="err" role="alert" style={{ marginBottom: 16 }}>You are offline. Check your Wi-Fi. What you see may be old.</p>}
        {!me && !offline ? (
          <>
            <h1>Finish setting up</h1>
            <p>Open the assistant to create an account or continue as a guest.</p>
            <button className="btn primary" onClick={() => openAssistant()}>Open the assistant</button>
          </>
        ) : !me ? null : sec === "assistant" ? (
          <>
            <h1>Assistant</h1>
            <p>Say what you want. I look, explain, and ask before I change anything.</p>
            <div className="rows" style={{ maxWidth: 620, marginBottom: 20 }}>
              {[["Chat", "Type or speak a question about your computer or your screen."], ["Fix for me", "I find the cause, show what I will change, and wait for Allow fix."], ["Teach me", "I highlight where to click. You do each step, or say Do it for me."], ["History", "Problems I solved before, and how."]].map(([t, d]) => (
                <div className="r" key={t}><span style={{ width: 110, fontWeight: 500, flex: "none" }}>{t}</span><span className="small">{d}</span></div>
              ))}
            </div>
            <button className="btn primary" onClick={() => openAssistant()}>Open the assistant</button>
            <p className="small" style={{ marginTop: 16 }}>Shortcut: {os === "mac" ? "Command" : "Ctrl"} + Shift + Space, from any app. Or press the round DeskFix button on your screen.</p>
          </>
        ) : sec === "activity" ? (
          <>
            <h1>Activity</h1>
            {rows === null ? <p className="small">Loading…</p> : rows.length === 0 ? (
              <>
                <p>No problems or lessons yet. When I fix or teach something, it shows up here. Each note is deleted after 30 days.</p>
                <button className="btn primary" onClick={() => openAssistant()}>Open the assistant</button>
              </>
            ) : (
              <div className="rows" style={{ maxWidth: 720 }}>
                <p className="small" style={{ margin: "0 0 12px" }}>The last 30 days. Each note is deleted 30 days after it is made.</p>
                {rows.map((h) => (
                  <div key={h.at}>
                    <button className="r" onClick={() => setOpen(open === h.at ? null : h.at)} aria-expanded={open === h.at}>
                      <span className="d">{new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                      <span className="t">{h.task}</span>
                      <span className="mono" style={{ width: 60 }}>{h.mode === "fix" ? "Fix" : h.mode === "teach" ? "Teach" : "Chat"}</span>
                      <span className={`status ${h.worked ? "ok" : "bad"}`}>{h.worked ? "Solved" : "Not fixed"}</span>
                    </button>
                    {open === h.at && (
                      <div className="small" style={{ padding: "0 16px 16px 102px", userSelect: "text" }}>
                        <p style={{ margin: "0 0 6px", color: "var(--ink)" }}>{h.outcome}</p>
                        {h.cause && <p style={{ margin: "0 0 6px" }}>Cause: {h.cause}</p>}
                        {h.steps?.length > 0 && <ol style={{ margin: "0 0 6px", paddingLeft: 18 }}>{h.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>}
                        {!h.worked && h.support && <button className="btn sm" onClick={() => navigator.clipboard.writeText(`DeskFix summary\nProblem: ${h.task}\nResult: ${h.outcome}\n${h.support}`).then(() => flash("Copied. Paste it to a person who helps you."))}>Copy summary for support</button>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : sec === "preferences" ? (
          <div style={{ maxWidth: 620 }}>
            <h1>Preferences</h1>
            <span className="mono">Voice</span>
            <div style={{ marginBottom: 24 }}>
              <Toggle k="voice" label="Talk out loud" hint="I say each step as I do it." />
              <Seg k="speech" label="How fast I talk" opts={[["slow", "Slower"], ["normal", "Normal"], ["fast", "Faster"]]} />
              <Seg k="textSize" label="Word size in my bubbles" opts={[[15, "Small"], [17, "Normal"], [20, "Big"]]} />
            </div>
            <span className="mono">Control permissions</span>
            <div style={{ marginBottom: 24 }}>
              <Toggle k="control" label="Let DeskFix click and type" hint="Off: I only show you where to click. You do every step." />
              <Seg k="moveSpeed" label="How fast I move" opts={[["slow", "Slower"], ["normal", "Normal"]]} />
              {os === "mac" && (
                <div className="pref">
                  <span className="l">Mac switches<span className="small">Screen viewing and computer control are switches in System Settings.</span></span>
                  <span className="row"><button className="btn sm" onClick={() => invoke("perms_open", { which: "screen" })}>Screen</button><button className="btn sm" onClick={() => invoke("perms_open", { which: "control" })}>Control</button></span>
                </div>
              )}
            </div>
            <span className="mono">Privacy</span>
            <div>
              <Toggle k="keepHistory" label="Keep a history of what I fix" hint="A short note per problem, deleted after 30 days. No pictures of your screen are kept." />
              <div className="pref">
                <span className="l">Clear my history<span className="small">Removes every note in Activity. This can't be undone.</span></span>
                <button className="btn sm" onClick={() => api("/api/history/clear", {}).then(() => (setRows([]), flash("History cleared.")))}>Clear</button>
              </div>
              <div className="pref" style={{ alignItems: "flex-start" }}>
                <span className="l">What I remember about you<span className="small">{me.memories.length ? "Each line is deleted after 30 days. Press a line to forget it now." : "Nothing yet. I only remember what you tell me to, for 30 days."}</span></span>
                <span className="stack" style={{ alignItems: "flex-end" }}>
                  {me.memories.map((m) => <button key={m} className="btn sm" title="Forget this" onClick={() => set({ memories: me.memories.filter((x) => x !== m) })}>{m} ×</button>)}
                </span>
              </div>
              <Seg k="theme" label="Look" opts={[["system", "Match my computer"], ["light", "Light"], ["dark", "Dark"]]} />
            </div>
            <p className="small" style={{ marginTop: 16 }}>Screen pictures leave your computer only while I help you, and you can pause that from the assistant at any time.</p>
          </div>
        ) : (
          <div style={{ maxWidth: 620 }}>
            <h1>Account</h1>
            <div className="plan">
              <span className="mono">Your plan</span>
              <div className="price">{me.plan === "free" ? "Free" : me.plan === "pro" ? <>Pro <small>$20 a month</small></> : <>Business <small>$15 per person a month · {me.seats} {me.seats === 1 ? "seat" : "seats"}</small></>}</div>
              {me.fixes.limit != null ? <p style={{ margin: "8px 0 0" }}>{me.fixes.left} of {me.fixes.limit} fixes left this month. They refill on the 1st.</p> : <p style={{ margin: "8px 0 0" }}>{me.fixes.used} {me.fixes.used === 1 ? "fix" : "fixes"} this month.</p>}
              {me.payer && <p className="small" style={{ margin: "6px 0 0" }}>Paid by {me.payer}.</p>}
              {me.comp && <p className="small" style={{ margin: "6px 0 0" }}>This account is free of charge.</p>}
              {me.status === "canceled" && me.cancelAt && <p className="small" style={{ margin: "6px 0 0" }}>Cancelled. It keeps working until {fmt(me.cancelAt)}.</p>}
              {me.status === "active" && me.renews && !me.payer && <p className="small" style={{ margin: "6px 0 0" }}>Next bill: {fmt(me.renews)}. Charges show as Toolbay AI, the company behind DeskFix.</p>}
              {me.status === "past_due" && <p className="err">Your last payment did not go through. Open Billing to fix the card.</p>}
              {me.plan !== "free" && !me.payer && !me.comp && <p className="small" style={{ margin: "6px 0 0" }}>Cancel any time. No refunds: your plan stays on until the paid month ends.</p>}
              {me.plan !== "free" && !me.payer && !me.comp && <button className="btn" style={{ marginTop: 14 }} onClick={portal}>Billing</button>}
            </div>
            {me.plan === "free" && !me.payer && (me.guest ? (
              <div className="plan">
                <span className="mono">You are a guest</span>
                <p style={{ margin: "8px 0 14px" }}>Create an account to keep your history and to get more fixes. It takes a minute. No password.</p>
                <button className="btn primary" onClick={() => openAssistant("signin")}>Create account</button>
              </div>
            ) : (
              <>
                <div className="plan">
                  <span className="mono">Pro · most people pick this</span>
                  <div className="price">$20 <small>a month</small></div>
                  <p className="small" style={{ margin: "8px 0 14px" }}>Help whenever you need it, not only 5 times a month. Cancel any time. No refunds: your plan stays on until the paid month ends.</p>
                  <button className="btn primary" onClick={() => checkout("pro")}>Get Pro</button>
                </div>
                <div className="plan">
                  <span className="mono">Business · for teams</span>
                  <div className="price">$15 <small>per person a month</small></div>
                  <div className="row" style={{ margin: "12px 0 14px" }}>
                    <label htmlFor="seats" className="small">People</label>
                    <input id="seats" className="field" style={{ width: 90 }} type="number" min={1} max={50} value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
                    <span className="small">${seats * 15} a month</span>
                  </div>
                  <p className="small" style={{ margin: "0 0 14px" }}>Cancel any time. No refunds: the plan stays on until the paid month ends.</p>
                  <button className="btn" onClick={() => checkout("business", seats)}>Get Business</button>
                </div>
                <div className="plan">
                  <span className="mono">Have a team code?</span>
                  <form className="row" style={{ marginTop: 10 }} onSubmit={async (e) => {
                    e.preventDefault();
                    const r = await api<any>("/api/team/join", { code: joinCode }).catch(() => ({ error: "That did not work. Try again." }));
                    r.ok ? (flash("You are on your team's plan."), load()) : flash(r.error);
                  }}>
                    <input className="field" aria-label="Team code" placeholder="Team code" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
                    <button className="btn" disabled={joinCode.length < 6}>Join</button>
                  </form>
                </div>
              </>
            ))}
            {me.plan === "business" && !me.payer && (
              <div className="plan">
                <span className="mono">Your team · {me.members.length} of {me.seats} seats used</span>
                {me.members.map((m) => (
                  <div className="pref" key={m}><span className="l">{m}</span><button className="btn sm" onClick={() => api<Me>("/api/team/remove", { email: m }).then(setMe)}>Remove</button></div>
                ))}
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" onClick={async () => {
                    const r = await api<any>("/api/team/invite", {}).catch(() => ({ error: "That did not work. Try again." }));
                    r.code ? setInvite(r.code) : flash(r.error);
                  }}>Invite someone</button>
                  {invite && <span style={{ userSelect: "text" }}>Code: <b className="mono" style={{ fontSize: 17 }}>{invite}</b></span>}
                </div>
                {invite && <p className="small" style={{ margin: "8px 0 0" }}>They install DeskFix, sign in, open Account and enter this code. It works for 14 days.</p>}
              </div>
            )}
            <div className="plan">
              <span className="mono">Signed in as</span>
              <p style={{ margin: "8px 0 14px", userSelect: "text" }}>{me.guest ? "Guest (no email)" : me.email}</p>
              <div className="row">
                {!me.guest && <button className="btn" onClick={async () => (await setToken(null), emitTo("panel", "panel-open", {}), setMe(null))}>Sign out</button>}
                {confirmDelete ? (
                  <>
                    <button className="btn stop" style={{ minHeight: 48 }} onClick={async () => {
                      const r = await api<any>("/api/account/delete", { confirm: "delete" }).catch(() => ({ error: "We couldn't delete it just now. Nothing changed." }));
                      if (r.ok) (await setToken(null), emitTo("panel", "panel-open", {}), setMe(null));
                      else flash(r.error);
                      setConfirmDelete(false);
                    }}>Yes, delete everything</button>
                    <button className="btn" onClick={() => setConfirmDelete(false)}>Keep my account</button>
                  </>
                ) : (
                  <button className="link" onClick={() => setConfirmDelete(true)}>Delete my account</button>
                )}
              </div>
              {confirmDelete && <p className="small" style={{ margin: "10px 0 0" }}>This removes your account, settings and history, and stops any plan. It can't be undone.</p>}
            </div>
          </div>
        )}
        {note && <p role="status" className="small" style={{ position: "fixed", bottom: 20, left: 240, background: "var(--ink)", color: "var(--bg)", padding: "10px 16px", borderRadius: 10 }}>{note}</p>}
      </main>
    </div>
  );
}
