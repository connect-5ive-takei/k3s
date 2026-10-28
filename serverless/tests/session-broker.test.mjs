import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionPolicy,
  hashClientWindow,
  parseViewerAddress,
} from "../functions/session-broker/index.mjs";

test("CloudFront viewer addresses are normalized", () => {
  assert.equal(parseViewerAddress("203.0.113.10"), "203.0.113.10");
  assert.equal(parseViewerAddress("2001:db8::1"), "2001:db8::1");
  assert.equal(parseViewerAddress("203.0.113.10:44321"), "203.0.113.10");
  assert.equal(parseViewerAddress("[2001:db8::1]:44321"), "2001:db8::1");
  assert.equal(parseViewerAddress("invalid"), null);
});

test("temporary Transcribe permissions allow only stream start before deadline", () => {
  const deadline = new Date("2026-10-27T00:01:00.000Z");
  const policy = JSON.parse(buildSessionPolicy(deadline));
  const statement = policy.Statement[0];

  assert.deepEqual(statement.Action, [
    "transcribe:StartStreamTranscription",
    "transcribe:StartStreamTranscriptionWebSocket",
  ]);
  assert.equal(statement.Resource, "*");
  assert.deepEqual(Object.keys(statement.Condition), ["DateLessThan"]);
  assert.equal(
    statement.Condition.DateLessThan["aws:CurrentTime"],
    deadline.toISOString(),
  );
});

test("temporary Transcribe permissions reject an invalid deadline", () => {
  assert.throws(() => buildSessionPolicy(new Date("invalid")), /validUntil/);
});

test("rate-limit keys do not store the raw client address", () => {
  const clientWindow = hashClientWindow(
    "203.0.113.10",
    new Date("2026-10-27T00:15:00.000Z"),
  );

  assert.equal(clientWindow.key.includes("203.0.113.10"), false);
  assert.equal(clientWindow.retryAfterSeconds, 2700);
  assert.equal(clientWindow.expiresAt, 1793066400);
});
