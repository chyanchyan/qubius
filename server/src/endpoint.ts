export interface ClaudeConnection {
  baseUrl: string;
  model: string;
  subagentModel: string;
}

export function claudeConnection(baseUrl: string, model: string): ClaudeConnection {
  const endpoint = deepseekAnthropicBase(baseUrl);
  const deepseek = isDeepseek(endpoint);
  const bare = model.replace(/\[.*\]$/, "");
  return {
    baseUrl: endpoint,
    model: deepseek && !model.includes("[") ? `${model}[1m]` : model,
    subagentModel: deepseek ? bare : model,
  };
}

/**
 * 这些是 git/Node/运维脚本正常运行需要的基础变量，即使名字碰巧像密钥也保留。
 * 代理与 CA 变量也在这里，避免内网或自签证书环境被误伤。
 */
const BASE_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOSTNAME",
  "NODE_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  // Windows 上运行 git/Node 需要的基础变量。
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
]);

/** 明显的密钥类变量：*_KEY、*_TOKEN、*_SECRET、*PASSWORD*、AWS_* 等。 */
const SECRET_ENV_NAME =
  /(^|_)(API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)($|_)/i;

/**
 * 没有下划线分隔的常见凭据名：PGPASSWORD、MYSQL_PWD、npm 的 ..._authToken 等。
 * PWD/OLDPWD 在 BASE_ENV_NAMES 里，会在前面被豁免。
 */
const SECRET_ENV_SUFFIX =
  /(?:PASSWORD|PASSWD|PWD|APIKEY|ACCESSKEY|PRIVATEKEY|SECRETKEY|AUTHTOKEN|AUTH)$/i;
/** `_PASS` 作为独立后缀，避免误伤 COMPASS/BYPASS。 */
const SECRET_ENV_PASS = /(?:^|_)PASS$/i;

/** 带 user:pass@ 的 URL（DATABASE_URL 之类）本身就是凭据。 */
const CREDENTIAL_URL = /:\/\/[^/\s@]*:[^/\s@]+@/;

function isSecretEnv(name: string, value: string): boolean {
  const upper = name.toUpperCase();
  if (BASE_ENV_NAMES.has(upper)) return false;
  if (/^LC_/i.test(name)) return false;
  // 只剔除真正的 AWS 凭据；AWS_REGION/AWS_PROFILE 等配置保留。
  if (SECRET_ENV_NAME.test(name) || SECRET_ENV_SUFFIX.test(name) || SECRET_ENV_PASS.test(name)) {
    return true;
  }
  return CREDENTIAL_URL.test(value);
}

export function claudeEnv(
  base: NodeJS.ProcessEnv,
  apiKey: string,
  connection: ClaudeConnection,
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isSecretEnv(name, value)) continue;
    filtered[name] = value;
  }
  return {
    ...filtered,
    // 函数显式构造的 ANTHROPIC_* 放在最后，确保不被 base 里的同名变量覆盖。
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: connection.baseUrl,
    ANTHROPIC_MODEL: connection.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: connection.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: connection.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: connection.subagentModel,
    CLAUDE_CODE_SUBAGENT_MODEL: connection.subagentModel,
    // SDK 默认把 system/session_state_changed 标成 sdk_host_only 并从消费流里丢掉；
    // 打开这个开关后 CLI 会正常下发，服务端才能拿到权威的 idle/running。
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "qubius/0.1.0",
  };
}

function deepseekAnthropicBase(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  if (url.hostname !== "api.deepseek.com") return baseUrl.replace(/\/$/, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") url.pathname = "/anthropic";
  return url.toString().replace(/\/$/, "");
}

function isDeepseek(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}
