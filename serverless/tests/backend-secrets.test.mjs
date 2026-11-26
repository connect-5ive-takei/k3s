import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../../scripts/configure-backend-secrets.sh", import.meta.url);

test("backend secret setup resolves the origin secret when the stack output is absent", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(
    script,
    /describe-stacks[\s\S]*?OriginVerificationSecretArn/,
  );
  assert.match(
    script,
    /describe-stack-resource[\s\S]*?--logical-resource-id OriginVerificationSecret/,
  );
  assert.match(
    script,
    /--query 'StackResourceDetail\.PhysicalResourceId'/,
  );
});

test("backend secret setup stores the JWT signing secret as an encrypted parameter", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /required_variables=\([\s\S]*?JWT_SECRET/);
  assert.match(script, /put_secure_parameter "\$variable_name" "\$\{!variable_name\}"/);
});
