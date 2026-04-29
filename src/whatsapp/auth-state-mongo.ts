import { Collection } from "mongodb";
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import createLogger from "../utils/logger";

const log = createLogger("AuthState");

/**
 * MongoDB-backed auth state for Baileys.
 * Stores creds + signal keys as JSON documents.
 */
export async function useMongoDBAuthState(
  collection: Collection
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const esmImport = new Function("s", "return import(s)") as (
    s: string
  ) => Promise<typeof import("@whiskeysockets/baileys")>;
  const { BufferJSON, initAuthCreds } = await esmImport("@whiskeysockets/baileys");

  const readData = async (id: string): Promise<any | null> => {
    try {
      const doc = await collection.findOne({ _id: id } as any);
      if (!doc) return null;
      return JSON.parse((doc as any).data, BufferJSON.reviver);
    } catch (err: any) {
      log.warn(`Failed to read auth data for key "${id}"`, { error: err.message });
      return null;
    }
  };

  const writeData = async (id: string, data: any): Promise<void> => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await collection.updateOne(
      { _id: id } as any,
      { $set: { data: serialized } },
      { upsert: true }
    );
  };

  const removeData = async (id: string): Promise<void> => {
    await collection.deleteOne({ _id: id } as any);
  };

  const existingCreds = await readData("creds");
  const creds: AuthenticationCreds = existingCreds || initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const result: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            const value = await readData(`${type}-${id}`);
            if (value) result[id] = value;
          })
        );
        return result;
      },

      set: async (data: any): Promise<void> => {
        const ops: Promise<void>[] = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            if (value) ops.push(writeData(`${category}-${id}`, value));
            else ops.push(removeData(`${category}-${id}`));
          }
        }
        await Promise.all(ops);
      },
    },
  };

  const saveCreds = async (): Promise<void> => {
    await writeData("creds", state.creds);
  };

  log.info(`Auth state loaded from MongoDB (existing session: ${!!existingCreds})`);
  return { state, saveCreds };
}
