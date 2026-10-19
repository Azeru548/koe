#!/usr/bin/env node
"use strict";

// Smoke test for the koe-tts MCP server. Run it against a running studio:
//   TTS_STUDIO_URL=http://localhost:3000 node mcp/test-client.js
// A free tenant key is auto-registered on first use (see KOE_CREDENTIALS_FILE).

const path = require("path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "index.js")],
    env: { ...process.env },
  });

  const client = new Client({ name: "koe-tts-smoke-test", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  const opts = { timeout: 300000 };
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, opts);
    const text = (r.content || []).map((c) => c.text).join("\n");
    console.log(`\n=== ${name} ${r.isError ? "(ERROR)" : "(ok)"} ===\n${text}`);
    return { r, text };
  };

  await call("studio_status", {});
  await call("get_usage", {});
  await call("list_voices", { engine: "edge", lang: "en-GB" });
  const gen = await call("generate_voiceover", {
    text: "This clip was generated through the Koe TTS MCP server, end to end.",
    voice: "en-GB-SoniaNeural",
    rate: 1,
    file_name: "mcp-smoke-test",
  });
  if (!gen.r.isError) {
    const parsed = JSON.parse(gen.text);
    const { files } = parsed;
    const fs = require("fs");
    for (const f of files) {
      const stat = fs.statSync(f);
      console.log(`\nFILE OK: ${f} (${stat.size} bytes)`);
    }
  }
  await call("list_recent_voiceovers", {});
  await call("get_voiceover_status", { job_id: "does-not-exist-123" });

  await client.close();
  console.log("\nSMOKE TEST COMPLETE");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
