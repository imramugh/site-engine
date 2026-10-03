import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

/**
 * Run Payload Local API operations on one SQLite transaction. Callers must pass
 * the supplied request to every Local API operation in the callback.
 */
export async function withPayloadTransaction<T>(payload: Payload, operation: (req: PayloadRequest) => Promise<T>): Promise<T> {
  const transactionID = await payload.db.beginTransaction()
  if (!transactionID) throw new Error('The database adapter did not start a transaction.')

  const req = await createLocalReq({ req: { transactionID } }, payload)
  try {
    const result = await operation(req)
    await payload.db.commitTransaction(transactionID)
    return result
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID)
    throw error
  }
}
