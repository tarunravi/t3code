import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import { VoiceTranscribeInput, VoiceTranscribeResult } from "@t3tools/contracts";

import * as DesktopIpc from "../DesktopIpc.ts";
import { TRANSCRIBE_VOICE_CHANNEL } from "../channels.ts";

const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

export class VoiceTranscriptionError extends Schema.TaggedError<VoiceTranscriptionError>()(
  "VoiceTranscriptionError",
  {
    message: Schema.String,
  },
) {}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

function readCodexCredentials(): { accessToken: string; accountId: string | null } {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const authPath = path.join(codexHome, "auth.json");
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as CodexAuthFile;
  } catch {
    throw new Error(
      "No Codex login found. Sign in with the Codex app or CLI first, then try again.",
    );
  }
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) {
    throw new Error("Codex auth file is missing an access token. Re-run Codex login.");
  }
  const parts = accessToken.split(".");
  if (parts.length === 3 && parts[1]) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
        exp?: number;
      };
      if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
        throw new Error(
          "Your Codex login has expired. Open the Codex app or CLI once to refresh it, then try again.",
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) throw error;
    }
  }
  return { accessToken, accountId: parsed.tokens?.account_id ?? null };
}

async function transcribeWithCodex(
  input: typeof VoiceTranscribeInput.Type,
): Promise<typeof VoiceTranscribeResult.Type> {
  const { accessToken, accountId } = readCodexCredentials();
  const audioBytes = Buffer.from(input.audioBase64, "base64");
  if (audioBytes.byteLength === 0) {
    throw new Error("Recording was empty.");
  }
  const extension = input.mimeType.includes("mp4")
    ? "mp4"
    : input.mimeType.includes("ogg")
      ? "ogg"
      : "webm";
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: input.mimeType }), `voice.${extension}`);
  if (input.language) {
    form.append("language", input.language);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  // Electron's net.fetch uses Chromium's network stack, which passes the bot
  // mitigation that rejects plain Node/curl TLS fingerprints on this endpoint.
  const response = await Electron.net.fetch(CODEX_TRANSCRIBE_URL, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Codex rejected the login token. Open the Codex app or CLI to refresh it, then try again.",
      );
    }
    if (response.status === 403) {
      throw new Error("Transcription request was blocked (403). Try again in a moment.");
    }
    throw new Error(`Transcription failed (${response.status}).`);
  }
  const payload = (await response.json()) as { text?: string };
  return { text: typeof payload.text === "string" ? payload.text : "" };
}

export const transcribeVoice = DesktopIpc.makeIpcMethod({
  channel: TRANSCRIBE_VOICE_CHANNEL,
  payload: VoiceTranscribeInput,
  result: VoiceTranscribeResult,
  handler: (input) =>
    Effect.tryPromise({
      try: () => transcribeWithCodex(input),
      catch: (error) =>
        new VoiceTranscriptionError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
});
