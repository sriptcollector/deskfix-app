// The see-through layer over the whole screen. It shows the character moving to where it acts, its
// speech bubbles, the Teach me highlight, and the "Yes, do it" card for higher-risk steps.
// It never takes clicks except while a Yes card is up.
import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Bot, type Expr } from "./bot";
import { autopilot } from "./api";

const BOT = 36;
// A drawn picture of the system box the person will meet next, shown on the Yes card so they know which button is safe.
function guideKind(detail: string): "uac" | "automation" | null {
  if (/windows will (also )?ask|do you want to allow this app/i.test(detail)) return "uac";
  if (/mac will (also )?ask|control .?system events/i.test(detail)) return "automation";
  return null;
}
function GuidePic({ kind }: { kind: "uac" | "automation" }) {
  return kind === "uac" ? (
    <svg viewBox="0 0 300 150" role="img" aria-label="The Windows box that asks: Do you want to allow this app to make changes to your device. The Yes button is circled." style={{ width: "100%", borderRadius: 8, margin: "4px 0 10px" }}>
      <rect width="300" height="150" fill="#2b3340" />
      <rect x="30" y="10" width="240" height="130" fill="#f0f0f0" stroke="#8a8a8a" />
      <rect x="30" y="10" width="240" height="24" fill="#0b6a9e" />
      <text x="40" y="26" fontSize="10" fill="#fff">User Account Control</text>
      <text x="40" y="54" fontSize="10" fontWeight="600" fill="#111">Do you want to allow this app to</text>
      <text x="40" y="67" fontSize="10" fontWeight="600" fill="#111">make changes to your device?</text>
      <rect x="40" y="100" width="100" height="26" fill="#0b6a9e" />
      <text x="90" y="117" fontSize="11" fill="#fff" textAnchor="middle">Yes</text>
      <rect x="150" y="100" width="100" height="26" fill="#dcdcdc" stroke="#aaa" />
      <text x="200" y="117" fontSize="11" fill="#111" textAnchor="middle">No</text>
      <rect x="35" y="95" width="110" height="36" rx="4" fill="none" stroke="#e2b23c" strokeWidth="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 300 150" role="img" aria-label="The Mac box that says DeskFix wants access to control System Events. The OK button is circled." style={{ width: "100%", borderRadius: 8, margin: "4px 0 10px" }}>
      <rect width="300" height="150" fill="#c9d3de" />
      <rect x="40" y="8" width="220" height="134" rx="12" fill="#ececec" stroke="#bdbdbd" />
      <text x="150" y="40" fontSize="10.5" fontWeight="700" fill="#111" textAnchor="middle">&#8220;DeskFix&#8221; wants access to</text>
      <text x="150" y="54" fontSize="10.5" fontWeight="700" fill="#111" textAnchor="middle">control &#8220;System Events&#8221;.</text>
      <rect x="56" y="100" width="90" height="26" rx="6" fill="#fff" stroke="#c8c8c8" />
      <text x="101" y="117" fontSize="10.5" fill="#111" textAnchor="middle">Don&#8217;t Allow</text>
      <rect x="154" y="100" width="90" height="26" rx="6" fill="#0a84ff" />
      <text x="199" y="117" fontSize="11" fill="#fff" textAnchor="middle" fontWeight="600">OK</text>
      <rect x="150" y="95" width="98" height="36" rx="9" fill="none" stroke="#e2b23c" strokeWidth="3" />
    </svg>
  );
}

export function Overlay() {
  const [on, setOn] = useState(false);
  const [expr, setExpr] = useState<Expr>("idle");
  const [pos, setPos] = useState<[number, number]>([innerWidth / 2, innerHeight / 2]);
  const [say, setSay] = useState<string | null>(null);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [card, setCard] = useState<{ x: number; y: number; title: string; detail: string; undoable: boolean } | null>(null);
  const [textSize, setTextSize] = useState(17);
  const botRef = useRef<HTMLDivElement>(null);
  // Screen points -> this window's CSS pixels (differs when the computer zooms text, e.g. Windows Text size).
  const fRef = useRef(1);
  const F = (x: number) => x * fRef.current;
  const posRef = useRef(pos);

  useEffect(() => {
    const un: Promise<() => void>[] = [
      listen<{ mode: string }>("ov:mode", (e) => {
        setOn(e.payload.mode !== "off");
        setSay(null);
        setPoint(null);
        setCard(null);
      }),
      listen<{ sw: number; sh: number }>("ov:screen", (e) => (fRef.current = innerWidth / e.payload.sw || 1)),
      listen<{ x: number; y: number; ms: number }>("ov:fly", (e) => fly(F(e.payload.x), F(e.payload.y), e.payload.ms)),
      listen<{ expr: Expr }>("ov:expr", (e) => setExpr(e.payload.expr)),
      listen<{ text: string | null }>("ov:say", (e) => setSay(e.payload.text)),
      listen<{ x: number; y: number }>("ov:press", (e) => {
        const id = Math.random();
        setRipples((r) => [...r, { id, x: F(e.payload.x), y: F(e.payload.y) }]);
        setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 320);
      }),
      listen<{ x: number; y: number } | null>("ov:point", (e) => setPoint(e.payload ? [F(e.payload.x), F(e.payload.y)] : null)),
      listen<{ x: number; y: number; title: string; detail: string; undoable: boolean } | null>("ov:confirm", async (e) => {
        setCard(e.payload && { ...e.payload, x: F(e.payload.x), y: F(e.payload.y) });
        if (e.payload && (await autopilot())) setTimeout(() => answer(true), 3000);
      }),
      listen<{ textSize: number }>("ov:settings", (e) => setTextSize(e.payload.textSize)),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  // Flight on a gentle arc; the bot's top-left sits 4 px down-right of the target.
  function fly(tx: number, ty: number, ms: number) {
    const el = botRef.current;
    const [sx, sy] = posRef.current;
    const ex = tx + 4, ey = ty + 4;
    const dx = ex - sx, dy = ey - sy;
    const dist = Math.hypot(dx, dy);
    posRef.current = [ex, ey];
    setPos([ex, ey]);
    if (!el || dist < 2) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.style.transform = `translate(${ex}px, ${ey}px)`;
      return;
    }
    const nx = -dy / dist, ny = dx / dist;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const bend = Math.sin(Math.PI * t) * dist * 0.12;
      frames.push({ transform: `translate(${sx + dx * t + nx * bend}px, ${sy + dy * t + ny * bend}px)` });
    }
    el.animate(frames, { duration: ms, easing: "cubic-bezier(.45,0,.55,1)", fill: "forwards" }).onfinish = () => {
      el.style.transform = `translate(${ex}px, ${ey}px)`;
    };
  }

  const answer = (yes: boolean) => {
    setCard(null);
    emitTo("panel", "ov:answer", { yes });
  };

  // Bubble: above-right of the bot, flipped to whichever side has room.
  const bx = pos[0] + BOT + 8 > innerWidth - 300 ? pos[0] - 296 : pos[0] + BOT + 8;
  const by = pos[1] - 64 < 8 ? pos[1] + BOT + 8 : pos[1] - 64;

  if (!on) return <div className="overlay" />;
  return (
    <div className={`overlay${card ? " interactive" : ""}`} style={{ ["--bubble" as any]: `${textSize}px` }}>
      {point && <span className="ring" style={{ left: point[0], top: point[1] }} />}
      {card && <span className="target" style={{ left: card.x, top: card.y }} />}
      {ripples.map((r) => <span key={r.id} className="ripple" style={{ left: r.x, top: r.y }} />)}
      <div ref={botRef} className="bot" style={{ transform: `translate(${pos[0]}px, ${pos[1]}px)` }}>
        <Bot expr={expr} />
      </div>
      {say && !card && <div className="bubble" style={{ left: bx, top: by }} aria-live="polite">{say}</div>}
      {card && (
        <div className="ovcard" style={{ left: Math.min(card.x + 30, innerWidth - 360), top: Math.min(Math.max(card.y - 40, 16), innerHeight - 280) }} role="alertdialog" aria-label={card.title}>
          <h2>{card.title}</h2>
          {card.detail && <div className="detail">{card.detail}</div>}
          {guideKind(card.detail) && <GuidePic kind={guideKind(card.detail)!} />}
          <p className="small" style={{ margin: "0 0 14px" }}>{card.undoable ? "You can get it back." : "This can't be undone."}</p>
          <button className="btn primary full" autoFocus onClick={() => answer(true)}>Yes, do it</button>
          <button className="btn full" style={{ marginTop: 8 }} onClick={() => answer(false)}>No, don't</button>
        </div>
      )}
    </div>
  );
}
