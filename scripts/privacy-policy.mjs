/** Shared release policy. Findings contain locations and rule names, never matching values. */
export function forbiddenPath(path) {
  return /(^|\/)\.env($|\.(?!example$))|(^|\/)\.npmrc$|\.(pem|key|crt|p12|pfx|db|sqlite|sqlite3|bundle)(?:-(?:wal|shm|journal))?$|(^|\/)[^/]+\.local\.md$|(^|\/)\.private-terms$|(^|\/)\.vscode\/mcp\.json$|(^|\/)(certs|backups|state|artifacts|\.ardent|\.magnus|\.hive-dev|\.ssh|audit-logs|terminal-audit)\//i.test(path);
}

const TOKEN_RULES = [
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36,}\b/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
];

// Exempt only an explicitly fake value, never unrelated words elsewhere on its line.
function placeholder(value) {
  return /^(?:change[-_]me[-_]|replace[-_]|playwright[-_]|dummy[-_]|your[-_]|mock[-_]|ci-only-|\$\{|<)/i.test(value)
    || /(?:^|[-_])(?:test|fixture|example|placeholder)(?:[-_]|$)/i.test(value);
}

export function secretFindings(content) {
  const findings = [];
  for (const [index, line] of content.split('\n').entries()) {
    for (const [rule, pattern] of TOKEN_RULES) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push({ line: index + 1, rule });
    }
    // Quoted and unquoted shell/JSON/YAML/TS literal credentials. Expressions are not literals.
    const assignments = /\b(?:DEPLOY_PASSWORD|SSH_PASSWORD|IAM_AGENT_SECRET|HIVE_ROUTER_SECRET|HIVEMEM_JWT_SECRET|API_SECRET|JWT_SECRET|SESSION_SECRET|NODE_MANAGER_SECRET|AWS_SECRET_ACCESS_KEY)["']?\s*[:=]\s*(?:["']([^"'\r\n]+)["']|([^\s#;,'"}]+))/g;
    for (const match of line.matchAll(assignments)) {
      const value = (match[1] ?? match[2]).split(/\\[nr]/, 1)[0];
      const minimum = /(?:DEPLOY_PASSWORD|SSH_PASSWORD)/.test(match[0]) ? 8 : 16;
      const expression = match[1] == null && (/^(?:[A-Za-z_$][\w$]*(?:\.|\(|\[)|\$|\.\*)/.test(value)
        || (match[0].includes(':') && /^[A-Za-z_$][\w$]*$/.test(value)));
      if (value.length >= minimum && !placeholder(value) && !expression) {
        findings.push({ line: index + 1, rule: 'literal credential' });
      }
    }
  }
  return findings;
}

export function privateInfrastructureFindings(content) {
  const findings = [];
  for (const [index, line] of content.split('\n').entries()) {
    if (/\b(?:[a-z0-9-]+\.)+ts\.net\b/i.test(line)) findings.push({ line: index + 1, rule: 'private network domain' });
    for (const match of line.matchAll(/\/(?:home|Users)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)/g)) {
      if (!['operator', 'deploy', 'user', 'x', 'foo', 'bar'].includes(match[1])) findings.push({ line: index + 1, rule: 'personal home path' });
    }
  }
  return findings;
}
