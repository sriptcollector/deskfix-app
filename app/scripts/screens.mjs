// Renders the real app screens in a headless browser with the native side and the server mocked,
// walks the Fix / Teach / failure flows through the real session engine, asserts the key rules
// (nothing changes before Allow fix; "Problem solved" only when verified) and saves screenshots.
//   bun run build && node scripts/screens.mjs [outDir]
// Needs `playwright` resolvable (NODE_PATH or a global install).
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright");

const DIST = new URL("../dist/", import.meta.url);
const OUT = process.argv[2] ?? "shots";
mkdirSync(OUT, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const PX = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

const me = (o = {}) => ({ email: "pat@example.com", name: "Pat", guest: false, plan: "free", status: null, renews: null, cancelAt: null, seats: null, comp: false, payer: null, members: [], canUse: true, why: null, fixes: { used: 2, limit: 5, left: 3 }, settings: { speech: "normal", voice: false, textSize: 17, moveSpeed: "normal", talkLess: false, theme: "system", screenAccess: true, control: true, keepHistory: true }, memories: ["Prefers big text"], test: false, ...o });
const HISTORY = [
  { at: Date.now() - 864e5, mode: "fix", task: "Fixing the printer", outcome: "Your printer was paused. It prints again.", worked: true, cause: "The printer was set to Pause Printing.", steps: ["Open Printers & scanners", "Open the print queue", "Untick Pause Printing"], support: "" },
  { at: Date.now() - 2 * 864e5, mode: "teach", task: "Making a spreadsheet", outcome: "You made a new spreadsheet and saved it.", worked: true, cause: "", steps: ["Open Excel", "Pick Blank workbook"], support: "" },
  { at: Date.now() - 5 * 864e5, mode: "fix", task: "Connecting to Wi-Fi", outcome: "Your router does not answer. I could not fix that from here.", worked: false, cause: "The router is not answering.", steps: [], support: "Wi-Fi is on. The router at 192.168.1.1 does not answer. Tried: reconnect, network check. Next: unplug the router for 30 seconds." },
];
const tool = (name, input, id = name + Math.random().toString(36).slice(2, 6)) => ({ type: "tool_use", id, name, input });
const SCRIPTS = {
  fix: [
    [tool("propose", { understood: "You want bigger text on your screen.", cause: "Your text size is set to 100%, the smallest.", task: "Making text bigger", steps: ["Set the text size to 125%", "Check the new size"], risk: "low" })],
    [tool("say", { text: "I set your text size to 125%.", expression: "focused", step: 1 }), tool("quick", { action: "text_size", arg: "125" })],
    [tool("done", { outcome: "Your text is bigger now. Some open windows may need closing and reopening.", worked: true, verified: true, cause: "Your text size was set to 100%, the smallest.", how_next_time: ["Open Settings", "Pick Accessibility, then Text size", "Move the slider and press Apply"], support_summary: "" })],
  ],
  teach: [
    [tool("propose", { understood: "You want to learn how to make a spreadsheet.", cause: "", task: "Making a spreadsheet", steps: ["Open Excel", "Pick Blank workbook", "Type in the first cell", "Save it"], risk: "low" })],
    [tool("say", { text: "First we open a blank workbook.", expression: "focused", step: 2 }), { ...tool("mouse_move", { coordinate: [420, 300] }), toolset_name: "computer" }, tool("needs_you", { text: "Press Blank workbook here." })],
    [tool("done", { outcome: "You made a new spreadsheet.", worked: true, verified: true, cause: "", how_next_time: ["Open Excel", "Pick Blank workbook"], support_summary: "" })],
  ],
  // "My computer is slow": read-only checks run with no card; the diagnosis has real numbers; then one
  // command that changes something goes through the Allow fix card; a blocked one never runs.
  slow: [
    [tool("say", { text: "Checking what is slowing you down.", expression: "thinking", step: 1 }), tool("check", { what: "cpu" }), tool("check", { what: "memory" }), tool("check", { what: "disk" }), tool("check", { what: "startup" })],
    [tool("run_command", { command: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU", why: "Looking at the busiest programs", undo: "", timeout_s: 20 })],
    [tool("propose", { understood: "Your computer is slow.", cause: "Chrome is using most of your memory, and 9 programs start with the computer.", task: "Speeding up the computer", steps: ["Close the extra Chrome windows", "Stop Spotify starting with the computer"], risk: "low" })],
    [tool("say", { text: "Stopping Spotify from starting with the computer.", expression: "focused", step: 2 }), tool("run_command", { command: "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name Spotify", why: "Stopping Spotify from starting with the computer", undo: "You can turn it back on in Spotify's settings.", timeout_s: 20 })],
    [tool("run_command", { command: "Remove-Item -Recurse -Force C:\\Users", why: "Clearing space", undo: "", timeout_s: 20 })],
    [tool("done", { outcome: "Your computer has more room now. Chrome was using most of the memory.", worked: true, verified: true, cause: "Chrome had many windows open and 9 programs started with the computer.", how_next_time: ["Close Chrome windows you are not using", "Open Settings, then Apps, then Startup"], support_summary: "" })],
  ],
  fail: [
    [tool("propose", { understood: "Your printer says it is offline.", cause: "No printer is set up on this computer.", task: "Fixing the printer", steps: ["Look for your printer on the network", "Add it again"], risk: "medium" })],
    [tool("say", { text: "I am looking for your printer.", expression: "focused", step: 1 }), tool("quick", { action: "list_printers", arg: "" })],
    [tool("done", { outcome: "I could not find a printer. It may be off, or on a different Wi-Fi.", worked: false, verified: false, cause: "No printer answers on your network.", how_next_time: [], support_summary: "No printer is installed. Network search found none. Tried: list printers, add printer search. Next: check the printer is on and on the same Wi-Fi." })],
  ],
};

const INIT = ({ view, token, os, flags }) => {
  for (const [k, v] of Object.entries(flags)) localStorage.setItem(k, v);
  const listeners = {};
  window.__calls = [];
  window.__emit = (event, payload) => (listeners[event] ?? []).forEach((id) => window["_" + id]?.({ event, payload, id: 0 }));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: view }, currentWebview: { label: view, windowLabel: view } },
    transformCallback: (cb) => {
      const id = Math.floor(Math.random() * 1e9);
      window["_" + id] = cb;
      return id;
    },
    convertFileSrc: (x) => x,
    invoke: async (cmd, args) => {
      window.__calls.push(cmd + (cmd === "act" || cmd === "quick" || cmd === "cmd_run" || cmd === "syscheck" ? ":" + JSON.stringify(args) : ""));
      if (cmd === "env_info") return { os, version: "1.0.0", server: "http://api.local", test_session: null, show_in_capture: false, autopilot: null, signin: null, model: null };
      if (cmd === "session_get") return token;
      if (cmd === "perms_status") return { screen: true, control: true };
      if (cmd === "capture") return { data: window.__px, w: 1280, h: 800, sw: 1280, sh: 800, scale: 1 };
      if (cmd === "cursor") return [600, 400];
      if (cmd === "windows_list") return [];
      if (cmd === "front_app") return "Microsoft Excel (Book1)";
      if (cmd === "quick") return args.action === "text_size" ? "Text size is now 125%." : "No printers are installed.";
      if (cmd === "syscheck") {
        const R = {
          cpu: ["The processor is busy (62% in use, 8 cores). The busiest programs: Chrome (41%), Spotify (9%). The computer has not been restarted for 23 days.", { load_pct: 62 }],
          memory: ["Memory: 14 of 16 GB in use (88%). That is getting full.", { used_pct: 88 }],
          disk: ["Main disk (C:): 7.2 GB free of 256 GB (97% full). That is very low: the computer needs about 10 GB free to run well.", []],
          startup: ["9 programs start with the computer: Spotify, Discord, Steam, OneDrive, Teams, Zoom, Dropbox, Epic Games, iTunes Helper. That many slows down starting up.", []],
        };
        const [report, data] = R[args.what] ?? ["Fine.", {}];
        return { what: args.what, data, report };
      }
      if (cmd === "cmd_classify") {
        const c = String(args.command);
        if (/remove-item -recurse|rm -rf \//i.test(c)) return { verdict: "blocked", reason: "deletes a whole folder tree" };
        return /^get-|^ls|^df/i.test(c) ? { verdict: "allowed" } : { verdict: "approval" };
      }
      if (cmd === "cmd_run") return { ok: true, code: 0, output: args.command.startsWith("Get-Process") ? "Name    CPU\nchrome  412\nSpotify 88" : "", cut: false, timed_out: false, ms: 120 };
      if (cmd === "cmd_stop") return null;
      if (cmd === "plugin:event|listen") return ((listeners[args.event] ??= []).push(args.handler), args.handler);
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") return window.__emit(args.event, args.payload), null;
      if (cmd === "plugin:window|scale_factor") return 1;
      if (cmd === "plugin:window|outer_position") return { x: 800, y: 40 };
      if (cmd === "plugin:window|outer_size") return { width: 440, height: 64 };
      return null;
    },
  };
};

const browser = await chromium.launch();
async function open({ view = "panel", token = "tok", os = "windows", flags = { df_explained: "1", df_perms_ok: "1" }, size = [380, 560], dark = false, script = null, meOver = {}, delay = 0, keepMini = false }) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: dark ? "dark" : "light", deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(INIT, { view, token, os, flags });
  await page.addInitScript((px) => (window.__px = px), PX);
  let turn = 0;
  page.agentBodies = [];
  await page.route("http://localhost/**", (r) => {
    const p = new URL(r.request().url()).pathname;
    const f = new URL("." + (p === "/" ? "/index.html" : p), DIST);
    return existsSync(f) ? r.fulfill({ body: readFileSync(f), contentType: MIME[extname(p)] ?? "text/html" }) : r.fulfill({ status: 404, body: "" });
  });
  await page.route("http://api.local/**", async (r) => {
    const p = new URL(r.request().url()).pathname;
    const json = (d, status = 200) => r.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" }, body: JSON.stringify(d) });
    if (r.request().method() === "OPTIONS") return json({});
    if (p === "/api/me") return json(me(meOver));
    if (p === "/api/history") return json(HISTORY);
    if (p === "/api/config") return json({ google: true });
    if (p === "/api/agent") {
      page.agentBodies.push(JSON.parse(r.request().postData()));
      if (delay && turn > 0) await new Promise((x) => setTimeout(x, delay));
      return json({ content: SCRIPTS[script][turn++] ?? [], stop_reason: "tool_use" });
    }
    return json({});
  });
  page.on("pageerror", (e) => console.error("PAGE ERROR", String(e.stack).slice(0, 600)));
  await page.goto(`http://localhost/?view=${view}`);
  await page.waitForTimeout(500);
  // The app starts as the small floating button; a person presses it to open the assistant.
  const mini = page.getByRole("button", { name: "Open DeskFix" });
  if (view === "panel" && !keepMini && (await mini.count())) (await mini.click(), await page.waitForTimeout(300));
  return page;
}
const shot = async (page, name) => (await page.screenshot({ path: join(OUT, name + ".png"), omitBackground: false }), console.log("shot", name));
const bg = (page, dark) => page.addStyleTag({ content: `html{background:${dark ? "#2a2a28" : "#d9d9d4"} !important}` });

for (const dark of [false, true]) {
  const sfx = dark ? "-dark" : "";
  // Onboarding
  let p = await open({ token: null, flags: {}, dark });
  await bg(p, dark);
  await shot(p, `01-welcome${sfx}`);
  await p.getByRole("button", { name: "Create account" }).click();
  await p.waitForTimeout(300);
  await shot(p, `02-create-account${sfx}`);
  p = await open({ flags: {}, dark });
  await bg(p, dark);
  await shot(p, `03-what-it-can-do${sfx}`);
  await p.getByRole("button", { name: "Continue" }).click();
  await p.waitForTimeout(300);
  await shot(p, `04-permissions-windows${sfx}`);
  await p.getByRole("button", { name: "Allow" }).click();
  await p.waitForTimeout(300);
  await shot(p, `05-ready${sfx}`);
  if (!dark) {
    p = await open({ flags: { df_explained: "1" }, os: "mac" });
    await bg(p, dark);
    await shot(p, "04-permissions-mac-intro");
  }

  // Fix for me: nothing changes before Allow fix; Problem solved only after the verified done.
  p = await open({ script: "fix", dark, delay: 1500 });
  await bg(p, dark);
  await shot(p, `06-assistant${sfx}`);
  await p.getByRole("button", { name: "Make my text bigger" }).click();
  await p.getByRole("button", { name: "Allow fix" }).waitFor();
  assert.ok(!(await p.evaluate(() => window.__calls.some((c) => c.startsWith("quick:") || c.startsWith("act:")))), "something changed before Allow fix");
  assert.equal(p.agentBodies[0].mode, "fix");
  assert.equal(p.agentBodies[0].app, "Microsoft Excel (Book1)");
  await shot(p, `07-approval-card${sfx}`);
  await p.getByRole("button", { name: "Allow fix" }).click();
  await p.getByRole("button", { name: "Stop" }).waitFor();
  await p.setViewportSize({ width: 440, height: 64 });
  await p.waitForTimeout(500);
  await shot(p, `08-working-pill${sfx}`);
  await p.setViewportSize({ width: 380, height: 560 });
  await p.getByText("Problem solved").waitFor();
  assert.ok(await p.evaluate(() => window.__calls.some((c) => c.startsWith("quick:") && c.includes("text_size"))), "the fix did not run after Allow fix");
  await p.getByText("Is everything working?").waitFor();
  await shot(p, `09-problem-solved${sfx}`);
  await p.getByRole("button", { name: "Why did this happen?" }).click();
  await shot(p, `10-why${sfx}`);

  // Cancel: nothing runs.
  if (!dark) {
    const c = await open({ script: "fix" });
    await c.getByRole("button", { name: "Make my text bigger" }).click();
    await c.getByRole("button", { name: "Cancel" }).click();
    await c.getByText("Nothing was changed").waitFor();
    assert.ok(!(await c.evaluate(() => window.__calls.some((x) => x.startsWith("quick:") || (x.startsWith("act:") && !x.includes('"up"'))))), "Cancel still changed something");
    console.log("ok cancel changes nothing");
  }

  // Teach me: the person's turn, with Do it for me.
  p = await open({ script: "teach", dark, delay: 600 });
  await bg(p, dark);
  await p.getByRole("tab", { name: "Teach me" }).click();
  await p.getByRole("button", { name: "Show me how to make a spreadsheet" }).click();
  await p.getByRole("button", { name: "Start" }).waitFor();
  await shot(p, `11-teach-proposal${sfx}`);
  await p.getByRole("button", { name: "Start" }).click();
  await p.getByRole("button", { name: "Do it for me" }).waitFor();
  await p.getByText("Your turn").waitFor();
  assert.ok(!(await p.evaluate(() => window.__calls.some((c) => c.startsWith("act:") && c.includes('"click"')))), "Teach me clicked by itself");
  await p.setViewportSize({ width: 440, height: 64 });
  await p.waitForTimeout(300);
  await shot(p, `12-teach-pill${sfx}`);
  await p.getByRole("button", { name: "Do it for me" }).click();
  await p.setViewportSize({ width: 380, height: 560 });
  await p.getByText("Is everything working?").waitFor();
  assert.match(JSON.stringify(p.agentBodies.at(-1).messages.at(-1)), /Do it for me/);
  console.log("ok teach + do it for me");

  // "My computer is slow": checks need no card; the diagnosis shows numbers; a changing command gets the card
  // with the command under Details; a blocked command never reaches cmd_run.
  p = await open({ script: "slow", dark, delay: 400 });
  await bg(p, dark);
  await p.getByRole("button", { name: "My computer is slow" }).click();
  await p.getByText("97% full").waitFor();
  await p.getByRole("button", { name: "Allow fix" }).waitFor();
  const callsBeforeAllow = await p.evaluate(() => window.__calls.filter((c) => c.startsWith("cmd_run") || c.startsWith("syscheck")));
  assert.equal(callsBeforeAllow.filter((c) => c.startsWith("syscheck")).length, 4, "the four checks did not run before the card");
  assert.equal(callsBeforeAllow.filter((c) => c.startsWith("cmd_run")).length, 1, "the read-only command should run without a card");
  await shot(p, `18-slow-diagnosis${sfx}`);
  await p.getByRole("button", { name: "Allow fix" }).click();
  await p.locator('[data-card="command"]').waitFor();
  assert.equal(await p.locator("pre.cmd").count(), 0, "the command must sit under Details until opened");
  await shot(p, `19-command-card${sfx}`);
  await p.getByRole("button", { name: "Details" }).click();
  await p.locator("pre.cmd").waitFor();
  await shot(p, `20-command-card-details${sfx}`);
  await p.getByRole("button", { name: "Allow fix" }).click();
  await p.getByText("Problem solved").waitFor();
  const ran = await p.evaluate(() => window.__calls.filter((c) => c.startsWith("cmd_run")));
  assert.equal(ran.length, 2, `two commands should have run, got ${ran.length}`);
  assert.ok(!(await p.evaluate(() => window.__calls.some((c) => c.startsWith("cmd_run") && c.includes("Remove-Item -Recurse")))), "a blocked command reached cmd_run");
  await p.getByText("I won't do that one").waitFor();
  console.log("ok slow: checks free, command card, blocked never runs");
  if (!dark) {
    // Cancel on the command card: the command does not run.
    const c = await open({ script: "slow", delay: 200 });
    await c.getByRole("button", { name: "My computer is slow" }).click();
    await c.getByRole("button", { name: "Allow fix" }).click();
    await c.locator('[data-card="command"]').waitFor();
    await c.getByRole("button", { name: "Cancel" }).click();
    await c.getByText("That command did not run").waitFor();
    assert.ok(!(await c.evaluate(() => window.__calls.some((x) => x.startsWith("cmd_run") && x.includes("Spotify")))), "Cancel still ran the command");
    console.log("ok command cancel");
    // History shows the commands run on this computer.
    const h = await open({});
    await h.evaluate(() => localStorage.setItem("df_commands", JSON.stringify([{ at: Date.now(), why: "Stopping Spotify from starting with the computer", command: "Remove-ItemProperty -Path 'HKCU:\\...\\Run' -Name Spotify", ok: true, approved: true }, { at: Date.now() - 60000, why: "Looking at the busiest programs", command: "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5", ok: true, approved: false }])));
    await h.getByRole("tab", { name: "History" }).click();
    await h.getByText("Commands run on this computer").click();
    await h.getByText("Stopping Spotify").waitFor();
    await shot(h, "21-history-commands");
  }

  // Failure: plain words, a safe alternative, a summary to share. Never "Problem solved".
  p = await open({ script: "fail", dark });
  await bg(p, dark);
  await p.getByRole("button", { name: "My printer is offline" }).click();
  await p.getByRole("button", { name: "Allow fix" }).click();
  await p.getByText("Could not fix").waitFor();
  assert.equal(await p.getByText("Problem solved").count(), 0);
  await p.getByRole("button", { name: "Copy summary for support" }).waitFor();
  await shot(p, `13-could-not-fix${sfx}`);

  // The floating button (what stays on screen), history, the free limit
  p = await open({ dark, keepMini: true, size: [56, 56] });
  await shot(p, `00-floating-button${sfx}`);
  p = await open({ dark });
  await bg(p, dark);
  await p.getByRole("tab", { name: "History" }).click();
  await p.waitForTimeout(300);
  await shot(p, `14-history${sfx}`);
  p = await open({ dark, meOver: { canUse: false, why: "free_used", fixes: { used: 5, limit: 5, left: 0 } } });
  await bg(p, dark);
  await p.getByRole("button", { name: "Make my text bigger" }).click();
  await p.getByText("You have used your 5 free fixes this month").waitFor();
  await shot(p, `15-free-limit${sfx}`);

  // Overlay: the Teach me highlight over a (drawn) app window
  p = await open({ view: "overlay", size: [1280, 800], dark });
  await p.evaluate(() => {
    const d = document.createElement("div");
    d.innerHTML = `<div style="position:fixed;inset:0;background:#3b6ea5"></div><div style="position:fixed;left:140px;top:90px;width:1000px;height:600px;background:#fff;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.3);font:15px system-ui;color:#111"><div style="height:44px;background:#1d6f42;border-radius:10px 10px 0 0;color:#fff;padding:12px 16px">Excel</div><div style="padding:28px"><div style="font-size:22px;margin-bottom:18px">New</div><div style="display:flex;gap:18px"><div style="width:150px"><div style="height:110px;border:1px solid #c8c8c8;background:linear-gradient(#eee 1px,transparent 1px) 0 0/100% 14px,linear-gradient(90deg,#eee 1px,transparent 1px) 0 0/30px 100%"></div>Blank workbook</div><div style="width:150px"><div style="height:110px;border:1px solid #c8c8c8;background:#f4f4f4"></div>Budget</div></div></div></div>`;
    document.body.prepend(d);
    window.__emit("ov:mode", { mode: "walk" });
    window.__emit("ov:screen", { sw: 1280, sh: 800 });
    window.__emit("ov:fly", { x: 300, y: 250, ms: 1 });
    window.__emit("ov:expr", { expr: "waiting" });
    window.__emit("ov:point", { x: 243, y: 245 });
    window.__emit("ov:say", { text: "Press Blank workbook here." });
  });
  await p.waitForTimeout(500);
  await shot(p, `16-teach-highlight${sfx}`);
  // The DeskFix cursor gliding to a button with its label; Stop freezes it where it is.
  await p.evaluate(() => {
    window.__emit("ov:point", null);
    window.__emit("ov:say", { text: null });
    window.__emit("ov:expr", { expr: "focused" });
    window.__emit("ov:label", { text: "Opening a blank workbook" });
    window.__emit("ov:fly", { x: 243, y: 245, ms: 1 });
  });
  await p.waitForTimeout(400);
  assert.equal(await p.getByRole("img", { name: "DeskFix cursor: Opening a blank workbook" }).count(), 1, "the DeskFix cursor is not labelled");
  await shot(p, `22-deskfix-cursor${sfx}`);
  await p.evaluate(() => {
    window.__emit("ov:fly", { x: 900, y: 600, ms: 4000 });
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__emit("ov:expr", { expr: "stopped" }));
  await p.waitForTimeout(100);
  const frozenAt = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".dfcursor")).transform).e);
  await p.waitForTimeout(600);
  const stillAt = await p.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".dfcursor")).transform).e);
  assert.ok(Math.abs(frozenAt - stillAt) < 2 && frozenAt < 880, `Stop did not freeze the cursor (${frozenAt} -> ${stillAt})`);
  console.log("ok cursor stops instantly");

  // Dashboard: four sections only
  p = await open({ view: "dashboard", size: [960, 640], dark });
  assert.deepEqual(await p.locator("nav.rail button").allInnerTexts(), ["Assistant", "Activity", "Preferences", "Account"]);
  for (const s of ["Assistant", "Activity", "Preferences", "Account"]) {
    await p.locator("nav.rail").getByRole("button", { name: s }).click();
    await p.waitForTimeout(250);
    await shot(p, `17-dashboard-${s.toLowerCase()}${sfx}`);
  }
  assert.ok(await p.getByText("3 of 5 fixes left this month").count(), "Account does not show the fixes left");
}
await browser.close();
console.log("ALL OK");
