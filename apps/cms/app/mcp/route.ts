import { handleMcp } from '../../src/mcp'

export const dynamic = 'force-dynamic'
export async function POST(request: Request): Promise<Response> { return handleMcp(request) }
export async function GET(request: Request): Promise<Response> { return handleMcp(request) }
