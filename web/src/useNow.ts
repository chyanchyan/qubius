import { useEffect, useState } from "react";

/** 定时更新的当前时间，用于相对时间和确认倒计时；页面隐藏时不更新。 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [intervalMs]);

  return now;
}
