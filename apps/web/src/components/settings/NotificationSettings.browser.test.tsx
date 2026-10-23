import { act, render as mount, type Screen } from "../../../test/render";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

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

let renderer: Screen;
let container: HTMLElement;

async function setup() {
  await using stack = new AsyncDisposableStack();
  stack.defer(() => {
    vi.unstubAllGlobals();
  });
  vi.clearAllMocks();
  state.mode = "notifications-and-sound";

  vi.stubGlobal("Notification", { requestPermission: state.requestPermission });
  vi.stubGlobal("isSecureContext", true);
  renderer = stack.use(await mount(null, { router: false }));
  container = renderer.container;
  return stack.move();
}

it("labels the current preference as System notifications without changing it", async () => {
  await using _fixture = await setup();
  await renderer.rerender(<NotificationSettings />);
  expect(container.querySelector("h3")?.textContent).toBe("System notifications");
  expect(
    container.querySelector('[role="combobox"][aria-label="System notifications"]')?.textContent,
  ).toBe("Notifications with sound");
  expect(state.update).not.toHaveBeenCalled();
  expect(state.requestPermission).not.toHaveBeenCalled();
});

it("changes the existing notificationMode through the System notifications control", async () => {
  await using _fixture = await setup();
  state.mode = "off";
  await renderer.rerender(<NotificationSettings />);
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
