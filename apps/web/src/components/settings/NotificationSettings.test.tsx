// @vitest-environment jsdom
import type { ClientSettings } from "@t3tools/contracts/settings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications-and-sound" as ClientSettings["notificationMode"],
  update: vi.fn(),
  unlockAudio: vi.fn(),
  requestPermission: vi.fn().mockResolvedValue("granted"),
}));

vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: Pick<ClientSettings, "notificationMode">) => unknown) =>
    select({ notificationMode: state.mode }),
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../threadNotifications")>()),
  unlockNotificationAudio: state.unlockAudio,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { NotificationSettings } from "./NotificationSettings";

let renderer: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "notifications-and-sound";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", { requestPermission: state.requestPermission });
  vi.stubGlobal("isSecureContext", true);
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
});

afterEach(async () => {
  await act(() => renderer.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("labels the current preference as System notifications without changing it", async () => {
  await act(() => renderer.render(<NotificationSettings />));
  expect(container.querySelector("h3")?.textContent).toBe("System notifications");
  expect(
    container.querySelector('[role="combobox"][aria-label="System notifications"]')?.textContent,
  ).toBe("Notifications with sound");
  expect(state.update).not.toHaveBeenCalled();
  expect(state.requestPermission).not.toHaveBeenCalled();
});

it("changes the existing notificationMode through the System notifications control", async () => {
  state.mode = "off";
  await act(() => renderer.render(<NotificationSettings />));
  const trigger = container.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-label="System notifications"]',
  );
  expect(trigger).not.toBeNull();
  await act(() => trigger!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (entry) => entry.textContent === "Notifications with sound",
  );
  expect(option).toBeDefined();
  await act(() => option!.click());
  expect(state.requestPermission).toHaveBeenCalledOnce();
  expect(state.unlockAudio).toHaveBeenCalledOnce();
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    notificationMode: "notifications-and-sound",
  });
});
