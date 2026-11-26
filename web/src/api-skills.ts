import { request } from "./api";

export type SkillDomainKind = "user" | "project" | "plugin";

export interface SkillDomain {
  id: string;
  kind: SkillDomainKind;
  label: string;
  projectId?: string;
  /** SKILL.md 所在目录。 */
  path: string;
  /** 能否在本页新建/编辑；插件技能只读。 */
  writable: boolean;
  /** 目录是否已经存在；可写域即使不存在也能新建。 */
  available: boolean;
}

export interface SkillSummary {
  /** `<域 id>/<技能目录名>`，列表和请求都用它定位。 */
  id: string;
  domain: string;
  dir: string;
  name: string;
  description: string;
  /** SDK 过滤列表里的名字；插件技能是 `plugin:skill`。 */
  sdkName: string;
  path: string;
  enabled: boolean;
  writable: boolean;
  plugin?: string;
  bytes: number;
  updatedAt?: string;
}

export interface SkillList {
  domains: SkillDomain[];
  skills: SkillSummary[];
}

export interface SkillDetail {
  skill: SkillSummary;
  content: string;
}

function skillUrl(domain: string, dir: string): string {
  // 域 id 里可能有 `:`（project:xxx），必须编码成单个路径段。
  return `/api/skills/${encodeURIComponent(domain)}/${encodeURIComponent(dir)}`;
}

export function getSkills(signal?: AbortSignal): Promise<SkillList> {
  return request("/api/skills", undefined, signal);
}

export function getSkill(domain: string, dir: string, signal?: AbortSignal): Promise<SkillDetail> {
  return request(skillUrl(domain, dir), undefined, signal);
}

export function saveSkill(
  domain: string,
  dir: string,
  content: string,
  signal?: AbortSignal,
): Promise<{ skill: SkillSummary }> {
  return request(skillUrl(domain, dir), {
    method: "PUT",
    body: JSON.stringify({ content }),
  }, signal);
}

export function createSkill(
  domain: string,
  name: string,
  content: string,
  signal?: AbortSignal,
): Promise<{ skill: SkillSummary }> {
  return request("/api/skills", {
    method: "POST",
    body: JSON.stringify({ domain, name, content }),
  }, signal);
}

export function setSkillEnabled(
  domain: string,
  dir: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<{ skill: SkillSummary }> {
  return request(skillUrl(domain, dir), {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  }, signal);
}
