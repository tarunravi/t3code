import type { DesktopAwsLoginStatus, DesktopAwsProfile } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { setDevboxPanelState } from "./devboxPanel";

/** Sessions closer than this to expiry show a warning before they lapse. */
export const AWS_LOGIN_WARNING_MS = 60 * 60_000;
// `aws sts get-caller-identity` is a network call, so the desktop runs it sparingly.
const STATUS_POLL_MS = 5 * 60_000;
const LOGIN_POLL_MS = 1_500;

export type AwsLoginLevel = "off" | "ok" | "expiring" | "missing";

/** The profile a picker starts on: the last one used, or the only one there is. */
export function defaultAwsProfile(
  profiles: readonly DesktopAwsProfile[],
  lastUsed: string | null | undefined,
): string | null {
  if (lastUsed) return lastUsed;
  return profiles.length === 1 ? profiles[0]!.name : null;
}

export function classifyAwsLogin(
  status: DesktopAwsLoginStatus | null,
  nowMs: number,
): AwsLoginLevel {
  if (status?.awsProfile == null) return "off";
  if (!status.ok) return "missing";
  const expiresMs = status.expiresAt === null ? Number.NaN : Date.parse(status.expiresAt);
  // Static keys and role credentials have no SSO expiry to track.
  if (!Number.isFinite(expiresMs)) return "ok";
  const leftMs = expiresMs - nowMs;
  if (leftMs <= 0) return "missing";
  return leftMs < AWS_LOGIN_WARNING_MS ? "expiring" : "ok";
}

export function formatExpiresIn(expiresAt: string, nowMs: number): string {
  const ms = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  if (days > 0) return `expires in ${days}d ${hours}h`;
  if (hours > 0) return `expires in ${hours}h ${minutes % 60}m`;
  return `expires in ${minutes}m`;
}

export function formatExpiryTime(expiresAt: string): string {
  return new Date(expiresAt).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// The desktop process owns the check; this caches its latest answer for the
// sidebar indicator and the General setting, polling while either is mounted.
let status: DesktopAwsLoginStatus | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const desktopBridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge);

export function setAwsLoginStatus(next: DesktopAwsLoginStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export async function refreshAwsLoginStatus(): Promise<DesktopAwsLoginStatus | null> {
  const bridge = desktopBridge();
  if (!bridge?.getAwsLoginStatus) return null;
  const next = await bridge.getAwsLoginStatus();
  setAwsLoginStatus(next);
  return next;
}

export function useAwsLoginStatus(): DesktopAwsLoginStatus | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      if (timer === undefined && desktopBridge()?.getAwsLoginStatus) {
        void refreshAwsLoginStatus();
        timer = setInterval(() => void refreshAwsLoginStatus(), STATUS_POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    () => status,
    () => null,
  );
}

/**
 * Runs a fresh `aws sso login` for the profile through the devbox sign-in
 * flow, opening the approval page, and resolves with the re-checked status.
 */
export async function runAwsLogin(awsProfile: string): Promise<DesktopAwsLoginStatus | null> {
  const bridge = desktopBridge();
  if (!bridge?.startDevboxLogin || !bridge.getDevboxState) return null;
  let state = await bridge.startDevboxLogin({ target: "mac", provider: "aws", awsProfile });
  let opened = false;
  for (;;) {
    const login = state.logins.find((entry) => entry.target === "mac" && entry.provider === "aws");
    if (login === undefined || login.phase === "done" || login.phase === "failed") break;
    const link = login.links[0];
    if (login.phase === "approve" && link && !login.opensBrowser && !opened) {
      opened = true;
      void bridge.openExternal(link);
    }
    await new Promise((resolve) => setTimeout(resolve, LOGIN_POLL_MS));
    state = await bridge.getDevboxState();
  }
  setDevboxPanelState(state);
  return refreshAwsLoginStatus();
}
