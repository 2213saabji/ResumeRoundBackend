import { config } from '../config.js';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';

/** Private object storage for resumes and (opt-in) interview audio. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Short-lived URL for direct download; never expose permanent public links. */
  signedUrl(key: string, expiresInSec?: number): Promise<string>;
}

let instance: ObjectStorage | undefined;

export function getStorage(): ObjectStorage {
  instance ??=
    config.STORAGE_DRIVER === 's3'
      ? new S3Storage({
          bucket: config.S3_BUCKET!,
          region: config.S3_REGION,
          endpoint: config.S3_ENDPOINT,
          forcePathStyle: config.S3_FORCE_PATH_STYLE,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        })
      : new LocalStorage(config.LOCAL_STORAGE_DIR);
  return instance;
}

/** Test hook: swap the storage implementation. */
export function setStorage(storage: ObjectStorage): void {
  instance = storage;
}
