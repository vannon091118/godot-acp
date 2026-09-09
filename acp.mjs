#!/usr/bin/env node
/**
 * acp.mjs — DER KANONISCHE EINSTIEGSPUNKT von GODOT ACP.
 *
 * EIN Entry-Point für alles:
 *   node acp.mjs install   → One-Link-Onboarding (Discovery→Bind→Config→Verify)
 *   node acp.mjs mcp       → kanonischer MCP-Einstieg (stdio ↔ Runtime)
 *   node acp.mjs start     → Backend + Cockpit (kanonischer Launcher)
 *   node acp.mjs status    → reale Verifikation (install/bind/target/tools)
 *   node acp.mjs doctor    → Diagnose mit konkreter Ursache
 *   node acp.mjs bridge    → klassische stdio↔TCP-Bridge (intern, von `mcp` genutzt)
 *
 * Installationszustand: ~/.godot-acp/install.json (EIN kanonischer Datensatz).
 * Race-Schutz: Lock-Dateien (install.lock, runtime.lock) via O_EXCL — atomar.
 * Idempotenz: wiederholtes install erkennt Bestand (DETECT→VERIFY→READY).
 * Rekursionsschutz: installierte Kopien tragen install.marker; trifft der
 * Installer auf eine, bricht er mit klarer Ursache ab statt zu verschachteln.
 *
 * Keine zweite Autorität: Das Backend (backend/server.mjs) bleibt die System-
 * autorität; dieses Skript ist Werkzeug davor, nicht Wahrheit daneben.
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACP_HOME = path.join(os.homedir(), ".godot-acp");
const INSTALL_FILE = path.join(ACP_HOME, "install.json");
const INSTALL_LOCK = path.join(ACP_HOME, "install.lock");
const RUNTIME_LOCK = path.join(ACP_HOME, "runtime.lock");
const BACKEND_PORT = Number(process.env.ACP_BACKEND_PORT || 8787);
const GODOT_PORT = Number(process.env.ACP_GODOT_PORT || 9090);
const BRIDGE_PORT = Number(process.env.ACP_PROXY_PORT || 9099);

/* ── Installationszustand (EIN Datensatz, konservativ geschrieben) ────── */

function readInstall() {
  try { return JSON.parse(fs.readFileSync(INSTALL_FILE, "utf8")); } catch { return null; }
}

/** Atomar schreiben: temp + rename (kein teilweises JSON bei Crash). */
function writeInstall(record) {
  fs.mkdirSync(ACP_HOME, { recursive: true });
  const tmp = INSTALL_FILE + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  fs.renameSync(tmp, INSTALL_FILE);
}

/** Lock via O_EXCL: atomar auf allen Plattformen. Stale-Lock (> 10 min) wird gebrochen. */
function acquireLock(lockFile, purpose) {
  fs.mkdirSync(ACP_HOME, { recursive: true });
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, purpose, at: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    try {
      const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      const age = Date.now() - (existing.at ?? 0);
      if (age > 10 * 60 * 1000) {
        // Stale Lock: Halter tot oder hängen > 10 min → brechen (protokolliert).
        process.stderr.write(`[acp] stale lock gebrochen (${purpose}, Alter ${Math.round(age / 1000)}s)\n`);
        try { fs.unlinkSync(lockFile); } catch { return false; }
        return acquireLock(lockFile, purpose);
      }
    } catch { /* unlesbar → gilt als belegt */ }
    return false;
  }
}

function releaseLock(lockFile) {
  try {
    const existing = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (existing.pid === process.pid) fs.unlinkSync(lockFile);
  } catch { /* weg oder fremd */ }
}

/* ── Projekt-Detection: reale Merkmale, kein Ratespiel ────────────────── */

function findProjectRoot(startDir) {
  // cwd aufwärts, dann typische Workspace-Nachbarn. Ein Godot-Projekt hat
  // project.godot (+ optional addons/mcp). Genau EIN Kandidat wird gebunden.
  const found = [];
  const seen = new Set();
  const scan = (dir, depth) => {
    if (depth > 4 || !dir || seen.has(dir)) return;
    seen.add(dir);
    try {
      if (fs.existsSync(path.join(dir, "project.godot"))) found.push(dir);
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
          scan(path.join(dir, e.name), depth + 1);
        }
      }
    } catch { /* unlesbar */ }
  };
  scan(startDir, 0);
  // Mehrfachkandidaten: bevorzugt der mit addons/mcp (bereits gebunden oder binderbar)
  const withAddon = found.filter((d) => fs.existsSync(path.join(d, "addons", "mcp")));
  const unique = withAddon.length > 0 ? withAddon : found;
  return { candidates: found, unique: unique.length === 1 ? unique[0] : (found.length === 1 ? found[0] : null) };
}

/** Rekursionsschutz: liegt der Installer selbst in einem Zielprojekt? */
function isRecursiveInstall(projectRoot) {
  const selfReal = fs.realpathSync(__dirname);
  const projectReal = fs.realpathSync(projectRoot);
  if (selfReal.startsWith(projectReal + path.sep)) return true;
  return fs.existsSync(path.join(projectRoot, "addons", "mcp", "acp.mjs"));
}

/* ── Binding: Projekt an bestehende Installation binden ───────────────── */

function bindProject(projectRoot, install) {
  // 0) Startfähigkeit: project.godot MUSS eine vorhandene Main Scene deklarieren.
  //    Ohne diese Prüfe erzeugt der erste Start einen Godot-Fehlerdialog
  //    ("no main scene defined") statt eines konkreten, agentenlesbaren Fehlers.
  const pg = path.join(projectRoot, "project.godot");
  if (fs.existsSync(pg)) {
    const m = fs.readFileSync(pg, "utf8").match(/run\/main_scene="([^"]+)"/);
    if (!m) {
      throw new Error(`BLOCKED: ${projectRoot} hat keine Main Scene (run/main_scene in project.godot fehlt). Szene im Godot-Editor setzen oder: acp.mjs install <pfad> nachholen.`);
    }
    const sceneFile = path.join(projectRoot, m[1].replace("res://", ""));
    if (!fs.existsSync(sceneFile)) {
      throw new Error(`BLOCKED: Main Scene ${m[1]} existiert nicht in ${projectRoot} — project.godot korrigieren.`);
    }
  }
  // 1) addons/mcp als LEICHTE Kopie (nur Runtime+Editor+Core, kein backend/…):
  //    Der Runtime-Pfad res://addons/mcp/... ist im Godot-Addon hard verdrahtet
  //    (mcp_runtime.gd: MCP_SERVER_PATH), deshalb ist der Well-known-Pfad Pflicht.
  const dst = path.join(projectRoot, "addons", "mcp");
  const alreadyThere = fs.existsSync(path.join(dst, "plugin.cfg"));
  if (!alreadyThere) {
    copyRuntimeIntoProject(dst);
  }
  // 2) .mcp.json ins Projekt-Root: zeigt IMMER auf den kanonischen Einstieg
  //    der Installation (acp.mjs mcp) — absolut aufgelöst, cwd-immun.
  const mcpJson = {
    mcpServers: {
      "godot-acp": {
        command: process.execPath,
        args: [path.join(__dirname, "acp.mjs"), "mcp"],
        env: { MCP_HOST: "127.0.0.1", MCP_PORT: String(GODOT_PORT) },
      },
    },
  };
  fs.writeFileSync(path.join(projectRoot, ".mcp.json"), JSON.stringify(mcpJson, null, 2) + "\n");
  // 3) Installationsrecord aktualisieren (EIN Datensatz, kein Wachstum).
  const bound = new Set(install.boundProjects ?? []);
  bound.add(fs.realpathSync(projectRoot));
  install.boundProjects = [...bound];
  install.lastBoundAt = Date.now();
  writeInstall(install);
  return { copied: !alreadyThere, mcpJson };
}

/** Runtime-Kopie: ohne backend/dashboard/cli/fake_godot/testing (keine Rekursion, keine Leichen). */
function copyRuntimeIntoProject(dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of ["runtime", "editor", "icons", "client", "mcp_chains", "plugin.cfg"]) {
    const src = path.join(__dirname, entry);
    const out = path.join(dst, entry);
    if (fs.statSync(src).isDirectory()) {
      fs.cpSync(src, out, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes("__pycache__") && !p.includes(".git") });
    } else {
      fs.copyFileSync(src, out);
    }
  }
  fs.writeFileSync(path.join(dst, "install.marker"), JSON.stringify({ installedAt: Date.now(), from: "acp.mjs" }) + "\n");
}

/* ── Verifikation: READY nur nach echtem Nachweis ─────────────────────── */

function probeTcp(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("timeout", () => done(false));
  });
}

/** MCP-Handshake + Tools/list am Godot-Ziel — kein Schein-READY. */
function verifyMcp(port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = "";
    const fail = (why) => { try { sock.destroy(); } catch {} resolve({ ok: false, why }); };
    sock.setTimeout(timeoutMs);
    sock.once("error", () => fail("TCP nicht erreichbar"));
    sock.once("timeout", () => fail("Timeout"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          sock.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
        } else if (msg.id === 2 && msg.result) {
          const tools = (msg.result.tools ?? []).map((t) => t.name);
          try { sock.destroy(); } catch {}
          resolve({ ok: true, toolCount: tools.length, tools });
          return;
        } else if (msg.id === 1 && msg.error) {
          return fail("Handshake abgelehnt: " + (msg.error.message ?? "?"));
        }
      }
    });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "acp-installer", version: "1.0.0" } } }) + "\n");
  });
}

async function verify(install, projectRoot) {
  const report = { install: !!install, project: !!projectRoot, backend: false, godot: false, mcp: null };
  report.backend = await probeTcp(BACKEND_PORT);
  report.godot = await probeTcp(GODOT_PORT);
  if (report.godot) report.mcp = await verifyMcp(GODOT_PORT);
  report.ready = report.install && report.project && report.backend && report.godot && !!report.mcp?.ok;
  return report;
}

/* ── Commands ─────────────────────────────────────────────────────────── */

async function cmdInstall(projectArg) {
  if (!acquireLock(INSTALL_LOCK, "install")) {
    console.error("BLOCKED: Eine Installation läuft bereits (install.lock aktiv). Nicht parallel installieren.");
    process.exit(2);
  }
  try {
    // DETECT: Installation vorhanden?
    let install = readInstall();
    const phase1 = install ? "DETECT (vorhanden)" : "INSTALL (frisch)";
    if (!install) {
      install = {
        acpVersion: "1.0.0",
        nodeRequirement: process.version,
        godotRequirement: "4.x",
        bridge: "client/mcp_stdio_bridge.py",
        backend: "backend/server.mjs",
        launcher: "acp.mjs start",
        mcpEntry: "acp.mjs mcp",
        transport: "stdio→tcp 127.0.0.1:" + GODOT_PORT,
        healthCheck: "acp.mjs status",
        capabilityCheck: "runtime_mcp_capabilities (via MCP tools/list)",
        installedAt: Date.now(),
        boundProjects: [],
      };
      writeInstall(install);
      console.log(`[1/4] ${phase1}: Installationsrecord ${INSTALL_FILE}`);
    } else {
      console.log(`[1/4] ${phase1}: bestehende Installation vom ${new Date(install.installedAt).toLocaleString("de-DE")} — wiederverwendet (idempotent)`);
    }

    // PROJECT DETECT: eindeutiges Zielprojekt finden
    const startDir = projectArg ? path.resolve(projectArg) : process.cwd();
    const { candidates, unique } = findProjectRoot(startDir);
    if (!unique) {
      console.error(candidates.length === 0
        ? "BLOCKED: kein Godot-Projekt (project.godot) gefunden — Projekt pfad angeben: acp.mjs install <pfad>"
        : `BLOCKED: ${candidates.length} Projektkandidaten — kein Ratespiel. Pfad angeben:\n  ${candidates.join("\n  ")}`);
      process.exit(3);
    }
    console.log(`[2/4] PROJECT DETECT: ${unique} (${candidates.length} Kandidat(en) gesamt)`);

    if (isRecursiveInstall(unique)) {
      console.error("BLOCKED: Rekursionsversuch — der Installer läuft bereits INNERHALB des Zielprojekts (addons/mcp). Keine ACP-in-ACP-Verschachtelung.");
      process.exit(4);
    }

    // BIND: Runtime-Kopie (falls fehlend) + .mcp.json (immer aktuell, idempotent)
    const bind = bindProject(unique, install);
    console.log(`[3/4] BIND: addons/mcp ${bind.copied ? "kopiert" : "bereits vorhanden (unverändert)"} · .mcp.json geschrieben (kanonischer Einstieg: node …/acp.mjs mcp)`);

    // VERIFY: reale Checks, kein Erfundenes
    const report = await verify(install, unique);
    console.log(`[4/4] VERIFY: backend=${report.backend ? "erreichbar" : "NICHT erreichbar (acp.mjs start)"} · godot-tcp=${report.godot ? "offen" : "zu (Spiel mit --mcp starten oder Dock START)"} · mcp=${report.mcp?.ok ? `Handshake ok, ${report.mcp.toolCount} Tools` : (report.mcp?.why ?? "kein MCP")}`);
    if (report.ready) {
      console.log("READY — System betriebsbereit.");
    } else {
      console.log("NOT READY — Ursachen oben. Diagnose: node acp.mjs doctor");
      process.exitCode = 1;
    }
  } finally {
    releaseLock(INSTALL_LOCK);
  }
}

async function cmdStatus() {
  const install = readInstall();
  const project = findProjectRoot(process.cwd());
  const report = await verify(install, project.unique);
  console.log(JSON.stringify({
    install: report.install ? { at: new Date(install.installedAt).toISOString(), version: install.acpVersion, boundProjects: install.boundProjects } : null,
    project: report.project ? fs.realpathSync(project.unique) : null,
    backend: report.backend, godotTcp: report.godot,
    mcp: report.mcp, ready: report.ready,
  }, null, 2));
  process.exitCode = report.ready ? 0 : 1;
}

async function cmdDoctor() {
  const install = readInstall();
  if (!install) console.log("✗ Keine Installation (~/.godot-acp/install.json fehlt) → acp.mjs install");
  else console.log("✓ Installation vorhanden (" + new Date(install.installedAt).toLocaleString("de-DE") + ")");
  const project = findProjectRoot(process.cwd());
  if (!project.unique) console.log(project.candidates.length === 0 ? "✗ Kein Godot-Projekt im Pfad" : `✗ ${project.candidates.length} Projektkandidaten — eindeutig angeben`);
  else console.log("✓ Projekt: " + fs.realpathSync(project.unique));
  const backend = await probeTcp(BACKEND_PORT, 1500);
  console.log(backend ? `✓ Backend läuft auf :${BACKEND_PORT}` : `✗ Backend nicht erreichbar → node acp.mjs start`);
  const godot = await probeTcp(GODOT_PORT, 1500);
  if (!godot) console.log(`✗ Godot-Runtime nicht erreichbar (:${GODOT_PORT}) → Spiel starten (Dock START oder godot --path . -- --mcp)`);
  else {
    const mcp = await verifyMcp(GODOT_PORT);
    console.log(mcp.ok ? `✓ MCP-Handshake ok, ${mcp.toolCount} Tools via tools/list` : `✗ MCP-Handshake fehlgeschlagen: ${mcp.why}`);
  }
  for (const [name, file] of [["install", INSTALL_LOCK], ["runtime", RUNTIME_LOCK]]) {
    if (fs.existsSync(file)) {
      try { const l = JSON.parse(fs.readFileSync(file, "utf8")); console.log(`⚠ ${name}-Lock aktiv (PID ${l.pid}, ${Math.round((Date.now() - l.at) / 1000)}s) — löschen falls Prozess tot`); }
      catch { console.log(`⚠ ${name}-Lock unlesbar: ${file}`); }
    }
  }
}

async function cmdStart() {
  // Doppelstart-Schutz: wenn Backend-Port schon offen ist, nicht noch eins starten.
  if (await probeTcp(BACKEND_PORT, 1200)) {
    console.log(`Backend läuft bereits auf :${BACKEND_PORT} — kein zweiter Prozess (Doppelstart-Schutz).`);
    return;
  }
  if (!acquireLock(RUNTIME_LOCK, "backend-start")) {
    console.error("BLOCKED: Ein anderer Start läuft gerade (runtime.lock).");
    process.exit(2);
  }
  try {
    const dashboardDist = path.join(__dirname, "dashboard", "dist", "index.html");
    if (!fs.existsSync(dashboardDist)) {
      console.log("Dashboard noch nicht gebaut — baue (einmalig) …");
      await new Promise((resolve) => {
        const p = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", path.join(__dirname, "dashboard"), "run", "build"], { stdio: "inherit" });
        p.on("exit", resolve);
      });
    }
    console.log("Starte Backend (Autorität) + Cockpit …");
    const child = spawn(process.execPath, [path.join(__dirname, "backend", "server.mjs")], { stdio: "inherit", detached: false });
    child.on("exit", (code) => { releaseLock(RUNTIME_LOCK); process.exitCode = code ?? 0; });
    // Laufenden Prozess sauber herunterfahren → Lock freigeben.
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
  } finally {
    // Lock wird beim child-exit freigegeben; bei Fehler hier nicht doppelt.
  }
}

async function cmdMcp() {
  // Kanonischer externer MCP-Einstieg: stdio ↔ Godot-Runtime (:9090).
  // cwd-immun (Pfade relativ zu dieser Datei), keine Benutzerkonfiguration.
  const bridge = path.join(__dirname, "client", "mcp_stdio_bridge.py");
  const python = process.platform === "win32" ? "python" : "python3";
  const child = spawn(python, [bridge], {
    stdio: "inherit",
    env: { ...process.env, MCP_HOST: process.env.MCP_HOST ?? "127.0.0.1", MCP_PORT: String(GODOT_PORT), PYTHONUNBUFFERED: "1" },
  });
  child.on("exit", (code) => { process.exitCode = code ?? 0; });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { try { child.kill(sig); } catch {} });
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

const cmd = process.argv[2] ?? "help";
const arg = process.argv[3];
const commands = {
  install: () => cmdInstall(arg).catch((e) => { console.error(e.message); process.exitCode = 1; }),
  mcp: () => cmdMcp(),
  start: () => cmdStart(),
  status: () => cmdStatus(),
  doctor: () => cmdDoctor(),
  help: () => {
    console.log(`GODOT ACP — kanonischer Einstieg

  node acp.mjs install [projektpfad]   One-Link-Onboarding (idempotent)
  node acp.mjs mcp                     kanonischer MCP-Einstieg (stdio)
  node acp.mjs start                   Backend + Cockpit starten
  node acp.mjs status                  reale Verifikation (JSON)
  node acp.mjs doctor                  Diagnose mit Ursachen
`);
  },
};
(commands[cmd] ?? commands.help)();
