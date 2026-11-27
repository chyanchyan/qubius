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

/** 传给 SDK 子进程的代理变量；命中白名单时统一改写成配置的代理地址。 */
const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/**
 * 这些是 git/Node/运维脚本正常运行需要的基础变量，即使名字碰巧像密钥也保留。
 * CA 变量也在这里，避免内网或自签证书环境被误伤；代理变量由 claudeEnv 按
 * 域名白名单单独处理，不直接继承。
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
  "NO_PROXY",
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
  proxyUrl?: string,
): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isSecretEnv(name, value)) continue;
    filtered[name] = value;
  }
  // 代理路由只由设置页的域名白名单决定：先清掉继承来的代理变量，避免服务级
  // API 设置 / 环境变量把未列入白名单的接口也送进代理；命中白名单时再显式注入。
  // 本机回环（Gemini 适配层等）始终直连，避免代理客户端把本地请求也拦走。
  for (const name of PROXY_ENV_NAMES) delete filtered[name];
  delete filtered.NODE_USE_ENV_PROXY;
  if (proxyUrl) {
    for (const name of PROXY_ENV_NAMES) filtered[name] = proxyUrl;
    // Node 的 fetch 默认不读代理环境变量；打开这个开关后才会走 HTTPS_PROXY。
    filtered.NODE_USE_ENV_PROXY = "1";
    const noProxy = withLoopbackBypass(filtered.NO_PROXY ?? filtered.no_proxy);
    filtered.NO_PROXY = noProxy;
    filtered.no_proxy = noProxy;
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

/** 把回环地址合并进 NO_PROXY，保留用户原有的绕过项。 */
function withLoopbackBypass(value: string | undefined): string {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    if (!entries.includes(host)) entries.push(host);
  }
  return entries.join(",");
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
