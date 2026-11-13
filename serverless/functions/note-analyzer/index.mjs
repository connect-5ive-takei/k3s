import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});
const secretsManagerClient = new SecretsManagerClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});

const MAX_CONTENT_BYTES = 8_000;
const MAX_HUMANS = 10;
const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};
const GEMINI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["humans"],
  properties: {
    humans: {
      type: "array",
      maxItems: MAX_HUMANS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "roll", "text", "tags"],
        properties: {
          name: { type: "string", maxLength: 100 },
          roll: { type: "string", maxLength: 100 },
          text: { type: "string", maxLength: 500 },
          tags: {
            type: "array",
            maxItems: 3,
            items: { type: "string", maxLength: 50 },
          },
        },
      },
    },
  },
};

let geminiApiKeyCache;
let geminiApiKeyPromise;

class ClientInputError extends Error {}
class RateLimitError extends Error {
  constructor(retryAfterSeconds) {
    super("Rate limit exceeded");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
class GeminiUpstreamError extends Error {
  constructor(status) {
    super(`Gemini request failed with status ${status}`);
    this.status = status;
  }
}

function jsonResponse(statusCode, body, additionalHeaders = {}) {
  return {
    statusCode,
    headers: { ...RESPONSE_HEADERS, ...additionalHeaders },
    body: JSON.stringify(body),
  };
}

function secretsEqual(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function parseViewerAddress(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const closingBracket = trimmed.indexOf("]");
    const address =
      closingBracket > 1 ? trimmed.slice(1, closingBracket) : "";
    return isIP(address) === 6 ? address : null;
  }

  if (isIP(trimmed)) {
    return trimmed;
  }

  const separator = trimmed.lastIndexOf(":");
  const address = separator > 0 ? trimmed.slice(0, separator) : "";
  return isIP(address) === 4 ? address : null;
}

export function hashClientWindow(sourceIp, now) {
  const windowStart = Math.floor(now.getTime() / 3_600_000) * 3_600;
  const clientHash = createHash("sha256").update(sourceIp).digest("hex");
  return {
    key: `analyze:${clientHash}:${windowStart}`,
    expiresAt: windowStart + 7_200,
    retryAfterSeconds: windowStart + 3_600 - Math.floor(now.getTime() / 1_000),
  };
}

function parseSecretString(secretString) {
  const value = secretString?.trim();
  if (!value) {
    throw new Error("Gemini API key secret is empty");
  }

  if (!value.startsWith("{")) {
    return value;
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Gemini API key secret contains invalid JSON");
  }

  if (typeof parsed.apiKey !== "string" || !parsed.apiKey.trim()) {
    throw new Error('Gemini API key secret must contain a non-empty "apiKey"');
  }

  return parsed.apiKey.trim();
}

async function getGeminiApiKey() {
  if (geminiApiKeyCache?.expiresAt > Date.now()) {
    return geminiApiKeyCache.value;
  }

  if (!geminiApiKeyPromise) {
    geminiApiKeyPromise = (async () => {
      const secretId = process.env.GEMINI_API_KEY_SECRET_ID;
      if (!secretId) {
        throw new Error("GEMINI_API_KEY_SECRET_ID is not configured");
      }

      const secret = await secretsManagerClient.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      const value = parseSecretString(secret.SecretString);
      geminiApiKeyCache = {
        value,
        expiresAt: Date.now() + 300_000,
      };
      return value;
    })().catch((error) => {
      throw error;
    }).finally(() => {
      geminiApiKeyPromise = undefined;
    });
  }

  return geminiApiKeyPromise;
}

export function parseRequestContent(event) {
  let rawBody;
  try {
    rawBody = event?.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event?.body ?? "";
  } catch {
    throw new ClientInputError("リクエストを読み取れませんでした。");
  }

  if (Buffer.byteLength(rawBody, "utf8") > MAX_CONTENT_BYTES) {
    throw new ClientInputError("入力内容が長すぎます。");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new ClientInputError("リクエストの形式が正しくありません。");
  }

  if (typeof body?.content !== "string" || !body.content.trim()) {
    throw new ClientInputError("会話内容を入力してください。");
  }

  return body.content.trim();
}

export function buildGeminiRequest(content) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `あなたは会話記録を整理するアシスタントです。
以下の会話記録から、人物情報を抽出してください。

【ルール】
- 入力にない情報を推測して追加しない
- nameは人物の名前
- rollは人物との関係性。不明なら「不明」とする
- textはその人物についての会話内容を一言に要約する
- tagsは趣味や興味関心などのキーワードを1〜3件にする
- 人物が複数いる場合は、それぞれ分けて抽出する
- 名前が分からない場合は、勝手に名前を作らない
- 人物情報を抽出できない場合は空配列を返す

【会話記録】
${content}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: GEMINI_RESPONSE_SCHEMA,
    },
  };
}

function isValidHuman(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.name === "string" &&
    value.name.length <= 100 &&
    typeof value.roll === "string" &&
    value.roll.length <= 100 &&
    typeof value.text === "string" &&
    value.text.length <= 500 &&
    Array.isArray(value.tags) &&
    value.tags.length <= 3 &&
    value.tags.every(
      (tag) => typeof tag === "string" && tag.length <= 50,
    )
  );
}

export function parseGeminiResponse(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    throw new Error("Gemini returned no candidate content");
  }

  const text = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("")
    .trim();
  const result = JSON.parse(text);
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray(result.humans) ||
    result.humans.length > MAX_HUMANS ||
    !result.humans.every(isValidHuman)
  ) {
    throw new Error("Gemini returned an invalid analysis result");
  }

  return { humans: result.humans };
}

async function consumeRateLimit(sourceIp, now) {
  const tableName = process.env.ANALYSIS_RATE_LIMIT_TABLE;
  const limit = Number(process.env.ANALYSIS_RATE_LIMIT_PER_HOUR ?? "20");
  if (!tableName || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Invalid analysis rate limit configuration");
  }

  const clientWindow = hashClientWindow(sourceIp, now);
  try {
    await dynamoDbClient.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { clientWindow: { S: clientWindow.key } },
        UpdateExpression: "ADD requestCount :one SET expiresAt = :expiresAt",
        ConditionExpression:
          "attribute_not_exists(requestCount) OR requestCount < :limit",
        ExpressionAttributeValues: {
          ":one": { N: "1" },
          ":expiresAt": { N: String(clientWindow.expiresAt) },
          ":limit": { N: String(limit) },
        },
      }),
    );
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      error?.name === "ConditionalCheckFailedException"
    ) {
      throw new RateLimitError(clientWindow.retryAfterSeconds);
    }
    throw error;
  }
}

async function requestGemini(content, apiKey, fetchImpl) {
  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
  const timeoutMilliseconds = Number(
    process.env.GEMINI_TIMEOUT_MILLISECONDS ?? "20000",
  );
  if (
    !/^[a-z0-9][a-z0-9.-]+$/.test(model) ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 23_000
  ) {
    throw new Error("Invalid Gemini configuration");
  }

  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(buildGeminiRequest(content)),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    },
  );
  if (!response.ok) {
    throw new GeminiUpstreamError(response.status);
  }

  return parseGeminiResponse(await response.json());
}

export function createHandler({
  fetchImpl = fetch,
  getApiKey = getGeminiApiKey,
  applyRateLimit = consumeRateLimit,
} = {}) {
  return async function noteAnalyzerHandler(event, context) {
    const requestId = context?.awsRequestId ?? "unknown";
    const headers = Object.fromEntries(
      Object.entries(event?.headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );

    if (
      event?.requestContext?.http?.method !== "POST" ||
      !secretsEqual(headers["x-origin-verify"], process.env.ORIGIN_SECRET)
    ) {
      return jsonResponse(403, { error: "Forbidden" });
    }

    const sourceIp = parseViewerAddress(headers["true-client-ip"]);
    if (!sourceIp) {
      return jsonResponse(400, { error: "接続元を確認できませんでした。" });
    }

    try {
      const content = parseRequestContent(event);
      await applyRateLimit(sourceIp, new Date());
      const apiKey = await getApiKey();
      const result = await requestGemini(content, apiKey, fetchImpl);
      return jsonResponse(200, result);
    } catch (error) {
      if (error instanceof ClientInputError) {
        return jsonResponse(400, { error: error.message });
      }
      if (error instanceof RateLimitError) {
        return jsonResponse(
          429,
          { error: "利用回数の上限に達しました。時間をおいてお試しください。" },
          { "retry-after": String(error.retryAfterSeconds) },
        );
      }
      if (error instanceof GeminiUpstreamError) {
        const statusCode = error.status === 429 ? 429 : 502;
        return jsonResponse(statusCode, {
          error:
            error.status === 429
              ? "分析サービスが混み合っています。時間をおいてお試しください。"
              : "会話内容の分析に失敗しました。",
        });
      }
      if (error?.name === "TimeoutError") {
        return jsonResponse(504, {
          error: "分析に時間がかかっています。もう一度お試しください。",
        });
      }

      console.error(
        JSON.stringify({
          level: "error",
          message: "Failed to analyze note content",
          errorName: error instanceof Error ? error.name : "UnknownError",
          requestId,
        }),
      );
      return jsonResponse(500, { error: "会話内容の分析に失敗しました。" });
    }
  };
}

export const handler = createHandler();
