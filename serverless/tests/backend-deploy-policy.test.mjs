import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateUrl = new URL("../backend-deploy-policy.yaml", import.meta.url);

test("backend deployment role trusts the immutable production repository identity", async () => {
  const template = await readFile(templateUrl, "utf8");
  const trustPolicy = template.match(
    /  BackendServerlessDeployRole:[\s\S]*?(?=\n      Policies:)/,
  )?.[0];

  assert.ok(trustPolicy, "backend deployment role trust policy must exist");
  assert.match(
    trustPolicy,
    /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/,
  );
  assert.match(
    trustPolicy,
    /token\.actions\.githubusercontent\.com:ref: refs\/heads\/main/,
  );
  assert.match(
    trustPolicy,
    /repo:connect-5ive-takei@336816162\/backend@1402241221:environment:production/,
  );
  assert.doesNotMatch(trustPolicy, /backend@1401223559/);
});

test("deployment roles are scoped to backend and summarizer functions", async () => {
  const template = await readFile(templateUrl, "utf8");
  const executionRole = template.match(
    /  BackendCloudFormationExecutionRole:[\s\S]*?(?=\n  BackendServerlessDeployRole:)/,
  )?.[0];
  const deploymentRole = template.match(
    /  BackendServerlessDeployRole:[\s\S]*?(?=\nOutputs:)/,
  )?.[0];

  assert.ok(executionRole, "CloudFormation execution role must exist");
  assert.match(executionRole, /- lambda:ListVersionsByFunction/);
  assert.match(
    executionRole,
    /function:\$\{BackendStackName\}-\*"/,
  );
  assert.match(
    executionRole,
    /function:\$\{SummarizerStackName\}-\*"/,
  );

  assert.ok(deploymentRole, "GitHub deployment role must exist");
  assert.match(
    deploymentRole,
    /Sid: ReadApplicationFunctions[\s\S]*?Action: lambda:GetFunction[\s\S]*?function:\$\{BackendStackName\}-\*"[\s\S]*?function:\$\{SummarizerStackName\}-\*"/,
  );
  assert.match(
    deploymentRole,
    /Sid: VerifySummarizerDeployment[\s\S]*?Action: lambda:InvokeFunction[\s\S]*?function:\$\{SummarizerStackName\}-summarize"/,
  );
});

test("deployment role can inspect only the shared HTTP API root", async () => {
  const template = await readFile(templateUrl, "utf8");
  const deploymentRole = template.match(
    /  BackendServerlessDeployRole:[\s\S]*?(?=\nOutputs:)/,
  )?.[0];

  assert.ok(deploymentRole, "GitHub deployment role must exist");
  assert.match(
    deploymentRole,
    /Sid: ReadSharedHttpApi[\s\S]*?Action: apigateway:GET[\s\S]*?::\/apis\/\$\{HttpApiId\}"/,
  );
  assert.doesNotMatch(
    deploymentRole,
    /Sid: ReadSharedHttpApi[\s\S]*?::\/apis\/\$\{HttpApiId\}\/\*/,
  );
});

test("BERT deployment permissions stay within the ML stack and its image repository", async () => {
  const template = await readFile(templateUrl, "utf8");
  const executionRole = template.match(
    /  BackendCloudFormationExecutionRole:[\s\S]*?(?=\n  BackendServerlessDeployRole:)/,
  )?.[0];
  const deploymentRole = template.match(
    /  BackendServerlessDeployRole:[\s\S]*?(?=\nOutputs:)/,
  )?.[0];

  assert.ok(executionRole);
  assert.ok(deploymentRole);
  assert.match(executionRole, /function:\$\{MlSummarizerStackName\}-\*"/);
  assert.match(executionRole, /log-group:\/aws\/lambda\/\$\{MlSummarizerStackName\}-\*"/);
  assert.match(executionRole, /role\/\$\{MlSummarizerStackName\}-\*"/);
  assert.match(deploymentRole, /stack\/\$\{MlSummarizerStackName\}\/\*"/);
  assert.match(
    deploymentRole,
    /Sid: VerifySummarizerDeployment[\s\S]*?function:\$\{MlSummarizerStackName\}-summarize"/,
  );
  for (const [role, sid] of [
    [executionRole, "ReadSummarizerImages"],
    [deploymentRole, "PublishSummarizerImages"],
  ]) {
    const statement = role.match(
      new RegExp(`- Sid: ${sid}\\n[\\s\\S]*?(?=\\n              - Sid:)`),
    )?.[0];
    assert.ok(statement);
    assert.match(statement, /Resource: !GetAtt SummarizerImageRepository.Arn/);
    assert.doesNotMatch(statement, /Resource: ["']?\*|ecr:\*/);
  }
  assert.doesNotMatch(deploymentRole, /ssm:GetParameters|ecr:DeleteRepository/);
});

test("released model images are retained, encrypted, immutable, and private", async () => {
  const template = await readFile(templateUrl, "utf8");
  const repository = template.match(
    /  SummarizerImageRepository:[\s\S]*?(?=\n  BackendCloudFormationExecutionRole:)/,
  )?.[0];

  assert.ok(repository);
  assert.match(repository, /DeletionPolicy: Retain/);
  assert.match(repository, /UpdateReplacePolicy: Retain/);
  assert.match(repository, /RepositoryName: !Sub "\$\{MlSummarizerStackName\}-images"/);
  assert.match(repository, /ImageTagMutability: IMMUTABLE/);
  assert.match(repository, /EncryptionType: AES256/);
  assert.match(repository, /ScanOnPush: true/);
  assert.match(repository, /Service: lambda.amazonaws.com/);
  assert.match(
    repository,
    /aws:SourceArn: !Sub "arn:\$\{AWS::Partition\}:lambda:\$\{AWS::Region\}:\$\{AWS::AccountId\}:function:\$\{MlSummarizerStackName\}-summarize"/,
  );
  assert.doesNotMatch(repository, /Principal: ["']?\*|Action: ["']?\*/);
});
