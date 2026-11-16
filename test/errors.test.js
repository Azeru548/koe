"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { readableError, MAX_LEN } = require("../engines/errors");

// A real edge-tts failure: the useful sentence is the last line.
const TRACEBACK = `Traceback (most recent call last):
  File "/usr/local/lib/python3.11/runpy.py", line 198, in _run_module_as_main
    return _run_code(code, main_globals, None, "__main__", mod_spec)
  File "/usr/local/lib/python3.11/site-packages/edge_tts/__main__.py", line 60, in <module>
    main()
  File "/usr/local/lib/python3.11/site-packages/edge_tts/communicate.py", line 426, in communicate
    raise exceptions.NoAudioReceived
edge_tts.exceptions.NoAudioReceived: No audio was received. Please verify that your parameters are correct.
`;

test("a traceback collapses to its exception line", () => {
  const out = readableError(TRACEBACK);
  assert.equal(
    out,
    "edge_tts.exceptions.NoAudioReceived: No audio was received. Please verify that your parameters are correct."
  );
  assert.ok(!out.includes("Traceback"), "no frames survive");
  assert.ok(!out.includes('File "'), "no stack frames survive");
  assert.equal(out.split("\n").length, 1, "it is one line");
});

test("a traceback with no recognisable exception keeps its last line", () => {
  const out = readableError("Traceback (most recent call last):\n  File \"x.py\", line 1\n    boom\n");
  assert.equal(out, "boom");
});

test("plain stderr is passed through, squashed onto one line", () => {
  assert.equal(readableError("ERROR:   something   went wrong\n"), "ERROR: something went wrong");
});

test("empty stderr falls back to the error message, then to a generic line", () => {
  assert.equal(readableError("", new Error("spawn failed")), "spawn failed");
  assert.equal(readableError("   ", null), "synthesis failed");
});

test("very long output is truncated to the documented length", () => {
  const out = readableError(`SomethingError: ${"x".repeat(900)}`);
  assert.equal(out.length, MAX_LEN);
  assert.ok(out.endsWith("…"));
});
