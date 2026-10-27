import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSessionPolicy,
  hashClientWindow,
  parseViewerAddress,
} from "../functions/session-broker/index.mjs";

test("CloudFront viewer addresses are normalized", () => {
  assert.equal(parseViewerAddress("203.0.113.10:44321"), "203.0.113.10");
  assert.equal(parseViewerAddress("[2001:db8::1]:44321"), "2001:db8::1");
  assert.equal(parseViewerAddress("invalid"), null);
});

test("temporary Transcribe permissions are restricted by IP and time", () => {
  const deadline = new Date("2026-10-27T00:01:00.000Z");
  const policy = JSON.parse(buildSessionPolicy("203.0.113.10", deadline));
  const statement = policy.Statement[0];

  assert.equal(statement.Action, "transcribe:StartStreamTranscription");
  assert.equal(
    statement.Condition.IpAddress["aws:SourceIp"],
    "203.0.113.10/32",
  );
  assert.equal(
    statement.Condition.DateLessThan["aws:CurrentTime"],
    deadline.toISOString(),
  );
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
