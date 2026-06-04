declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(eventName: string, handler: (event: any, ctx: any) => any): void;
    registerFlag(
      name: string,
      options: { description: string; type: "boolean" | "string" | "number"; default?: unknown },
    ): void;
    getFlag(name: string): unknown;
  }
}
