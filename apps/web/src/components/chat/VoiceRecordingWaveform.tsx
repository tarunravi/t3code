import { cn } from "../../lib/utils";

const DEFAULT_BAR_COUNT = 64;

export function visibleVoiceWaveformLevels(
  levels: readonly number[],
  barCount = DEFAULT_BAR_COUNT,
): number[] {
  const recentLevels = levels.slice(-barCount);
  return [...Array(Math.max(0, barCount - recentLevels.length)).fill(0), ...recentLevels];
}

export function VoiceRecordingWaveform(props: {
  levels: readonly number[];
  active: boolean;
  className?: string;
}) {
  const levels = visibleVoiceWaveformLevels(props.levels);

  return (
    <div
      role="img"
      aria-label={props.active ? "Voice recording waveform" : "Transcribing voice input"}
      data-chat-composer-voice-waveform="true"
      className={cn(
        "flex h-8 min-w-0 flex-1 items-center gap-[3px] overflow-hidden",
        props.className,
      )}
    >
      {levels.map((level, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "min-w-0 flex-1 rounded-full transition-[height,background-color] duration-75",
            level > 0.04 ? "bg-foreground/70" : "bg-muted-foreground/30",
          )}
          style={{ height: `${Math.max(2, Math.round(3 + level * 28))}px` }}
        />
      ))}
    </div>
  );
}
