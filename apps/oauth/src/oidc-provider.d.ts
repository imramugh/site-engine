declare module 'oidc-provider' {
  export const errors: Record<string, new (...args: never[]) => Error>;
  export const interactionPolicy: { base(): { remove(name: string): void } };
  export class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    callback(): (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void;
    interactionDetails(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<{ jti: string; prompt: { name: string } }>;
    interactionFinished(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, result: Record<string, unknown>): Promise<void>;
    Client: { new (metadata: Record<string, unknown>): { clientId: string; metadata(): Record<string, unknown> }; adapter: { upsert(id: string, payload: Record<string, unknown>): Promise<void> } };
  }
  export default Provider;
}
