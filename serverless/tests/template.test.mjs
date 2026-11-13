import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateUrl = new URL("../template.yaml", import.meta.url);

test("session API forwards only the trusted viewer address", async () => {
  const template = await readFile(templateUrl, "utf8");
  const originPolicy = template.match(
    /  ApiOriginRequestPolicy:[\s\S]*?(?=\n  [A-Z][A-Za-z]+:)/,
  )?.[0];
  const viewerAddressFunction = template.match(
    /  ApiViewerAddressFunction:[\s\S]*?(?=\n  [A-Z][A-Za-z]+:)/,
  )?.[0];
  const apiBehavior = template.match(
    /          - PathPattern: \/api\/transcribe-session[\s\S]*?(?=\n        DefaultRootObject:)/,
  )?.[0];

  assert.ok(originPolicy, "API origin request policy must exist");
  assert.match(originPolicy, /HeaderBehavior: whitelist/);
  assert.match(originPolicy, /- True-Client-IP/);
  assert.doesNotMatch(originPolicy, /CloudFront-Viewer-Address/);

  assert.ok(viewerAddressFunction, "API viewer address function must exist");
  assert.match(
    viewerAddressFunction,
    /request\.headers\['true-client-ip'\] = \{ value: event\.viewer\.ip \}/,
  );

  assert.ok(apiBehavior, "session API cache behavior must exist");
  assert.match(
    apiBehavior,
    /FunctionARN: !GetAtt ApiViewerAddressFunction\.FunctionARN/,
  );
  assert.match(apiBehavior, /OriginRequestPolicyId: !Ref ApiOriginRequestPolicy/);
});

test("Laravel API forwards request state without forwarding the viewer host", async () => {
  const template = await readFile(templateUrl, "utf8");
  const originPolicy = template.match(
    /  LaravelApiOriginRequestPolicy:[\s\S]*?(?=\n  [A-Z][A-Za-z]+:)/,
  )?.[0];
  const apiBehavior = template.match(
    /          - PathPattern: \/api\/\*[\s\S]*?(?=\n        DefaultRootObject:)/,
  )?.[0];

  assert.ok(originPolicy, "Laravel API origin request policy must exist");
  assert.match(originPolicy, /CookieBehavior: all/);
  assert.match(originPolicy, /HeaderBehavior: allExcept/);
  assert.match(originPolicy, /- Host/);
  assert.match(originPolicy, /QueryStringBehavior: all/);

  assert.ok(apiBehavior, "Laravel API wildcard cache behavior must exist");
  assert.match(apiBehavior, /CachePolicyId: !Ref ApiNoCachePolicy/);
  assert.match(
    apiBehavior,
    /OriginRequestPolicyId: !Ref LaravelApiOriginRequestPolicy/,
  );
  assert.match(apiBehavior, /TargetOriginId: SessionApiOrigin/);
  assert.doesNotMatch(apiBehavior, /ApiViewerAddressFunction/);
});

test("exports the shared API and origin secret for the backend deployment", async () => {
  const template = await readFile(templateUrl, "utf8");
  const outputs = template.slice(template.indexOf("Outputs:"));

  assert.match(outputs, /OriginVerificationSecretArn:/);
  assert.match(outputs, /Value: !Ref OriginVerificationSecret/);
  assert.match(outputs, /TranscriptionApiId:/);
  assert.match(outputs, /Value: !Ref TranscriptionApi/);
});

test("note analysis is routed through a rate-limited Lambda with a runtime secret", async () => {
  const template = await readFile(templateUrl, "utf8");
  const apiBehavior = template.match(
    /          - PathPattern: \/api\/analyze[\s\S]*?(?=\n          - PathPattern: \/api\/transcribe-session)/,
  )?.[0];
  const analyzerFunction = template.match(
    /  NoteAnalyzerFunction:[\s\S]*?(?=\n  NoteAnalyzerLogGroup:)/,
  )?.[0];
  const analyzerRole = template.match(
    /  NoteAnalyzerExecutionRole:[\s\S]*?(?=\n  NoteAnalyzerFunction:)/,
  )?.[0];
  const analyzerRoute = template.match(
    /  NoteAnalyzerApiRoute:[\s\S]*?(?=\n  TranscriptionApiStage:)/,
  )?.[0];
  const geminiSecret = template.match(
    /  GeminiApiKeySecret:[\s\S]*?(?=\n  StaticSiteBucket:)/,
  )?.[0];

  assert.ok(apiBehavior, "note analyzer cache behavior must exist");
  assert.match(
    apiBehavior,
    /FunctionARN: !GetAtt ApiViewerAddressFunction\.FunctionARN/,
  );
  assert.match(apiBehavior, /CachePolicyId: !Ref ApiNoCachePolicy/);
  assert.match(apiBehavior, /OriginRequestPolicyId: !Ref ApiOriginRequestPolicy/);

  assert.ok(analyzerFunction, "note analyzer Lambda must exist");
  assert.match(analyzerFunction, /CodeUri: functions\/note-analyzer\//);
  assert.match(
    analyzerFunction,
    /GEMINI_API_KEY_SECRET_ID: !Ref GeminiApiKeySecret/,
  );
  assert.doesNotMatch(analyzerFunction, /\n          GEMINI_API_KEY:/);
  assert.match(
    analyzerFunction,
    /ANALYSIS_RATE_LIMIT_TABLE: !Ref AnalysisRateLimitTable/,
  );

  assert.ok(analyzerRole, "note analyzer role must exist");
  assert.match(analyzerRole, /Action: secretsmanager:GetSecretValue/);
  assert.match(analyzerRole, /Resource: !Ref GeminiApiKeySecret/);
  assert.match(analyzerRole, /Action: dynamodb:UpdateItem/);
  assert.doesNotMatch(analyzerRole, /Resource: "\*"/);

  assert.ok(analyzerRoute, "note analyzer API route must exist");
  assert.match(analyzerRoute, /RouteKey: POST \/api\/analyze/);

  assert.ok(geminiSecret, "Gemini API key secret must exist");
  assert.match(geminiSecret, /DeletionPolicy: Retain/);
  assert.doesNotMatch(geminiSecret, /SecretString:/);
  assert.doesNotMatch(geminiSecret, /GenerateSecretString:/);
});
