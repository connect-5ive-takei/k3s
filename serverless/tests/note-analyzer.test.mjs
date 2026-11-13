import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGeminiRequest,
  createHandler,
  hashClientWindow,
  parseGeminiResponse,
  parseRequestContent,
} from "../functions/note-analyzer/index.mjs";

const originalOriginSecret = process.env.ORIGIN_SECRET;

test.beforeEach(() => {
  process.env.ORIGIN_SECRET = "test-origin-secret";
});

test.after(() => {
  if (originalOriginSecret === undefined) {
    delete process.env.ORIGIN_SECRET;
  } else {
    process.env.ORIGIN_SECRET = originalOriginSecret;
  }
});

function createEvent(body, overrides = {}) {
  return {
    body: JSON.stringify(body),
    headers: {
      "true-client-ip": "203.0.113.10",
      "x-origin-verify": "test-origin-secret",
    },
    requestContext: { http: { method: "POST" } },
    ...overrides,
  };
}

test("analysis requests require the CloudFront origin secret", async () => {
  const handler = createHandler({
    applyRateLimit: () => assert.fail("rate limit must not run"),
    getApiKey: () => assert.fail("secret lookup must not run"),
  });

  const response = await handler(
    createEvent(
      { content: "会話" },
      { headers: { "true-client-ip": "203.0.113.10" } },
    ),
  );

  assert.equal(response.statusCode, 403);
});

test("invalid JSON is rejected before invoking Gemini", async () => {
  const handler = createHandler({
    applyRateLimit: () => assert.fail("rate limit must not run"),
    getApiKey: () => assert.fail("secret lookup must not run"),
  });
  const response = await handler(createEvent({}, { body: "not-json" }));

  assert.equal(response.statusCode, 400);
  assert.match(JSON.parse(response.body).error, /形式/);
});

test("oversized note content is rejected", () => {
  assert.throws(
    () => parseRequestContent(createEvent({ content: "あ".repeat(3_000) })),
    /長すぎます/,
  );
});

test("Gemini receives a bounded JSON schema", () => {
  const request = buildGeminiRequest("話した相手：田中\n会話内容：旅行の話");
  const schema = request.generationConfig.responseJsonSchema;

  assert.equal(request.generationConfig.responseMimeType, "application/json");
  assert.equal(schema.properties.humans.maxItems, 10);
  assert.deepEqual(schema.properties.humans.items.required, [
    "name",
    "roll",
    "text",
    "tags",
  ]);
});

test("Gemini responses are validated before returning to the browser", () => {
  const valid = parseGeminiResponse({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                humans: [
                  {
                    name: "田中",
                    roll: "友人",
                    text: "旅行が好き",
                    tags: ["旅行"],
                  },
                ],
              }),
            },
          ],
        },
      },
    ],
  });

  assert.equal(valid.humans[0].name, "田中");
  assert.throws(
    () =>
      parseGeminiResponse({
        candidates: [
          { content: { parts: [{ text: '{"humans":[{"name":1}]}' }] } },
        ],
      }),
    /invalid analysis result/,
  );
});

test("successful analysis returns validated people", async () => {
  let rateLimitedAddress;
  const handler = createHandler({
    applyRateLimit: async (sourceIp) => {
      rateLimitedAddress = sourceIp;
    },
    getApiKey: async () => "test-api-key",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["x-goog-api-key"], "test-api-key");
      return {
        ok: true,
        async json() {
          return {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        humans: [
                          {
                            name: "田中",
                            roll: "友人",
                            text: "旅行が好き",
                            tags: ["旅行"],
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          };
        },
      };
    },
  });

  const response = await handler(createEvent({ content: "旅行の話をした" }));

  assert.equal(response.statusCode, 200);
  assert.equal(rateLimitedAddress, "203.0.113.10");
  assert.equal(JSON.parse(response.body).humans[0].name, "田中");
});

test("Gemini throttling is returned as an actionable API error", async () => {
  const handler = createHandler({
    applyRateLimit: async () => {},
    getApiKey: async () => "test-api-key",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });

  const response = await handler(createEvent({ content: "旅行の話をした" }));

  assert.equal(response.statusCode, 429);
  assert.match(JSON.parse(response.body).error, /混み合っています/);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("analysis rate-limit keys never store raw viewer addresses", () => {
  const window = hashClientWindow(
    "203.0.113.10",
    new Date("2026-10-30T00:15:00.000Z"),
  );

  assert.equal(window.key.startsWith("analyze:"), true);
  assert.equal(window.key.includes("203.0.113.10"), false);
  assert.equal(window.retryAfterSeconds, 2700);
});
