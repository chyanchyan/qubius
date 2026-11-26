import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DeployForm, DeployJob, DeployState } from "../api-deploy";
import {
  ROLE_NAME,
  browserHostSuggestion,
  initialScenario,
  isWindowsPlatform,
  otherRole,
  roleKeys,
  scenarioOptions,
  scenarioPatch,
  stepTitle,
  validateWizardStep,
  wizardCopy,
  wizardPlaceholders,
  wizardSteps,
  wizardSummaryGroups,
  type DeployPhase,
  type WizardMode,
  type WizardPlaceholders,
  type WizardRole,
  type WizardScenario,
} from "../deploy-wizard";
import { Notice } from "../ui";
import "./DeployWizard.css";

/* 分步部署向导：首次运行（还没有 config.yaml）时自动进入，已有配置时由部署页的
   「重新部署」入口打开。表单状态和提交逻辑仍由 DeployPage 持有，这里只负责按步骤
   展示和逐步校验。 */

interface DeployWizardProps {
  state: DeployState;
  /** setup：首次部署；redeploy：已有配置时从向导重新配置。 */
  mode: WizardMode;
  form: DeployForm;
  phase: DeployPhase;
  job: DeployJob | null;
  formError: string;
  /** DeployPage 生成的部署状态卡片；向导只决定放在哪一步展示。 */
  status: ReactNode;
  /** 部署后服务端口变了：旧地址打不开，不能提供站内跳转按钮。 */
  moved: boolean;
  onUpdate: (patch: Partial<DeployForm>) => void;
  onSubmit: (event: FormEvent) => void;
  onSwitchToAdvanced: () => void;
  /** 重新部署成功后回到向导第一步，方便继续调整配置。 */
  onRestart: () => void;
}

function platformName(platform: string): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  return platform;
}

function Field({
  label,
  value,
  placeholder,
  hint,
  mono,
  disabled,
  className,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={className ? `field ${className}` : "field"}>
      {label}
      <input
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        className={mono ? "mono" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <span className="wizard-hint">{hint}</span>}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? 0 : Number(event.target.value))}
      />
    </label>
  );
}

/** 全局可选参数：放在实例步骤里，确认部署前就能配置好。 */
function OptionalSettings({
  form,
  placeholders,
  disabled,
  onUpdate,
}: {
  form: DeployForm;
  placeholders: WizardPlaceholders;
  disabled: boolean;
  onUpdate: (patch: Partial<DeployForm>) => void;
}) {
  return (
    <section className="wizard-optional" aria-labelledby="wizard-optional-title">
      <h3 id="wizard-optional-title">访问与运行</h3>
      <p className="wizard-hint">
        不填也能正常部署；这里控制对外访问、访问令牌和运行上限，部署后仍可在完整表单里修改。
      </p>
      <div className="wizard-fields">
        <Field
          className="wizard-span-2"
          label="额外允许的访问域名（逗号分隔，可选）"
          value={form.allowedHostsExtra}
          placeholder="例如 qa.example.com, [2001:db8::1]"
          mono
          disabled={disabled}
          hint="公网域名会自动加入 allowedHosts；这里补充其它域名或 IP。局域网经 lan-proxy 转发不需要填。"
          onChange={(value) => onUpdate({ allowedHostsExtra: value })}
        />
        <label className="field">
          访问令牌
          <select
            value={form.authMode}
            disabled={disabled}
            onChange={(event) => onUpdate({ authMode: event.target.value as DeployForm["authMode"] })}
          >
            <option value="off">关闭</option>
            <option value="auto">自动生成（推荐）</option>
            <option value="custom">自定义</option>
          </select>
        </label>
        {form.authMode === "custom" && (
          <label className="field">
            自定义访问令牌
            <input
              type="password"
              value={form.authToken}
              placeholder={form.authTokenSet ? "已设置，留空保持不变" : "16 到 512 个字符"}
              autoComplete="off"
              disabled={disabled}
              onChange={(event) => onUpdate({ authToken: event.target.value })}
            />
          </label>
        )}
        <NumberField
          label="并发上限"
          value={form.maxConcurrent}
          min={1}
          max={256}
          disabled={disabled}
          onChange={(value) => onUpdate({ maxConcurrent: value })}
        />
        <NumberField
          label="确认超时（分钟，0 不自动拒绝）"
          value={form.approvalTimeoutMinutes}
          min={0}
          max={1440}
          disabled={disabled}
          onChange={(value) => onUpdate({ approvalTimeoutMinutes: value })}
        />
        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.terminal}
            disabled={disabled}
            onChange={(event) => onUpdate({ terminal: event.target.checked })}
          />
          启用浏览器命令行页
        </label>
        <label className="field field-check">
          <input
            type="checkbox"
            checked={form.lanEnabled}
            disabled={disabled}
            onChange={(event) => onUpdate({ lanEnabled: event.target.checked })}
          />
          启用局域网入口（Basic 认证）
        </label>
        {form.lanEnabled && (
          <>
            <Field
              label="局域网用户名"
              value={form.lanAuthUser}
              placeholder="qubius"
              disabled={disabled}
              onChange={(value) => onUpdate({ lanAuthUser: value })}
            />
            <label className="field">
              局域网登录密码
              <input
                type="password"
                value={form.lanAuthPassword}
                placeholder={form.lanAuthPasswordSet ? "已设置，留空保持不变" : "留空自动生成"}
                autoComplete="off"
                disabled={disabled}
                onChange={(event) => onUpdate({ lanAuthPassword: event.target.value })}
              />
            </label>
          </>
        )}
        <p className="wizard-hint wizard-span-2">
          启用后凭据写入配置目录的 lan-proxy.credentials；部署成功后会一次性显示访问地址、用户名、密码和 API 访问令牌。
        </p>
        <Field
          label="归档目录（留空不归档）"
          value={form.archiveDir}
          placeholder={`绝对路径，例如 ${placeholders.archive}`}
          mono
          disabled={disabled}
          hint="列表里超过保留天数的旧对话会先归档到这里，再从列表移除；归档不会自动清理。"
          onChange={(value) => onUpdate({ archiveDir: value })}
        />
        <NumberField
          label="列表保留天数（到期归档到冷存储）"
          value={form.archiveRetentionDays}
          min={1}
          max={3650}
          disabled={disabled}
          onChange={(value) => onUpdate({ archiveRetentionDays: value })}
        />
        <Field
          className="wizard-span-2"
          label="qubius 仓库地址"
          value={form.primaryRepoUrl}
          placeholder="http://git.example.com/owner/qubius.git"
          mono
          disabled={disabled}
          hint="用于标记 qubius 自己的仓库和自动克隆；单实例本机使用不影响运行。"
          onChange={(value) => onUpdate({ primaryRepoUrl: value })}
        />
      </div>
      <p className="wizard-hint">额外项目可以在部署完成后到主页的「管理项目」里添加，不需要在这里填写。</p>
    </section>
  );
}

function RoleFields({
  form,
  role,
  requireHost,
  disabled,
  windows,
  placeholders,
  onUpdate,
  children,
}: {
  form: DeployForm;
  role: WizardRole;
  requireHost: boolean;
  disabled: boolean;
  windows: boolean;
  placeholders: WizardPlaceholders;
  onUpdate: (patch: Partial<DeployForm>) => void;
  children?: ReactNode;
}) {
  const keys = roleKeys(role);
  const name = ROLE_NAME[role];
  return (
    <div className="wizard-fields">
      <Field
        className="wizard-span-2"
        label={`${name} Checkout 路径`}
        value={form[keys.dir]}
        placeholder={placeholders.checkout}
        mono
        disabled={disabled}
        hint={windows
          ? "必须是包含 deploy/deploy-job.mjs 和 package.json 的 qubius checkout；首次部署已填入当前运行目录。"
          : "必须是包含 deploy/install.sh 等脚本的 qubius checkout；首次部署已填入当前运行目录。"}
        onChange={(value) => onUpdate({ [keys.dir]: value })}
      />
      <Field
        label={`${name}数据目录`}
        value={form[keys.data]}
        placeholder={placeholders.data}
        mono
        disabled={disabled}
        hint="会话、worktree 和 API key 都保存在这里。"
        onChange={(value) => onUpdate({ [keys.data]: value })}
      />
      <NumberField
        label={`${name}端口`}
        value={form[keys.port]}
        min={1}
        max={65535}
        disabled={disabled}
        onChange={(value) => onUpdate({ [keys.port]: value })}
      />
      {requireHost && (
        <Field
          className="wizard-span-2"
          label="访问域名"
          value={form[keys.host]}
          placeholder="例如 code.example.com"
          mono
          disabled={disabled}
          hint="会写进 allowedHosts。只在本机通过 SSH 隧道访问时填 localhost。"
          onChange={(value) => onUpdate({ [keys.host]: value })}
        />
      )}
      {children}
    </div>
  );
}

export function DeployWizard({
  state,
  mode,
  form,
  phase,
  job,
  formError,
  status,
  moved,
  onUpdate,
  onSubmit,
  onSwitchToAdvanced,
  onRestart,
}: DeployWizardProps) {
  const role = state.role;
  const copy = wizardCopy(mode);
  const windows = isWindowsPlatform(state.platform);
  const scenarios = scenarioOptions(state.platform);
  const placeholders = wizardPlaceholders(state.platform, role);
  const peerPlaceholders = wizardPlaceholders(state.platform, otherRole(role));
  /* 通过域名打开页面时把当前主机名作为访问域名候选；IP 不预填。 */
  const suggestedHost = browserHostSuggestion(window.location.hostname);
  const [scenario, setScenario] = useState<WizardScenario>(() => initialScenario(form, role));
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const jumpedToReview = useRef(false);
  /** 刚进入确认步骤的一小段时间内忽略提交，避免「下一步」双击误触部署。 */
  const reviewReadyAt = useRef(0);

  const steps = wizardSteps(scenario);
  const index = Math.min(stepIndex, steps.length - 1);
  const step = steps[index] ?? "scenario";
  const busy = phase === "submitting" || phase === "running" || phase === "restarting";
  const terminal = phase === "relocated";

  /* 刷新了正在运行的部署：直接展示进度。历史失败/成功任务不跳步，
     让用户从第一步重新确认配置。 */
  useEffect(() => {
    if (jumpedToReview.current) return;
    if (busy || job?.state === "running") {
      jumpedToReview.current = true;
      setStepIndex(wizardSteps(scenario).length - 1);
    }
  }, [job, busy, scenario]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [index]);

  useEffect(() => {
    if (phase === "success") headingRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (step === "review") reviewReadyAt.current = Date.now() + 400;
  }, [step]);

  function goNext() {
    const failure = validateWizardStep(step, form, role, scenario);
    if (failure) {
      setError(failure);
      return;
    }
    setError("");
    if (step === "scenario") onUpdate(scenarioPatch(form, role, scenario, suggestedHost));
    setStepIndex(Math.min(index + 1, steps.length - 1));
  }

  function goBack() {
    setError("");
    setStepIndex(Math.max(index - 1, 0));
  }

  /** 改任何字段都清掉上一步留下的校验提示。 */
  function change(patch: Partial<DeployForm>) {
    setError("");
    onUpdate(patch);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (step !== "review") {
      goNext();
      return;
    }
    // 从「下一步」进入确认步骤时的双击、回车可能直接落到提交按钮上。
    if (Date.now() < reviewReadyAt.current) return;
    // 隐藏步骤里的字段也可能被改坏（例如退回上一步改到一半）：提交前全部再查一遍。
    const order = wizardSteps(scenario);
    for (const candidate of order) {
      const failure = validateWizardStep(candidate, form, role, scenario);
      if (failure) {
        setError(failure);
        setStepIndex(order.indexOf(candidate));
        return;
      }
    }
    setError("");
    onSubmit(event);
  }

  if (phase === "success") {
    return (
      <section className="page deploy-wizard">
        <h1 tabIndex={-1} ref={headingRef}>部署完成</h1>
        <p className="lead">{copy.successLead}</p>
        {status}
        {moved ? (
          <p className="note">服务已在新端口启动，请用上面的新地址打开页面。</p>
        ) : (
          <div className="wizard-actions">
            <button type="button" className="btn btn-primary" onClick={() => window.location.assign("/")}>
              进入 qubius
            </button>
            {mode === "setup" ? (
              <button type="button" className="btn" onClick={() => window.location.assign("/settings")}>
                填写模型 API Key
              </button>
            ) : (
              <button type="button" className="btn" onClick={onRestart}>
                重新配置
              </button>
            )}
          </div>
        )}
        <p className="muted">
          {mode === "setup"
            ? "第一次使用还需要在设置页填写接口地址、API Key 和模型名，然后就能开始对话。"
            : "新的配置已经生效；之后需要调整时可以回到部署页点「重新部署」，再从向导走一遍。"}
        </p>
        {windows && (
          <p className="note">
            Windows 部署不会安装开机自启；需要时用「任务计划程序」登记
            <span className="mono"> node server\dist\index.js</span>。
          </p>
        )}
      </section>
    );
  }

  return (
    <form className="page deploy-wizard" onSubmit={submit} noValidate aria-busy={busy}>
      <header className="wizard-head">
        <h1 tabIndex={-1} ref={headingRef}>{copy.title}</h1>
        <p className="lead">{copy.intro}</p>
      </header>

      <ol className="wizard-progress" aria-label="部署步骤">
        {steps.map((id, item) => (
          <li
            key={id}
            data-state={item === index ? "current" : item < index ? "done" : "todo"}
            aria-current={item === index ? "step" : undefined}
          >
            <span className="wizard-progress-index" aria-hidden="true">{item + 1}</span>
            <span className="wizard-progress-title">{stepTitle(id, scenario, role)}</span>
          </li>
        ))}
      </ol>

      <section className="wizard-step" aria-labelledby="wizard-step-title">
        <h2 id="wizard-step-title">{stepTitle(step, scenario, role)}</h2>
        {error && (
          <Notice tone="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        )}
        {phase === "failed" && step !== "review" && (
          <Notice tone="warn">
            上次部署没有成功。按步骤确认配置后，到最后一步可以重新提交；详细日志在确认页。
          </Notice>
        )}

        {step === "scenario" && (
          <>
            <dl className="wizard-env">
              <div>
                <dt>运行平台</dt>
                <dd>{platformName(state.platform)}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd className="mono">{state.nodeVersion || "—"}</dd>
              </div>
              <div className="wizard-env-wide">
                <dt>当前 checkout</dt>
                <dd className="mono">{state.repoDir}</dd>
              </div>
            </dl>
            {windows && (
              <Notice tone="info">
                Windows 部署会生成配置、按需 npm ci / build 并重启本机 Node 服务，不需要 bash 或 systemd，
                但需要 Node.js 22+ 和 git 在 PATH 中。开机自启请用「任务计划程序」；
                公网入口和副实例同步/回滚不在 Windows 部署范围内。
              </Notice>
            )}
            {state.platform === "darwin" && (
              <Notice tone="info">
                macOS 部署会生成配置、按需 npm ci / build 并重启本机 Node 服务，不需要 bash、flock 或 systemd，
                但需要 Node.js 22+ 和 git 在 PATH 中。开机自启请用 launchd；
                公网入口和副实例同步/回滚不在 macOS 部署范围内。
              </Notice>
            )}
            <div className="wizard-choices" role="radiogroup" aria-label="使用方式">
              {scenarios.map((item) => (
                <label
                  key={item.id}
                  className="wizard-choice"
                  data-selected={scenario === item.id}
                >
                  <input
                    type="radio"
                    name="wizard-scenario"
                    value={item.id}
                    checked={scenario === item.id}
                    onChange={() => {
                      setScenario(item.id);
                      setError("");
                    }}
                  />
                  <span className="wizard-choice-text">
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        {step === "instance" && (
          <>
            <p className="wizard-hint">
              {scenario === "dual"
                ? `先确认当前${ROLE_NAME[role]}。另一个实例的目录和端口在下一步填写。`
                : "下面这些值已经按当前环境填好，通常直接下一步即可。"}
            </p>
            <RoleFields
              form={form}
              role={role}
              requireHost={scenario !== "local"}
              disabled={busy || terminal}
              windows={windows}
              placeholders={placeholders}
              onUpdate={change}
            />
            <div className="wizard-readonly">
              <span className="wizard-readonly-label">配置目录</span>
              <span className="mono wizard-readonly-value">{form.configDir || "—"}</span>
              <p className="wizard-hint">
                由启动服务时的 QUBIUS_CONFIG_DIR 决定，运行中不能修改。
                需要换目录时先停止服务，再用 <span className="mono">npm run quickstart</span> 重新启动；
                启动命令里可以选择配置目录。
              </p>
            </div>
            <OptionalSettings
              form={form}
              placeholders={placeholders}
              disabled={busy || terminal}
              onUpdate={change}
            />
          </>
        )}

        {step === "peer" && (
          <>
            <p className="wizard-hint">
              另一个实例使用同一份代码但独立的 checkout 和数据目录；端口和访问域名不能和当前实例相同。
              {windows && " Windows 上两个实例可以同时运行，但没有副实例的同步/回滚按钮。"}
            </p>
            <RoleFields
              form={form}
              role={otherRole(role)}
              requireHost
              disabled={busy || terminal}
              windows={windows}
              placeholders={peerPlaceholders}
              onUpdate={change}
            >
              <label className="field field-check wizard-span-2">
                <input
                  type="checkbox"
                  checked={form.clonePeer}
                  disabled={busy || terminal}
                  onChange={(event) => change({ clonePeer: event.target.checked })}
                />
                缺少这个 checkout 时自动克隆
              </label>
              {form.clonePeer && (
                <Field
                  className="wizard-span-2"
                  label="qubius 仓库地址"
                  value={form.primaryRepoUrl}
                  placeholder="http://git.example.com/owner/qubius.git"
                  mono
                  disabled={busy || terminal}
                  hint="两个实例共用这个仓库；向导会尽量从当前 checkout 的 origin 自动填写。"
                  onChange={(value) => change({ primaryRepoUrl: value })}
                />
              )}
            </RoleFields>
          </>
        )}

        {step === "review" && (
          <>
            <p className="wizard-hint">
              确认无误后点「保存并部署」。需要修改归档或仓库地址，请回到上一步的「可选设置」。
              部署期间服务会重启，页面可能短暂断开。
            </p>
            {status}
            <div className="wizard-summary">
              {wizardSummaryGroups(form, role, scenario).map((group) => (
                <article className="wizard-summary-card" key={group.title}>
                  <h3>{group.title}</h3>
                  <dl>
                    {group.rows.map((row) => (
                      <div key={row.label}>
                        <dt>{row.label}</dt>
                        <dd className={row.mono ? "mono" : undefined}>{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              ))}
            </div>

            <Notice tone="info">
              agent 会以运行服务的系统用户身份读写文件、执行命令。第一次使用建议先保持默认的项目权限，
              不要在这台机器上放无关的 SSH key 或云凭据；处理不可信仓库时改用专用系统用户或容器。
            </Notice>

            {formError && <Notice tone="error">{formError}</Notice>}
          </>
        )}
      </section>

      <div className="wizard-nav">
        <button
          type="button"
          className="btn"
          onClick={goBack}
          disabled={index === 0 || busy || terminal}
        >
          上一步
        </button>
        <div className="wizard-nav-main">
          {step === "review" ? (
            <button type="submit" className="btn btn-primary" disabled={busy || terminal}>
              {phase === "submitting"
                ? "正在提交…"
                : busy
                  ? "部署进行中…"
                  : terminal
                    ? "部署已提交"
                    : "保存并部署"}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={goNext} disabled={busy || terminal}>
              下一步
            </button>
          )}
        </div>
        <button
          type="button"
          className="text-btn wizard-switch"
          onClick={onSwitchToAdvanced}
          disabled={busy || terminal}
        >
          {copy.switchLabel}
        </button>
      </div>
    </form>
  );
}
