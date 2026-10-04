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

  it("does not attribute an unrelated same-driver hub to an instance", () => {
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
    expect(usage[instanceId]).toBeUndefined();
  });
  it("does not replace the instance's quota with a fresher unrelated hub report", () => {
    const own = provider(limits({ windows: [window({ usedPercent: 10 })] }));
    const sources: UsageLimitSourceSnapshots = [
      {
        id: "source:unrelated" as never,
        kind: "cliproxy",
        label: "Unrelated hub",
        checkedAt: "2026-10-03T11:00:00Z",
        accounts: [
          hubAccount(
            limits({ checkedAt: "2026-10-03T11:00:00Z", windows: [window({ usedPercent: 100 })] }),
            { email: "tarun@example.com" },
          ),
        ],
      },
    ];
    expect(providerCapabilityUsage([own], sources)[instanceId]?.mostConstrained?.usedPercent).toBe(
      10,
    );
  });

  it("keeps independent same-driver instance quotas separate and unknowns unknown", () => {
    const a = {
      ...provider(limits({ windows: [window({ usedPercent: 10 })] })),
      instanceId: ProviderInstanceId.make("A"),
    };
    const b = {
      ...provider(limits({ windows: [window({ usedPercent: 100 })] })),
      instanceId: ProviderInstanceId.make("B"),
    };
    const c = { ...provider(undefined), instanceId: ProviderInstanceId.make("C") };
    const usage = providerCapabilityUsage([a, b, c], []);
    expect(usage.A?.mostConstrained?.usedPercent).toBe(10);
    expect(usage.B?.mostConstrained?.usedPercent).toBe(100);
    expect(usage.C).toBeUndefined();
    expect(usage.A?.accountsCombined).toBeUndefined();
    expect(usage.B?.accountsCombined).toBeUndefined();
  });
});
