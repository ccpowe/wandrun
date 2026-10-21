import { z } from "zod";

const preferenceSchema = z.object({
  language: z.enum(["zh", "en"]),
  theme: z.enum(["system", "light", "dark"]),
}).strict();

export type AppearancePreferences = z.infer<typeof preferenceSchema>;
export type AppearanceState = AppearancePreferences & { ready: boolean; saving: boolean; error: string | null };
export type AppearanceStorage = { read(): Promise<string | null>; write(value: string): Promise<void> };

/** Device-local preferences are independent of credentials and gateway sessions. */
export class AppearanceStore {
  private state: AppearanceState = { language: "zh", theme: "system", ready: false, saving: false, error: null };
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private restoring: Promise<void> | null = null;

  private readonly storage: AppearanceStorage;
  private readonly apply: (preferences: AppearancePreferences) => void;

  constructor(storage: AppearanceStorage, apply: (preferences: AppearancePreferences) => void) {
    this.storage = storage;
    this.apply = apply;
  }

  snapshot = (): AppearanceState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: AppearanceState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run);
    this.pending = result.catch(() => {});
    return result;
  }

  restore(): Promise<void> {
    if (this.state.ready) return Promise.resolve();
    if (this.restoring) return this.restoring;
    const operation = this.enqueue(async () => {
      try {
        const raw = await this.storage.read();
        const preferences = raw === null ? { language: "zh", theme: "system" } as const : preferenceSchema.parse(JSON.parse(raw));
        this.apply(preferences);
        this.publish({ ...preferences, ready: true, saving: false, error: null });
      } catch (error) {
        console.warn("Unable to load appearance preferences", error);
        this.publish({ ...this.state, ready: false, saving: false, error: "无法读取外观设置，请重试。" });
        throw error;
      }
    });
    this.restoring = operation;
    void operation.finally(() => { this.restoring = null; }).catch(() => {});
    return operation;
  }

  update(patch: Partial<AppearancePreferences>): Promise<void> {
    return this.enqueue(async () => {
      if (!this.state.ready) throw new Error("Appearance preferences have not been loaded");
      const preferences = preferenceSchema.parse({ language: this.state.language, theme: this.state.theme, ...patch });
      if (preferences.language === this.state.language && preferences.theme === this.state.theme) return;
      this.publish({ ...this.state, saving: true, error: null });
      try {
        await this.storage.write(JSON.stringify(preferences));
        this.apply(preferences);
        this.publish({ ...preferences, ready: true, saving: false, error: null });
      } catch (error) {
        console.warn("Unable to save appearance preferences", error);
        this.publish({ ...this.state, saving: false, error: "无法保存外观设置，请重试。" });
        throw error;
      }
    });
  }
}
