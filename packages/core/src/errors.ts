export const SIYUAN_OFFICIAL_S3_CODE = "siyuan_official_s3_unsupported";
export const SIYUAN_OFFICIAL_S3_MESSAGE =
  "v1 不解包官方加密快照，请用内核 API 或明文 data/ 前缀。";

export class HubError extends Error {
  readonly code: string;
  readonly httpStatus?: number;

  constructor(code: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "HubError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isHubError(err: unknown): err is HubError {
  return err instanceof HubError;
}
