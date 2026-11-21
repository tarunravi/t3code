// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - promise-based helper outside the Effect runtime, like the desktop's other Node adapters.
import type {
  DesktopCodexSpeechResult,
  DesktopCodexSpeechTranscribeInput,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { encodeSpeechWav, SPEECH_SAMPLE_RATE } from "./wav.ts";

const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_PCM_BYTES = SPEECH_SAMPLE_RATE * Float32Array.BYTES_PER_ELEMENT * 5 * 60;
// The endpoint intermittently answers 403 to non-browser clients; a short retry covers it.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 1_000];

export interface CodexCredentials {
  readonly accessToken: string;
  readonly accountId: string | null;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

function codexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  return NodePath.join(codexHome, "auth.json");
}

function readCodexTokens(): CodexCredentials {
  let parsed: CodexAuthFile;
  try {
    parsed = JSON.parse(NodeFS.readFileSync(codexAuthPath(), "utf8")) as CodexAuthFile;
  } catch {
    throw new Error("No Codex login found on this device.");
  }
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) throw new Error("The Codex login file has no access token.");
  return { accessToken, accountId: parsed.tokens?.account_id ?? null };
}

/** True when a Codex login exists on this device; token freshness is checked at transcribe time. */
export function codexSpeechSupported(): boolean {
  try {
    readCodexTokens();
    return true;
  } catch {
    return false;
  }
}

function accessTokenExpired(accessToken: string): boolean {
  const payload = accessToken.split(".")[1];
  if (!payload) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof exp === "number" && exp * 1_000 <= Date.now();
  } catch {
    return false;
  }
}

export interface CodexTranscribeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface CodexTranscribeDeps {
  readonly fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: FormData },
  ) => Promise<CodexTranscribeFetchResponse>;
  readonly readCredentials?: () => CodexCredentials;
  readonly sleep?: (ms: number) => Promise<void>;
}

function unavailable(message: string): DesktopCodexSpeechResult {
  return { ok: false, code: "unavailable", message };
}

function failed(message: string): DesktopCodexSpeechResult {
  return { ok: false, code: "failed", message };
}

function httpError(status: number): DesktopCodexSpeechResult {
  if (status === 401) {
    return unavailable(
      "Codex rejected the login token. Open the Codex app or CLI once to refresh it, then try again.",
    );
  }
  if (status === 403) {
    return failed("The transcription request was blocked. Try again in a moment.");
  }
  return failed(`Transcription failed (${status}). Try again later.`);
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || (status >= 500 && status <= 599);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * POSTs 16 kHz PCM to the Codex transcription endpoint as WAV. Callers must use a fetch
 * implementation on Chromium's network stack (Electron `net.fetch`); plain Node fetch is
 * rejected by the endpoint's bot mitigation.
 */
export async function transcribeCodexSpeech(
  input: DesktopCodexSpeechTranscribeInput,
  deps: CodexTranscribeDeps,
): Promise<DesktopCodexSpeechResult> {
  const readCredentials = deps.readCredentials ?? readCodexTokens;
  const sleep = deps.sleep ?? defaultSleep;
  let credentials: CodexCredentials;
  try {
    credentials = readCredentials();
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : "No Codex login found on this device.",
    );
  }
  if (accessTokenExpired(credentials.accessToken)) {
    return unavailable(
      "The Codex login has expired. Open the Codex app or CLI once to refresh it, then try again.",
    );
  }
  if (input.pcm.byteLength === 0) return failed("The recording was empty.");
  if (input.pcm.byteLength > MAX_PCM_BYTES) {
    return failed("The recording is too long to transcribe.");
  }

  const form = new FormData();
  form.append("file", new Blob([encodeSpeechWav(input.pcm)], { type: "audio/wav" }), "voice.wav");
  if (input.language) form.append("language", input.language);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;

  let lastError = failed("Transcription failed.");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: CodexTranscribeFetchResponse;
    try {
      response = await deps.fetchImpl(CODEX_TRANSCRIBE_URL, {
        method: "POST",
        headers,
        body: form,
      });
    } catch {
      lastError = failed("The transcription request could not reach Codex. Try again later.");
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1_000);
        continue;
      }
      return lastError;
    }
    if (response.ok) {
      try {
        const payload = (await response.json()) as { text?: unknown } | null;
        if (typeof payload?.text !== "string" || payload.text.trim().length === 0) {
          return failed("Transcription returned no text. Try recording again.");
        }
        return { ok: true, value: payload.text };
      } catch {
        return failed("Transcription returned an unreadable response.");
      }
    }
    lastError = httpError(response.status);
    if (response.status === 401 || !isRetryableStatus(response.status)) return lastError;
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1_000);
  }
  return lastError;
}
