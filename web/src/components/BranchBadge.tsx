/**
 * 会话分支的小标签。工作区里的分支名是 `qubius/<完整 uuid>`，列表里只显示
 * 前缀和 uuid 前 8 位；完整名字放在 title 里，避免撑破一行。
 */
export function shortBranch(branch: string | undefined): string {
  if (!branch) return "";
  const match = /^(qubius|qoder|remote-coder)\/([0-9a-f]{8})[0-9a-f-]*$/i.exec(branch);
  if (match) return `${match[1]}/${match[2]}`;
  return branch;
}

/**
 * 分支标签。列表拿到合入状态后传入 merged / base / untouched，用底色表示
 * 分支的状态：已合入为绿底，未合入保持默认；分支创建后从未改过代码时为
 * 灰底（它只是停在基准分支上，并没有可归档的改动）。
 * 不传 merged / untouched（详情页、总览页、状态未加载）时样式不变。
 */
export function BranchBadge({
  branch,
  className,
  merged,
  base,
  untouched,
}: {
  branch?: string;
  className?: string;
  merged?: boolean;
  base?: string;
  untouched?: boolean;
}) {
  if (!branch) return null;
  const title = untouched
    ? `${branch} · 从未改过代码`
    : merged === undefined
      ? branch
      : `${branch} · ${merged ? "已合入" : "未合入"} ${base || "main"}`;
  const state = untouched
    ? "untouched"
    : merged === undefined
      ? undefined
      : merged ? "merged" : "unmerged";
  return (
    <span
      className={className ? `branch-badge mono ${className}` : "branch-badge mono"}
      data-state={state}
      title={title}
    >
      {shortBranch(branch)}
    </span>
  );
}
