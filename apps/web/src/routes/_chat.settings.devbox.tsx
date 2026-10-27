import { createFileRoute } from "@tanstack/react-router";

import { DevboxSettings } from "../components/settings/DevboxSettings";

export const Route = createFileRoute("/_chat/settings/devbox")({
  component: DevboxSettings,
});
