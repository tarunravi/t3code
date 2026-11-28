import type { ProviderInstanceId, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { antigravityModelAccounts } from "./AntigravityModelAccounts.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

// Instance ids are never empty, so this cannot name an account.
const UNROUTED = "";

export function AntigravityModelAccountsSection({
  providers,
  routes,
  readOnly,
  onRouteChange,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly routes: ServerSettings["antigravityModelAccounts"];
  readonly readOnly: boolean;
  readonly onRouteChange: (model: string, instanceId: ProviderInstanceId | null) => void;
}) {
  const gt = useGT();
  const { accounts, models } = antigravityModelAccounts(providers, routes);
  const labels = new Map(accounts.map((account) => [account.instanceId, account.label]));
  const selectedInstance = gt("Selected instance", {
    $context: "model runs on the picked account",
  });
  return (
    <SettingsSection title={gt("Model accounts")}>
      {accounts.length < 2 ? (
        <SettingsRow
          title={gt("One Google account")}
          description={
            <T>
              Every Antigravity model runs on the instance you pick. To run some models on another
              Google account, add another Antigravity instance and sign it in to that account.
            </T>
          }
        />
      ) : models.length === 0 ? (
        <SettingsRow
          title={gt("No models yet")}
          description={
            <T>Sign in and refresh the Antigravity instances to list their models here.</T>
          }
        />
      ) : (
        <div
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            <T>
              New turns with a model run on its chosen account, whichever Antigravity instance you
              picked the model from.
            </T>
          </p>
          {models.map((model) => (
            <SettingsRow
              key={model.slug}
              title={model.name}
              control={
                <Select
                  value={model.instanceId ?? UNROUTED}
                  onValueChange={(value) =>
                    onRouteChange(
                      model.slug,
                      value === UNROUTED || value === null ? null : (value as ProviderInstanceId),
                    )
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={gt("Account for {model}", { model: model.name })}
                  >
                    <SelectValue>
                      {(value: string | null) =>
                        value && value !== UNROUTED
                          ? (labels.get(value as ProviderInstanceId) ?? value)
                          : selectedInstance
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    <SelectItem value={UNROUTED}>{selectedInstance}</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.instanceId} value={account.instanceId}>
                        {account.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
