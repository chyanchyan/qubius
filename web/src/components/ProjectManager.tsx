import { useEffect, useState, type FormEvent } from "react";
import {
  addProject,
  createRepo,
  deleteProject,
  getProjects,
  PERMISSION_LABEL,
  type Project,
} from "../api";
import { Notice, Skeleton, useDialogs } from "../ui";

const LOAD_ERROR_FALLBACK = "请检查网络或服务器状态";

function errorText(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * 项目列表的管理面板（主页「管理项目」弹窗里）：管理跟踪的仓库条目，支持增删，
 * 也可以在机器上新建 git 仓库并直接加入列表。
 * 只增删运行期项目文件里的条目；config.yaml 项目和内置项目只展示，不能在这里删。
 */
export function ProjectManager({ onChange }: { onChange?: () => void }) {
  const dialogs = useDialogs();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [form, setForm] = useState<null | "add" | "create">(null);
  const [draft, setDraft] = useState({ id: "", name: "", path: "" });
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [createDraft, setCreateDraft] = useState({ name: "", parent: "" });
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getProjects(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setProjects(data.projects);
        setLoadError("");
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorText(reason, LOAD_ERROR_FALLBACK));
      });
    return () => controller.abort();
  }, [reloadToken]);

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    if (addBusy) return;
    setAddBusy(true);
    setAddError("");
    setError("");
    try {
      const { project } = await addProject({
        id: draft.id.trim(),
        name: draft.name.trim(),
        path: draft.path.trim(),
      });
      setProjects((current) => (current ? [...current, project] : [project]));
      setNotice(`已添加「${project.name}」；无需重启，刷新页面后仍保留。`);
      setDraft({ id: "", name: "", path: "" });
      setForm(null);
      onChange?.();
    } catch (reason) {
      setAddError(errorText(reason, "添加失败，请检查服务器日志"));
    } finally {
      setAddBusy(false);
    }
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    if (createBusy) return;
    setCreateBusy(true);
    setCreateError("");
    setError("");
    try {
      const { project } = await createRepo({
        name: createDraft.name.trim(),
        parent: createDraft.parent.trim(),
      });
      setProjects((current) => (current ? [...current, project] : [project]));
      setNotice(`已创建仓库「${project.name}」：${project.path}`);
      setCreateDraft({ name: "", parent: "" });
      setForm(null);
      onChange?.();
    } catch (reason) {
      setCreateError(errorText(reason, "创建失败，请检查服务器日志"));
    } finally {
      setCreateBusy(false);
    }
  }

  async function onRemove(project: Project) {
    if (!project.removable || removingId !== null) return;
    const confirmed = await dialogs.confirm({
      title: "移除项目",
      message: `从跟踪列表移除「${project.name}」？不会删除磁盘上的仓库或已有对话记录。`,
      confirmLabel: "移除",
      danger: true,
    });
    if (!confirmed) return;
    setRemovingId(project.id);
    setError("");
    try {
      await deleteProject(project.id);
      setProjects((current) => (current ? current.filter((item) => item.id !== project.id) : current));
      setNotice(`已移除「${project.name}」。`);
      onChange?.();
    } catch (reason) {
      setError(errorText(reason, "移除失败，请检查服务器日志"));
    } finally {
      setRemovingId(null);
    }
  }

  // 内置「普通对话」放最前面，和项目列表页保持一致的顺序。
  const ordered = projects
    ? [...projects].sort((a, b) => Number(b.builtin) - Number(a.builtin))
    : null;
  const addDisabled = addBusy || !draft.id.trim() || !draft.name.trim() || !draft.path.trim();
  const createDisabled = createBusy || !createDraft.name.trim() || !createDraft.parent.trim();

  return (
    <div className="project-manage">
      <p className="project-manage-lead">
        config.yaml 里定义的项目和内置项目需要改配置后重启。
      </p>
      {notice && <Notice tone="success" onDismiss={() => setNotice("")}>{notice}</Notice>}
      {error && <Notice tone="error" onDismiss={() => setError("")}>{error}</Notice>}
      <div className="project-manage-add">
        {form === "add" ? (
          <form className="project-manage-add-form" onSubmit={(event) => void onAdd(event)}>
            <div className="project-manage-add-grid">
              <label className="field">
                id
                <input
                  value={draft.id}
                  placeholder="例如 qubius"
                  autoComplete="off"
                  onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))}
                />
              </label>
              <label className="field">
                名称
                <input
                  value={draft.name}
                  placeholder="显示名称"
                  autoComplete="off"
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="field project-manage-add-path">
                路径
                <input
                  value={draft.path}
                  placeholder="/home/you/repo"
                  autoComplete="off"
                  onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
                />
              </label>
            </div>
            <p className="project-manage-add-hint">
              路径必须在运行服务的开发机上，且已经是 git 仓库。添加后立即出现在项目列表里，重启后仍保留。
            </p>
            {addError && <p className="error" role="alert">{addError}</p>}
            <div className="project-manage-add-actions">
              <button className="btn btn-primary" type="submit" disabled={addDisabled}>
                {addBusy ? "添加中…" : "添加"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={addBusy}
                onClick={() => {
                  setForm(null);
                  setAddError("");
                }}
              >
                取消
              </button>
            </div>
          </form>
        ) : form === "create" ? (
          <form className="project-manage-add-form" onSubmit={(event) => void onCreate(event)}>
            <div className="project-manage-add-grid project-manage-create-grid">
              <label className="field">
                仓库名称
                <input
                  value={createDraft.name}
                  placeholder="例如 demo"
                  autoComplete="off"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </label>
              <label className="field">
                目录路径（母目录）
                <input
                  value={createDraft.parent}
                  placeholder="/home/you/projects（不要带仓库名）"
                  autoComplete="off"
                  onChange={(event) => setCreateDraft((current) => ({ ...current, parent: event.target.value }))}
                />
              </label>
            </div>
            <p className="project-manage-add-hint">
              会在
              {" "}
              <span className="mono">
                {createDraft.parent.trim() || "<目录路径>"}/{createDraft.name.trim() || "<仓库名称>"}
              </span>
              {" "}
              创建目录并初始化 git 仓库（一个空初始提交），然后加入项目列表。母目录必须已存在，目标目录不能已存在。
            </p>
            {createError && <p className="error" role="alert">{createError}</p>}
            <div className="project-manage-add-actions">
              <button className="btn btn-primary" type="submit" disabled={createDisabled}>
                {createBusy ? "创建中…" : "创建"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={createBusy}
                onClick={() => {
                  setForm(null);
                  setCreateError("");
                }}
              >
                取消
              </button>
            </div>
          </form>
        ) : (
          <div className="project-manage-add-actions">
            <button
              className="btn"
              type="button"
              onClick={() => {
                setForm("add");
                setNotice("");
              }}
            >
              添加已有仓库
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setForm("create");
                setNotice("");
              }}
            >
              新建仓库
            </button>
          </div>
        )}
      </div>
      {loadError ? (
        <div className="project-manage-error">
          <Notice tone="error" onDismiss={() => setLoadError("")}>
            无法加载项目列表：{loadError}
          </Notice>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setLoadError("");
              setReloadToken((value) => value + 1);
            }}
          >
            重试
          </button>
        </div>
      ) : ordered ? (
        ordered.length === 0 ? (
          <p className="muted">还没有项目。</p>
        ) : (
          <ul className="project-manage-list">
            {ordered.map((project) => {
              const source = project.builtin
                ? "内置"
                : project.removable
                  ? "运行期添加"
                  : "config.yaml";
              const removeHint = project.builtin
                ? "内置项目不能删除"
                : project.removable
                  ? "从跟踪列表移除"
                  : "来自 config.yaml，请修改配置文件后重启";
              return (
                <li key={project.id} className="project-manage-item" data-available={project.available}>
                  <div className="project-manage-main">
                    <div className="project-manage-title">
                      <strong>{project.name}</strong>
                      <span className="mono muted">{project.id}</span>
                      {!project.available && <span className="project-manage-badge">不可用</span>}
                    </div>
                    <span className="project-manage-path mono" title={project.path}>{project.path}</span>
                    <span className="project-manage-meta">
                      {PERMISSION_LABEL[project.permission]} · {source}{project.isolated ? " · 独立目录" : ""}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-btn danger"
                    disabled={!project.removable || removingId !== null}
                    title={removeHint}
                    onClick={() => void onRemove(project)}
                  >
                    {removingId === project.id ? "移除中…" : "移除"}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div className="project-manage-loading" role="status" aria-live="polite">
          <Skeleton lines={3} />
          <span className="visually-hidden">正在加载项目列表…</span>
        </div>
      )}
    </div>
  );
}
