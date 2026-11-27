import type { BranchLamp } from "../branch-state";

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

/** 各状态对应的提示文案；合入状态带上基准分支名。 */
function badgeTitle(branch: string, state: BranchLamp | undefined, base?: string): string {
  switch (state) {
    case "starting":
      return `${branch} · 首轮答复中，还没有改动`;
    case "dirty":
      return `${branch} · 有未提交的改动`;
    case "untouched":
      return `${branch} · 从未改过代码`;
    case "merged":
      return `${branch} · 已合入 ${base || "main"}`;
    case "unmerged":
      return `${branch} · 未合入 ${base || "main"}`;
    default:
      return branch;
  }
}

/**
 * 分支标签。底色由调用方传入的 state 决定：灰=首轮答复中且没有改动，
 * 橙=有未提交改动，黄=有提交但没合入，绿=已合入，蓝=做过答复且没有改动。
 * 不传 state（详情页、总览页、状态未加载）时样式不变。
 */
export function BranchBadge({
  branch,
  className,
  state,
  base,
}: {
  branch?: string;
  className?: string;
  state?: BranchLamp;
  base?: string;
}) {
  if (!branch) return null;
  return (
    <span
      className={className ? `branch-badge mono ${className}` : "branch-badge mono"}
      data-state={state}
      title={badgeTitle(branch, state, base)}
    >
      {shortBranch(branch)}
    </span>
  );
}
