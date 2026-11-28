import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const now = Date.parse("2026-10-30T12:00:00.000Z");
const checkedAt = "2026-10-30T11:59:00.000Z";
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("claudeAgent");

function limitsAt(usedPercent: number): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: "2026-10-30T13:17:00.000Z",
      },
    ],
  };
}

const unsupported: ServerProviderUsageLimits = {
  checkedAt,
  windows: [],
  unavailable: { reason: "unsupported" },
};

function claudeInstance(usageLimits: ServerProviderUsageLimits): ServerProvider {
  return {
    instanceId,
    driver: claude,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      type: "customEndpoint",
      label: "Custom API endpoint",
      endpoint: "http://127.0.0.1:8317",
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits,
  };
}

interface HubAccountInput {
  readonly id: string;
  readonly driver?: ProviderDriverKind;
  readonly models?: readonly string[];
  readonly limits: ServerProviderUsageLimits;
}

function hub(
  label: string,
  accounts: readonly HubAccountInput[],
  origin = "http://127.0.0.1:8317",
): UsageLimitSourceSnapshot {
  return {
    id: UsageLimitSourceId.make(label),
    kind: "cliproxy",
    label,
    origin,
    checkedAt,
    accounts: accounts.map((account) => ({
      id: account.id,
      driver: account.driver ?? claude,
      ...(account.models ? { models: account.models } : {}),
      usageLimits: account.limits,
    })),
  };
}

function shown(
  own: ServerProviderUsageLimits,
  sources: readonly UsageLimitSourceSnapshot[],
  model: string | null,
) {
  const resolved = resolveThreadDetailsLimits(
    instanceId,
    model,
    [claudeInstance(own)],
    sources,
    now,
  );
  if (resolved?.kind !== "pool") return resolved;
  return {
    kind: resolved.kind,
    rows: resolved.rows.map(({ window }) => ({
      label: window.label,
      left: window.remainingPercent,
      accounts: window.members.length,
      from: poolSources(window),
    })),
  };
}

describe("resolveThreadDetailsLimits", () => {
  it("keeps an instance's failed reading instead of a hub it is not sent to", () => {
    const failed: ServerProviderUsageLimits = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" },
    };
    const direct = { ...claudeInstance(failed), auth: { status: "authenticated" as const } };
    const elsewhere = claudeInstance(unsupported);
    const readableHub = hub("Hub", [{ id: "a.json", limits: limitsAt(20) }]);
    const otherHub = hub("Other", [{ id: "a.json", limits: limitsAt(20) }], "http://hub");
    expect(resolveThreadDetailsLimits(instanceId, null, [direct], [readableHub], now)).toEqual({
      kind: "instance",
      limits: failed,
    });
    expect(resolveThreadDetailsLimits(instanceId, null, [elsewhere], [otherHub], now)).toEqual({
      kind: "instance",
      limits: unsupported,
    });
  });

  it("pools only the accounts the hub routes the model to, even of another driver", () => {
    const sources = [
      hub("Hub", [
        { id: "a.json", models: ["claude-opus-5-5"], limits: limitsAt(10) },
        { id: "c.json", driver: codex, models: ["gpt-5.6-sol"], limits: limitsAt(30) },
      ]),
    ];
    expect(shown(unsupported, sources, "gpt-5.6-sol[1m]")).toEqual({
      kind: "pool",
      rows: [{ label: "Session", left: 70, accounts: 1, from: { hubs: ["Hub"], signedIn: false } }],
    });
  });
});

describe("resolveThreadDetailsLimits for Antigravity accounts behind a hub", () => {
  it("gives each account its own keyed, labeled row", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const gemini = (usedPercent: number): ServerProviderUsageLimits => ({
      checkedAt,
      windows: [{ id: "gemini-5h", kind: "session", label: "Gemini · 5-hour", usedPercent }],
    });
    const instance: ServerProvider = {
      ...claudeInstance(unsupported),
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: antigravity,
    };
    const source: UsageLimitSourceSnapshot = {
      ...hub("Hub", []),
      accounts: [
        { id: "a.json", driver: antigravity, email: "me@gmail.com", usageLimits: gemini(10) },
        { id: "b.json", driver: antigravity, email: "me@work.example", usageLimits: gemini(70) },
      ],
    };
    const resolved = resolveThreadDetailsLimits(
      instance.instanceId,
      null,
      [instance],
      [source],
      now,
    );
    if (resolved?.kind !== "pool") throw new Error("expected a pool");
    expect(
      resolved.rows.map(({ accountLabel, window }) => [accountLabel, window.remainingPercent]),
    ).toEqual([
      ["me@gmail.com", 90],
      ["me@work.example", 30],
    ]);
    expect(new Set(resolved.rows.map((row) => row.key)).size).toBe(2);
  });
});

describe("resolveThreadHttpQuotas", () => {
  it("shows only the quota accounts bound to the thread's provider instance", () => {
    const window = { id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 35 } as const;
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("quota"),
      kind: "http",
      label: "Quota server",
      checkedAt,
      accounts: [],
      quotaAccounts: [
        { id: "bound", label: "Work plan", providerInstanceId: instanceId, windows: [window] },
        { id: "unbound", label: "Unbound", windows: [window] },
        {
          id: "other",
          label: "Other plan",
          providerInstanceId: ProviderInstanceId.make("other"),
          windows: [window],
        },
      ],
    };
    expect(
      resolveThreadHttpQuotas(instanceId, [source]).map((quota) => quota.accountLabel),
    ).toEqual(["Work plan"]);
    expect(resolveThreadHttpQuotas(null, [source])).toEqual([]);
  });
});
