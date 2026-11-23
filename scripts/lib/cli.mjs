// Terminal and wrangler plumbing shared by setup and capture.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const MIN_NODE_MAJOR = 22;

export const say = (/** @type {string} */ line = "") => process.stdout.write(line + "\n");
export const step = (/** @type {string} */ title) => say(`\n== ${title}`);

/** @param {string} message */
export function fail(message) {
  process.stderr.write(`\nStopped: ${message}\n`);
  process.exit(1);
}

export function checkNodeAndInstall() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    fail(`this needs Node.js ${MIN_NODE_MAJOR} or later, and this computer has ${process.versions.node}. Install the LTS version from https://nodejs.org and run the command again.`);
  }
  if (!existsSync(WRANGLER)) fail('the tools are not installed yet. Run "npm ci" in this folder first.');
}

/**
 * Runs wrangler without a shell (the same on Windows, macOS and Linux).
 * "inherit" shows its output and lets it prompt; otherwise output is captured.
 * @param {string[]} args
 * @param {{ input?: string, inherit?: boolean, accountId?: string }} [opts]
 */
export function wrangler(args, opts = {}) {
  const env = { ...process.env, WRANGLER_HIDE_BANNER: "true" };
  if (opts.accountId) env.CLOUDFLARE_ACCOUNT_ID = opts.accountId;
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env,
    input: opts.input,
    stdio: opts.inherit ? "inherit" : [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Parses the JSON wrangler prints, ignoring any notice lines around it.
 * @param {string} stdout
 */
export function parseJson(stdout) {
  const start = stdout.search(/[[{]/);
  if (start === -1) throw new Error("wrangler printed no JSON");
  return JSON.parse(stdout.slice(start));
}

/**
 * @param {string} question
 * @param {{ hidden?: boolean }} [opts]
 * @returns {Promise<string>}
 */
export function ask(question, opts = {}) {
  if (!process.stdin.isTTY) fail(`setup needs an answer to "${question.trim()}" but is not running in an interactive terminal.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (opts.hidden) {
    // Echo nothing while the answer is typed.
    const out = /** @type {any} */ (rl);
    out._writeToOutput = (/** @type {string} */ s) => {
      if (s.startsWith(question)) process.stdout.write(question);
    };
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (opts.hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

/**
 * @param {string} question
 * @param {boolean} [dflt]
 */
export async function confirm(question, dflt = true) {
  const answer = (await ask(`${question} ${dflt ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return answer === "" ? dflt : answer.startsWith("y");
}

/**
 * Reads "--name=value" and "--flag" arguments.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | true>} */
  const args = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unknown argument "${arg}".`);
    else args[/** @type {string} */ (m[1])] = m[2] ?? true;
  }
  return args;
}
