import { connect } from "framer-api";
import type { JobField, JobItem } from "./fields";

// The slice of Framer's Server API the sync uses, in this repo's own types.
// The sync only ever talks to this interface; `connectFramer` below is the
// real client (the `framer-api` package), and the tests use an in-memory fake.

export interface JobsCollection {
  /** Sets the managed collection's fields. Idempotent. */
  setFields(fields: readonly JobField[]): Promise<void>;
  getItemIds(): Promise<string[]>;
  /** Adds or updates items, keyed by item id. */
  addItems(items: JobItem[]): Promise<void>;
  removeItems(ids: string[]): Promise<void>;
}

export interface FramerSession {
  /** The managed collection with this name, created if it does not exist. */
  managedCollection(name: string): Promise<JobsCollection>;
  /** Builds a new version of the site. CMS writes are not live until deployed. */
  publish(): Promise<{ deploymentId: string }>;
  deploy(deploymentId: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface FramerSettings {
  projectId: string;
  apiKey: string;
}

export type FramerConnector = (settings: FramerSettings) => Promise<FramerSession>;

/**
 * The connector the Worker uses: one Server API connection per sync. The key
 * travels in a request header, never in the URL. A same-named collection that
 * this key does not manage is refused rather than written to.
 */
export const connectFramer: FramerConnector = async ({ projectId, apiKey }) => {
  const framer = await connect(projectId, apiKey);
  return {
    managedCollection: async (name) => {
      const existing = (await framer.getManagedCollections()).find((c) => c.name === name);
      if (existing && existing.managedBy !== "thisPlugin") throw new Error("collection managed elsewhere");
      const collection = existing ?? (await framer.createManagedCollection(name));
      return {
        // Our field and item shapes are the API's input shapes.
        setFields: (fields) => collection.setFields([...fields]),
        getItemIds: () => collection.getItemIds(),
        addItems: (items) => collection.addItems(items),
        removeItems: (ids) => collection.removeItems(ids),
      };
    },
    publish: async () => ({ deploymentId: (await framer.publish()).deployment.id }),
    deploy: async (deploymentId) => {
      await framer.deploy(deploymentId);
    },
    disconnect: () => framer.disconnect(),
  };
};
