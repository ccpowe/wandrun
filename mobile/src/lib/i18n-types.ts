export type Language = "zh" | "en";
export type Translation = string | { one: string; other: string };
export type MessageCatalog = Readonly<Record<string, Translation>>;
export type MessageValues = Readonly<Record<string, string | number>>;
