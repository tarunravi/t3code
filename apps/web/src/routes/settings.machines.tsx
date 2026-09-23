import { createFileRoute } from "@tanstack/react-router";

import { MachinesSettings } from "../components/settings/MachinesSettings";

export const Route = createFileRoute("/settings/machines")({
  component: MachinesSettings,
});
