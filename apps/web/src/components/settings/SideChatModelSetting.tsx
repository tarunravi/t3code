import type { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Default model for /side chats; off keeps each side chat on its parent's model. */
export function SideChatModelSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const mixed = useScopedSettingsMixed(["sideChatModelSelection"]);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const selection = settings.sideChatModelSelection;
  const fallback = instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const active =
    selection ??
    (fallback === undefined
      ? null
      : createModelSelection(fallback.instanceId, fallback.models[0]?.slug ?? ""));

  return (
    <SettingsRow
      serverScoped
      settingKeys={["sideChatModelSelection"]}
      {...searchableSetting("side-chat-model")}
      description="Model /side chats start with. Off uses the parent thread's model. Each side chat can still switch models."
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to choose its side chat model.
          </span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {selection !== null ? (
              <ProviderModelPicker
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  selection.instanceId,
                  selection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Side chat model"
                {...(mixed ? { triggerLabel: "Mixed" } : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={(instanceId: ProviderInstanceId, model: string) => {
                  const reason = disabledReason(instanceId, model);
                  if (reason) {
                    toastManager.add({
                      type: "error",
                      title: "Side chat model not saved",
                      description: reason,
                    });
                    return;
                  }
                  updateSettings({
                    sideChatModelSelection: createModelSelection(instanceId, model),
                  });
                }}
              />
            ) : null}
            <Switch
              checked={selection !== null}
              disabled={selection === null && active === null}
              onCheckedChange={(checked) =>
                updateSettings({ sideChatModelSelection: checked ? active : null })
              }
              aria-label="Use a separate side chat model"
            />
          </div>
        )
      }
    />
  );
}
