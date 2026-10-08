import { createHash } from 'node:crypto';
import { isSafeOutgoingAttachmentFilename } from './attachment-filename';
/** Fixed official Graph and Gmail endpoints; adapters never accept provider URLs from callers. */
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Envelope = {
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  threadID?: string;
  replyMessageID?: string;
  rfcMessageID?: string;
  rfcReferences?: string;
  outboundRFCMessageID?: string;
  /** Internal-only bytes resolved and verified before provider serialization. */
  attachments?: readonly VerifiedAttachment[];
};
export type VerifiedAttachment = Readonly<{
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  bytes: Uint8Array;
}>;
const maximum = 262_144;
const attachmentMaximum = 10 * 1024 * 1024;
const attachmentCountMaximum = 5;
const attachmentTypes = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const timeout = 10_000;
const graph = "https://graph.microsoft.com";
const gmail = "https://gmail.googleapis.com";
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const controls = /[\u0000-\u001f\u007f]/;
const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
const graphAuth = (token: string) => ({ ...auth(token), Prefer: 'IdType="ImmutableId"' });
const clean = (value: unknown, limit = 20_000) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(controls, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim()
    .slice(0, limit);
const opaque = (value: unknown) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 500 &&
    !controls.test(value);
const rfcMessageID = (value: unknown) => {
  const id = String(value ?? "").trim();
  return /^<[^<>\s]{1,480}>$/.test(id) ? id : undefined;
};
const rfcReferences = (value: unknown) => {
  const references = String(value ?? "").match(/<[^<>\s]{1,480}>/g) ?? [];
  return references.length && references.join(" ").length <= 4000
    ? [...new Set(references)].join(" ")
    : undefined;
};
export function boundedRFCReferenceChain(references: unknown, messageID: string) {
  const values = (String(references ?? '').match(/<[^<>\s]{1,480}>/g) ?? []).filter((value, index, all) => value !== messageID && all.indexOf(value) === index)
  const selected: string[] = [messageID]; let length = messageID.length
  // Keep the newest valid identifiers while leaving room for the header name
  // and CRLF inside RFC 5322's 998-character physical-line limit.
  for (const value of values.reverse()) { const next = length + 1 + value.length; if (next <= 980) { selected.unshift(value); length = next } }
  return selected.join(' ')
}
function checkedAttachments(input: Envelope): readonly VerifiedAttachment[] {
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > attachmentCountMaximum) throw new Error('invalid_attachments');
  let total = 0;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object' || !(attachment.bytes instanceof Uint8Array) || !isSafeOutgoingAttachmentFilename(attachment.filename) || !attachmentTypes.has(attachment.mimeType) || !Number.isSafeInteger(attachment.size) || attachment.size !== attachment.bytes.byteLength || attachment.size < 1 || attachment.size > attachmentMaximum || !/^[a-f0-9]{64}$/i.test(attachment.sha256) || createHash('sha256').update(attachment.bytes).digest('hex') !== attachment.sha256) throw new Error('invalid_attachments');
    total += attachment.size;
    if (total > attachmentMaximum) throw new Error('invalid_attachments');
  }
  return attachments;
}
const graphSimpleAttachmentMaximum = 3 * 1024 * 1024 - 1;
const graphUploadChunk = 320 * 1024;
function graphUploadURL(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('provider_malformed_response');
  let url: URL; try { url = new URL(value) } catch { throw new Error('provider_malformed_response') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.hostname !== 'outlook.office.com' || !url.pathname.includes('/AttachmentSessions(') || !url.search) throw new Error('provider_malformed_response');
  return value;
}
async function graphAttachment(fetcher: Fetcher, token: string, messageID: string, attachment: VerifiedAttachment): Promise<void> {
  const endpoint = `${graph}/v1.0/me/messages/${encodeURIComponent(messageID)}/attachments`;
  if (attachment.size <= graphSimpleAttachmentMaximum) {
    const added = await request(fetcher, endpoint, { method: 'POST', headers: graphAuth(token), body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: attachment.filename, contentType: attachment.mimeType, contentBytes: Buffer.from(attachment.bytes).toString('base64') }) });
    if (added.status !== 201) fail(added.status); return;
  }
  const session = await request(fetcher, `${endpoint}/createUploadSession`, { method: 'POST', headers: graphAuth(token), body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: attachment.filename, size: attachment.size, contentType: attachment.mimeType } }) });
  if (session.status !== 201) fail(session.status);
  const sessionBody = await json(session); const initial = sessionBody.nextExpectedRanges;
  if (initial !== undefined && (!Array.isArray(initial) || initial.length !== 1 || initial[0] !== '0-')) throw new Error('provider_malformed_response');
  const uploadURL = graphUploadURL(sessionBody.uploadUrl);
  for (let start = 0; start < attachment.size; start += graphUploadChunk) {
    const end = Math.min(start + graphUploadChunk, attachment.size) - 1;
    const part = attachment.bytes.slice(start, end + 1);
    const uploaded = await request(fetcher, uploadURL, { method: 'PUT', headers: { 'content-length': String(part.byteLength), 'content-range': `bytes ${start}-${end}/${attachment.size}`, 'content-type': 'application/octet-stream' }, body: part });
    if (end + 1 === attachment.size) { if (uploaded.status !== 201) fail(uploaded.status); }
    else {
      if (uploaded.status !== 200) fail(uploaded.status);
      const ranges = (await json(uploaded)).nextExpectedRanges;
      if (!Array.isArray(ranges) || ranges[0] !== `${end + 1}-`) throw new Error('provider_malformed_response');
    }
  }
}
function mime(input: Envelope, attachments: readonly VerifiedAttachment[]) {
  const references = input.rfcMessageID ? boundedRFCReferenceChain(input.rfcReferences, input.rfcMessageID) : ''
  if (!attachments.length) return `To: ${input.recipient}\r\nFrom: ${input.sender}\r\nSubject: ${input.subject}\r\n${input.outboundRFCMessageID ? `Message-ID: ${input.outboundRFCMessageID}\r\n` : ''}${input.rfcMessageID ? `In-Reply-To: ${input.rfcMessageID}\r\nReferences: ${references}\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.body}`;
  const seed = createHash('sha256').update(JSON.stringify({ sender: input.sender, recipient: input.recipient, subject: input.subject, body: input.body, attachments: attachments.map(({ filename, mimeType, size, sha256 }) => ({ filename, mimeType, size, sha256 })) })).digest('hex');
  let index = 0; let boundary = `=_mail_${seed.slice(0, 32)}`;
  const encoded = attachments.map((attachment) => Buffer.from(attachment.bytes).toString('base64').replace(/.{1,76}/g, '$&\r\n').replace(/\r\n$/, ''));
  while ([input.body, ...encoded].some((part) => part.includes(`--${boundary}`))) boundary = `=_mail_${seed.slice(0, 28)}_${++index}`;
  const headers = `To: ${input.recipient}\r\nFrom: ${input.sender}\r\nSubject: ${input.subject}\r\n${input.outboundRFCMessageID ? `Message-ID: ${input.outboundRFCMessageID}\r\n` : ''}${input.rfcMessageID ? `In-Reply-To: ${input.rfcMessageID}\r\nReferences: ${references}\r\n` : ''}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${input.body}\r\n`;
  return headers + attachments.map((attachment, position) => `--${boundary}\r\nContent-Type: ${attachment.mimeType}; name="${attachment.filename}"\r\nContent-Disposition: attachment; filename="${attachment.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded[position]}\r\n`).join('') + `--${boundary}--\r\n`;
}
function fail(status: number): never {
  if (status === 401) throw new Error("provider_unauthorized");
  if (status === 403) throw new Error("provider_forbidden");
  throw new Error("provider_unavailable");
}
function checkedEnvelope(input: Envelope) {
  if (
    !email.test(input.sender) ||
    !email.test(input.recipient) ||
    [
      input.sender,
      input.recipient,
      input.subject,
      input.threadID ?? "",
      input.replyMessageID ?? "",
      input.outboundRFCMessageID ?? "",
    ].some((value) => controls.test(value))
  )
    throw new Error("invalid_envelope");
}
function checkedSender(verified: string, input: Envelope) {
  if (
    !email.test(verified) ||
    input.sender.toLowerCase() !== verified.toLowerCase()
  )
    throw new Error("sender_not_verified");
}
async function request(fetcher: Fetcher, url: string, init: RequestInit) {
  try {
    return await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error("provider_timeout");
  }
}
async function json(response: Response): Promise<Record<string, unknown>> {
  const size = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(size) || size > maximum)
    throw new Error("provider_response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_malformed_response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("provider_timeout")),
            timeout,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("provider_response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("provider_malformed_response");
  }
}
async function bytes(response: Response, limit: number) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared > limit) throw new Error("provider_response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_malformed_response");
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) { await reader.cancel(); throw new Error("provider_response_too_large"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
async function attachmentJSON(response: Response) {
  const raw = await bytes(response, Math.ceil(attachmentMaximum * 4 / 3) + 1024);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("provider_malformed_response"); }
}
function graphDelta(folderID: string, cursor?: string) {
  if (!opaque(folderID)) throw new Error("invalid_cursor");
  const path = `/v1.0/me/mailFolders/${encodeURIComponent(folderID)}/messages/delta`;
  if (!cursor)
    return `${graph}${path}?$select=id,conversationId,subject,body,from,toRecipients,receivedDateTime,hasAttachments`;
  let url: URL;
  try {
    url = new URL(cursor);
  } catch {
    throw new Error("invalid_cursor");
  }
  if (
    url.origin !== graph ||
    url.pathname !== path ||
    [...url.searchParams.keys()].some(
      (key) => key !== "$skiptoken" && key !== "$deltatoken",
    ) ||
    (!url.searchParams.has("$skiptoken") &&
      !url.searchParams.has("$deltatoken"))
  )
    throw new Error("invalid_cursor");
  return url.toString();
}
function graphMessage(value: Record<string, unknown>) {
  const from = value.from as
    { emailAddress?: { address?: unknown } } | undefined;
  const recipients = value.toRecipients as
    Array<{ emailAddress?: { address?: unknown } }> | undefined;
  const body = value.body as { content?: unknown } | undefined;
  return {
    messageId: String(value.id ?? ""),
    threadId: String(value.conversationId ?? ""),
    subject: clean(value.subject),
    body: clean(body?.content),
    date: String(value.receivedDateTime ?? ""),
    sender: clean(from?.emailAddress?.address),
    recipient: clean(recipients?.[0]?.emailAddress?.address),
    attachments: [] as Array<{
      name: string;
      contentType: string;
      size: number;
    }>,
  };
}
async function graphAttachments(fetcher: Fetcher, token: string, messageID: string) {
  // Timeline storage deliberately retains metadata for at most 20 attachments;
  // use Graph's fixed bounded collection rather than following provider links.
  const response = await request(fetcher, `${graph}/v1.0/me/messages/${encodeURIComponent(messageID)}/attachments?$select=id,name,contentType,size&$top=20`, { headers: graphAuth(token) });
  if (!response.ok) fail(response.status)
  const value = await json(response)
  if (!Array.isArray(value.value) || value.value.length > 20) throw new Error('provider_malformed_response')
  return value.value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object').flatMap((entry) => {
    const type = entry['@odata.type']
    if (type !== '#microsoft.graph.fileAttachment' && type !== '#microsoft.graph.itemAttachment' || !opaque(entry.id)) return []
    return [{ name: clean(entry.name, 255), contentType: clean(entry.contentType, 120), size: Number(entry.size) || 0, providerAttachmentID: String(entry.id) }]
  })
}
export function microsoftAdapter(fetcher: Fetcher, verifiedSender: string) {
  return {
    async send(token: string, input: Envelope) {
      checkedEnvelope(input);
      checkedSender(verifiedSender, input);
      const attachments = checkedAttachments(input);
      if (input.threadID && !input.replyMessageID)
        throw new Error("invalid_envelope");
      if (input.replyMessageID) {
        if (!opaque(input.replyMessageID)) throw new Error("invalid_envelope");
        const draft = await request(fetcher, `${graph}/v1.0/me/messages/${encodeURIComponent(input.replyMessageID)}/createReply`, {
          method: 'POST', headers: graphAuth(token), body: JSON.stringify({ message: { subject: input.subject, body: { contentType: 'Text', content: input.body }, toRecipients: [{ emailAddress: { address: input.recipient } }], from: { emailAddress: { address: verifiedSender } } } }),
        });
        if (!draft.ok) fail(draft.status);
        const created = await json(draft); const id = typeof created.id === 'string' ? created.id : '';
        if (!opaque(id)) throw new Error('provider_malformed_response');
        for (const attachment of attachments) await graphAttachment(fetcher, token, id, attachment);
        const sent = await request(fetcher, `${graph}/v1.0/me/messages/${encodeURIComponent(id)}/send`, { method: 'POST', headers: graphAuth(token) });
        if (sent.status !== 202) fail(sent.status);
        return { accepted: true as const, id };
      }
      const draft = await request(fetcher, `${graph}/v1.0/me/messages`, {
        method: "POST",
        headers: graphAuth(token),
        body: JSON.stringify({
          subject: input.subject,
          body: { contentType: "Text", content: input.body },
          toRecipients: [{ emailAddress: { address: input.recipient } }],
          from: { emailAddress: { address: verifiedSender } },
        }),
      });
      if (!draft.ok) fail(draft.status);
      const created = await json(draft);
      const id = typeof created.id === "string" ? created.id : "";
      const threadID = typeof created.conversationId === "string" ? created.conversationId : "";
      if (!opaque(id) || !opaque(threadID)) throw new Error("provider_malformed_response");
      for (const attachment of attachments) await graphAttachment(fetcher, token, id, attachment);
      const sent = await request(
        fetcher,
        `${graph}/v1.0/me/messages/${encodeURIComponent(id)}/send`,
        { method: "POST", headers: graphAuth(token) },
      );
      if (sent.status !== 202) fail(sent.status);
      return { accepted: true as const, id, threadID };
    },
    async thread(token: string, id: string) {
      if (!opaque(id)) throw new Error("invalid_thread");
      const response = await request(
        fetcher,
        `${graph}/v1.0/me/messages/${encodeURIComponent(id)}?$select=id,conversationId,body,subject`,
        { headers: graphAuth(token) },
      );
      if (!response.ok) fail(response.status);
      const output = graphMessage(await json(response));
      if (!output.messageId || !output.threadId)
        throw new Error("provider_malformed_response");
      return {
        id: output.messageId,
        threadID: output.threadId,
        subject: output.subject,
        body: output.body,
      };
    },
    async poll(token: string, folderID: string, cursor?: string) {
      const response = await request(fetcher, graphDelta(folderID, cursor), {
        headers: { ...graphAuth(token), Prefer: 'odata.maxpagesize=100, IdType="ImmutableId"' },
      });
      if (!response.ok) fail(response.status);
      const value = await json(response);
      if (!Array.isArray(value.value))
        throw new Error("provider_malformed_response");
      if (value.value.length > 500) throw new Error("provider_page_too_large");
      const next = value["@odata.nextLink"] ?? value["@odata.deltaLink"];
      const messages = value.value.map((entry) => {
        if (!entry || typeof entry !== "object")
          throw new Error("provider_malformed_response");
        const raw = entry as Record<string, unknown>;
        if (raw["@removed"] !== undefined) return undefined;
        const message = graphMessage(raw);
        if (!message.messageId || !message.threadId)
          throw new Error("provider_malformed_response");
        return { ...message, attachmentsPending: raw.hasAttachments === true };
      });
      return {
        cursor: typeof next === "string" ? graphDelta(folderID, next) : null,
        messages: messages.filter((message): message is NonNullable<typeof message> => !!message),
      };
    },
    attachments(token: string, messageID: string) { return graphAttachments(fetcher, token, messageID) },
  };
}
export function microsoftIdentity(fetcher: Fetcher) {
  return async (token: string) => {
    const response = await request(
      fetcher,
      `${graph}/v1.0/me?$select=mail,userPrincipalName`,
      { headers: graphAuth(token) },
    );
    if (!response.ok) fail(response.status);
    const value = await json(response);
    const primary = String(value.mail || value.userPrincipalName || "")
      .trim()
      .toLowerCase();
    if (!email.test(primary)) throw new Error("provider_identity_missing");
    return { primaryAddress: primary, verifiedSenders: [primary] };
  };
}
function mimeBody(payload: Record<string, unknown>, depth = 0): string {
  if (depth > 8) return "";
  const body = payload.body as
    { data?: unknown; attachmentId?: unknown } | undefined;
  if (
    !body?.attachmentId &&
    typeof body?.data === "string" &&
    body.data.length <= 100_000 &&
    /^[A-Za-z0-9_-]*$/.test(body.data) &&
    payload.mimeType === "text/plain"
  )
    return clean(Buffer.from(body.data, "base64url").toString("utf8"));
  const parts = Array.isArray(payload.parts) ? payload.parts.slice(0, 50) : [];
  for (const part of parts)
    if (part && typeof part === "object") {
      const value = mimeBody(part as Record<string, unknown>, depth + 1);
      if (value) return value;
    }
  return "";
}
function address(value: unknown) {
  const matches =
    String(value ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return matches
    .filter((item) => email.test(item))
    .join(", ")
    .toLowerCase();
}
function gmailMessage(message: Record<string, unknown>, threadID: string) {
  const payload = message.payload as Record<string, unknown> | undefined;
  const headers = Array.isArray(payload?.headers) ? payload.headers : [];
  const header = (name: string) =>
    headers.find(
      (entry): entry is Record<string, unknown> =>
        !!entry &&
        typeof entry === "object" &&
        String(entry.name).toLowerCase() === name.toLowerCase(),
    )?.value;
  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  const attachments = parts
    .filter(
      (part): part is Record<string, unknown> =>
        !!part &&
        typeof part === "object" &&
        (typeof part.filename === "string" ||
          !!(part.body as { attachmentId?: unknown })?.attachmentId),
    )
    .slice(0, 20)
    .map((part) => ({
      name: clean(part.filename, 255),
      contentType: clean(part.mimeType, 120),
      size: Number((part.body as { size?: unknown })?.size) || 0,
      providerAttachmentID: opaque((part.body as { attachmentId?: unknown })?.attachmentId) ? String((part.body as { attachmentId: string }).attachmentId) : undefined,
    }));
  const date = Number(message.internalDate);
  return {
    messageId: String(message.id ?? ""),
    threadId: String(message.threadId ?? ""),
    subject: clean(header("subject")),
    body: payload ? mimeBody(payload) : "",
    date: Number.isFinite(date) ? new Date(date).toISOString() : "",
    sender: address(header("from")),
    recipient: address(header("to")),
    rfcMessageID: rfcMessageID(header("message-id")),
    rfcReferences: rfcReferences(header("references")),
    attachments,
  };
}
export function gmailAttachment(fetcher: Fetcher) {
  return async (token: string, messageID: string, attachmentID: string) => {
    if (!opaque(messageID) || !opaque(attachmentID)) throw new Error("invalid_attachment");
    const response = await request(fetcher, `${gmail}/gmail/v1/users/me/messages/${encodeURIComponent(messageID)}/attachments/${encodeURIComponent(attachmentID)}`, { headers: auth(token) });
    if (!response.ok) fail(response.status);
    const value = await attachmentJSON(response);
    if (typeof value.data !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value.data)) throw new Error("provider_malformed_response");
    const output = Buffer.from(value.data, "base64url");
    if (output.length > attachmentMaximum) throw new Error("provider_response_too_large");
    return new Uint8Array(output);
  };
}
export function microsoftAttachment(fetcher: Fetcher) {
  return async (token: string, messageID: string, attachmentID: string) => {
    if (!opaque(messageID) || !opaque(attachmentID)) throw new Error("invalid_attachment");
    const response = await request(fetcher, `${graph}/v1.0/me/messages/${encodeURIComponent(messageID)}/attachments/${encodeURIComponent(attachmentID)}/$value`, { headers: graphAuth(token) });
    if (!response.ok) fail(response.status);
    return bytes(response, attachmentMaximum);
  };
}
export function gmailAdapter(fetcher: Fetcher, verifiedSender: string) {
  return {
    async send(token: string, input: Envelope) {
      checkedEnvelope(input);
      checkedSender(verifiedSender, input);
      const attachments = checkedAttachments(input);
      const normalizedReferences = input.rfcReferences
        ? rfcReferences(input.rfcReferences)
        : undefined;
      if (
        (input.threadID && !input.rfcMessageID) ||
        (input.threadID && !opaque(input.threadID)) ||
        (input.rfcMessageID && !rfcMessageID(input.rfcMessageID)) ||
        (input.outboundRFCMessageID && !rfcMessageID(input.outboundRFCMessageID)) ||
        (input.rfcReferences && normalizedReferences !== input.rfcReferences)
      )
        throw new Error("invalid_envelope");
      const raw = Buffer.from(mime({ ...input, ...(normalizedReferences ? { rfcReferences: normalizedReferences } : {}) }, attachments), 'utf8').toString("base64url");
      const response = await request(
        fetcher,
        `${gmail}/gmail/v1/users/me/messages/send`,
        {
          method: "POST",
          headers: auth(token),
          body: JSON.stringify({
            raw,
            ...(input.threadID ? { threadId: input.threadID } : {}),
          }),
        },
      );
      if (!response.ok) fail(response.status);
      const value = await json(response);
      if (!opaque(value.id) || !opaque(value.threadId))
        throw new Error("provider_malformed_response");
      return {
        accepted: true as const,
        id: value.id,
        threadID: value.threadId,
      };
    },
    async message(token: string, id: string) {
      if (!opaque(id)) throw new Error("invalid_thread");
      const response = await request(
        fetcher,
        `${gmail}/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
        { headers: auth(token) },
      );
      if (!response.ok) fail(response.status);
      const value = await json(response);
      const output = gmailMessage(value, String(value.threadId ?? ""));
      if (!output.messageId || !output.threadId)
        throw new Error("provider_malformed_response");
      return output;
    },
    async poll(token: string, historyID: string, pageToken?: string) {
      if (!/^[0-9]{1,40}$/.test(historyID) || (pageToken && !opaque(pageToken)))
        throw new Error("invalid_cursor");
      const response = await request(
        fetcher,
        `${gmail}/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyID)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}&maxResults=100`,
        { headers: auth(token) },
      );
      if (!response.ok) fail(response.status);
      const value = await json(response);
      if (
        typeof value.historyId !== "string" ||
        !/^[0-9]{1,40}$/.test(value.historyId) ||
        (value.history !== undefined && !Array.isArray(value.history)) ||
        (value.nextPageToken !== undefined && !opaque(value.nextPageToken))
      )
        throw new Error("provider_malformed_response");
      if (Array.isArray(value.history) && value.history.length > 500)
        throw new Error("provider_page_too_large");
      return {
        historyID: value.historyId,
        nextPageToken:
          typeof value.nextPageToken === "string" ? value.nextPageToken : null,
        entries: Array.isArray(value.history) ? value.history : [],
      };
    },
  };
}
export function gmailThreadReader(fetcher: Fetcher) {
  return async (token: string, threadID: string) => {
    if (!opaque(threadID)) throw new Error("invalid_thread");
    const response = await request(
      fetcher,
      `${gmail}/gmail/v1/users/me/threads/${encodeURIComponent(threadID)}?format=full`,
      { headers: auth(token) },
    );
    if (!response.ok) fail(response.status);
    const value = await json(response);
    if (value.id !== threadID || !Array.isArray(value.messages))
      throw new Error("provider_malformed_response");
    return value.messages
      .slice(0, 500)
      .filter(
        (message): message is Record<string, unknown> =>
          !!message && typeof message === "object",
      )
      .map((message) => gmailMessage(message, threadID))
      .filter((message) => message.messageId && message.threadId === threadID);
  };
}
export function gmailIdentity(fetcher: Fetcher) {
  return async (token: string) => {
    const [profile, aliases] = await Promise.all(
      [
        `${gmail}/gmail/v1/users/me/profile`,
        `${gmail}/gmail/v1/users/me/settings/sendAs`,
      ].map(async (url) => {
        const response = await request(fetcher, url, { headers: auth(token) });
        if (!response.ok) fail(response.status);
        return json(response);
      }),
    );
    const primary = String(profile.emailAddress ?? "").toLowerCase();
    if (!email.test(primary)) throw new Error("provider_identity_missing");
    const verified = Array.isArray(aliases.sendAs)
      ? aliases.sendAs
          .filter(
            (alias): alias is Record<string, unknown> =>
              !!alias &&
              typeof alias === "object" &&
              alias.verificationStatus === "accepted",
          )
          .map((alias) => String(alias.sendAsEmail).toLowerCase())
          .filter((alias) => email.test(alias))
      : [];
    const historyID = String(profile.historyId ?? "");
    return {
      primaryAddress: primary,
      verifiedSenders: [...new Set([primary, ...verified])].sort(),
      historyID: /^[0-9]{1,40}$/.test(historyID) ? historyID : undefined,
    };
  };
}
