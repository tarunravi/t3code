import type { ProviderInstanceId } from "@t3tools/contracts";

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
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Configures the provider and model retried after two consecutive provider errors. */
export function FallbackModelSetting() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, connectedEnvironments } = useSettingsScope();
  const settingKeys = ["fallbackProviderInstanceId", "fallbackModel"] as const;
  const mixed = useScopedSettingsMixed(settingKeys);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const disabledReason = useScopedModelDisabledReason(settings, instanceEntries);
  const configuredSelection =
    settings.fallbackProviderInstanceId !== null && settings.fallbackModel !== null
      ? {
          instanceId: settings.fallbackProviderInstanceId,
          model: settings.fallbackModel,
        }
      : null;
  const defaultEntry = instanceEntries.find(
    (entry) => entry.enabled && entry.isAvailable && entry.models[0]?.slug,
  );
  const defaultSelection =
    defaultEntry === undefined
      ? null
      : { instanceId: defaultEntry.instanceId, model: defaultEntry.models[0]!.slug };
  const activeSelection = configuredSelection ?? defaultSelection;
  const enabled = configuredSelection !== null;
  const clearFallback = () =>
    updateSettings({ fallbackProviderInstanceId: null, fallbackModel: null });
  const setFallback = (instanceId: ProviderInstanceId, model: string) => {
    const reason = disabledReason(instanceId, model);
    if (reason) {
      toastManager.add({
        type: "error",
        title: "Fallback model not saved",
        description: reason,
      });
      return;
    }
    updateSettings({ fallbackProviderInstanceId: instanceId, fallbackModel: model });
  };

  return (
    <SettingsRow
      serverScoped
      settingKeys={settingKeys}
      mixed={mixed}
      {...searchableSetting("fallback-model")}
      description="Retry with this provider and model after two consecutive provider errors. Off keeps recovery manual."
      resetAction={
        settings.fallbackProviderInstanceId !== null || settings.fallbackModel !== null ? (
          <SettingResetButton label="provider fallback" onClick={clearFallback} />
        ) : null
      }
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            Connect an environment to configure provider fallback.
          </span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {enabled && configuredSelection !== null ? (
              <ProviderModelPicker
                environmentId={environment?.environmentId ?? null}
                activeInstanceId={configuredSelection.instanceId}
                model={configuredSelection.model}
                lockedProvider={null}
                instanceEntries={instanceEntries}
                modelOptionsByInstance={getCustomModelOptionsByInstance(
                  settings,
                  providers,
                  configuredSelection.instanceId,
                  configuredSelection.model,
                )}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                triggerAriaLabel="Fallback model"
                {...(mixed ? { triggerLabel: "Mixed" } : {})}
                getModelDisabledReason={disabledReason}
                onInstanceModelChange={setFallback}
              />
            ) : null}
            <Switch
              checked={enabled}
              disabled={!enabled && activeSelection === null}
              onCheckedChange={(checked) => {
                if (checked && activeSelection !== null) {
                  setFallback(activeSelection.instanceId, activeSelection.model);
                } else if (!checked) {
                  clearFallback();
                }
              }}
              aria-label="Enable provider fallback"
            />
          </div>
        )
      }
    />
  );
}
