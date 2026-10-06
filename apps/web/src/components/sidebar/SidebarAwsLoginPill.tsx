import { useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  classifyAwsLogin,
  formatExpiresIn,
  formatExpiryTime,
  runAwsLogin,
  useAwsLoginStatus,
} from "~/lib/awsLogin";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** "Require AWS login" warning: shown only while the watched SSO session is missing or ending. */
export function SidebarAwsLoginPill() {
  const navigate = useNavigate();
  const status = useAwsLoginStatus();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [loggingIn, setLoggingIn] = useState(false);
  const level = classifyAwsLogin(status, nowMs);
  const watching = level !== "off";

  // Re-classify each minute so the warning appears and counts down between desktop checks.
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [watching]);

  const profile = status?.awsProfile;
  if (!profile || (level !== "missing" && level !== "expiring")) return null;

  const expiresAt = status.expiresAt;
  const title =
    level === "missing"
      ? `Missing AWS login (profile ${profile})`
      : `AWS login ${expiresAt ? formatExpiresIn(expiresAt, nowMs) : "expires soon"} (profile ${profile})`;
  const description = expiresAt
    ? `${Date.parse(expiresAt) <= nowMs ? "Expired" : "Expires"} ${formatExpiryTime(expiresAt)} · ${formatExpiresIn(expiresAt, nowMs)}`
    : status.ok
      ? "Expiry unknown"
      : status.detail;

  const logIn = async () => {
    setLoggingIn(true);
    try {
      const next = await runAwsLogin(profile);
      if (next?.ok) {
        void navigate({ to: "/settings/devbox" });
      } else {
        toastManager.add({
          type: "error",
          title: `AWS login for ${profile} did not complete`,
          description: next?.detail ?? "The desktop app is unavailable.",
        });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Could not start the AWS login for ${profile}`,
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setLoggingIn(false);
    }
  };

  const Icon = level === "missing" ? TriangleAlertIcon : CircleAlertIcon;
  return (
    <div
      className={cn(
        "flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg px-2 py-1 text-2xs leading-4 font-medium",
        level === "missing" ? "bg-destructive/12 text-destructive" : "bg-warning/12 text-warning",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">{title}</span>
            </span>
          }
        />
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      <Button
        size="xs"
        variant={level === "missing" ? "destructive" : "outline"}
        disabled={loggingIn}
        onClick={() => void logIn()}
      >
        {loggingIn ? <Spinner className="size-3" /> : null}
        Log in
      </Button>
    </div>
  );
}
