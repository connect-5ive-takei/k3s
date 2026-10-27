import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});
const stsClient = new STSClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});

const RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

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

export function buildSessionPolicy(sourceIp, validUntil) {
  const addressVersion = isIP(sourceIp);
  if (addressVersion === 0) {
    throw new TypeError("sourceIp must be a valid IP address");
  }

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "transcribe:StartStreamTranscription",
        Resource: "*",
        Condition: {
          IpAddress: {
            "aws:SourceIp": `${sourceIp}/${addressVersion === 4 ? 32 : 128}`,
          },
          DateLessThan: {
            "aws:CurrentTime": validUntil.toISOString(),
          },
        },
      },
    ],
  });
}

export function hashClientWindow(sourceIp, now) {
  const windowStart = Math.floor(now.getTime() / 3_600_000) * 3_600;
  const clientHash = createHash("sha256").update(sourceIp).digest("hex");
  return {
    key: `${clientHash}:${windowStart}`,
    expiresAt: windowStart + 7_200,
    retryAfterSeconds: windowStart + 3_600 - Math.floor(now.getTime() / 1_000),
  };
}

async function consumeRateLimit(sourceIp, now) {
  const tableName = process.env.RATE_LIMIT_TABLE;
  const limit = Number(process.env.RATE_LIMIT_PER_HOUR ?? "6");
  if (!tableName || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("Invalid rate limit configuration");
  }

  const clientWindow = hashClientWindow(sourceIp, now);
  await dynamoDbClient.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: {
        clientWindow: { S: clientWindow.key },
      },
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

  return clientWindow;
}

export async function handler(event, context) {
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
    return jsonResponse(403, { message: "Forbidden" });
  }

  const sourceIp = parseViewerAddress(headers["cloudfront-viewer-address"]);
  if (!sourceIp) {
    return jsonResponse(400, { message: "Client address is unavailable" });
  }

  try {
    const now = new Date();
    const clientWindow = await consumeRateLimit(sourceIp, now);
    const permissionDeadline = new Date(now.getTime() + 60_000);
    const assumedRole = await stsClient.send(
      new AssumeRoleCommand({
        RoleArn: process.env.TRANSCRIBE_SESSION_ROLE_ARN,
        RoleSessionName: `web-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        DurationSeconds: 900,
        Policy: buildSessionPolicy(sourceIp, permissionDeadline),
      }),
    );
    const credentials = assumedRole.Credentials;
    if (
      !credentials?.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !credentials.SessionToken ||
      !credentials.Expiration
    ) {
      throw new Error("STS returned incomplete credentials");
    }

    return jsonResponse(200, {
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
        expiration: credentials.Expiration.toISOString(),
      },
      languageCode: process.env.TRANSCRIBE_LANGUAGE_CODE ?? "ja-JP",
      maxSessionSeconds: Number(process.env.MAX_SESSION_SECONDS ?? "300"),
      region: process.env.AWS_REGION,
      sampleRate: Number(process.env.TRANSCRIBE_SAMPLE_RATE ?? "16000"),
      permissionExpiresAt: permissionDeadline.toISOString(),
    });
  } catch (error) {
    if (
      error instanceof ConditionalCheckFailedException ||
      error?.name === "ConditionalCheckFailedException"
    ) {
      const clientWindow = hashClientWindow(sourceIp, new Date());
      return jsonResponse(
        429,
        { message: "Rate limit exceeded" },
        { "retry-after": String(clientWindow.retryAfterSeconds) },
      );
    }

    console.error(
      JSON.stringify({
        level: "error",
        message: "Failed to create transcription session",
        errorName: error instanceof Error ? error.name : "UnknownError",
        requestId,
      }),
    );
    return jsonResponse(500, { message: "Unable to create session" });
  }
}
