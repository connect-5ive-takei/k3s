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
