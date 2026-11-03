import { RegistryContext } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type AuthSessionState,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: "connected" | "disconnected" };
    serverConfig: Pick<ServerConfig, "environment" | "settings">;
  }[],
  providers: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  requests: [] as EnvironmentId[],
  sessions: new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>>(),
  updateServer: vi.fn(),
}));

vi.mock(import("~/state/environments"), () => ({
  useEnvironments: (() => ({ environments: state.environments })) as never,
  useEnvironmentProviders: () => state.providers,
}));
vi.mock(import("@t3tools/client-runtime/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createEnvironmentSessionAtoms: ((
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({
      ...actual.createEnvironmentSessionAtoms(...args),
      sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
    })) as typeof actual.createEnvironmentSessionAtoms,
  };
});
vi.mock(import("~/state/server"), () => ({
  serverEnvironment: { updateProvider: {} } as never,
  environmentUpdateStatesAtom: (() =>
    Atom.make(state.environments.map(() => ({ status: "idle" as const })))) as never,
}));
vi.mock(import("./ServerUpdateAction"), () => ({
  canUpdateServer: () => true,
  useServerUpdate: () => state.updateServer,
}));
vi.mock(import("./sidebar/updateEverythingRun"), () => ({
  clearSavedUpdateEverythingResult: vi.fn(),
  saveUpdateEverythingResult: vi.fn(),
  setUpdateEverythingRun: vi.fn(),
  settleUpdateRunMachine: vi.fn(),
  showUpdateEverythingResult: vi.fn(),
  waitForServerUpdateHandoff: (_id, finished) => finished.then(() => undefined),
  waitForUpdateRestart: async () => true,
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ environmentId }: { environmentId: EnvironmentId }) => {
      state.requests.push(environmentId);
      return AsyncResult.success(undefined);
    }) as never,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { APP_VERSION } from "~/branding";
import { useProviderUpdates } from "./ProviderUpdatesAction";
import { useUpdateEverything } from "./sidebar/useUpdateEverything";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-21T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateCommand: "npm install -g @openai/codex",
    canUpdate: true,
    checkedAt: "2026-10-21T00:00:00.000Z",
    message: "Update available.",
  },
};

function session(
  scopes: NonNullable<AuthSessionState["scopes"]>,
): AsyncResult.AsyncResult<AuthSessionState> {
  return AsyncResult.success<AuthSessionState>({
    authenticated: true,
    scopes,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
  });
}

function setup() {
  state.environments = [
    { environmentId: EnvironmentId.make("read-only"), label: "Read only" },
    { environmentId: EnvironmentId.make("writable"), label: "Writable" },
    { environmentId: EnvironmentId.make("unresolved"), label: "Unresolved" },
  ].map((environment) => ({
    ...environment,
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        ...environment,
        serverVersion: APP_VERSION,
        platform: { os: "linux", arch: "x64" },
        capabilities: { repositoryIdentity: true, serverSelfUpdate: "boot-service" },
      },
      settings: DEFAULT_UNIFIED_SETTINGS,
    },
  }));
  state.providers = new Map(
    state.environments.map(({ environmentId }) => [environmentId, [provider]]),
  );
  state.requests = [];
  state.updateServer.mockReset().mockResolvedValue({ status: "updated" });
  const sessions = new Map<EnvironmentId, Atom.Writable<AsyncResult.AsyncResult<AuthSessionState>>>(
    [
      [state.environments[0]!.environmentId, Atom.make(session(["orchestration:read"]))],
      [state.environments[1]!.environmentId, Atom.make(session([AuthProvidersManageScope]))],
      [
        state.environments[2]!.environmentId,
        Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(
          AsyncResult.initial<AuthSessionState>(),
        ),
      ],
    ],
  );
  state.sessions = sessions;
  return { sessions };
}

it("bulk provider updates exclude connections without a confirmed management grant", async () => {
  const fixture = setup();
  let updates!: ReturnType<typeof useProviderUpdates>;
  function Probe() {
    const nextUpdates = useProviderUpdates();
    useEffect(() => {
      updates = nextUpdates;
    }, [nextUpdates]);
    return null;
  }
  await using _screen = await render(
    <RegistryContext.Provider value={appAtomRegistry}>
      <Probe />
    </RegistryContext.Provider>,
  );

  const writableId = state.environments[1]!.environmentId;
  expect(updates.machines.map(({ environmentId }) => environmentId)).toEqual([writableId]);
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([writableId]);

  await act(() => {
    appAtomRegistry.set(fixture.sessions.get(writableId)!, session(["orchestration:read"]));
  });
  expect(updates.machines).toEqual([]);
  state.requests = [];
  await act(async () => {
    await updates.updateAll({ quiet: true });
  });
  expect(state.requests).toEqual([]);
});

it.each([false, true])(
  "keeps T3 updates separate from stale provider advisories when checks are %s",
  async (enableProviderUpdateChecks) => {
    setup();
    for (const environment of state.environments) {
      environment.serverConfig = {
        ...environment.serverConfig,
        settings: { ...environment.serverConfig.settings, enableProviderUpdateChecks },
      };
    }
    let updates!: ReturnType<typeof useUpdateEverything>;
    let manual!: ReturnType<typeof useProviderUpdates>;
    function Probe({ localVersion }: { localVersion: string | null }) {
      const nextUpdates = useUpdateEverything(localVersion);
      const nextManual = useProviderUpdates();
      useEffect(() => {
        updates = nextUpdates;
        manual = nextManual;
      }, [nextUpdates, nextManual]);
      return null;
    }
    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe localVersion={null} />
      </RegistryContext.Provider>,
    );

    expect(updates.hasUpdates).toBe(false);
    expect(updates.providerCount).toBe(0);
    expect(updates.rows).toEqual([]);

    const writable = state.environments[1]!;
    writable.serverConfig = {
      ...writable.serverConfig,
      environment: { ...writable.serverConfig.environment, serverVersion: "0.0.1" },
    };
    await screen.rerender(
      <RegistryContext.Provider value={appAtomRegistry}>
        <Probe localVersion={APP_VERSION} />
      </RegistryContext.Provider>,
    );
    expect(updates.hasUpdates).toBe(true);
    expect(updates.summary).toBe("Update this app and 1 server");
    const downloadLocal = vi.fn(async () => true);
    const installLocal = vi.fn(async () => true);
    await act(async () => {
      await updates.run({ downloadLocal, installLocal });
    });
    expect(state.requests).toEqual([]);
    expect(state.updateServer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ environmentId: writable.environmentId }),
      { quiet: true },
    );
    expect(downloadLocal).toHaveBeenCalledOnce();
    expect(installLocal).toHaveBeenCalledOnce();

    await act(async () => {
      await manual.updateAll({ quiet: true });
    });
    expect(state.requests).toEqual([writable.environmentId]);
  },
);
