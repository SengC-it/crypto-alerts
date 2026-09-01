// Consistent persistence -> delivery state transition for live and serverless.

export async function persistAndNotify({ signal, signalStore, sendEmail }) {
  if (!signal || !signalStore || typeof sendEmail !== 'function') {
    throw new TypeError('signal, signalStore and sendEmail are required');
  }

  // Persist first. A signal that cannot be recorded must never be emailed.
  const persisted = await signalStore.save(signal);
  const pending = await signalStore.markDeliveryPending(persisted);

  let sent;
  try {
    // The persisted row uses database column names. The notifier contract is
    // the original strategy signal (signal, suggestedEntry, stopLoss, etc.).
    sent = await sendEmail(signal);
  } catch (err) {
    try {
      await signalStore.markDeliveryFailed(pending, err);
    } catch (stateError) {
      throw new Error('Email failed and delivery state update failed: ' + stateError.message);
    }
    throw err;
  }

  if (!sent) {
    const failed = await signalStore.markDeliveryFailed(
      pending,
      'Email transport unavailable or rejected the message',
    );
    return { sent: false, record: failed };
  }

  try {
    const delivered = await signalStore.markDelivered(pending);
    return { sent: true, record: delivered };
  } catch (err) {
    // The email has already left the transport. Keep the persisted record in
    // delivery_pending so deduplication blocks an automatic duplicate send.
    throw new Error('Email was sent but delivery confirmation failed: ' + err.message, {
      cause: err,
    });
  }
}
