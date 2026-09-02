export const SIYUAN_OFFICIAL_S3_CODE = "siyuan_official_s3_unsupported";
export const SIYUAN_OFFICIAL_S3_MESSAGE =
  "v1 不解包官方加密快照，请用内核 API 或明文 data/ 前缀。";

export const SIYUAN_REPO_PASSWORD_REQUIRED_CODE = "siyuan_repo_password_required";
export const SIYUAN_REPO_PASSWORD_REQUIRED_MESSAGE =
  "官方 S3 快照需要数据仓库密码";

export const SIYUAN_REPO_PASSWORD_INCORRECT_CODE = "siyuan_repo_password_incorrect";
export const SIYUAN_REPO_PASSWORD_INCORRECT_MESSAGE = "数据仓库密码不正确";

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

export function isSiyuanRepoErrorCode(code: string | undefined | null): boolean {
  return (
    code === SIYUAN_OFFICIAL_S3_CODE ||
    code === SIYUAN_REPO_PASSWORD_REQUIRED_CODE ||
    code === SIYUAN_REPO_PASSWORD_INCORRECT_CODE
  );
}
