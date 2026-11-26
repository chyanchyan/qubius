import { useEffect, useRef, useState } from "react";
import { getPushStatus, sendTestPush, type PushStatus } from "../api";
import {
  currentSubscription,
  disablePush,
  enablePush,
  getPermission,
  pushSupported,
} from "../push-client";
import { Notice } from "../ui";

/* 浏览器 fetch 失败时往往只给出英文 TypeError（Chrome: Failed to fetch，
   Safari: Load failed），统一换成中文后再展示。 */
const NETWORK_ERROR_PATTERN = /failed to fetch|load failed|networkerror|network error|fetch failed|internet connection appears to be offline/i;

function readableError(reason: unknown, fallback: string): string {
  if (!(reason instanceof Error)) return fallback;
  const message = reason.message.trim();
  if (!message) return fallback;
  if (NETWORK_ERROR_PATTERN.test(message)) return "网络连接失败，请检查网络后重试。";
  return message;
}

/** 推送通知区块：开关本机订阅、查看服务端订阅数、发送测试通知。
    部署页和设置页共用，文案和布局保持一致。 */
export function PushSettings() {
  const [supported] = useState(() => pushSupported());
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() => getPermission());
  const [push, setPush] = useState<PushStatus | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState<"enable" | "disable" | "test" | null>(null);
  const [pushMessage, setPushMessage] = useState("");
  const [pushError, setPushError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* 并行读取服务端推送状态和本机订阅；卸载后不再 setState。 */
  useEffect(() => {
    (async () => {
      const [status, subscription] = await Promise.allSettled([getPushStatus(), currentSubscription()]);
      if (!mounted.current) return;
      if (status.status === "fulfilled") {
        setPush(status.value);
      } else {
        setPushError(readableError(status.reason, "读取推送状态失败"));
      }
      if (subscription.status === "fulfilled") {
        setSubscribed(subscription.value !== null);
      } else {
        setPushError((current) => current || readableError(subscription.reason, "读取推送订阅失败"));
      }
      setPermission(getPermission());
    })();
  }, []);

  async function refreshPushState() {
    const [status, subscription] = await Promise.all([getPushStatus(), currentSubscription()]);
    if (!mounted.current) return;
    setPush(status);
    setSubscribed(subscription !== null);
    setPermission(getPermission());
  }

  async function onEnablePush() {
    if (pushBusy !== null) return;
    setPushBusy("enable");
    setPushMessage("");
    setPushError("");
    try {
      // 正常情况下 push 在挂载时已读到，这里直接调用才能保住用户手势，
      // 让 Notification.requestPermission() 仍处于点击事件里。
      const publicKey = push?.publicKey ?? (await getPushStatus()).publicKey;
      if (!mounted.current) return;
      await enablePush(publicKey);
      if (!mounted.current) return;
      // 订阅已经成功创建并上报；后续刷新失败不能改写成“开启失败”。
      setSubscribed(true);
      setPermission(getPermission());
      setPushMessage("已开启推送通知。");
      try {
        await refreshPushState();
      } catch (reason) {
        if (mounted.current) {
          setPushError(readableError(reason, "已开启推送通知，但刷新状态失败；请刷新页面确认。"));
        }
      }
    } catch (reason) {
      if (!mounted.current) return;
      setPushError(readableError(reason, "开启推送通知失败"));
      setPermission(getPermission());
    } finally {
      if (mounted.current) setPushBusy(null);
    }
  }

  async function onDisablePush() {
    if (pushBusy !== null) return;
    setPushBusy("disable");
    setPushMessage("");
    setPushError("");
    try {
      await disablePush();
      if (!mounted.current) return;
      // 同理：取消订阅已经完成，刷新状态失败只提示刷新，不报“关闭失败”。
      setSubscribed(false);
      setPushMessage("已关闭推送通知。");
      try {
        await refreshPushState();
      } catch (reason) {
        if (mounted.current) {
          setPushError(readableError(reason, "已关闭推送通知，但刷新状态失败；请刷新页面确认。"));
        }
      }
    } catch (reason) {
      if (mounted.current) setPushError(readableError(reason, "关闭推送通知失败"));
    } finally {
      if (mounted.current) setPushBusy(null);
    }
  }

  async function onSendTestPush() {
    if (pushBusy !== null) return;
    setPushBusy("test");
    setPushMessage("");
    setPushError("");
    try {
      const result = await sendTestPush();
      if (!mounted.current) return;
      if (result.sent === 0 && result.failed === 0) {
        setPushMessage("服务器还没有订阅，请先在本设备开启通知。");
      } else {
        setPushMessage(`测试通知已发送：成功 ${result.sent} 条，失败 ${result.failed} 条。`);
      }
      // 发送可能清理掉 404/410 的订阅；刷新计数失败不影响发送结果。
      await refreshPushState().catch(() => undefined);
    } catch (reason) {
      if (mounted.current) setPushError(readableError(reason, "发送测试通知失败"));
    } finally {
      if (mounted.current) setPushBusy(null);
    }
  }

  let pushStatusText = "未开启。";
  if (!supported) {
    pushStatusText = "当前浏览器不支持推送通知。";
  } else if (permission === "denied") {
    pushStatusText = "通知权限被拒绝，需要在浏览器或系统设置里允许本站通知。";
  } else if (subscribed) {
    pushStatusText = `已开启${push ? `，服务器已有 ${push.count} 个订阅` : ""}。`;
  } else if (permission === "granted") {
    pushStatusText = "浏览器已授权，但本设备尚未订阅。";
  }

  return (
    <section className="deploy-section" aria-labelledby="push-settings-title">
      <h2 id="push-settings-title">推送通知</h2>
      <p className="muted">
        对话完成、失败或等待你确认时会推送通知。iPhone / iPad 需要先点「分享 → 添加到主屏幕」，再从主屏幕图标打开；iOS 16.4 及以上才支持网页推送。
      </p>
      <Notice tone="info">状态：{pushStatusText}</Notice>
      <div className="actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!supported || !push || subscribed || pushBusy !== null}
          onClick={onEnablePush}
        >
          {pushBusy === "enable" ? "开启中…" : "开启通知"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!supported || !subscribed || pushBusy !== null}
          onClick={onDisablePush}
        >
          {pushBusy === "disable" ? "关闭中…" : "关闭通知"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!supported || !push || pushBusy !== null}
          onClick={onSendTestPush}
        >
          {pushBusy === "test" ? "发送中…" : "发送测试通知"}
        </button>
      </div>
      {pushMessage && (
        <Notice tone="success" onDismiss={() => setPushMessage("")}>{pushMessage}</Notice>
      )}
      {pushError && (
        <Notice tone="error" onDismiss={() => setPushError("")}>{pushError}</Notice>
      )}
    </section>
  );
}
