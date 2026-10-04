import { describe, expect, it } from "@effect/vitest";
import type {
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  accountsForDriver,
  aggregateProviderUsage,
  providerCapabilityUsage,
  type ProviderUsageAccount,
} from "./providerCapabilityUsage.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

function window(overrides: Partial<ServerProviderUsageWindow> = {}): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Five hours",
    usedPercent: 40,
    ...overrides,
  };
}

function limits(
  overrides: {
    checkedAt?: string;
    windows?: ServerProviderUsageWindow[];
    unavailable?: { reason: "unsupported" | "probeFailed"; message?: string };
  } = {},
): ServerProviderUsageLimits {
  return {
    checkedAt: overrides.checkedAt ?? "2026-10-03T10:00:00.000Z",
    windows: overrides.windows ?? [],
    ...(overrides.unavailable === undefined ? {} : { unavailable: overrides.unavailable }),
  };
}

const account = (limits: ServerProviderUsageLimits, email?: string): ProviderUsageAccount => ({
  email,
  limits,
});

const provider = (usageLimits: ServerProviderUsageLimits | undefined) =>
  ({
    instanceId,
    driver: codex,
    auth: { email: "tarun@example.com" },
    ...(usageLimits === undefined ? {} : { usageLimits }),
  }) as unknown as ServerProvider;

const hubAccount = (
  usageLimits: ServerProviderUsageLimits,
  overrides: { id?: string; email?: string; driver?: string } = {},
): UsageLimitSourceAccount => ({
  id: overrides.id ?? "account-1",
  driver: overrides.driver === undefined ? codex : ProviderDriverKind.make(overrides.driver),
  ...(overrides.email === undefined ? {} : { email: overrides.email }),
  usageLimits,
});

describe("aggregateProviderUsage", () => {
  it("omits the block when there are no accounts", () => {
    expect(aggregateProviderUsage([])).toBeUndefined();
  });

  it("presents the fullest window and its account", () => {
    const usage = aggregateProviderUsage([
      account(limits({ windows: [window({ usedPercent: 20 })] })),
      account(
        limits({ checkedAt: "2026-10-03T09:00:00.000Z", windows: [window({ usedPercent: 80 })] }),
      ),
    ]);
    expect(usage).toMatchObject({
      checkedAt: "2026-10-03T09:00:00.000Z",
      mostConstrained: { usedPercent: 80 },
      accountsCombined: 2,
    });
    // The rest of the most-constrained account's quota travels with it.
    expect(usage?.windows).toHaveLength(1);
  });

  it("breaks usage ties toward the sooner reset", () => {
    const usage = aggregateProviderUsage([
      account(limits({ windows: [window({ usedPercent: 50, resetsAt: "2026-10-04T10:00:00Z" })] })),
      account(limits({ windows: [window({ usedPercent: 50, resetsAt: "2026-10-03T18:00:00Z" })] })),
    ]);
    expect(usage?.mostConstrained).toMatchObject({ resetsAt: "2026-10-03T18:00:00Z" });
  });

  it("prefers a known reset over a missing one at equal usage", () => {
    const usage = aggregateProviderUsage([
      account(limits({ windows: [window({ usedPercent: 50 })] })),
      account(limits({ windows: [window({ usedPercent: 50, resetsAt: "2026-10-03T18:00:00Z" })] })),
    ]);
    expect(usage?.mostConstrained).toMatchObject({ resetsAt: "2026-10-03T18:00:00Z" });
  });

  it("reports unavailable when no account has windows", () => {
    const usage = aggregateProviderUsage([
      account(limits({ unavailable: { reason: "unsupported" } })),
    ]);
    expect(usage).toMatchObject({
      mostConstrained: null,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
    expect(usage?.accountsCombined).toBeUndefined();
  });

  it("reports probeFailed with its message when every read failed", () => {
    const usage = aggregateProviderUsage([
      account(limits({ unavailable: { reason: "probeFailed", message: "Hub unreachable." } })),
      account(limits({ unavailable: { reason: "probeFailed" } })),
    ]);
    expect(usage).toMatchObject({
      unavailable: { reason: "probeFailed", message: "Hub unreachable." },
      accountsCombined: 2,
    });
  });

  it("keeps a single account's view unlabelled", () => {
    const usage = aggregateProviderUsage([
      account(limits({ windows: [window({ usedPercent: 10 })] })),
    ]);
    expect(usage?.accountsCombined).toBeUndefined();
    expect(usage?.mostConstrained).toMatchObject({ usedPercent: 10 });
  });
});

describe("accountsForDriver", () => {
  const sources: UsageLimitSourceSnapshots = [
    {
      id: "source:hub" as never,
      kind: "cliproxy",
      label: "Hub",
      checkedAt: "2026-10-03T10:00:00.000Z",
      accounts: [
        hubAccount(
          { ...limits(), windows: [window({ usedPercent: 90 })] },
          { email: "tarun@example.com" },
        ),
        hubAccount(
          {
            ...limits(),
            windows: [window({ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 30 })],
          },
          { id: "b.json", email: "other@example.com" },
        ),
        hubAccount(limits(), { id: "c.json", driver: "claudeAgent" }),
      ],
    },
  ];

  it("combines the instance account with same-driver hub accounts", () => {
    const accounts = accountsForDriver(codex, [provider(limits())], sources);
    expect(accounts).toHaveLength(2);
  });

  it("does not double-count an account the instance snapshot already covers", () => {
    // Same email as the hub's a.json, but the hub read is fresher.
    const accounts = accountsForDriver(
      codex,
      [provider(limits({ checkedAt: "2026-10-03T08:00:00.000Z", windows: [window()] }))],
      sources,
    );
    expect(accounts).toHaveLength(2);
    expect(
      accounts.find((candidate) => candidate.email === "tarun@example.com")?.limits.windows[0]
        ?.usedPercent,
    ).toBe(90);
  });

  it("ignores hub accounts of other drivers", () => {
    const otherDriverOnly: UsageLimitSourceSnapshots = [
      { ...sources[0]!, accounts: [sources[0]!.accounts[2]!] },
    ];
    expect(accountsForDriver(codex, [], otherDriverOnly)).toHaveLength(0);
  });
});

describe("providerCapabilityUsage", () => {
  it("omits instances with no usage data at all", () => {
    const usage = providerCapabilityUsage([provider(undefined)], []);
    expect(usage).toEqual({});
  });

  it("keys the block by instance id", () => {
    const usage = providerCapabilityUsage(
      [provider(limits({ windows: [window({ usedPercent: 25 })] }))],
      [],
    );
    expect(usage[instanceId]).toMatchObject({ mostConstrained: { usedPercent: 25 } });
  });

  it("includes hub accounts under the instance's driver", () => {
    const usage = providerCapabilityUsage(
      [provider(undefined)],
      [
        {
          id: "source:hub" as never,
          kind: "cliproxy",
          label: "Hub",
          checkedAt: "2026-10-03T10:00:00.000Z",
          accounts: [hubAccount(limits({ windows: [window()] }), { email: "tarun@example.com" })],
        },
      ],
    );
    expect(usage[instanceId]).toMatchObject({ mostConstrained: { usedPercent: 40 } });
    expect(usage[instanceId]?.accountsCombined).toBeUndefined();
  });
});
