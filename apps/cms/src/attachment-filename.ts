/** A descriptor filename is inserted into provider MIME headers unchanged. */
export const isSafeOutgoingAttachmentFilename = (value: unknown): value is string =>
  typeof value === 'string' && /^[^\u0000-\u001f\u007f"\\/]{1,240}$/.test(value)
