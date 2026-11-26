import { useLayoutEffect, useState } from "react";

/**
 * 对话视图密度，三档展开程度：
 * - 详细：平铺每一步工具/思考，各自一行，展开后看原始输入与结果；
 * - 简要（Cursor 风格）：平铺每一步，相邻编辑合并成带绿红底色的改动卡，思考显示耗时/token；
 * - 精简（默认）：连续活动只留一行汇总，任何情况下都不自动展开；运行中在
 *   指示器上实时显示本轮消耗的 token。
 */
export type Density = "detail" | "brief" | "compact";

/** 三档展开程度在界面上的显示文案（从左到右由展开到折叠）。 */
export const DENSITY_OPTIONS: readonly { value: Density; label: string; hint: string }[] = [
  { value: "detail", label: "详细", hint: "平铺每一步工具与思考" },
  { value: "brief", label: "简要", hint: "Cursor 风格：编辑显示改动卡，思考显示耗时" },
  { value: "compact", label: "精简", hint: "每段活动只保留一行汇总，运行中实时显示 token" },
];

/** localStorage 里记住用户选择；默认精简。 */
const DENSITY_KEY = "qubius:thread-density";

/** 只有明确的 detail/brief 才生效，其余（含缺失/损坏值）一律回到精简。 */
export function parseDensity(raw: string | null): Density {
  return raw === "detail" || raw === "brief" ? raw : "compact";
}

function readDensity(): Density {
  try {
    return parseDensity(window.localStorage.getItem(DENSITY_KEY));
  } catch {
    // Storage can be unavailable (private mode, disabled cookies); use the default.
    return "compact";
  }
}

/** 读写视图密度的持久化 state；写法与 App 的 useFontPercent 保持一致。 */
export function useDensity(): readonly [Density, (next: Density) => void] {
  const [density, setDensity] = useState<Density>(readDensity);
  useLayoutEffect(() => {
    try {
      window.localStorage.setItem(DENSITY_KEY, density);
    } catch {
      // Ignore storage failures; the choice still applies for this session.
    }
  }, [density]);
  return [density, setDensity] as const;
}
