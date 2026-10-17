#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

const repoRoot = process.cwd();
const crateRoot = join(repoRoot, 'native/crates/aimux');
const srcRoot = join(crateRoot, 'src');
const testsRoot = join(crateRoot, 'tests');
const libPath = join(srcRoot, 'lib.rs');
const contractCorpusRoot = join(repoRoot, 'testdata/contracts/v1');
const fixtureDispatcherAllowlistPath = join(repoRoot, 'scripts/rust-fixture-dispatcher-allowlist.json');
const enforceFixtureDispatchers = process.argv.includes('--enforce-fixture-twins');
const historicalCorpusReferencePrefixes = ['docs/rust-translation/'];
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

function walkFilesPruned(dir, predicate) {
  if (!existsSync(dir)) {
    return [];
  }
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (['.git', 'node_modules', 'target', 'release'].includes(entry)) {
      continue;
    }
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkFilesPruned(path, predicate));
    } else if (predicate(path)) {
      files.push(path);
    }
  }
  return files;
}

const activeContractInventoryFiles = [
  'AGENTS.md',
  'testdata/contracts/v1/README.md',
  'testdata/contracts/v1/ENFORCEMENT_AUDIT.md',
  ...walkFiles(
    contractCorpusRoot,
    (path) => /^PHASE8_.*\.md$/.test(basename(path)),
  ).map((path) => relative(repoRoot, path)),
].sort();

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

function isTwinFile(file) {
  return /_contract\.rs$/.test(file);
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

function isModuleDeclarationLine(line, name) {
  return new RegExp(`\\bpub\\s+mod\\s+${name}\\s*;`).test(line);
}

function referenceCountsOutsideDefinitions(name) {
  const needle = new RegExp(`\\b${name}\\b`, 'g');
  const counts = {
    production: 0,
    twin: 0,
  };
  for (const [file, source] of sourceCache) {
    let match;
    while ((match = needle.exec(source)) !== null) {
      const ranges = definitionNameRanges.get(`${file}\0${name}`) ?? [];
      const isDefinitionName = ranges.some(([start, end]) => match.index >= start && match.index < end);
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.indexOf('\n', match.index);
      const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
      if (!isDefinitionName) {
        if (isModuleDeclarationLine(line, name)) {
          continue;
        }
        if (isTwinFile(file)) {
          counts.twin += 1;
        } else {
          counts.production += 1;
        }
      }
    }
  }
  return counts;
}

const graphUnreachableCandidates = defs
  .filter((def) => def.productionFile && def.public && !def.file.startsWith('native/crates/aimux/src/bin/'))
  .filter((def) => !productionReachable.has(def.id))
  .map((def) => {
    const references = referenceCountsOutsideDefinitions(def.name);
    return {
      file: def.file,
      line: def.line,
      name: def.name,
      productionReferences: references.production,
      twinReferences: references.twin,
      reachableFromTests: testReachable.has(def.id),
      triage: triage(def, testReachable),
    };
  })
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const candidates = graphUnreachableCandidates.filter((candidate) => candidate.productionReferences === 0);

const actionable = candidates;
const countsByTriage = {};
for (const candidate of actionable) {
  countsByTriage[candidate.triage] = (countsByTriage[candidate.triage] ?? 0) + 1;
}
const fixtureDispatcherAllowlist = loadFixtureDispatcherAllowlist();
const fixtureDispatcherFiles = new Map(
  publicLibModules()
    .filter((module) => isTwinFile(module.file))
    .map((module) => [module.file, module]),
);
for (const file of productionSourceFiles.map((file) => relative(repoRoot, file)).filter(isTwinFile)) {
  if (!fixtureDispatcherFiles.has(file)) {
    fixtureDispatcherFiles.set(file, {
      name: basename(file, '.rs'),
      file,
      line: 1,
    });
  }
}
const strandedFixtureDispatchers = [...fixtureDispatcherFiles.values()]
  .map((module) => {
    const publicFileDefinitions = defs.filter((def) => def.file === module.file && def.public);
    const moduleReferences = referenceCountsForModule(module.name, module.file);
    const dispatchers = publicFileDefinitions
      .filter((def) => testReachable.has(def.id))
      .map((def) => def.name)
      .sort();
    return {
      file: module.file,
      module: module.name,
      line: module.line,
      dispatchers,
      productionReferences: moduleReferences.production,
      twinReferences: moduleReferences.twin,
      testReferences: moduleReferences.test,
      reason: fixtureDispatcherAllowlist[module.file] ?? null,
      stranded: (
        publicFileDefinitions.length > 0 &&
        moduleReferences.production === 0
      ),
    };
  })
  .filter((entry) => entry.stranded)
  .map(({ stranded: _stranded, ...entry }) => entry)
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

function referenceCountsForModule(moduleName, moduleFile) {
  const needle = new RegExp(`\\b${moduleName}\\b`, 'g');
  const counts = {
    production: 0,
    twin: 0,
    test: 0,
  };
  for (const [file, source] of [...sourceCache, ...testSourceCache]) {
    if (file === moduleFile) {
      continue;
    }
    let match;
    while ((match = needle.exec(source)) !== null) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const lineEnd = source.indexOf('\n', match.index);
      const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
      if (isModuleDeclarationLine(line, moduleName)) {
        continue;
      }
      if (file.startsWith('native/crates/aimux/tests/')) {
        counts.test += 1;
      } else if (isTwinFile(file)) {
        counts.twin += 1;
      } else {
        counts.production += 1;
      }
    }
  }
  return counts;
}

const unreferencedExportedModules = publicLibModules()
  .map((module) => {
    const references = referenceCountsForModule(module.name, module.file);
    return {
      ...module,
      references: references.production + references.twin + references.test,
      productionReferences: references.production,
      twinReferences: references.twin,
      testReferences: references.test,
    };
  })
  .filter((module) => module.references === 0)
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

const corpusReferenceCache = rawSourceCache;

function contractCorpusFiles() {
  return walkFiles(
    contractCorpusRoot,
    (path) => /\.(?:json|jsonl|txt)$/.test(path),
  ).map((path) => relative(repoRoot, path));
}

function isCorpusPath(rel) {
  return rel.startsWith('testdata/contracts/v1/') && /\.(?:json|jsonl|txt)$/.test(rel);
}

function activeCorpusReferenceSources() {
  const activeSources = new Set(activeContractInventoryFiles);
  for (const file of sourceFiles) {
    activeSources.add(relative(repoRoot, file));
  }
  for (const root of ['app', 'bin', 'scripts', '.github']) {
    for (const file of walkFilesPruned(join(repoRoot, root), (path) => /\.(?:md|rs|ts|tsx|js|mjs|sh|py|yml|yaml)$/.test(path))) {
      activeSources.add(relative(repoRoot, file));
    }
  }
  for (const file of walkFiles(join(repoRoot, 'docs'), (path) => /\.(?:md|rs|ts|tsx|js|mjs|sh|py)$/.test(path))) {
    const rel = relative(repoRoot, file);
    if (historicalCorpusReferencePrefixes.some((prefix) => rel.startsWith(prefix))) {
      continue;
    }
    activeSources.add(rel);
  }
  return [...activeSources].filter((file) => existsSync(join(repoRoot, file))).sort();
}

function isContractInventoryFile(rel) {
  return rel === 'testdata/contracts/v1/README.md'
    || rel === 'testdata/contracts/v1/ENFORCEMENT_AUDIT.md'
    || /^testdata\/contracts\/v1\/PHASE8_.*\.md$/.test(rel);
}

function referencedCorpusPathsInLine(rel, line) {
  const paths = [];
  const fullPathPattern = /testdata\/contracts\/v1\/[A-Za-z0-9_.\/-]+\.(?:json|jsonl|txt)/g;
  let match;
  while ((match = fullPathPattern.exec(line)) !== null) {
    paths.push(match[0]);
  }
  if (isContractInventoryFile(rel)) {
    const backtickPathPattern = /`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+\.(?:json|jsonl|txt))`/g;
    while ((match = backtickPathPattern.exec(line)) !== null) {
      const candidate = match[1];
      if (!candidate.startsWith('testdata/contracts/v1/')) {
        paths.push(`testdata/contracts/v1/${candidate}`);
      }
    }
  }
  return paths.filter(isCorpusPath);
}

function staleReferencedCorpusPaths() {
  const stale = [];
  const seen = new Set();
  for (const rel of activeCorpusReferenceSources()) {
    const source = readFileSync(join(repoRoot, rel), 'utf8');
    const lines = source.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const corpusPath of referencedCorpusPathsInLine(rel, line)) {
        if (existsSync(join(repoRoot, corpusPath))) {
          continue;
        }
        const key = `${rel}\0${index + 1}\0${corpusPath}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        stale.push({
          source: rel,
          line: index + 1,
          corpus: corpusPath,
        });
      }
    }
  }
  return stale.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line || a.corpus.localeCompare(b.corpus));
}

function enforcementRows() {
  const report = join(contractCorpusRoot, 'ENFORCEMENT_AUDIT.md');
  if (!existsSync(report)) {
    return [];
  }
  const rows = [];
  const lines = readFileSync(report, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const cells = lines[index].trim().split('|').map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 5 || cells[0] === 'Suite' || /^---+$/.test(cells[0])) {
      continue;
    }
    const suite = cells[0].replace(/^`|`$/g, '');
    const corpus = cells[2].replace(/^`|`$/g, '');
    if (!suite || !corpus || !isCorpusPath(corpus)) {
      continue;
    }
    rows.push({
      source: relative(repoRoot, report),
      line: index + 1,
      suite,
      suitePath: `native/crates/aimux/tests/${suite}.rs`,
      corpus,
    });
  }
  return rows;
}

function rustSourceTree(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) {
    return '';
  }
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const parts = [source];
  const pathModPattern = /#\s*\[\s*path\s*=\s*"([^"]+)"\s*\]\s*mod\s+\w+\s*;/g;
  let match;
  while ((match = pathModPattern.exec(source))) {
    parts.push(rustSourceTree(join(dirname(file), match[1]), seen));
  }
  return parts.join('\n');
}

const staleEnforcementBindings = enforcementRows()
  .map((row) => {
    const suiteFile = join(repoRoot, row.suitePath);
    const missingSuite = !existsSync(suiteFile);
    const missingCorpus = !existsSync(join(repoRoot, row.corpus));
    const missingBinding = !missingSuite && !missingCorpus && !rustSourceTree(suiteFile).includes(row.corpus);
    return {
      ...row,
      missingSuite,
      missingCorpus,
      missingBinding,
    };
  })
  .filter((row) => row.missingSuite || row.missingCorpus || row.missingBinding)
  .sort((a, b) => a.suite.localeCompare(b.suite) || a.corpus.localeCompare(b.corpus));

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
const staleContractCorpusReferences = staleReferencedCorpusPaths();

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
      staleReferences: staleContractCorpusReferences,
      staleEnforcementBindings,
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
  console.log(`Stale referenced corpus paths: ${staleContractCorpusReferences.length}`);
  console.log(`Stale enforcement bindings: ${staleEnforcementBindings.length}`);
  console.log(`Historical reference prefixes skipped: ${historicalCorpusReferencePrefixes.join(', ')}`);
  if (unreferencedContractCorpusFiles.length > 0) {
    console.log('');
    console.log('| unreferenced corpus file |');
    console.log('| --- |');
    for (const file of unreferencedContractCorpusFiles) {
      console.log(`| ${file} |`);
    }
  }
  if (staleContractCorpusReferences.length > 0) {
    console.log('');
    console.log('| source | line | missing corpus path |');
    console.log('| --- | ---: | --- |');
    for (const entry of staleContractCorpusReferences) {
      console.log(`| ${entry.source} | ${entry.line} | ${entry.corpus} |`);
    }
  }
  if (staleEnforcementBindings.length > 0) {
    console.log('');
    console.log('| source | line | suite | corpus | missing |');
    console.log('| --- | ---: | --- | --- | --- |');
    for (const entry of staleEnforcementBindings) {
      const missing = [
        entry.missingSuite ? 'suite' : null,
        entry.missingCorpus ? 'corpus' : null,
        entry.missingBinding ? 'binding' : null,
      ].filter(Boolean).join(', ');
      console.log(`| ${entry.source} | ${entry.line} | \`${entry.suite}\` | ${entry.corpus} | ${missing} |`);
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
    || staleContractCorpusReferences.length > 0
    || staleEnforcementBindings.length > 0
  )
) {
  process.exitCode = 1;
}
