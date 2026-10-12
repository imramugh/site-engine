declare module 'oidc-provider' {
  export const errors: Record<string, new (...args: never[]) => Error>;
  type PolicyCheck = { check(context: unknown): boolean | Promise<boolean> };
  type PolicyPrompt = { checks: { get(name: string): PolicyCheck | undefined } };
  export const interactionPolicy: { base(): { get(name: string): PolicyPrompt | undefined } };
  export class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    callback(): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void;
    interactionDetails(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<{ jti: string; prompt: { name: string } }>;
    interactionFinished(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, result: Record<string, unknown>): Promise<void>;
    Client: { new (metadata: Record<string, unknown>): { clientId: string; metadata(): Record<string, unknown> }; adapter: { upsert(id: string, payload: Record<string, unknown>): Promise<void> } };
  }
  export default Provider;
}
