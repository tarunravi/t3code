import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  DesktopBridge,
  DesktopEnvironmentRecoveryState,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";

type State = DesktopEnvironmentRecoveryState;
export const environmentRecoveryRunning = (state: State | null) =>
  state?.job?.phase === "running" || state?.job?.phase === "browser";
export function environmentRecoveryLabel(state: State | null): string | null {
  switch (state?.job?.phase) {
    case "running":
      return "Running local recovery…";
    case "browser":
      return "Waiting for browser sign-in…";
    case "done":
      return "Recovery ran; still unreachable. You can retry recovery.";
    case "failed":
      return "Local recovery failed. You can retry.";
    case "cancelled":
      return "Local recovery cancelled.";
    default:
      return null;
  }
}
let states: readonly State[] = [];
const listeners = new Set<() => void>();
const publish = (next: readonly State[]) => {
  if (JSON.stringify(states) === JSON.stringify(next)) return;
  states = next;
  for (const listener of listeners) listener();
};
export function setEnvironmentRecoveryState(state: State) {
  publish([...states.filter((entry) => entry.environmentId !== state.environmentId), state]);
}
export function useEnvironmentRecovery(id: EnvironmentId): State | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => states.find((state) => state.environmentId === id) ?? null,
    () => null,
  );
}
export interface RecoveryObservation {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly state: SupervisorConnectionState;
}
const eligible = ({ enabled, state }: RecoveryObservation) =>
  enabled &&
  state.network === "online" &&
  state.phase !== "connected" &&
  state.phase !== "blocked" &&
  state.lastFailure?._tag === "ConnectionTransientError";

/** One root observer; Electron owns process lifetime and the cross-window outage latch. */
export function createRecoveryObserver(
  bridge: DesktopBridge,
  retry: (id: EnvironmentId) => Promise<unknown>,
) {
  let observations: readonly RecoveryObservation[] = [];
  let stopped = false;
  let refreshing = false;
  let configured: readonly State[] = [];
  const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  const attempted = new Set<EnvironmentId>();
  const retried = new Map<EnvironmentId, string>();
  const canRun = (entry: RecoveryObservation) =>
    eligible(entry) &&
    configured.some(
      (state) => state.environmentId === entry.environmentId && state.recipe?.automatic,
    );
  const observe = (next: readonly RecoveryObservation[]) => {
    observations = next;
    for (const [id, timer] of timers)
      if (!next.some((entry) => entry.environmentId === id && canRun(entry))) {
        clearTimeout(timer);
        timers.delete(id);
      }
    for (const entry of next) {
      const id = entry.environmentId;
      if (entry.state.phase === "connected") attempted.delete(id);
      if (!canRun(entry) || attempted.has(id) || timers.has(id)) continue;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          attempted.add(id);
          void bridge
            .runEnvironmentRecovery?.({ environmentId: id, reason: "automatic" })
            .then((state) => {
              if (!stopped) setEnvironmentRecoveryState(state);
            })
            .catch(() => {});
        }, 30_000),
      );
    }
  };
  return {
    observe,
    refresh: async () => {
      if (stopped || refreshing || !bridge.getEnvironmentRecovery) return;
      refreshing = true;
      try {
        const next = await bridge.getEnvironmentRecovery(
          observations
            .filter((entry) => entry.state.phase === "connected")
            .map((entry) => entry.environmentId),
        );
        if (stopped) return;
        configured = next;
        publish(next);
        observe(observations);
        for (const state of next) {
          if (state.job?.phase !== "done" || retried.get(state.environmentId) === state.job.id)
            continue;
          retried.set(state.environmentId, state.job.id);
          const entry = observations.find((entry) => entry.environmentId === state.environmentId);
          if (entry?.enabled && entry.state.phase !== "connected") await retry(state.environmentId);
        }
      } finally {
        refreshing = false;
      }
    },
    stop: () => {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
const observationsAtom = Atom.make((get): readonly RecoveryObservation[] =>
  [...get(environmentCatalog.catalogValueAtom).entries]
    .filter(([, entry]) => entry.target._tag !== "PrimaryConnectionTarget")
    .map(([environmentId, entry]) => ({
      environmentId,
      enabled: entry.enabled && entry.unsupportedReason === undefined,
      state: AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      ),
    })),
);
export function EnvironmentRecoveryObserver() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the root connection subscription and desktop recovery polling timer until unmount
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.getEnvironmentRecovery || !bridge.runEnvironmentRecovery) return;
    const observer = createRecoveryObserver(bridge, (id) =>
      runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, id, { reportFailure: false }),
    );
    const unsubscribe = appAtomRegistry.subscribe(observationsAtom, observer.observe, {
      immediate: true,
    });
    const refresh = () => {
      void observer.refresh().catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      clearInterval(timer);
      unsubscribe();
      observer.stop();
    };
  }, []);
  return null;
}
