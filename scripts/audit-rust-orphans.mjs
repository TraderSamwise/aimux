#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const repoRoot = process.cwd();
const crateRoot = join(repoRoot, 'native/crates/aimux');
const srcRoot = join(crateRoot, 'src');
const testsRoot = join(crateRoot, 'tests');
const contractCorpusRoot = join(repoRoot, 'testdata/contracts/v1');
const fixtureDispatcherAllowlistPath = join(repoRoot, 'scripts/rust-fixture-dispatcher-allowlist.json');
const enforceFixtureDispatchers = process.argv.includes('--enforce-fixture-twins');

const tuiOwnedPatterns = [
  /(^|\/)dashboard_renderer(\.rs|\/)/,
  /(^|\/)dashboard_controller\.rs$/,
  /(^|\/)dashboard_internal\.rs$/,
  /(^|\/)dashboard_navigation\.rs$/,
  /(^|\/)dashboard_ui_state\.rs$/,
  /(^|\/)dashboard_targets\.rs$/,
  /(^|\/)tui_render\//,
  /(^|\/)tui_screen_renderers\.rs$/,
  /(^|\/)statusline\.rs$/,
  /(^|\/)expose/,
  /(^|\/)tmux_expose/,
];

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.endsWith('.rs')) {
      files.push(path);
    }
  }
  return files;
}

function walkFiles(dir, predicate) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFiles(path, predicate));
    } else if (predicate(path)) {
      files.push(path);
    }
  }
  return files;
}

function lineFor(source, index) {
  return source.slice(0, index).split('\n').length;
}

function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (ch === '"') {
      const quote = ch;
      out += quote;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
    } else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function parseFunctions(file) {
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, 'utf8');
  const source = stripCommentsAndStrings(raw);
  const rel = relative(repoRoot, file);
  const defs = [];
  const pattern = /((?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]+"\s+)?)fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{;]*>)?\s*\(/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const prefix = match[1] ?? '';
    const name = match[2];
    const argsOpen = source.indexOf('(', match.index);
    let parenDepth = 0;
    let cursor = argsOpen;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') {
        parenDepth += 1;
      } else if (source[cursor] === ')') {
        parenDepth -= 1;
        if (parenDepth === 0) {
          cursor += 1;
          break;
        }
      }
    }
    while (cursor < source.length && source[cursor] !== '{' && source[cursor] !== ';') {
      cursor += 1;
    }
    if (source[cursor] !== '{') {
      continue;
    }
    const bodyStart = cursor;
    const bodyEnd = findMatchingBrace(source, bodyStart);
    if (bodyEnd < 0) {
      continue;
    }
    const nameStart = match.index + match[0].lastIndexOf(name);
    defs.push({
      id: `${rel}:${lineFor(raw, match.index)}:${name}`,
      file: rel,
      line: lineFor(raw, match.index),
      name,
      nameStart,
      nameEnd: nameStart + name.length,
      public: /\bpub(?:\s|\(crate\))/.test(prefix),
      body: source.slice(bodyStart + 1, bodyEnd),
      productionFile: rel.startsWith('native/crates/aimux/src/'),
      testFile: rel.startsWith('native/crates/aimux/tests/'),
    });
    pattern.lastIndex = bodyEnd + 1;
  }
  return defs;
}

function collectCallNames(body) {
  const names = new Set();
  const direct = /(?:\b[A-Za-z_][A-Za-z0-9_]*\s*::\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match;
  while ((match = direct.exec(body)) !== null) {
    names.add(match[1]);
  }
  const methods = /\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  while ((match = methods.exec(body)) !== null) {
    names.add(match[1]);
  }
  return names;
}

function reachableFrom(rootIds, defsById, defsByName) {
  const seen = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift();
    const def = defsById.get(id);
    if (!def) {
      continue;
    }
    for (const callName of collectCallNames(def.body)) {
      for (const callee of defsByName.get(callName) ?? []) {
        if (!seen.has(callee.id)) {
          seen.add(callee.id);
          queue.push(callee.id);
        }
      }
    }
  }
  return seen;
}

function isContractFile(file) {
  return /_contract\.rs$/.test(file) || /(^|\/)contracts\.rs$/.test(file);
}

function isTuiOwned(file) {
  return tuiOwnedPatterns.some((pattern) => pattern.test(file));
}

function triage(def, testReachable) {
  if (isContractFile(def.file) || /^fixture_/.test(def.name) || /contract/i.test(def.name)) {
    return 'fixture-contract';
  }
  if (isTuiOwned(def.file)) {
    return 'tui-owned';
  }
  if (
    /_for_test$/.test(def.name)
    || /for_test/.test(def.name)
    || /_test_/.test(def.name)
    || /tests?/.test(def.file)
  ) {
    return 'test-helper';
  }
  if (testReachable.has(def.id)) {
    return 'test-only-reachable';
  }
  return 'needs-node-caller-triage';
}

function loadFixtureDispatcherAllowlist() {
  if (!existsSync(fixtureDispatcherAllowlistPath)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(fixtureDispatcherAllowlistPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${fixtureDispatcherAllowlistPath} must be an object keyed by Rust source path`);
  }
  for (const [file, reason] of Object.entries(parsed)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`${fixtureDispatcherAllowlistPath} entry ${file} must have a one-line reason`);
    }
    if (reason.includes('\n')) {
      throw new Error(`${fixtureDispatcherAllowlistPath} entry ${file} reason must be one line`);
    }
  }
  return parsed;
}

function isFixtureDispatcherName(name) {
  return /^(?:run_.*_case|.*_contract)$/.test(name);
}

const sourceFiles = [...walk(srcRoot), ...walk(testsRoot)];
const productionSourceFiles = sourceFiles.filter((file) => relative(repoRoot, file).startsWith('native/crates/aimux/src/'));
const testSourceFiles = sourceFiles.filter((file) => relative(repoRoot, file).startsWith('native/crates/aimux/tests/'));
const defs = sourceFiles.flatMap(parseFunctions);
const defsById = new Map(defs.map((def) => [def.id, def]));
const defsByName = new Map();
for (const def of defs) {
  if (!defsByName.has(def.name)) {
    defsByName.set(def.name, []);
  }
  defsByName.get(def.name).push(def);
}

const productionRoots = defs
  .filter((def) => def.file.startsWith('native/crates/aimux/src/bin/') && def.name === 'main')
  .map((def) => def.id);
const testRoots = defs.filter((def) => def.testFile).map((def) => def.id);
const productionReachable = reachableFrom(productionRoots, defsById, defsByName);
const testReachable = reachableFrom(testRoots, defsById, defsByName);
const sourceCache = new Map();
for (const file of productionSourceFiles) {
  sourceCache.set(relative(repoRoot, file), stripCommentsAndStrings(readFileSync(file, 'utf8')));
}
const testSourceCache = new Map();
for (const file of testSourceFiles) {
  testSourceCache.set(relative(repoRoot, file), stripCommentsAndStrings(readFileSync(file, 'utf8')));
}
const rawSourceCache = new Map();
for (const file of sourceFiles) {
  rawSourceCache.set(relative(repoRoot, file), readFileSync(file, 'utf8'));
}

const definitionNameRanges = new Map();
for (const def of defs.filter((def) => def.productionFile)) {
  const key = `${def.file}\0${def.name}`;
  if (!definitionNameRanges.has(key)) {
    definitionNameRanges.set(key, []);
  }
  definitionNameRanges.get(key).push([def.nameStart, def.nameEnd]);
}

function productionReferenceCountOutsideDefinitions(name) {
  const needle = new RegExp(`\\b${name}\\b`, 'g');
  let count = 0;
  for (const [file, source] of sourceCache) {
    let match;
    while ((match = needle.exec(source)) !== null) {
      const ranges = definitionNameRanges.get(`${file}\0${name}`) ?? [];
      const isDefinitionName = ranges.some(([start, end]) => match.index >= start && match.index < end);
      if (!isDefinitionName) {
        count += 1;
      }
    }
  }
  return count;
}

const graphUnreachableCandidates = defs
  .filter((def) => def.productionFile && def.public && !def.file.startsWith('native/crates/aimux/src/bin/'))
  .filter((def) => !productionReachable.has(def.id))
  .map((def) => ({
    file: def.file,
    line: def.line,
    name: def.name,
    productionReferences: productionReferenceCountOutsideDefinitions(def.name),
    reachableFromTests: testReachable.has(def.id),
    triage: triage(def, testReachable),
  }))
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const candidates = graphUnreachableCandidates.filter((candidate) => candidate.productionReferences === 0);

const actionable = candidates;
const countsByTriage = {};
for (const candidate of actionable) {
  countsByTriage[candidate.triage] = (countsByTriage[candidate.triage] ?? 0) + 1;
}
const fixtureDispatcherAllowlist = loadFixtureDispatcherAllowlist();
const fixtureDispatcherFiles = new Map();
for (const def of defs.filter((def) => def.productionFile && def.public && isFixtureDispatcherName(def.name))) {
  if (!fixtureDispatcherFiles.has(def.file)) {
    fixtureDispatcherFiles.set(def.file, []);
  }
  fixtureDispatcherFiles.get(def.file).push(def);
}
const strandedFixtureDispatchers = [...fixtureDispatcherFiles.entries()]
  .filter(([file, dispatchers]) => {
    const publicFileDefinitions = defs.filter((def) => def.file === file && def.public);
    return (
      !publicFileDefinitions.some((def) => productionReachable.has(def.id)) &&
      !dispatchers.some((def) => productionReferenceCountOutsideDefinitions(def.name) > 0)
    );
  })
  .map(([file, dispatchers]) => ({
    file,
    dispatchers: dispatchers.map((def) => def.name).sort(),
    reason: fixtureDispatcherAllowlist[file] ?? null,
  }))
  .sort((a, b) => a.file.localeCompare(b.file));
const strandedFixtureDispatcherFiles = new Set(strandedFixtureDispatchers.map((entry) => entry.file));
const untrackedFixtureDispatchers = strandedFixtureDispatchers.filter((entry) => !entry.reason);
const staleFixtureDispatcherAllowlist = Object.keys(fixtureDispatcherAllowlist)
  .filter((file) => !strandedFixtureDispatcherFiles.has(file))
  .sort();
const fixtureDispatcherGate = {
  allowlistPath: relative(repoRoot, fixtureDispatcherAllowlistPath),
  stranded: strandedFixtureDispatchers,
  untracked: untrackedFixtureDispatchers,
  stale: staleFixtureDispatcherAllowlist,
};

const libPath = join(srcRoot, 'lib.rs');

function moduleSourceFile(moduleName) {
  const flat = join(srcRoot, `${moduleName}.rs`);
  if (existsSync(flat)) {
    return relative(repoRoot, flat);
  }
  return relative(repoRoot, join(srcRoot, moduleName, 'mod.rs'));
}

function publicLibModules() {
  if (!existsSync(libPath)) {
    return [];
  }
  const raw = readFileSync(libPath, 'utf8');
  const source = stripCommentsAndStrings(raw);
  const modules = [];
  const pattern = /^pub\s+mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    modules.push({
      name: match[1],
      file: moduleSourceFile(match[1]),
      line: lineFor(raw, match.index),
    });
  }
  return modules;
}

function referenceCountForModule(moduleName, moduleFile) {
  const needle = new RegExp(`\\b${moduleName}\\b`, 'g');
  let count = 0;
  for (const [file, source] of [...sourceCache, ...testSourceCache]) {
    if (file === moduleFile) {
      continue;
    }
    let match;
    while ((match = needle.exec(source)) !== null) {
      if (file === relative(repoRoot, libPath)) {
        const lineStart = source.lastIndexOf('\n', match.index) + 1;
        const lineEnd = source.indexOf('\n', match.index);
        const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
        if (new RegExp(`\\bpub\\s+mod\\s+${moduleName}\\s*;`).test(line)) {
          continue;
        }
      }
      count += 1;
    }
  }
  return count;
}

const unreferencedExportedModules = publicLibModules()
  .map((module) => ({
    ...module,
    references: referenceCountForModule(module.name, module.file),
  }))
  .filter((module) => module.references === 0)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const corpusReferenceCache = rawSourceCache;

function contractCorpusFiles() {
  return walkFiles(
    contractCorpusRoot,
    (path) => /\.(?:json|jsonl|txt)$/.test(path),
  ).map((path) => relative(repoRoot, path));
}

function referencedCorpusPath(rel) {
  for (const source of corpusReferenceCache.values()) {
    if (source.includes(rel)) {
      return true;
    }
    let parent = dirname(rel);
    while (parent && parent !== 'testdata/contracts/v1' && parent !== '.') {
      if (source.includes(parent)) {
        return true;
      }
      parent = dirname(parent);
    }
  }
  return false;
}

const unreferencedContractCorpusFiles = contractCorpusFiles()
  .filter((file) => !referencedCorpusPath(file))
  .sort();

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({
    productionRoots,
    publicFunctionsChecked: defs.filter((def) => def.productionFile && def.public).length,
    graphUnreachableCount: graphUnreachableCandidates.length,
    countsByTriage,
    candidates,
    actionable,
    fixtureDispatcherGate,
    exportedModuleGate: {
      unreferenced: unreferencedExportedModules,
    },
    contractCorpusGate: {
      checked: contractCorpusFiles().length,
      unreferenced: unreferencedContractCorpusFiles,
    },
  }, null, 2));
} else {
  console.log(`# Rust orphan sweep`);
  console.log(`Production roots: ${productionRoots.length}`);
  console.log(`Public functions checked: ${defs.filter((def) => def.productionFile && def.public).length}`);
  console.log(`Graph-unreachable public functions: ${graphUnreachableCandidates.length}`);
  console.log(`Unreferenced production public functions: ${candidates.length}`);
  console.log(`Reported unreferenced production public functions: ${actionable.length}`);
  for (const [label, count] of Object.entries(countsByTriage).sort()) {
    console.log(`- ${label}: ${count}`);
  }
  console.log('');
  console.log('| file | line | function | test reachable | triage |');
  console.log('| --- | ---: | --- | --- | --- |');
  for (const candidate of actionable) {
    console.log(`| ${candidate.file} | ${candidate.line} | \`${candidate.name}\` | ${candidate.reachableFromTests ? 'yes' : 'no'} | ${candidate.triage} |`);
  }
  console.log('');
  console.log('## Fixture dispatcher gate');
  console.log(`Stranded dispatcher modules: ${strandedFixtureDispatchers.length}`);
  console.log(`Tracked allowlist entries: ${Object.keys(fixtureDispatcherAllowlist).length}`);
  console.log(`Untracked stranded modules: ${untrackedFixtureDispatchers.length}`);
  console.log(`Stale allowlist entries: ${staleFixtureDispatcherAllowlist.length}`);
  if (untrackedFixtureDispatchers.length > 0) {
    console.log('');
    console.log('| untracked file | dispatchers |');
    console.log('| --- | --- |');
    for (const entry of untrackedFixtureDispatchers) {
      console.log(`| ${entry.file} | ${entry.dispatchers.map((name) => `\`${name}\``).join(', ')} |`);
    }
  }
  if (staleFixtureDispatcherAllowlist.length > 0) {
    console.log('');
    console.log('| stale allowlist file |');
    console.log('| --- |');
    for (const file of staleFixtureDispatcherAllowlist) {
      console.log(`| ${file} |`);
    }
  }
  console.log('');
  console.log('## Exported module gate');
  console.log(`Unreferenced exported modules: ${unreferencedExportedModules.length}`);
  if (unreferencedExportedModules.length > 0) {
    console.log('');
    console.log('| module file | line | module |');
    console.log('| --- | ---: | --- |');
    for (const entry of unreferencedExportedModules) {
      console.log(`| ${entry.file} | ${entry.line} | \`${entry.name}\` |`);
    }
  }
  console.log('');
  console.log('## Contract corpus gate');
  console.log(`Contract corpus files checked: ${contractCorpusFiles().length}`);
  console.log(`Unreferenced contract corpus files: ${unreferencedContractCorpusFiles.length}`);
  if (unreferencedContractCorpusFiles.length > 0) {
    console.log('');
    console.log('| unreferenced corpus file |');
    console.log('| --- |');
    for (const file of unreferencedContractCorpusFiles) {
      console.log(`| ${file} |`);
    }
  }
}

if (
  enforceFixtureDispatchers
  && (
    untrackedFixtureDispatchers.length > 0
    || staleFixtureDispatcherAllowlist.length > 0
    || unreferencedExportedModules.length > 0
    || unreferencedContractCorpusFiles.length > 0
  )
) {
  process.exitCode = 1;
}
