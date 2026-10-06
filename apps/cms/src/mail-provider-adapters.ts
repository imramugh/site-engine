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
};
const maximum = 262_144;
const timeout = 10_000;
const graph = "https://graph.microsoft.com";
const gmail = "https://gmail.googleapis.com";
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const controls = /[\u0000-\u001f\u007f]/;
const auth = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});
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
function graphDelta(folderID: string, cursor?: string) {
  if (!opaque(folderID)) throw new Error("invalid_cursor");
  const path = `/v1.0/me/mailFolders/${encodeURIComponent(folderID)}/messages/delta`;
  if (!cursor)
    return `${graph}${path}?$select=id,conversationId,subject,body,from,toRecipients,receivedDateTime`;
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
export function microsoftAdapter(fetcher: Fetcher, verifiedSender: string) {
  return {
    async send(token: string, input: Envelope) {
      checkedEnvelope(input);
      checkedSender(verifiedSender, input);
      if (input.threadID && !input.replyMessageID)
        throw new Error("invalid_envelope");
      if (input.replyMessageID) {
        if (!opaque(input.replyMessageID)) throw new Error("invalid_envelope");
        const response = await request(
          fetcher,
          `${graph}/v1.0/me/messages/${encodeURIComponent(input.replyMessageID)}/reply`,
          {
            method: "POST",
            headers: auth(token),
            body: JSON.stringify({
              message: {
                subject: input.subject,
                body: { contentType: "Text", content: input.body },
                toRecipients: [{ emailAddress: { address: input.recipient } }],
                from: { emailAddress: { address: verifiedSender } },
              },
            }),
          },
        );
        if (response.status !== 202) fail(response.status);
        return { accepted: true as const };
      }
      const response = await request(fetcher, `${graph}/v1.0/me/sendMail`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: "Text", content: input.body },
            toRecipients: [{ emailAddress: { address: input.recipient } }],
            from: { emailAddress: { address: verifiedSender } },
          },
        }),
      });
      if (response.status !== 202) fail(response.status);
      return { accepted: true as const };
    },
    async thread(token: string, id: string) {
      if (!opaque(id)) throw new Error("invalid_thread");
      const response = await request(
        fetcher,
        `${graph}/v1.0/me/messages/${encodeURIComponent(id)}?$select=id,conversationId,body,subject`,
        { headers: auth(token) },
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
        headers: { ...auth(token), Prefer: "odata.maxpagesize=100" },
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
        return message;
      });
      return {
        cursor: typeof next === "string" ? graphDelta(folderID, next) : null,
        messages: messages.filter((message): message is NonNullable<typeof message> => !!message),
      };
    },
  };
}
export function microsoftIdentity(fetcher: Fetcher) {
  return async (token: string) => {
    const response = await request(
      fetcher,
      `${graph}/v1.0/me?$select=mail,userPrincipalName`,
      { headers: auth(token) },
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
export function gmailAdapter(fetcher: Fetcher, verifiedSender: string) {
  return {
    async send(token: string, input: Envelope) {
      checkedEnvelope(input);
      checkedSender(verifiedSender, input);
      const normalizedReferences = input.rfcReferences
        ? rfcReferences(input.rfcReferences)
        : undefined;
      if (
        (input.threadID && !input.rfcMessageID) ||
        (input.threadID && !opaque(input.threadID)) ||
        (input.rfcMessageID && !rfcMessageID(input.rfcMessageID)) ||
        (input.rfcReferences && normalizedReferences !== input.rfcReferences)
      )
        throw new Error("invalid_envelope");
      const reply = input.rfcMessageID
        ? `In-Reply-To: ${input.rfcMessageID}\r\nReferences: ${[normalizedReferences, input.rfcMessageID].filter(Boolean).join(" ")}\r\n`
        : "";
      const raw = Buffer.from(
        `To: ${input.recipient}\r\nFrom: ${input.sender}\r\nSubject: ${input.subject}\r\n${reply}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.body}`,
        "utf8",
      ).toString("base64url");
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
      if (typeof value.id !== "string" || typeof value.threadId !== "string")
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
