import type { S3Client } from "@aws-sdk/client-s3";
import type { Adapter, SourceKind } from "@note-hub/core";
import { ObsidianAdapter } from "./obsidian.ts";
import { SiYuanAdapter, type ObjectStore } from "./siyuan.ts";
import { NotionAdapter } from "./notion.ts";
import { FeishuAdapter } from "./feishu.ts";

export type AdapterOptions = {
  store?: ObjectStore;
  fetch?: typeof fetch;
  s3?: S3Client;
};

export function createAdapter(source: SourceKind | string, opts: AdapterOptions = {}): Adapter {
  switch (source) {
    case "obsidian":
      return new ObsidianAdapter(opts.s3);
    case "siyuan":
      return new SiYuanAdapter(opts);
    case "notion":
      return new NotionAdapter(opts.fetch);
    case "feishu":
      return new FeishuAdapter(opts.fetch);
    default:
      throw new Error(`unsupported source: ${source}`);
  }
}
