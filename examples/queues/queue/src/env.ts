declare global {
  namespace Cloudflare {
    interface Env {
      TOPOLOGY: KVNamespace;
      STORAGE: R2Bucket;
      PULL: R2Bucket;
      PRODUCER_TOKEN: string;
      CONSUMER_TOKEN: string;
    }
  }
}

export {};
