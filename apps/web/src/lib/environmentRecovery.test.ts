import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type DesktopBridge,
  type DesktopEnvironmentRecoveryState,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

import { createRecoveryObserver, type RecoveryObservation } from "./environmentRecovery";

const url = EnvironmentId.make("saved-loopback");
const ssh = EnvironmentId.make("saved-ssh");
const transient: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 2,
  lastFailure: new ConnectionTransientError({
    reason: "endpoint-unavailable",
    detail: "Route unavailable",
  }),
};
const connected: SupervisorConnectionState = {
  ...transient,
  phase: "connected",
  lastFailure: null,
};
const observation = (id: typeof url, state = transient): RecoveryObservation => ({
  environmentId: id,
  enabled: true,
  state,
});
const setup = (id: typeof url) => {
  let states: readonly DesktopEnvironmentRecoveryState[] = [
    {
      environmentId: id,
      recipe: { script: "existing-login && existing-proxy", automatic: true },
      job: null,
    },
  ];
  const get = vi.fn(async (_connected?: readonly EnvironmentId[]) => states);
  const run = vi.fn(async () => states[0]!);
  const retry = vi.fn(async () => {});
  const observer = createRecoveryObserver(
    { getEnvironmentRecovery: get, runEnvironmentRecovery: run } as unknown as DesktopBridge,
    retry,
  );
  return {
    observer,
    run,
    get,
    retry,
    setJob: (phase: NonNullable<DesktopEnvironmentRecoveryState["job"]>["phase"]) => {
      states = [{ ...states[0]!, job: { id: "job-1", phase, output: "", links: [], codes: [] } }];
    },
    clear: () => {
      states = [];
    },
  };
};

describe("environment recovery root observer", () => {
  it.each([url, ssh])(
    "waits through transient blips, runs once, and retries the existing %s route after completion",
    async (id) => {
      vi.useFakeTimers();
      const { observer, run, retry, setJob } = setup(id);
      try {
        observer.observe([observation(id)]);
        await observer.refresh();
        await vi.advanceTimersByTimeAsync(29_000);
        expect(run).not.toHaveBeenCalled();
        observer.observe([observation(id, connected)]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(run).not.toHaveBeenCalled();
        observer.observe([observation(id)]);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(run).toHaveBeenCalledExactlyOnceWith({ environmentId: id, reason: "automatic" });
        setJob("browser");
        await observer.refresh();
        await vi.advanceTimersByTimeAsync(60_000);
        observer.observe([observation(id, { ...transient, attempt: 10 })]);
        expect(run).toHaveBeenCalledTimes(1);
        setJob("done");
        await observer.refresh();
        await observer.refresh();
        expect(retry).toHaveBeenCalledExactlyOnceWith(id);
        await vi.advanceTimersByTimeAsync(300_000);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        observer.stop();
        vi.useRealTimers();
      }
    },
  );

  it("does not run for missing recipes, blocked errors, offline networks, or disabled environments", async () => {
    vi.useFakeTimers();
    const { observer, run, clear } = setup(url);
    try {
      await observer.refresh();
      for (const entry of [
        observation(url, {
          ...transient,
          phase: "blocked",
          lastFailure: new ConnectionBlockedError({ reason: "permission", detail: "Denied" }),
        }),
        observation(url, { ...transient, network: "offline" }),
        { ...observation(url), enabled: false },
      ]) {
        observer.observe([entry]);
        await vi.advanceTimersByTimeAsync(40_000);
      }
      clear();
      await observer.refresh();
      observer.observe([observation(url)]);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(run).not.toHaveBeenCalled();
    } finally {
      observer.stop();
      vi.useRealTimers();
    }
  });

  it("keeps failures latched until connection and stops observing without cancelling another window's job", async () => {
    vi.useFakeTimers();
    const { observer, run, get, setJob } = setup(url);
    try {
      await observer.refresh();
      observer.observe([observation(url)]);
      await vi.advanceTimersByTimeAsync(30_000);
      setJob("failed");
      await observer.refresh();
      observer.observe([observation(url, { ...transient, attempt: 9 })]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(run).toHaveBeenCalledTimes(1);
      observer.observe([observation(url, connected)]);
      await observer.refresh();
      expect(get).toHaveBeenLastCalledWith([url]);
      observer.observe([observation(url)]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(2);
      observer.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      observer.stop();
      vi.useRealTimers();
    }
  });
});
