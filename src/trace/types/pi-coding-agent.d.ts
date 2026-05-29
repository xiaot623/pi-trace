declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(eventName: string, handler: (event: any, ctx: any) => any): void;
  }
}
