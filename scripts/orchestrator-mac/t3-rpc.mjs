#!/usr/bin/env node
// Talks to a running T3 Code server for reinstall.sh. Node >= 22, no dependencies.
//
//   t3-rpc.mjs health          --app <App.app> --base-dir <home>
//   t3-rpc.mjs active-threads  --app <App.app> --base-dir <home> [--out FILE] [--exclude ID]
//   t3-rpc.mjs launch          --app <App.app> --base-dir <home> --project-root DIR --title T --message-file F
//                              [--provider-instance codex] [--model gpt-6-luna] [--dry-run]
//   t3-rpc.mjs resume          --app <App.app> --base-dir <home> --state FILE [--text T] [--include-subagents] [--dry-run]
//
// The bearer token is minted with the app's own server CLI
// (`auth session issue --token-only`) and never printed. The port comes from
// <home>/userdata/server-runtime.json. Reads use the HTTP API with the v2
// protocol header; writes go over the WS RPC (orchestrationProtocol=2).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const DEFAULT_RESUME_TEXT =
  "T3 was restarted to install a new build; continue where you left off. " +
  "Any delegated tasks you were waiting on were interrupted too: check them with task_status and re-delegate the unfinished ones.";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function required(flags, key) {
  const value = flags[key];
  if (typeof value !== "string" || value === "") throw new Error(`--${key} is required`);
  return value;
}

function runtimeOrigin(baseDir) {
  const file = path.join(baseDir, "userdata", "server-runtime.json");
  const runtime = JSON.parse(readFileSync(file, "utf8"));
  return {
    origin: runtime.origin ?? `http://${runtime.host}:${runtime.port}`,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
  };
}

function mintToken(app, baseDir) {
  const executable = execFileSync(
    "defaults",
    ["read", path.join(app, "Contents", "Info"), "CFBundleExecutable"],
    {
      encoding: "utf8",
    },
  ).trim();
  const out = execFileSync(
    path.join(app, "Contents", "MacOS", executable),
    [
      path.join(app, "Contents", "Resources", "app.asar", "apps", "server", "dist", "bin.mjs"),
      "auth",
      "session",
      "issue",
      "--base-dir",
      baseDir,
      "--ttl",
      "30m",
      "--label",
      "t3-reinstall",
      "--token-only",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  // Output can carry log noise; the token is the last long whitespace-free line.
  const token = out
    .split(/\s+/)
    .filter((part) => /^[A-Za-z0-9._~+/=-]{40,}$/.test(part))
    .pop();
  if (!token) throw new Error("could not mint a bearer token");
  return token;
}

async function connect(flags) {
  const app = required(flags, "app");
  const baseDir = required(flags, "base-dir");
  const { origin } = runtimeOrigin(baseDir);
  return { origin, token: mintToken(app, baseDir) };
}

async function getShell({ origin, token }) {
  const response = await fetch(`${origin}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET /api/orchestration/shell -> ${response.status}`);
  return response.json();
}

async function rpc({ origin, token }, tag, payload) {
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!ticketResponse.ok)
    throw new Error(`POST /api/auth/websocket-ticket -> ${ticketResponse.status}`);
  const { ticket } = await ticketResponse.json();
  const wsUrl = `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${tag}: timed out`));
    }, 60_000);
    const finish = (fn, value) => {
      clearTimeout(timer);
      ws.close();
      fn(value);
    };
    ws.onopen = () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, headers: [], payload }));
    ws.onerror = () => finish(reject, new Error(`${tag}: websocket error`));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
      if (message._tag !== "Exit" || message.requestId !== "1") return;
      if (message.exit?._tag === "Success") finish(resolve, message.exit.value);
      else
        finish(reject, new Error(`${tag} failed: ${JSON.stringify(message.exit).slice(0, 2000)}`));
    };
  });
}

function activeThreads(shell, exclude) {
  return shell.threads
    .filter((thread) => thread.id !== exclude && !thread.archivedAt && !thread.deletedAt)
    .filter(
      (thread) =>
        ACTIVE_STATUSES.has(thread.status) ||
        thread.activeRunId ||
        thread.pendingRuntimeRequest ||
        (thread.pendingBackgroundTasks ?? []).length > 0,
    )
    .map((thread) => ({
      id: thread.id,
      title: thread.title,
      status: thread.status,
      relationship: thread.lineage?.relationshipToParent ?? null,
      rootThreadId: thread.lineage?.rootThreadId ?? null,
      providerInstanceId: thread.providerInstanceId,
      pendingBackgroundTasks: (thread.pendingBackgroundTasks ?? []).length,
    }));
}

// Subagent threads are owned by their parents, which re-delegate on resume;
// messaging both would duplicate work. Their roots are resumed instead.
function resumeTargets(state, includeSubagents) {
  const ids = new Set();
  const known = new Set(state.threads.map((thread) => thread.id));
  for (const thread of state.threads) {
    if (thread.relationship === "subagent" && !includeSubagents) {
      if (thread.rootThreadId && thread.rootThreadId !== state.excludedThreadId)
        ids.add(thread.rootThreadId);
    } else ids.add(thread.id);
  }
  return [...ids].map((id) => ({ id, recorded: known.has(id) }));
}

function projectFor(shell, root) {
  const wanted = path.resolve(root);
  const project =
    shell.projects.find((p) => path.resolve(p.workspaceRoot) === wanted) ??
    shell.projects.find((p) => wanted.startsWith(path.resolve(p.workspaceRoot) + path.sep));
  if (!project) throw new Error(`no T3 project contains ${wanted}`);
  return project;
}

export function resolveLaunchModelSelection(flags) {
  return {
    instanceId:
      typeof flags["provider-instance"] === "string" ? flags["provider-instance"] : "codex",
    model: typeof flags.model === "string" ? flags.model : "gpt-6-luna",
  };
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;

  if (command === "health") {
    const conn = await connect(flags);
    const shell = await getShell(conn);
    console.log(
      `healthy: ${conn.origin} (${shell.threads.length} threads, ${shell.projects.length} projects)`,
    );
    return;
  }

  if (command === "active-threads") {
    const conn = await connect(flags);
    const shell = await getShell(conn);
    const exclude = typeof flags.exclude === "string" ? flags.exclude : null;
    const state = {
      recordedAt: new Date().toISOString(),
      origin: conn.origin,
      excludedThreadId: exclude,
      threads: activeThreads(shell, exclude),
    };
    if (typeof flags.out === "string")
      writeFileSync(flags.out, JSON.stringify(state, null, 2) + "\n");
    for (const thread of state.threads)
      console.log(
        `${thread.status.padEnd(9)} ${(thread.relationship ?? "root").padEnd(8)} ${thread.id}  ${thread.title}`,
      );
    console.log(
      `${state.threads.length} active thread(s)${typeof flags.out === "string" ? ` -> ${flags.out}` : ""}`,
    );
    return;
  }

  if (command === "launch") {
    const conn = await connect(flags);
    const shell = await getShell(conn);
    const project = projectFor(shell, required(flags, "project-root"));
    const text = readFileSync(required(flags, "message-file"), "utf8");
    const payload = {
      commandId: `t3-reinstall:launch:${randomUUID()}`,
      projectId: project.id,
      title: required(flags, "title"),
      modelSelection: resolveLaunchModelSelection(flags),
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text, attachments: [] },
    };
    if (dryRun) {
      console.log(`would launch in project ${project.title} (${project.workspaceRoot}):`);
      console.log(
        JSON.stringify({ ...payload, initialMessage: { text: `<${text.length} chars>` } }, null, 2),
      );
      return;
    }
    const result = await rpc(conn, "orchestration.launchThread", payload);
    console.log(`launched thread ${result.threadId}`);
    return;
  }

  if (command === "resume") {
    const statePath = required(flags, "state");
    if (!existsSync(statePath)) throw new Error(`${statePath} not found`);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const text = typeof flags.text === "string" ? flags.text : DEFAULT_RESUME_TEXT;
    const targets = resumeTargets(state, flags["include-subagents"] === true);
    const conn = dryRun ? null : await connect(flags);
    let failures = 0;
    for (const { id } of targets) {
      if (dryRun) {
        console.log(`would resume ${id}`);
        continue;
      }
      try {
        await rpc(conn, "orchestration.dispatchCommand", {
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: `t3-reinstall:resume:${randomUUID()}`,
          threadId: id,
          messageId: randomUUID(),
          text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        console.log(`resumed ${id}`);
      } catch (error) {
        failures++;
        console.error(`FAILED ${id}: ${error.message}`);
      }
    }
    console.log(
      dryRun
        ? `${targets.length} thread(s) would be resumed`
        : `${targets.length - failures}/${targets.length} thread(s) resumed`,
    );
    if (failures > 0) process.exitCode = 1;
    return;
  }

  throw new Error(
    `unknown command: ${command ?? "(none)"}; see the header of ${path.basename(process.argv[1])}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`t3-rpc: ${error.message}`);
    process.exit(1);
  });
}
