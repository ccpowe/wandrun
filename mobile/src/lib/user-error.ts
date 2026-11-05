import { GatewayError } from "../gateway/api.ts";
import { LocalUploadError } from "./upload-error.ts";

/** Explicit business refusals may be shown; native SDK exception text may not. */
export class UserFacingError extends Error {}

// Only gateway-classified turn failures are displayable; raw strings fall back without echoing diagnostics.
const TURN_FAILURE_REASONS: Record<string, string> = {
  "任务执行失败，请重试；若持续失败，请查看网关日志。": "原因未知",
  "上下文长度超过模型限制，请缩短输入或拆分任务后重试。": "对话内容超出模型限制",
  "请求超时，请稍后重试。": "模型响应超时",
  "网络连接失败，请检查网络后重试。": "模型连接失败",
  "模型服务认证或访问权限不足，请检查登录状态和凭据后重试。": "模型未登录或无访问权限",
  "模型服务额度或速率已达限制，请检查额度或稍后重试。": "模型额度或请求频率已达限制",
  "模型服务暂不可用，请稍后重试。": "模型服务暂不可用",
  "模型响应中断，请检查网络后重试。": "模型响应中断",
  "模型尚未登录，请先在电脑上登录模型。": "模型未登录",
  "模型登录已失效，请先在电脑上重新登录模型。": "模型登录已失效",
  "模型登录状态未确认，请先在电脑上停止网关并重新登录模型。": "模型登录状态未确认",
  "模型登录暂不可用，请在电脑上检查登录状态。": "模型登录暂不可用",
};

export function userErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string") return Object.hasOwn(TURN_FAILURE_REASONS, error) ? TURN_FAILURE_REASONS[error] : fallback;
  if (error instanceof UserFacingError || error instanceof GatewayError || error instanceof LocalUploadError) return error.message;
  console.warn(fallback, error);
  return fallback;
}
