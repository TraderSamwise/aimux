export const REDACTED_CONTRACT_VALUE = "<redacted>";

const CREDENTIAL_NAME_PATTERN =
  /(^|_)(API_?KEY|AUTH_?TOKEN|ACCESS_?TOKEN|REFRESH_?TOKEN|ID_?TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIAL|COOKIE|WEBHOOK|SIGNING_?KEY)($|_)/i;
const TOKENISH_VALUE_PATTERN = /^(?=.{32,}$)(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9._~+/=-]+$/;
const CLOUDFLARE_GLOBAL_KEY_PATTERN = /^[A-Za-z0-9_-]{37,64}$/;

export function isRedactedPlaceholder(value) {
  return typeof value === "string" && /^<redacted(?::[^>]+)?>$/i.test(value.trim());
}

export function isSafeFixturePlaceholder(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (isRedactedPlaceholder(trimmed)) return true;
  if (trimmed.length > 32) return false;
  return /(dummy|example|fake|fixture|placeholder|redacted|test|not[_-]?aimux|extra-secret|secret|token)/i.test(trimmed);
}

export function isCredentialName(name) {
  return CREDENTIAL_NAME_PATTERN.test(String(name));
}

export function isCredentialValue(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || isSafeFixturePlaceholder(trimmed)) return false;
  if (trimmed.includes("/") || /\s/.test(trimmed)) return false;
  if (/^[a-f0-9]{40,128}$/i.test(trimmed)) return false;
  return TOKENISH_VALUE_PATTERN.test(trimmed) || CLOUDFLARE_GLOBAL_KEY_PATTERN.test(trimmed);
}

export function shouldRedactEnvValue(name, value, allowlist = []) {
  const allowed = new Set(allowlist);
  return isCredentialName(name) || isCredentialValue(value) || !allowed.has(name);
}

export function redactCapturedEnv(env, options = {}) {
  const allowlist = options.allowlist ?? [];
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      shouldRedactEnvValue(name, String(value ?? ""), allowlist) ? REDACTED_CONTRACT_VALUE : String(value ?? ""),
    ]),
  );
}

export function redactTmuxDoctorContract(contract) {
  const copy = structuredClone(contract);
  for (const testCase of copy.cases ?? []) {
    for (const call of testCase.output?.calls ?? []) {
      if (
        call?.method === "isInsideTmux" &&
        Array.isArray(call.args) &&
        call.args[0] &&
        typeof call.args[0] === "object" &&
        !Array.isArray(call.args[0])
      ) {
        call.args[0] = redactCapturedEnv(call.args[0]);
      }
    }
  }
  return copy;
}
