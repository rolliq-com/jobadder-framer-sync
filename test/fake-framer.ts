import type { JobField, JobItem } from "../src/fields";
import type { FramerConnector, FramerSettings, JobsCollection } from "../src/framer";

// An in-memory stand-in for Framer's Server API, behind the same interface the
// real client will implement. It keeps the draft collection and, separately,
// what is live: items only reach `live` through publish then deploy, as on
// the real site.

export type FakeStep =
  | "connect"
  | "managedCollection"
  | "setFields"
  | "getItemIds"
  | "addItems"
  | "removeItems"
  | "publish"
  | "deploy";

export class FakeFramer {
  fields: JobField[] = [];
  items = new Map<string, JobItem>();
  live = new Map<string, JobItem>();
  calls: FakeStep[] = [];
  settings: FramerSettings[] = [];
  collectionNames: string[] = [];
  disconnects = 0;
  deployments = 0;
  failAt?: FakeStep;

  private pending?: { id: string; items: Map<string, JobItem> };

  private step(name: FakeStep): void {
    this.calls.push(name);
    if (this.failAt === name) throw new Error(`fake ${name} failed: https://api.example.test/?key=${this.settings.at(-1)?.apiKey}`);
  }

  /** Seeds both draft and live, as if an earlier sync had run. */
  seed(items: JobItem[]): void {
    for (const item of items) {
      this.items.set(item.id, item);
      this.live.set(item.id, item);
    }
  }

  connect: FramerConnector = async (settings) => {
    this.settings.push(settings);
    this.step("connect");
    const collection: JobsCollection = {
      setFields: async (fields) => {
        this.step("setFields");
        this.fields = [...fields];
      },
      getItemIds: async () => {
        this.step("getItemIds");
        return [...this.items.keys()];
      },
      addItems: async (items) => {
        this.step("addItems");
        for (const item of items) this.items.set(item.id, structuredClone(item));
      },
      removeItems: async (ids) => {
        this.step("removeItems");
        for (const id of ids) this.items.delete(id);
      },
    };
    return {
      managedCollection: async (name) => {
        this.step("managedCollection");
        this.collectionNames.push(name);
        return collection;
      },
      publish: async () => {
        this.step("publish");
        this.pending = { id: `deployment-${this.deployments + 1}`, items: new Map(this.items) };
        return { deploymentId: this.pending.id };
      },
      deploy: async (id) => {
        this.step("deploy");
        if (this.pending?.id !== id) throw new Error("unknown deployment");
        this.live = this.pending.items;
        this.deployments++;
      },
      disconnect: async () => {
        this.disconnects++;
      },
    };
  };
}
