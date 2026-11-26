/**
 * 部署页在 Linux 和 Windows 上都会打开。
 * POSIX 绝对路径以 / 开头；Windows 为盘符（C:\ 或 C:/）或 UNC（\\server\share）。
 */
export function pathIsAbsolute(value: string): boolean {
  const text = value.trim();
  if (text.startsWith("/") || text.startsWith("\\\\")) return true;
  return /^[A-Za-z]:[\\/]/.test(text);
}
