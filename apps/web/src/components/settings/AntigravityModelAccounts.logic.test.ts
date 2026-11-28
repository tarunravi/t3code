import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { antigravityModelAccounts } from "./AntigravityModelAccounts.logic";

const model = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});
const provider = (overrides: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-28T00:00:00.000Z",
  models: [model("gemini-4-neon", "Gemini Neon"), model("gemini-4-hydrogen", "Gemini Hydrogen")],
  slashCommands: [],
  skills: [],
  ...overrides,
});
const personal = provider({ auth: { status: "authenticated", email: "me@gmail.com" } });
const work = provider({
  instanceId: ProviderInstanceId.make("antigravity_work"),
  displayName: "Work",
  auth: { status: "authenticated", email: "me@work.example" },
  models: [model("gemini-4-hydrogen", "Gemini Hydrogen"), model("gemini-4-argon", "Gemini Argon")],
});

describe("antigravityModelAccounts", () => {
  it("labels each enabled account by instance name and lists every model once", () => {
    const { accounts, models } = antigravityModelAccounts(
      [
        personal,
        work,
        provider({ instanceId: ProviderInstanceId.make("off"), enabled: false }),
        provider({
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        }),
      ],
      { "gemini-4-hydrogen": work.instanceId },
    );
    expect(accounts).toEqual([
      { instanceId: personal.instanceId, label: "Antigravity" },
      { instanceId: work.instanceId, label: "Work" },
    ]);
    expect(models).toEqual([
      { slug: "gemini-4-neon", name: "Gemini Neon", instanceId: null },
      { slug: "gemini-4-hydrogen", name: "Gemini Hydrogen", instanceId: work.instanceId },
      { slug: "gemini-4-argon", name: "Gemini Argon", instanceId: null },
    ]);
  });

  it("tells apart accounts whose instances share a name", () => {
    const { accounts } = antigravityModelAccounts(
      [personal, { ...work, displayName: "Antigravity" }],
      {},
    );
    expect(accounts.map((account) => account.label)).toEqual([
      "Antigravity (antigravity)",
      "Antigravity (antigravity_work)",
    ]);
  });

  it("keeps a stale route visible and shows a route to a missing account as unrouted", () => {
    const { models } = antigravityModelAccounts([personal], {
      "gemini-4-carbon": personal.instanceId,
      "gemini-4-neon": ProviderInstanceId.make("removed"),
    });
    expect(models.slice(-1)).toEqual([
      { slug: "gemini-4-carbon", name: "gemini-4-carbon", instanceId: personal.instanceId },
    ]);
    expect(models.find((entry) => entry.slug === "gemini-4-neon")?.instanceId).toBeNull();
  });
});
