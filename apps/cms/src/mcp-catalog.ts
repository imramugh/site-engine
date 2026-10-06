/** Machine-readable guardrails advertised with every MCP resource and prompt. */
export const mcpCatalogLimits = Object.freeze({
  approve: false,
  publish: false,
  userManagement: false,
  credentialAccess: false,
})

type CatalogAuthorization = {
  securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>
  requiredScopes: string[]
  effectiveUserRequired: true
  requiredRoles?: string[]
}

export function mcpCatalogMeta(scope: string, requiredRoles?: string[]) {
  const authorization: CatalogAuthorization = {
    securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
    requiredScopes: [scope],
    effectiveUserRequired: true,
    ...(requiredRoles ? { requiredRoles } : {}),
  }
  return { securitySchemes: authorization.securitySchemes, authorization, limits: mcpCatalogLimits }
}
