// Carries the live Worker's plain-text variables into a deploy, so an update
// keeps settings made in the dashboard (FEED_MODE, the sync settings) without
// anyone editing wrangler.jsonc. Pure functions: no Node APIs, so the tests run
// them in the same runtime as the Worker tests.
//
// The live values come from two read-only wrangler commands:
//   wrangler deployments status --name <worker> --json   which version serves
//   wrangler versions view <id> --name <worker> --json   that version's bindings
// and go back in with `wrangler deploy --var NAME:VALUE`, which overrides the
// file's value for that name. Anything unexpected stops setup: it never falls
// back to deploying the file's defaults over a live Worker.

// Never carried silently: a forgotten override must not outlive every deploy.
export const MASS_REMOVAL_SHA = "ALLOW_MASS_REMOVAL_SHA";

/**
 * True when `wrangler deployments status` failed because nothing is live yet:
 * no Worker by that name (Cloudflare error 10007), or one with no deployment.
 * Any other failure is not a first install.
 * @param {string} output stderr and stdout of the failed command
 */
export function isNothingLive(output) {
  return /\[code: 10007\]/.test(output) || /has no deployments\./.test(output);
}

/**
 * The one version serving all traffic.
 * @param {unknown} status parsed `wrangler deployments status --json`
 * @returns {string}
 */
export function activeVersionId(status) {
  const versions = /** @type {any} */ (status)?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("Cloudflare's deployment status for the Worker is not in the expected form.");
  }
  if (versions.length > 1 || versions[0]?.percentage !== 100) {
    throw new Error("the live Worker is split between several versions (a gradual deployment), so there is no single set of settings to keep. Finish or roll back that deployment in the Cloudflare dashboard first.");
  }
  const id = versions[0].version_id;
  if (typeof id !== "string" || !/^[0-9a-f-]{8,64}$/.test(id)) {
    throw new Error("Cloudflare's deployment status has no usable version id.");
  }
  return id;
}

/**
 * The plain-text variables of a Worker version. Secrets and resource bindings
 * are ignored. A JSON-typed variable cannot be carried with --var, so it stops
 * setup rather than being dropped.
 * @param {unknown} version parsed `wrangler versions view --json`
 * @returns {Record<string, string>}
 */
export function liveVars(version) {
  const bindings = /** @type {any} */ (version)?.resources?.bindings;
  if (!Array.isArray(bindings)) {
    throw new Error("the live Worker's settings are not in the expected form.");
  }
  /** @type {Record<string, string>} */
  const vars = {};
  const unsupported = [];
  for (const b of bindings) {
    if (b?.type === "plain_text") {
      if (typeof b.name !== "string" || typeof b.text !== "string") {
        throw new Error("a live variable is not in the expected form.");
      }
      vars[b.name] = b.text;
    } else if (b?.type === "json") {
      unsupported.push(String(b.name));
    }
  }
  if (unsupported.length > 0) {
    throw new Error(`the live Worker has JSON-typed variables setup cannot carry over (${unsupported.join(", ")}). Change them to text variables in the Cloudflare dashboard, or remove them.`);
  }
  return vars;
}

/**
 * The `vars` block of wrangler.jsonc. Commented-out lines are not read.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function fileVars(text) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    throw new Error('wrangler.jsonc could not be read. Restore it with "git checkout wrangler.jsonc" and run setup again.');
  }
  const vars = parsed?.vars ?? {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(vars)) out[k] = String(v);
  return out;
}

/**
 * Removes // and block comments outside strings, then trailing commas.
 * @param {string} text
 */
function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) throw new Error("unterminated comment");
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * What the deploy will set: every live variable, the file's value for names
 * the live Worker lacks, and ALLOW_MASS_REMOVAL_SHA only when `keepSha` is
 * true. `lines` describes it for the deployer before the deploy.
 * @param {Record<string, string>} file
 * @param {Record<string, string>} live
 * @param {boolean} keepSha
 */
export function planVars(file, live, keepSha) {
  /** @type {Record<string, string>} */
  const carry = {};
  /** @type {string[]} */
  const lines = [];
  for (const name of Object.keys(live).sort()) {
    const value = /** @type {string} */ (live[name]);
    if (name === MASS_REMOVAL_SHA && !keepSha) {
      lines.push(`  drop   ${name} = ${shown(value)}`);
      continue;
    }
    carry[name] = value;
    const note = name in file && file[name] !== value ? `   (wrangler.jsonc says ${shown(/** @type {string} */ (file[name]))})` : "";
    lines.push(`  keep   ${name} = ${shown(value)}${note}`);
  }
  for (const name of Object.keys(file).sort()) {
    if (!(name in live)) lines.push(`  new    ${name} = ${shown(/** @type {string} */ (file[name]))}   (from wrangler.jsonc)`);
  }
  return { carry, lines };
}

/**
 * The wrangler deploy arguments for the carried variables. wrangler splits
 * each on its first ":" only, so a URL value survives.
 * @param {Record<string, string>} carry
 */
export function varArgs(carry) {
  return Object.entries(carry).flatMap(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`the live variable name "${shown(name)}" cannot be carried over. Rename or remove it in the Cloudflare dashboard.`);
    }
    return ["--var", `${name}:${value}`];
  });
}

/**
 * A value as shown on screen: quoted, control characters escaped, so a live
 * value cannot move the cursor or rewrite earlier lines.
 * @param {string} value
 */
function shown(value) {
  return JSON.stringify(value);
}
