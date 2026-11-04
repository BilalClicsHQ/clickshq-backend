// Husky git-hook guard.
//
// Blocks commits and pushes that contain the malicious-code signatures that were
// injected into our repos, and blocks direct pushes to main/master so that every
// change reaches main through a pull request.
//
//   node .husky/security-check.mjs staged   pre-commit: scan the staged files
//   node .husky/security-check.mjs push     pre-push: block main + scan the pushed files
//   node .husky/security-check.mjs all      manual audit of every tracked file
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROTECTED_BRANCHES = ["main", "master"];
const SELF = ".husky/security-check.mjs";

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });

const splitPaths = (out) => out.split(/[\0\n]/).filter(Boolean);

// File content at a revision (":path" is the staged version); null if it isn't a file.
function readBlob(spec) {
  try {
    return execFileSync("git", ["show", spec], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function readContent({ path, spec }) {
  if (spec) return readBlob(spec);
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function isText(buf) {
  const n = Math.min(buf.length, 1024);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c === 9 || c === 10 || c === 13 || c >= 32) printable++;
  }
  return printable / n > 0.9;
}

// Real fonts start with a binary signature; the injected "fonts" were JavaScript.
function isRealFont(buf) {
  if (buf.length < 4) return false;
  if (["wOFF", "wOF2", "OTTO", "true", "ttcf"].includes(buf.subarray(0, 4).toString("latin1"))) return true;
  if (buf[0] === 0 && buf[1] === 1 && buf[2] === 0 && buf[3] === 0) return true; // TrueType
  return buf.length > 36 && buf[34] === 0x4c && buf[35] === 0x50; // EOT ("LP")
}

// obfuscator.io output, which is what the injected payload looked like: an IIFE, heavy hex
// encoding and the self-defending `while (!![])` loop. Normal minified vendor code doesn't match.
function isObfuscated(s) {
  const hex = (s.match(/0x/g) || []).length;
  return /\(function\s*\(/.test(s) && hex > 25 && /while\s*\(\s*!!\s*\[\s*\]\s*\)/.test(s);
}

function findProblems(path, buf) {
  const name = path.split("/").pop();
  if (/\.(woff2?|ttf|otf|eot|orc)$/i.test(name)) {
    return !isRealFont(buf) && isText(buf) ? ["fake font file: contains code instead of font data"] : [];
  }
  if (!isText(buf)) return [];

  const s = buf.toString("utf8");
  const problems = [];
  if (isObfuscated(s)) problems.push("obfuscated code matching the injected malware");
  if (/eval\s*\(\s*atob\s*\(/.test(s)) problems.push("eval + atob: runs hidden base64-encoded code");
  if (/atob\s*\(\s*process\.env\.AUTH_API_KEY/.test(s) || /eval\s*\(\s*proxyInfo\s*\)/.test(s)) {
    problems.push("AUTH_API_KEY loader matching the injected malware");
  }
  if (/^\s*AUTH_API_KEY\s*=/m.test(s)) problems.push("AUTH_API_KEY variable (the malware uses it to fetch its payload)");
  if (/(^|\/)\.vscode\/tasks\.json$/.test(path) && /"runOn"\s*:\s*"folderOpen"/.test(s)) {
    problems.push("VS Code task that runs automatically when the folder is opened");
  }
  if (name === "package.json" && /node\s+(\.\/)?(init(?![\w.\/-])|api\.js\s*&&|dist\/setup\.js)/.test(s)) {
    problems.push("package.json script runs a hidden loader (node init / api.js / dist/setup.js)");
  }
  return problems;
}

const stagedFiles = () =>
  splitPaths(git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])).map((path) => ({ path, spec: `:${path}` }));

const trackedFiles = () => splitPaths(git(["ls-files", "-z"])).map((path) => ({ path, spec: null }));

// pre-push receives "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
function pushedFiles(blockedBranches) {
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    // no stdin
  }
  const files = new Map();
  for (const line of input.split("\n")) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!remoteRef) continue;
    const branch = remoteRef.replace(/^refs\/heads\//, "");
    if (PROTECTED_BRANCHES.includes(branch)) {
      blockedBranches.push(branch);
      continue;
    }
    if (/^0+$/.test(localSha)) continue; // deleting a remote branch
    try {
      // files touched by the commits the remote doesn't have yet
      const out = git(["log", "--format=", "--name-only", "--diff-filter=ACMR", "-z", localSha, "--not", "--remotes"]);
      for (const path of splitPaths(out)) files.set(path, `${localSha}:${path}`);
    } catch {
      // unknown revision - nothing to scan
    }
  }
  return [...files].map(([path, spec]) => ({ path, spec }));
}

const mode = (process.argv[2] || "staged").trim();
const blockedBranches = [];
const files = mode === "push" ? pushedFiles(blockedBranches) : mode === "all" ? trackedFiles() : stagedFiles();

const findings = [];
for (const file of files) {
  if (file.path === SELF) continue;
  const buf = readContent(file);
  if (!buf) continue;
  for (const problem of findProblems(file.path, buf)) findings.push(`  ${file.path}\n    -> ${problem}`);
}

if (blockedBranches.length) {
  console.error(`\n[security-check] Direct push to "${[...new Set(blockedBranches)].join(", ")}" is blocked.`);
  console.error("Push a feature branch and open a pull request instead:");
  console.error("  git checkout -b feature/<name>");
  console.error("  git push -u origin feature/<name>\n");
}
if (findings.length) {
  const what = { push: "Push blocked", all: "Audit failed" }[mode] || "Commit blocked";
  console.error(`\n[security-check] ${what}: possible malicious code found.\n`);
  console.error(findings.join("\n"));
  console.error("\nRemove these changes before continuing. If you think this is a false positive, check with your lead.\n");
} else if (mode === "all") {
  console.log(`[security-check] ${files.length} tracked files scanned - nothing suspicious found.`);
}
process.exitCode = blockedBranches.length || findings.length ? 1 : 0;
