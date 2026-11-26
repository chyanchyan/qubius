import type { DeployForm } from "../deploy.js";
import { deriveDeployForm } from "../deploy.js";
import { normalizeDomain } from "./registry.js";
import { EdgeError, type EdgeDesired, type EdgeRole, type EdgeSite } from "./types.js";

/**
 * 把部署页表单映射成 edge 期望站点。
 *
 * 只映射 start=true 且 publicHost 非空的角色：
 *   primary   -> qubius
 *   secondary -> co-qubius
 *
 * 输出固定为 dev 认证 + SSE（与部署页 dev 入口一致）：
 *   { name, domains:[publicHost], env:"dev", upstream:"http://127.0.0.1:<port>",
 *     auth:"dev", sse:true }
 *
 * 停用角色不产生 desired，但注册表里的旧条目保留（由上层给出 warning，
 * 避免悄悄删除用户手工维护的站点）。域名非法时记 warning 并跳过该角色。
 */
export function desiredSites(form: DeployForm, _role: EdgeRole = "primary"): EdgeDesired {
  const sites: EdgeSite[] = [];
  const warnings: string[] = [];
  const disabledRoles: EdgeRole[] = [];
  const seenDomains = new Set<string>();

  const build = (
    role: EdgeRole,
    name: "qubius" | "co-qubius",
    enabled: boolean,
    host: string,
    port: number,
  ): void => {
    const label = role === "primary" ? "主实例" : "副实例";
    if (!enabled) {
      disabledRoles.push(role);
      warnings.push(`${label}未启用，未生成 ${name} 站点（注册表中的旧条目保留）。`);
      return;
    }
    if (!host.trim()) {
      warnings.push(`${label}已启用但公网域名为空，未生成 ${name} 站点。`);
      return;
    }
    let domain: string;
    try {
      domain = normalizeDomain(host, `${label}公网域名`);
    } catch (error) {
      if (error instanceof EdgeError) {
        warnings.push(error.message);
        return;
      }
      throw error;
    }
    if (seenDomains.has(domain)) {
      warnings.push(`${label}和另一个实例使用了相同的公网域名 ${domain}，已跳过 ${name} 站点。`);
      return;
    }
    seenDomains.add(domain);
    sites.push({
      name,
      domains: [domain],
      env: "dev",
      upstream: `http://127.0.0.1:${port}`,
      auth: "dev",
      sse: true,
    });
  };

  build("primary", "qubius", form.startPrimary, form.publicHost, form.primaryPort);
  build("secondary", "co-qubius", form.startSecondary, form.publicHostSecondary, form.secondaryPort);
  return { sites, warnings, disabledRoles };
}

/** 从部署 env 推导表单后再算 desired（D2 的 GET 预览用）。 */
export function desiredSitesFromEnv(
  role: EdgeRole = "primary",
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): EdgeDesired {
  const { form } = deriveDeployForm(env, role, repoRoot);
  return desiredSites(form, role);
}
