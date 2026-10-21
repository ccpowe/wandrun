import { useEffect, useState } from "react";
import { AppState } from "react-native";

/**
 * 分钟级的“现在”：相对时间（“2 分钟前”）靠它在没有新事件时也能更新。只在使用它的屏幕里放一个定时器，
 * 由屏幕传给各行；App 回到前台时立即刷新（后台期间定时器可能被挂起）。
 */
export function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(new Date());
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, []);
  return now;
}
