import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CODEX_TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";

/** 3 attempts total: the initial attempt plus up to 2 retries. */
export const VOICE_TRANSCRIBE_MAX_ATTEMPTS = 3;
/** Backoff between attempts: 500ms before retry 1, 1s before retry 2. */
export const VOICE_TRANSCRIBE_RETRY_DELAYS_MS: ReadonlyArray<number> = [500, 1000];

export interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

export function readCodexCredentials(): CodexCredentials {
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

/** 403 is the endpoint's intermittent bot-mitigation rejection; 429/5xx are transient by nature. */
export function isRetryableTranscriptionStatus(status: number): boolean {
  return status === 403 || status === 429 || (status >= 500 && status <= 599);
}

function transcriptionHttpError(status: number): Error {
  if (status === 401) {
    return new Error(
      "Codex rejected the login token. Open the Codex app or CLI to refresh it, then try again.",
    );
  }
  if (status === 403) {
    return new Error("Transcription request was blocked (403). Try again in a moment.");
  }
  return new Error(`Transcription failed (${status}).`);
}

export interface TranscribeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface TranscribeWithRetryInput {
  readonly audioBase64: string;
  readonly mimeType: string;
  readonly language?: string | undefined;
}

export interface TranscribeWithRetryDeps {
  readonly fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body: FormData },
  ) => Promise<TranscribeFetchResponse>;
  readonly readCredentials?: () => CodexCredentials;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type TranscribeOutcome =
  | { readonly ok: true; readonly text: string; readonly attempts: number }
  | { readonly ok: false; readonly error: Error; readonly attempts: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function audioExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

/**
 * POST audio to the Codex transcription endpoint, retrying transient failures.
 * Auth failures (missing/expired token, 401) and empty recordings fail fast
 * without retrying; 403/429/5xx and network errors retry with backoff.
 */
export async function transcribeWithRetry(
  input: TranscribeWithRetryInput,
  deps: TranscribeWithRetryDeps,
): Promise<TranscribeOutcome> {
  const readCredentials = deps.readCredentials ?? readCodexCredentials;
  const sleep = deps.sleep ?? defaultSleep;
  let credentials: CodexCredentials;
  try {
    credentials = readCredentials();
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      attempts: 0,
    };
  }
  const audioBytes = Buffer.from(input.audioBase64, "base64");
  if (audioBytes.byteLength === 0) {
    return { ok: false, error: new Error("Recording was empty."), attempts: 0 };
  }
  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBytes], { type: input.mimeType }),
    `voice.${audioExtension(input.mimeType)}`,
  );
  if (input.language) {
    form.append("language", input.language);
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${credentials.accessToken}` };
  if (credentials.accountId) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }

  let lastError: Error = new Error("Transcription failed.");
  for (let attempt = 1; attempt <= VOICE_TRANSCRIBE_MAX_ATTEMPTS; attempt += 1) {
    let response: TranscribeFetchResponse;
    try {
      // Electron's net.fetch uses Chromium's network stack, which passes the bot
      // mitigation that rejects plain Node/curl TLS fingerprints on this endpoint.
      response = await deps.fetchImpl(CODEX_TRANSCRIBE_URL, { method: "POST", headers, body: form });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < VOICE_TRANSCRIBE_MAX_ATTEMPTS) {
        await sleep(VOICE_TRANSCRIBE_RETRY_DELAYS_MS[attempt - 1] ?? 1000);
        continue;
      }
      return { ok: false, error: lastError, attempts: attempt };
    }
    if (response.ok) {
      const payload = (await response.json()) as { text?: string };
      return {
        ok: true,
        text: typeof payload.text === "string" ? payload.text : "",
        attempts: attempt,
      };
    }
    lastError = transcriptionHttpError(response.status);
    if (response.status === 401) {
      return { ok: false, error: lastError, attempts: attempt };
    }
    if (
      isRetryableTranscriptionStatus(response.status) &&
      attempt < VOICE_TRANSCRIBE_MAX_ATTEMPTS
    ) {
      await sleep(VOICE_TRANSCRIBE_RETRY_DELAYS_MS[attempt - 1] ?? 1000);
      continue;
    }
    return { ok: false, error: lastError, attempts: attempt };
  }
  return { ok: false, error: lastError, attempts: VOICE_TRANSCRIBE_MAX_ATTEMPTS };
}
