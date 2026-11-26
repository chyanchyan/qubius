import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createSkill,
  getSkill,
  getSkills,
  saveSkill,
  setSkillEnabled,
  type SkillDomain,
  type SkillList,
  type SkillSummary,
} from "../api-skills";
import { formatRelativeTime } from "../format";
import { InlineLoading, Notice } from "../ui";
import "./SkillsPage.css";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function errorText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return fallback;
}

function domainTitle(domain: SkillDomain): string {
  if (domain.kind === "user") return "用户级技能";
  if (domain.kind === "plugin") return "插件技能";
  return `项目 · ${domain.label}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 新建技能时生成的骨架；description 用 JSON 字符串写法，避免 YAML 特殊字符。 */
function skillTemplate(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n`;
}

function SkillItem({
  skill,
  onChanged,
}: {
  skill: SkillSummary;
  onChanged: (skill: SkillSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const loaded = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    setLoading(true);
    getSkill(skill.domain, skill.dir)
      .then((detail) => {
        if (!mounted.current) return;
        setContent(detail.content);
        setDraft(detail.content);
      })
      .catch((reason: unknown) => {
        // 允许重新展开时再试一次。
        loaded.current = false;
        if (mounted.current) setError(errorText(reason, "读取技能内容失败"));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, [open, skill.domain, skill.dir]);

  async function toggle(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await setSkillEnabled(skill.domain, skill.dir, !skill.enabled);
      if (mounted.current) onChanged(result.skill);
    } catch (reason) {
      if (mounted.current) setError(errorText(reason, skill.enabled ? "停用技能失败" : "启用技能失败"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (saving || content === null || draft === content) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await saveSkill(skill.domain, skill.dir, draft);
      if (!mounted.current) return;
      setContent(draft);
      setNotice("已保存，下一轮或新对话生效。");
      onChanged(result.skill);
    } catch (reason) {
      if (mounted.current) setError(errorText(reason, "保存技能失败"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const dirty = content !== null && draft !== content;
  return (
    <li>
      <details
        className="skill-item"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="skill-summary">
          <span className="skill-name">{skill.name}</span>
          {skill.plugin && <span className="skill-chip">{skill.plugin}</span>}
          {!skill.writable && <span className="skill-chip">只读</span>}
          <span className="skill-description">{skill.description || "没有描述"}</span>
          <span className="skill-state" data-on={skill.enabled}>
            {skill.enabled ? "已启用" : "已停用"}
          </span>
        </summary>
        <div className="skill-body">
          <p className="skill-meta mono">
            {skill.path}
            <span className="skill-meta-size">
              {formatBytes(skill.bytes)}
              {skill.updatedAt ? ` · 更新于 ${formatRelativeTime(skill.updatedAt)}` : ""}
            </span>
          </p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void toggle()}>
              {busy ? "处理中…" : skill.enabled ? "停用" : "启用"}
            </button>
            <span className="muted">
              停用后 agent 看不到这个技能，但文件仍保留在磁盘上。
            </span>
          </div>
          {loading && <InlineLoading label="正在读取 SKILL.md" />}
          {error && (
            <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>
          )}
          {notice && (
            <Notice tone="success" onDismiss={() => setNotice("")}>{notice}</Notice>
          )}
          {content !== null && (
            <>
              <label className="field skill-editor-field">
                SKILL.md
                <textarea
                  className="skill-editor mono"
                  spellCheck={false}
                  readOnly={!skill.writable}
                  rows={18}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setNotice("");
                  }}
                />
              </label>
              {skill.writable ? (
                <div className="actions skill-editor-actions">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saving || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={saving || !dirty}
                    onClick={() => {
                      if (content !== null) setDraft(content);
                      setNotice("");
                    }}
                  >
                    撤销修改
                  </button>
                  <span className="muted skill-editor-count">{draft.length} 字符</span>
                </div>
              ) : (
                <p className="muted">插件技能由插件自己管理，不能在这里编辑；可以切换启用状态。</p>
              )}
            </>
          )}
        </div>
      </details>
    </li>
  );
}

function NewSkillForm({
  domain,
  onCreated,
  onCancel,
}: {
  domain: SkillDomain;
  onCreated: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const cleanName = name.trim();
    const cleanDescription = description.trim();
    if (!SKILL_NAME_RE.test(cleanName)) {
      setError("技能名只能包含字母、数字、点、下划线和连字符，且不超过 64 个字符。");
      return;
    }
    if (!cleanDescription) {
      setError("请填写描述。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createSkill(domain.id, cleanName, skillTemplate(cleanName, cleanDescription));
      if (mounted.current) onCreated(cleanName);
    } catch (reason) {
      if (mounted.current) setError(errorText(reason, "新建技能失败"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <form className="skill-new" onSubmit={(event) => void submit(event)}>
      <p className="muted">在 {domain.path} 下新建 &lt;技能名&gt;/SKILL.md。</p>
      <div className="skill-new-fields">
        <label className="field">
          技能名
          <input
            value={name}
            autoFocus
            placeholder="例如 my-skill"
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
          />
        </label>
        <label className="field">
          描述
          <input
            value={description}
            placeholder="一句话说明什么时候使用这个技能"
            onChange={(event) => {
              setDescription(event.target.value);
              setError("");
            }}
          />
        </label>
      </div>
      <div className="actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "创建中…" : "创建"}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>取消</button>
      </div>
      {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
    </form>
  );
}

export function SkillsPage() {
  const [data, setData] = useState<SkillList | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [creatingDomain, setCreatingDomain] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await getSkills();
      if (!mounted.current) return;
      setData(next);
      setError("");
    } catch (reason) {
      if (mounted.current) setError(errorText(reason, "读取技能列表失败"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function applySkill(next: SkillSummary): void {
    setData((current) => {
      if (!current) return current;
      return {
        ...current,
        skills: current.skills.map((item) => (item.id === next.id ? next : item)),
      };
    });
  }

  if (!data) {
    return (
      <section className="page skills-page">
        <h1 tabIndex={-1}>技能</h1>
        <p className="lead">按来源查看和管理磁盘上的 Claude Code 技能。</p>
        {error ? (
          <Notice tone="error" action={{ label: "重试", onClick: () => void refresh() }}>
            {error}
          </Notice>
        ) : (
          <InlineLoading label="正在加载技能" />
        )}
      </section>
    );
  }

  const disabled = data.skills.filter((skill) => !skill.enabled).length;
  return (
    <section className="page skills-page">
      <h1 tabIndex={-1}>技能</h1>
      <p className="lead">
        按来源域查看和管理 Claude Code 技能。停用只会把技能从 agent 的技能列表里去掉，不会删除文件；
        保存或切换后，改动对下一轮或新对话生效。这里只显示磁盘上的技能。
      </p>
      {error && (
        <Notice tone="error" action={{ label: "重试", onClick: () => void refresh() }} onDismiss={() => setError("")}>
          {error}
        </Notice>
      )}
      {message && <Notice tone="success" onDismiss={() => setMessage("")}>{message}</Notice>}
      <p className="skills-summary">
        共 {data.skills.length} 个技能
        {disabled > 0 ? `，已停用 ${disabled} 个` : "，全部启用"}
      </p>
      {data.domains.map((domain) => {
        const skills = data.skills.filter((skill) => skill.domain === domain.id);
        return (
          <section className="skill-domain" key={domain.id}>
            <header className="skill-domain-head">
              <div className="skill-domain-title">
                <h2>{domainTitle(domain)}</h2>
                <p className="mono skill-domain-path">
                  {domain.path}
                  {!domain.available ? "（目录还不存在）" : ""}
                </p>
              </div>
              <span className="skill-domain-count">{skills.length} 个</span>
              {domain.writable && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setCreatingDomain((current) => current === domain.id ? null : domain.id)}
                >
                  {creatingDomain === domain.id ? "取消新建" : "新建技能"}
                </button>
              )}
            </header>
            {creatingDomain === domain.id && (
              <NewSkillForm
                domain={domain}
                onCancel={() => setCreatingDomain(null)}
                onCreated={(name) => {
                  setCreatingDomain(null);
                  setMessage(`已创建技能 ${name}。`);
                  void refresh();
                }}
              />
            )}
            {skills.length === 0 ? (
              <p className="muted">这个来源域还没有技能。</p>
            ) : (
              <ul className="skill-list">
                {skills.map((skill) => (
                  <SkillItem key={skill.id} skill={skill} onChanged={applySkill} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </section>
  );
}
