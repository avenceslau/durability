declare global {
  namespace Cloudflare {
    interface Env {
      TOPOLOGY: KVNamespace;
      STORAGE: R2Bucket;
      ADMIN_TOKEN: string;
      PRODUCER_TOKEN: string;
    }
  }
}

export {};
