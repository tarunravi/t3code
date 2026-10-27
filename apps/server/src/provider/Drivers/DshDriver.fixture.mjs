import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

const models = [
  '["sparksdeepseek","DeepSeek-V4.1-Flash-1017"]',
  '["sparksdirect","GLM-5.3-Flash-EXL3"]',
];
let selected = models[1];
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: selected,
    options: models.map((value) => ({ value, name: value })),
  },
];
const write = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
if (process.argv.includes("--version")) {
  process.stdout.write("dsh-stub 0.2.1\n");
  process.exit(0);
}
if (process.argv.slice(2).join(" ") !== "--profile acp")
  throw new Error("Expected standard dsh ACP launch");
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (process.env.DSH_STUB_LOG)
    NodeFS.appendFileSync(process.env.DSH_STUB_LOG, JSON.stringify(request) + "\n");
  if (request.id === undefined) continue;
  let result = {};
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: 1,
        agentInfo: { name: "deepseek-harness-acp", version: "0.2.1-stub" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { resume: {}, list: {}, close: {} },
        },
        authMethods: [],
      };
      break;
    case "session/new":
      result = { sessionId: "dsh-persistent-session", configOptions: configOptions() };
      break;
    case "session/resume":
      result = { configOptions: configOptions() };
      break;
    case "session/set_config_option":
      selected = request.params.value;
      result = { configOptions: configOptions() };
      break;
    case "session/prompt":
      write({
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Stub reasoning" },
          },
        },
      });
      write({
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "DeepSeek Harness stub answer" },
          },
        },
      });
      result = { stopReason: "end_turn" };
      break;
    case "session/list":
      result = {
        sessions: [{ sessionId: "dsh-persistent-session", cwd: process.cwd(), title: "DSH stub" }],
      };
      break;
    case "session/close":
      break;
    default:
      write({ id: request.id, error: { code: -32601, message: "Not supported by DSH" } });
      continue;
  }
  write({ id: request.id, result });
}
