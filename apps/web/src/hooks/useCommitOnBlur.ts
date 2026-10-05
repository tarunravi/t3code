import { type ChangeEvent, type KeyboardEvent, useState } from "react";

export function useCommitOnBlur(value: string, onCommit: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);

  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    onFocus: () => {
      setDraft(value);
    },
    onBlur: () => {
      const next = draft ?? value;
      setDraft(null);
      if (next !== value) {
        onCommit(next);
      }
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      }
    },
  };
}
