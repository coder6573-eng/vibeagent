import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accumulateToolCallDeltas,
  createAccumulator,
  finishToolCalls,
  SseParser,
} from "../src/provider.ts";

test("SseParser handles chunk boundaries", () => {
  const parser = new SseParser();
  const first = parser.push('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(first, ['{"a":1}']);
  const second = parser.push(':2}\n\ndata: [DONE]\n\n');
  assert.deepEqual(second, ['{"b":2}', "[DONE]"]);
});

test("SseParser ignores comments and non-data lines", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": keep-alive\nevent: message\ndata: {}\n"), ["{}"]);
});

test("SseParser handles CRLF and flush", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"x":1}\r\n'), ['{"x":1}']);
  assert.deepEqual(parser.push('data: {"y":2}'), []);
  assert.deepEqual(parser.flush(), ['{"y":2}']);
});

test("tool call deltas accumulate by index", () => {
  const acc = createAccumulator();
  accumulateToolCallDeltas(acc, [
    { index: 0, id: "call_1", function: { name: "read_file", arguments: "" } },
    { index: 1, id: "call_2", function: { name: "grep", arguments: "" } },
  ]);
  accumulateToolCallDeltas(acc, [
    { index: 0, function: { arguments: '{"path":' } },
    { index: 1, function: { arguments: '{"pattern":"foo"}' } },
  ]);
  accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: '"a.ts"}' } }]);

  const calls = finishToolCalls(acc);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    id: "call_1",
    type: "function",
    function: { name: "read_file", arguments: '{"path":"a.ts"}' },
  });
  assert.equal(calls[1]?.function.name, "grep");
});

test("tool call deltas without a name are dropped", () => {
  const acc = createAccumulator();
  accumulateToolCallDeltas(acc, [{ index: 0, function: { arguments: "{}" } }]);
  assert.deepEqual(finishToolCalls(acc), []);
});
