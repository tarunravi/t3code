import type { DesktopAwsProfile } from "@t3tools/contracts";

import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";

/** Profiles from ~/.aws/config to pick from; any typed name is accepted as well. */
export function AwsProfilePicker({
  profiles,
  value,
  onValueChange,
  disabled = false,
}: {
  readonly profiles: readonly DesktopAwsProfile[];
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
}) {
  const query = value.trim().toLowerCase();
  // An exact match is the current choice, so the list then offers every profile.
  const shown = profiles.some((profile) => profile.name === value)
    ? profiles
    : profiles.filter((profile) => profile.name.toLowerCase().includes(query));
  return (
    <Autocomplete
      items={shown}
      itemToStringValue={(profile) => profile.name}
      mode="none"
      openOnInputClick
      value={value}
      onValueChange={(next) => onValueChange(next)}
    >
      <AutocompleteInput
        size="sm"
        showTrigger={profiles.length > 0}
        aria-label="AWS profile"
        placeholder="AWS profile"
        spellCheck={false}
        disabled={disabled}
      />
      {shown.length > 0 ? (
        <AutocompletePopup>
          <AutocompleteList className="max-h-72">
            {shown.map((profile) => (
              <AutocompleteItem key={profile.name} value={profile}>
                <span className="min-w-0 truncate text-sm">{profile.name}</span>
                <span className="ms-auto text-xs text-muted-foreground">
                  {profile.region ?? "no region"}
                </span>
              </AutocompleteItem>
            ))}
          </AutocompleteList>
        </AutocompletePopup>
      ) : null}
    </Autocomplete>
  );
}
