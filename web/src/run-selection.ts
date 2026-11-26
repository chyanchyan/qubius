import type { Effort, Provider, Session } from "./api";

/** 多模型并行对比里的一次模型选择。 */
export interface RunSelection {
  providerId: string;
  model: string;
  effort: Effort;
}

/**
 * BoardPage 和 MultiModelRun 之间的稳定契约。
 *
 * `createOne` 由 BoardPage 提供：用当前输入区的 prompt/附件创建一个普通会话
 * （各自独立 worktree），成功后把会话加进列表并返回；失败时抛错。
 * 组件负责选择多个模型、逐个调用、汇总结果；全体成功后才调用 `onDone`
 * 清空草稿。
 */
export interface MultiModelRunProps {
  projectId: string;
  providers: Provider[];
  defaults: RunSelection;
  disabled: boolean;
  createOne: (selection: RunSelection) => Promise<Session>;
  onError: (message: string) => void;
  onDone: () => void;
  /** 打开某个会话详情（对比面板里的“打开”）。 */
  onOpen: (sessionId: string) => void;
}
