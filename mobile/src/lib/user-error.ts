import { GatewayError } from "../gateway/api.ts";
import { LocalUploadError } from "./upload-error.ts";

/** Explicit business refusals may be shown; native SDK exception text may not. */
export class UserFacingError extends Error {}

export function userErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof UserFacingError || error instanceof GatewayError || error instanceof LocalUploadError) return error.message;
  console.warn(fallback, error);
  return fallback;
}
