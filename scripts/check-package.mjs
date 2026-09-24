import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = await mkdtemp(join(tmpdir(), 'duelloop-package-'));
const consumer = join(workspace, 'consumer');
await mkdir(consumer);
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const run = (command, args, cwd = consumer) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, { cwd, env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolveResult({ stdout, stderr }) : reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`)));
});
const stage = message => process.stderr.write(`[package-check] ${message}\n`);
function documentedCode(markdown, id, language) {
  const start = `<!-- duelloop-check:${id}:start -->`;
  const end = `<!-- duelloop-check:${id}:end -->`;
  assert.equal(markdown.split(start).length, 2, `Missing or duplicate documentation marker: ${id}`);
  const section = markdown.split(start)[1].split(end);
  assert.equal(section.length, 2, `Missing or duplicate documentation end marker: ${id}`);
  const fenced = section[0].trim();
  assert(fenced.startsWith(`\`\`\`${language}\n`) && fenced.endsWith('\n```'), `Unexpected documentation code block: ${id}`);
  const code = fenced.slice(language.length + 4, -4);
  assert(!code.includes('```'), `Only one complete code block may be checked by marker ${id}`);
  return code;
}
try {
  stage('Packing the current build into a unique temporary directory');
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', workspace], root)).stdout);
  assert.equal(packed.length, 1);
  assert.equal(manifest.license, 'MIT', 'Package metadata must declare the selected MIT license');
  assert.equal(manifest.private, true, 'Local distribution must remain private until npm publication is authorized');
  for (const path of ['dist/index.d.ts','dist/cli.js','dist/config.js','dist/strategy.js','dist/evaluation.js',
    'templates/domain.mjs','templates/README.md','docs/sdk.md','docs/cli.md','docs/model-only-decisions.md','LICENSE']) {
    assert(packed[0].files.some(file => file.path === path), `Required distribution artifact missing: ${path}`);
  }
  assert(packed[0].files.every(file => !file.path.startsWith('src/') && !file.path.includes('node_modules/') && !/(^|\/)\.env(?:\.|$)/.test(file.path)), 'Private sources or environment file packed');
  const archive = join(workspace, packed[0].filename);
  const typescript = JSON.parse(await readFile(join(root, 'node_modules/typescript/package.json'), 'utf8')).version;
  const nodeTypes = JSON.parse(await readFile(join(root, 'node_modules/@types/node/package.json'), 'utf8')).version;
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'duelloop-independent-consumer-check', private: true, type: 'module', dependencies: { duelloop: `file:${archive}` }, devDependencies: { typescript, '@types/node': nodeTypes } }, null, 2));
  stage('Installing the tarball in an independent consumer with install scripts disabled');
  await run('npm', ['install', '--ignore-scripts', '--package-lock=false']);
  assert.equal(JSON.parse(await readFile(join(consumer, 'node_modules/duelloop/package.json'), 'utf8')).license, 'MIT', 'Installed package license metadata differs');
  assert.equal(await readFile(join(consumer, 'node_modules/duelloop/LICENSE'), 'utf8'), await readFile(join(root, 'LICENSE'), 'utf8'), 'Installed MIT license text differs from the project license');
  for (const file of ['app.mjs', 'market-domain.mjs', 'conformance.mjs']) {
    const contents = await readFile(join(root, 'demo', file), 'utf8');
    assert(!/['"]duelloop\//.test(contents), `Private package import in ${file}`);
    assert(!/from\s*['"](?:\.\.\/)+(?:src|dist)\//.test(contents), `Repository source import in ${file}`);
    await copyFile(join(root, 'demo', file), join(consumer, file));
  }
  stage('Running SDK decisions and external domain conformance from installed public exports');
  const demo = await run(process.execPath, ['app.mjs']);
  const rows = demo.stdout.trim().split('\n').map(line => JSON.parse(line));
  const steps = rows.filter(row => row.result);
  assert.equal(steps.length, 12);
  assert(steps.every(row => row.result.decision.decisionSource === 'strategy' && row.result.receipt.status === 'completed'), 'Demo did not execute all selected strategy actions');
  assert.equal(new Set(steps.map(row => row.application)).size, 2);
  assert(rows.filter(row => row.status).every(row => row.status.unresolvedExecutions === 0));
  const conformance = JSON.parse((await run(process.execPath, ['conformance.mjs'])).stdout);
  assert.equal(conformance.passed, true);
  assert(conformance.checks.some(check => check.status === 'skipped'), 'Optional checks must be visibly skipped');
  stage('Checking every exported public type in a strict TypeScript consumer');
  const installedDist = join(consumer, 'node_modules/duelloop/dist');
  const barrel = await readFile(join(installedDist, 'index.d.ts'), 'utf8');
  const typeNames = new Set();
  for (const match of barrel.matchAll(/export \* from ['"]\.\/(.+?)\.js['"]/g)) {
    const declarations = await readFile(join(installedDist, `${match[1]}.d.ts`), 'utf8');
    for (const exported of declarations.matchAll(/export (?:declare )?(?:interface|type)\s+(\w+)/g)) typeNames.add(exported[1]);
  }
  assert(typeNames.size >= 30, 'Public declaration inventory is incomplete');
  const typeList = [...typeNames].sort();
  await writeFile(join(consumer, 'consumer.ts'), `import type { ${typeList.join(', ')} } from 'duelloop';\nimport { DuelLoop, SqliteStore, FixtureDecisionModel, KuhnPokerDomain, createKuhnStrategy, runDomainConformance } from 'duelloop';\nexport type PublicContracts = [${typeList.join(', ')}];\nconst domain: DomainDefinition = new KuhnPokerDomain({ applicationId: 'typecheck', seed: 1 });\nconst store: DuelLoopStore = new SqliteStore(':memory:');\nconst model: DecisionModel = new FixtureDecisionModel('typecheck-fixture', question => ({ score: 0, confidence: 1, probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 0 ? 1 : 0])) }));\nconst app = new DuelLoop({ domain, model, store, applicationId: 'typecheck', mode: 'offline', executionOwner: 'framework' });\nconst strategy: StrategyPackage = createKuhnStrategy();\napp.bootstrap(strategy, 'scope');\nvoid runDomainConformance(() => new KuhnPokerDomain({ seed: 1 }));\n`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true }, include: ['consumer.ts'] }));
  await run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json']);
  await writeFile(join(consumer, 'boundary.mjs'), "import assert from 'node:assert/strict';\nawait assert.rejects(import('duelloop/dist/storage.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });\n");
  await run(process.execPath, ['boundary.mjs']);
  stage('Checking installed CLI entry points');
  const cli = process.platform === 'win32' ? join(consumer, 'node_modules/duelloop/dist/cli.js') : join(consumer, 'node_modules/.bin/duelloop');
  const help = await run(process.execPath, [cli, '--help']);
  assert(help.stdout.length > 0, 'CLI help is empty');
  const version = await run(process.execPath, [cli, '--version']);
  assert(version.stdout.includes(manifest.version), 'CLI version differs from installed package');
  const installed = join(consumer, 'node_modules/duelloop');
  const offlineGuard = join(consumer, 'offline-guard.mjs');
  await writeFile(offlineGuard, `import net from 'node:net';\nimport http from 'node:http';\nimport https from 'node:https';\nlet attempts = 0;\nconst blocked = () => { attempts++; throw new Error('Offline distribution check attempted network access'); };\nglobalThis.fetch = async () => blocked();\nnet.Socket.prototype.connect = blocked;\nhttp.request = http.get = https.request = https.get = blocked;\nprocess.on('beforeExit', () => { if (attempts) process.exitCode = 1; });\n`);
  const offline = (args, cwd = consumer) => run(process.execPath, ['--import', offlineGuard, ...args], cwd);
  const cliResult = async (args, cwd = consumer) => {
    const response = JSON.parse((await offline([cli, ...args], cwd)).stdout);
    assert.equal(response.ok, true, `Installed CLI failed: ${args[0]}`);
    return response.data;
  };

  stage('Running the complete managed SDK snippet extracted from installed documentation');
  const sdkCode = documentedCode(await readFile(join(installed, 'docs/sdk.md'), 'utf8'), 'managed-sdk', 'js');
  assert(!/['"]duelloop\//.test(sdkCode), 'SDK documentation imports a private subpath');
  const sdkCheckDir = join(consumer, 'documented-sdk'); await mkdir(sdkCheckDir);
  await writeFile(join(sdkCheckDir, 'managed.mjs'), `import assert from 'node:assert/strict';\n${sdkCode}\nconst checkedStore = new SqliteStore('./app.sqlite');\ntry {\n  const decisions = checkedStore.listArtifacts('decision');\n  assert.equal(decisions.length, 1);\n  assert.equal(decisions[0].value.modelKind, 'fixture');\n  assert.equal(decisions[0].value.decisionSource, 'strategy');\n  assert.equal(checkedStore.intents().length, 1);\n  assert.equal(checkedStore.intents()[0].receipt.status, 'completed');\n} finally { checkedStore.close(); }\n`);
  await offline(['managed.mjs'], sdkCheckDir);

  stage('Executing the first offline CLI workflow from installed documentation');
  const cliCode = documentedCode(await readFile(join(installed, 'docs/cli.md'), 'utf8'), 'offline-cli', 'sh');
  const cliCommands = cliCode.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const documentedCommands = []; const documentedResults = [];
  for (const line of cliCommands) {
    // This documented quickstart intentionally uses simple literal words. Do not run
    // arbitrary shell expansion to test a README; fail if its grammar changes.
    assert(/^duelloop(?:\s+[A-Za-z0-9_./-]+)+$/.test(line), `CLI documentation needs an explicitly supported literal command: ${line}`);
    const args = line.split(/\s+/).slice(1); documentedCommands.push(args[0]);
    documentedResults.push(await cliResult(args));
  }
  assert.deepEqual(documentedCommands, ['init','doctor','run','status']);
  assert.equal(documentedResults[0].modelCalls, 0); assert.equal(documentedResults[1].modelCalls, 0);
  assert.equal(documentedResults[1].externalModuleExecuted, false);
  assert.equal(documentedResults[2].modelKind, 'fixture'); assert.equal(documentedResults[2].completedSteps, 20);
  assert.equal(documentedResults[2].last.receipt.status, 'completed');
  assert.equal(documentedResults[3].activeReleaseDigest, documentedResults[2].activeReleaseDigest);
  assert.equal(documentedResults[3].unresolvedExecutions.length, 0);

  stage('Validating generated configuration, strategy, and protocols through installed public exports');
  const validators = ['validateConfiguration','validateStrategy','validateProtocol'];
  await writeFile(join(consumer, 'validate-generated.mjs'), `import assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { resolve } from 'node:path';\nimport { validateConfiguration, validateStrategy, validateProtocol, loadConfiguration, KuhnPokerDomain } from 'duelloop';\nconst path = resolve(process.argv[2]);\nconst raw = JSON.parse(await readFile(path, 'utf8'));\nconst validated = validateConfiguration(raw);\nassert.equal(validated.runtime.mode, 'offline');\nassert.equal(validated.decisionModel.kind, 'fixture');\nassert.equal(validated.research.mode, 'off');\nconst config = await loadConfiguration(path);\nconst domain = new KuhnPokerDomain({applicationId: config.applicationId, scopeId: config.scopeId});\nconst strategy = validateStrategy(JSON.parse(await readFile(config.strategy, 'utf8')), domain);\nassert.equal(strategy.schemaVersion, '2.0');\nassert.throws(() => validateStrategy({...strategy, schemaVersion:'1.0'}, domain), {code:'VERSION_INCOMPATIBLE'});\nconst development = validateProtocol(JSON.parse(await readFile(config.evaluation.developmentProtocol, 'utf8')));\nconst final = validateProtocol(JSON.parse(await readFile(config.evaluation.finalProtocol, 'utf8')));\nassert.equal(development.version, '3.0');\nassert.equal(final.version, '3.0');\nassert.throws(() => validateProtocol({...final, maxFallbackRate:1}), {code:'CONFIG_INVALID'});\nassert.equal(strategy.scope.domain, development.domainId);\nassert.equal(development.domainId, final.domainId);\nassert.notEqual(development.holdoutId, final.holdoutId);\nassert(!development.seeds.some(seed => final.seeds.includes(seed)));\nassert.throws(() => validateConfiguration({...raw, unrecognizedField: true}), {code:'CONFIG_INVALID'});\nconst badStrategy = structuredClone(strategy); badStrategy.questions[0].criteria = ['only one level'];\nassert.throws(() => validateStrategy(badStrategy, domain), {code:'STRATEGY_INVALID'});\nassert.throws(() => validateProtocol({...final, maxFinalEvaluationsPerRun:2}), {code:'CONFIG_INVALID'});\n`);
  await offline(['validate-generated.mjs', './my-app/duelloop.json']);

  stage('Copying and executing the installed external-domain template as a consumer application');
  await cliResult(['init','--dir','./template-app','--domain','auction','--application','template-consumer','--scope','template-scope']);
  const templateDirectory = join(consumer, 'template-app');
  await copyFile(join(installed, 'templates/domain.mjs'), join(templateDirectory, 'domain.mjs'));
  const templateConfigurationPath = join(templateDirectory, 'duelloop.json');
  const templateConfiguration = JSON.parse(await readFile(templateConfigurationPath, 'utf8'));
  templateConfiguration.domain = { kind:'module', path:'./domain.mjs', exportName:'createDomain', options:{seed:1,opponentId:'fixed'} };
  await writeFile(templateConfigurationPath, JSON.stringify(templateConfiguration, null, 2));
  const templateDoctor = await cliResult(['doctor','--config',templateConfigurationPath]);
  assert.equal(templateDoctor.externalModuleExecuted, false); assert.equal(templateDoctor.modelCalls, 0);
  const templateStep = await cliResult(['step','--config',templateConfigurationPath]);
  assert.equal(templateStep.completedSteps, 1); assert.equal(templateStep.modelKind, 'fixture');
  assert.equal(templateStep.last.decision.observation.domainId, 'resource-auction');
  assert.equal(templateStep.last.receipt.status, 'completed');
  assert.equal(templateStep.last.decision.decisionSource, 'strategy');

  const report = { status: 'passed', package: `${manifest.name}@${manifest.version}`, testedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, tarball: archive, tarballSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), consumer, independentInstall: true, publicTypes: typeNames.size, skipLibCheck: false, sdkSteps: steps.length, conformance: { passed: conformance.checks.filter(check => check.status === 'passed').length, skipped: conformance.checks.filter(check => check.status === 'skipped').length }, cli: ['--help', '--version', ...documentedCommands, 'step'], privateImportRejected: true,
    documentation: { source:'installed tarball', executedSnippets:['docs/sdk.md#managed-sdk','docs/cli.md#offline-cli'], sdkSteps:1, cliSteps:documentedResults[2].completedSteps, networkDenied:true },
    runtimeSchemas: { validators, validInitializationAccepted:true, malformedInputsRejected:true },
    templates: [{ path:'templates/domain.mjs', copiedFromInstalledPackage:true, domainId:templateStep.last.decision.observation.domainId, steps:1, modelKind:'fixture', receipt:'completed' }] };
  await writeFile(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', workspace, message: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
